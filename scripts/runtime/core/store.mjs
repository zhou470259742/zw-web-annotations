import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUSES = ['todo', 'doing', 'review', 'done', 'blocked', 'cancelled'];
export const STATUS_SET = new Set(STATUSES);
export const TERMINAL_STATUSES = ['done', 'cancelled'];
export const TERMINAL_STATUS_SET = new Set(TERMINAL_STATUSES);
export const MAX_TASK_ID_LENGTH = 64;
export const MAX_INSTRUCTION_LENGTH = 4096;
export const MAX_IMAGES_PER_TASK = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 正常处理流；同状态写入是幂等的，reopen 由 updateTask 的显式选项控制。 */
export const STATUS_TRANSITIONS = {
  todo: new Set(['todo', 'doing', 'cancelled']),
  doing: new Set(['doing', 'review', 'blocked', 'cancelled']),
  review: new Set(['review', 'done', 'blocked', 'cancelled', 'todo']),
  done: new Set(['done']),
  // blocked → todo：人工「重新入列」。队列停下等的就是这个人工决定。
  blocked: new Set(['blocked', 'cancelled', 'todo']),
  cancelled: new Set(['cancelled']),
};
/**
 * 项目执行模式。区别只在「当前轮复核归档后的走向」：
 * - round：本轮收尾即停，等用户显式归档/下一步指令（默认）；
 * - queue：本轮复核归档后自动继续派发下一轮，直到没有待处理任务。
 * 模式是**实时状态**，只在轮次边界被消费（见 task-protocol.md 的决策点），
 * 不随轮次定稿——用户中途切换，下一次边界决策就用新值。
 */
export const EXECUTION_MODES = ['round', 'queue'];
export const EXECUTION_MODE_SET = new Set(EXECUTION_MODES);
export const MAX_BODY_BYTES = 24 * 1024 * 1024;

export function validateHttpRequest(req, { mutating = false } = {}) {
  const host = String(req?.headers?.host || '');
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    const error = new Error('forbidden host');
    error.statusCode = 403;
    throw error;
  }
  const origin = String(req?.headers?.origin || '');
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* invalid origin remains empty */ }
    if (originHost !== host) {
      const error = new Error('forbidden origin');
      error.statusCode = 403;
      throw error;
    }
  }
  if (mutating) {
    const type = String(req?.headers?.['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      const error = new Error('content-type must be application/json');
      error.statusCode = 415;
      throw error;
    }
  }
  return true;
}
/**
 * 任务落盘的规范目录。
 * 安装器、Vite 插件、http 适配器、bridge 与 MCP 必须共用这一个常量：
 * 任何一处写死别的路径，都会让「安装器说存在 tasks/，运行时却写到别处」
 * 这类不一致重新出现。
 */
export const DEFAULT_DIR = '.zwa/tasks';
export const ATTACHMENTS_DIRNAME = 'attachments';

/**
 * 运行时版本号，随运行时一起被复制进用户项目。
 *
 * 必需这份副本的原因：图形界面需要知道"页面里跑的是哪一版"，而它是被
 * Vite 插件/http 适配器作为纯文本下发给浏览器的，无法 import 技能侧的
 * scripts/index.mjs（那个文件不在 RUNTIME_FILES 里、不会被拷进项目）。
 *
 * 与 scripts/index.mjs 的 SKILL_VERSION 必须一致，由
 * tests/consistency.test.mjs 断言，避免两处各自漂移。
 */
export const RUNTIME_VERSION = '0.28.0';
/**
 * 归档目录名。归档是「已从活动组移出、暂不销毁」的任务，与活动组同 schema，
 * 协议文档承诺的「删除已归档 JSON 与对应附件」依赖这个目录真实存在。
 */
export const ARCHIVE_DIRNAME = 'archive';

/** 允许的图片类型与扩展名映射。 */
export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

export const nowIso = () => new Date().toISOString();

export function normalizeEndpointPath(value) {
  const text = String(value || '').trim();
  const normalized = text.replace(/\/+$/, '');
  if (!normalized || normalized === '/' || !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized) || normalized.includes('..')) {
    throw new Error('invalid endpoint path');
  }
  return normalized;
}

/**
 * 写入项目级运行时 endpoint 清单。执行要求文件本身是静态 runtime，不能把
 * 用户自定义的 endpoint 写死进去；适配器在运行时把真实 endpoint 写到
 * `.zwa/runtime/endpoint.json`，模型读取协议后再读这份清单。清单不在 tasks/
 * 中，不属于用户任务数据；写入采用临时文件 + rename，读取到半文件不会发生。
 */
export async function ensureEndpointManifest(workspace, endpoint) {
  const root = path.resolve(workspace);
  const file = path.join(root, '.zwa', 'runtime', 'endpoint.json');
  const manifest = `${JSON.stringify({
    version: '1.0',
    runtimeVersion: RUNTIME_VERSION,
    endpoint: normalizeEndpointPath(endpoint),
    routes: {
      tasks: 'GET /tasks',
      updateTask: 'PATCH /<groupId>/tasks/<taskId>',
      acceptTasks: 'POST /accept-tasks',
      execution: 'GET|POST /execution',
      completeRound: 'POST /complete-round',
      board: 'GET /board',
    },
  }, null, 2)}\n`;
  try {
    if (await fs.readFile(file, 'utf8') === manifest) return file;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 运行时元数据损坏时按期望内容原子修复，不影响 tasks/ 原件。
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, manifest, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

export function safeId(value) {
  const text = String(value || '');
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

export function validateTaskId(value) {
  const text = String(value || '');
  if (!text || text.length > MAX_TASK_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`invalid task id: ${text.slice(0, 40)}`);
  }
  return text;
}

/**
 * 解析 data URL，返回类型与二进制内容。
 * 只接受白名单内的图片类型，避免把任意文件写进工作区。
 */
export function parseDataUrl(dataUrl) {
  const match = /^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const type = match[1].toLowerCase();
  if (!IMAGE_TYPES[type]) return null;
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) return null;
  return { type, ext: IMAGE_TYPES[type], buffer };
}

export function pageKey(url) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
  const slug = String(url)
    .replace(/^https?:\/\//, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${slug || 'page'}-${hash}`;
}

export function validateGroup(group) {
  if (!group || group.version !== '1.0' || !group.id || !group.page || !Array.isArray(group.tasks)) {
    throw new Error('invalid annotation group');
  }
  for (const task of group.tasks) {
    if (!task.id || typeof task.id !== 'string' || task.id.length > MAX_TASK_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(task.id) || typeof task.instruction !== 'string' || task.instruction.length > MAX_INSTRUCTION_LENGTH || !STATUS_SET.has(task.status) || !Array.isArray(task.history)) {
      throw new Error(`invalid task: ${task.id || 'unknown'}`);
    }
    for (const item of task.history) {
      if (!item || typeof item.at !== 'string' || typeof item.event !== 'string') {
        throw new Error(`invalid task history: ${task.id}`);
      }
    }
    // manual 任务没有关联元素；element 任务必须有 element
    if (task.kind !== 'manual' && !task.element) {
      throw new Error(`task missing element: ${task.id}`);
    }
  }
  return group;
}

export function buildSendPayload(group) {
  const pending = group.tasks.filter(t => t.status === 'todo' || t.status === 'doing');
  const lines = [];
  for (const [i, t] of pending.entries()) {
    lines.push(`${i + 1}. [${t.id}] ${t.instruction}`);
    lines.push(`   状态：${t.status}`);
    if (t.kind === 'manual' || !t.element) {
      lines.push('   类型：手动添加的任务（无关联页面元素）');
    } else {
      const el = t.element;
      lines.push(`   元素：${el.tagName} ${el.accessibleName || el.text || ''}`.trimEnd());
      // 组件来源放最前：这是能直接打开的文件，比按类名猜文件可靠得多
      if (el.componentFile) {
        lines.push(`   组件文件：${el.componentFile}${el.componentName ? `（${el.componentName}）` : ''}`);
      }
      lines.push(`   Selector：${el.selector}`);
      if (el.uniqueMatch === false) {
        lines.push('   注意：该 Selector 在页面上匹配到多个元素，不能只凭它判断目标，请结合组件文件与下方属性区分。');
      }
      lines.push(`   XPath：${el.xpath}`);
      const attrs = el.attributes && typeof el.attributes === 'object' ? Object.entries(el.attributes) : [];
      if (attrs.length) {
        lines.push(`   属性：${attrs.map(([k, v]) => (v === '' ? k : `${k}="${v}"`)).join(' ')}`);
      }
      if (el.rect) {
        lines.push(`   尺寸：${el.rect.width}×${el.rect.height} @ (${el.rect.x}, ${el.rect.y})`);
      }
      // 样式归属提示：不写清楚的话，模型会把继承值当成元素自己的声明，
      // 于是「改这块区域的文字颜色」被翻译成改祖先/主题变量，一次影响全站。
      if (Array.isArray(el.inheritedStyles) && el.inheritedStyles.length) {
        lines.push(`   样式提示：${el.inheritedStyles.join('、')} 的取值继承自祖先，该元素自身没有这些声明；要改它们应修改祖先规则或主题变量，改本元素选择器无效。`);
      }
      lines.push(`   DOM：${el.domSnippet}`);
    }
    const images = Array.isArray(t.images) ? t.images.filter(img => img.file) : [];
    if (images.length) {
      lines.push(`   截图：${images.map(img => img.file).join('、')}`);
    }
    lines.push('');
  }
  return [
    '请处理以下网页标注任务：',
    `页面：${group.page.title}`,
    `URL：${group.page.url}`,
    '',
    ...lines,
    '请先分析相关代码，再修改当前工作区，并逐项回写任务状态与结果。',
  ].join('\n');
}

/**
 * 任务变更广播器（SSE）。页面通过 /events 长连接订阅；任何任务写入
 * （模型回写、归档、删除）都会合并去抖后向所有连接推送一条
 * `tasks-changed`，客户端收到后立即拉取最新任务。连接本身近乎零开销，
 * 常开即可；推送只带事件名不带数据，客户端自行拉取，避免大包与乱序。
 */
export function createTaskChangeHub() {
  const clients = new Set();
  const state = { announceTimer: null, heartbeatTimer: null };

  const safeWrite = (res, payload) => {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  };

  return {
    /** 建立一条 SSE 连接：下发重连间隔，之后交给心跳与广播维护。 */
    add(res) {
      clients.add(res);
      if (!state.heartbeatTimer) {
        // 注释行心跳：防止代理掐断空闲长连接；unref 不阻止进程退出
        state.heartbeatTimer = setInterval(() => {
          for (const res of [...clients]) safeWrite(res, ': ping\n\n');
        }, 25000);
        state.heartbeatTimer.unref?.();
      }
      safeWrite(res, 'retry: 3000\n\n');
      res.on('close', () => clients.delete(res));
      res.on('error', () => clients.delete(res));
    },
    /** 防抖合并：短时间内多次写入（一次修复常连改数项）只推一条。 */
    notify() {
      if (state.announceTimer) return;
      state.announceTimer = setTimeout(() => {
        state.announceTimer = null;
        for (const res of [...clients]) {
          // 必须带 event: 行——裸 data: 会作为 message 事件派发，
          // 客户端按具名事件监听时永远收不到（实测踩过）
          safeWrite(res, 'event: tasks-changed\ndata: {}\n\n');
        }
      }, 200);
      state.announceTimer.unref?.();
    },
    get clientCount() {
      return clients.size;
    },
    stop() {
      if (state.announceTimer) clearTimeout(state.announceTimer);
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      state.announceTimer = null;
      state.heartbeatTimer = null;
      clients.clear();
    },
  };
}

/**
 * 监听任务目录变化，覆盖 MCP 等**进程外**写入（进程内的写入走 onChange 回调）。
 * 目录不存在或平台不支持递归 watch 时抛错，调用方决定退化为轮询兜底。
 */
export function watchTaskDir(taskDir, onChange) {
  const watcher = fsSync.watch(taskDir, { recursive: true }, (event, filename) => {
    if (filename && !String(filename).endsWith('.json')) return;
    onChange();
  });
  // 目录被删除等异常时关闭监听，由轮询兜底
  watcher.unref?.();
  watcher.on('error', () => watcher.close());
  return { close: () => watcher.close() };
}

export function createStore(workspace, options = {}) {
  const root = path.resolve(workspace);
  // 相对 dir 一律相对工作区根目录解析，而不是相对进程 CWD，
  // 否则从子目录启动开发服务器时任务会落到错误位置。
  const taskDir = options.dir
    ? (path.isAbsolute(options.dir) ? options.dir : path.join(root, options.dir))
    : path.join(root, DEFAULT_DIR);

  const fileFor = id => {
    const clean = safeId(id);
    if (!clean || clean !== id) throw new Error('invalid group id');
    return path.join(taskDir, `${clean}.json`);
  };

  const lockFile = path.join(path.dirname(taskDir), '.write.lock');

  const attachmentsDir = path.join(taskDir, ATTACHMENTS_DIRNAME);
  const archiveDir = path.join(taskDir, ARCHIVE_DIRNAME);
  // 执行状态文件与 tasks/ 同级（默认 <workspace>/.zwa/execution.json）：
  // 存放项目级执行模式与轮次归档日志，是模式的唯一事实源。
  const executionFile = path.join(path.dirname(taskDir), 'execution.json');
  const tasksDirectory = taskDir;

  // 任务数据变更回调：宿主用它驱动 SSE 实时推送（见 createTaskChangeHub）。
  // 回调抛错绝不影响写盘本身的数据一致性。
  const notifyChange = () => {
    try {
      options.onChange?.();
    } catch {
      /* 通知失败不影响数据 */
    }
  };

  /**
   * 跨 store / 跨进程锁：每个 workspace 共用一个 O_EXCL 锁文件。
   * 同进程的 queueWrite 负责顺序，锁负责两个 createStore/进程之间互斥。
   * 锁只包住读—改—写临界区；异常/进程崩溃留下的锁在超时后才回收，
   * 避免一个短暂的残留文件永久阻塞任务系统。
   */
  const acquireFileLock = async () => {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const started = Date.now();
    const staleMs = 30_000;
    while (true) {
      try {
        const handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }));
        return async () => {
          await handle.close().catch(() => {});
          await fs.rm(lockFile, { force: true }).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const stat = await fs.stat(lockFile);
          stale = Date.now() - stat.mtimeMs > staleMs;
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
        }
        if (stale) {
          await fs.rm(lockFile, { force: true });
          continue;
        }
        if (Date.now() - started > 15_000) throw new Error('timed out waiting for workspace write lock');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  };

  /**
   * 写操作串行队列。
   *
   * 先前的 promise 队列只覆盖单个 createStore 实例；这里再加 workspace 级
   * O_EXCL 锁，避免两个 dev server/进程各自读旧快照后互相覆盖。
   */
  let writeChain = Promise.resolve();
  const queueWrite = fn => {
    const result = writeChain.then(async () => {
      const release = await acquireFileLock();
      try {
        return await fn();
      } finally {
        await release();
      }
    }, async () => {
      const release = await acquireFileLock();
      try {
        return await fn();
      } finally {
        await release();
      }
    });
    writeChain = result.then(() => undefined, () => undefined);
    return result;
  };

  /**
   * 把任务里的 data URL 图片落盘为真实文件，并替换成相对路径。
   * 这样 JSON 保持轻量、可读，图片也能被模型直接读取。
   */
  const persistAttachments = async (group, tasks) => {
    let written = 0;
    for (const task of tasks) {
      const images = Array.isArray(task.images) ? task.images : [];
      for (const image of images) {
        const parsed = parseDataUrl(image.dataUrl);
        if (!parsed) {
          delete image.dataUrl;
          continue;
        }
        if (parsed.buffer.length > MAX_IMAGE_BYTES) {
          throw new Error(`image too large: ${task.id}`);
        }
        await fs.mkdir(attachmentsDir, { recursive: true });
        const name = `${safeId(task.id)}-${safeId(image.id || crypto.randomUUID().slice(0, 8))}.${parsed.ext}`;
        const dest = path.join(attachmentsDir, name);
        const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tmp, parsed.buffer, { mode: 0o600 });
        await fs.rename(tmp, dest);
        // 相对路径必须由实际落盘目录推导：任务目录可配置（安装器写入 tasks/），
        // 硬编码 DEFAULT_DIR 会得到一个指向不存在位置的文件引用。
        image.file = path.relative(root, dest).split(path.sep).join('/');
        image.bytes = parsed.buffer.length;
        delete image.dataUrl;
        written++;
      }
    }
    return written;
  };

  const readGroup = async id => validateGroup(JSON.parse(await fs.readFile(fileFor(id), 'utf8')));

  const readGroupOrMissing = async id => {
    try {
      return await readGroup(id);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error(`corrupt annotation group: ${id}`);
    }
  };

  /** 按页面 URL 解析任务组 id，删除接口用它从不信任的页面侧值安全定位。 */
  const groupIdForPage = url => pageKey(url);

  /** 原子写 JSON：先写临时文件再 rename，进程中断不会留下半个文件。 */
  const writeJsonAtomic = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  };

  const writeGroup = async group => {
    validateGroup(group);
    await writeJsonAtomic(fileFor(group.id), JSON.stringify(group, null, 2));
    return group;
  };

  const listGroupsWithDiagnostics = async () => {
    await fs.mkdir(taskDir, { recursive: true });
    const names = (await fs.readdir(taskDir)).filter(n => n.endsWith('.json'));
    const groups = [];
    const diagnostics = [];
    for (const name of names) {
      try {
        groups.push(validateGroup(JSON.parse(await fs.readFile(path.join(taskDir, name), 'utf8'))));
      } catch (error) {
        diagnostics.push({
          kind: 'corrupt-group',
          file: path.join(taskDir, name),
          message: error?.message || 'invalid JSON',
        });
      }
    }
    groups.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { groups, diagnostics };
  };

  const listGroups = async () => (await listGroupsWithDiagnostics()).groups;

  const diagnostics = async () => {
    const result = await listGroupsWithDiagnostics();
    try {
      const names = (await fs.readdir(archiveDir)).filter(n => n.endsWith('.json'));
      for (const name of names) {
        try {
          validateGroup(JSON.parse(await fs.readFile(path.join(archiveDir, name), 'utf8')));
        } catch (error) {
          result.diagnostics.push({ kind: 'corrupt-archive', file: path.join(archiveDir, name), message: error?.message || 'invalid JSON' });
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') result.diagnostics.push({ kind: 'archive-read-error', file: archiveDir, message: error.message });
    }
    try {
      JSON.parse(await fs.readFile(executionFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') result.diagnostics.push({ kind: 'corrupt-execution', file: executionFile, message: error?.message || 'invalid JSON' });
    }
    return result.diagnostics;
  };

  const archiveFileFor = id => path.join(archiveDir, `${safeId(id)}.json`);

  /* ---------------- 执行模式（execution.json） ---------------- */

  const normalizeExecution = raw => {
    const execution = {
      version: '1.0',
      // 非法值一律回落 round 而不是报错：模式文件损坏不应让任务系统瘫痪
      mode: EXECUTION_MODE_SET.has(raw?.mode) ? raw.mode : 'round',
      activeRound: Number.isInteger(raw?.activeRound) && raw.activeRound > 0 ? raw.activeRound : null,
      runner: raw?.runner && typeof raw.runner === 'object' ? { ...raw.runner } : { status: 'idle' },
      totals: raw?.totals && typeof raw.totals === 'object' ? { ...raw.totals } : { queued: 0, completed: 0 },
      updatedAt: raw?.updatedAt || null,
      rounds: Array.isArray(raw?.rounds)
        ? raw.rounds.filter(r => r && Number.isFinite(r.round))
        : [],
    };
    // 非枚举元数据用于区分旧 execution 文件（没有 activeRound）与明确写入的
    // activeRound:null。否则 completeRound 后重新从旧任务 round 推导，会让已交付轮次
    // 重新出现在当前进度里。
    Object.defineProperty(execution, '_activeRoundExplicit', {
      value: !!raw && Object.prototype.hasOwnProperty.call(raw, 'activeRound'),
      enumerable: false,
    });
    return execution;
  };

  const readExecution = async () => {
    try {
      return normalizeExecution(JSON.parse(await fs.readFile(executionFile, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeExecution(null);
      throw new Error('corrupt execution state');
    }
  };

  const refreshExecutionTotals = async execution => {
    const groups = await listGroups();
    const all = groups.flatMap(g => g.tasks || []);
    const active = all.filter(t => t.status !== 'cancelled');
    execution.totals = {
      queued: all.filter(t => t.round == null && (t.status === 'todo' || t.status === 'doing')).length,
      completed: all.filter(t => t.status === 'done').length,
      total: active.length,
    };
    return execution;
  };

  const saveExecution = async execution => {
    execution.updatedAt = nowIso();
    await writeJsonAtomic(executionFile, JSON.stringify(execution, null, 2));
    notifyChange();
    return execution;
  };

  const completeRound = async round => {
    const summary = await roundSummary();
    if (!round || summary.activeRound !== round) throw new Error('active round mismatch');
    if (!summary.complete) {
      return { action: 'blocked', round, summary, obstacles: summary.obstacles };
    }
    const mode = (await readExecution()).mode;
    // 交付前先应用暂存新要求（pendingInstruction）：带它的任务重开为无轮次
    // todo（指令换成新值、清验收痕迹），不进入本轮归档，自然排队下一批——
    // 「冻结集合在处理期间不可变，追加一律进下一批」由此严格成立。
    // 必须在归档前做：重开成 todo 后任务不再是终态，不会被按轮归档误收。
    const groups = await listGroups();
    let appliedPendings = 0;
    for (const group of groups) {
      let changed = false;
      for (const task of group.tasks) {
        if (!task.pendingInstruction) continue;
        task.instruction = task.pendingInstruction;
        delete task.pendingInstruction;
        task.status = 'todo';
        task.result = null;
        task.reviewAt = null;
        task.completedAt = null;
        task.round = null;
        task.history.push({ at: nowIso(), event: 'pending_applied', detail: task.instruction, reason: 'applied at round delivery' });
        changed = true;
        appliedPendings++;
      }
      if (changed) await writeGroup(group);
    }
    const archived = [];
    for (const group of groups) {
      const hits = group.tasks.filter(t => t.round === round && TERMINAL_STATUS_SET.has(t.status));
      if (!hits.length) continue;
      const result = await archiveTasks(group.id, { statuses: [...TERMINAL_STATUSES], round });
      archived.push({ groupId: group.id, archived: result.archived });
    }
    const after = await roundSummary();
    const execution = await readExecution();
    execution.activeRound = null;
    execution.runner = { status: mode === 'queue' && after.queued ? 'ready' : 'idle', updatedAt: nowIso() };
    await saveExecution(execution);
    return { action: mode === 'queue' && after.queued ? 'continue' : 'stop', round, archived, appliedPendings, summary: after };
  };
  const setMode = async mode => {
    if (!EXECUTION_MODE_SET.has(mode)) throw new Error(`invalid mode: ${mode}`);
    const execution = await readExecution();
    // 本轮在途期间模式锁定：模式决定「本轮怎么收尾」，处理开始后再切换会让
    // 收尾预期漂移。面板按钮已禁用，这里是接口层兜底；交付（completeRound
    // 置空 activeRound）后自动恢复可切换。
    if (execution.activeRound != null) {
      throw new Error(`round ${execution.activeRound} in progress; mode is locked until delivery`);
    }
    if (execution.mode !== mode) {
      execution.mode = mode;
      await saveExecution(execution);
    }
    return execution;
  };

  /**
   * 轮次归档日志：把本次归档命中的轮次记录进 execution.json 的 rounds。
   * 纯记录性质（供面板显示历史轮次），不影响任何决策——决策读取的是任务
   * 文件里的实时状态。同一轮多次归档（跨页面组）按轮次幂等合并。
   */
  const recordArchivedRounds = async (execution, hits) => {
    const byRoundTasks = new Map();
    for (const task of hits) {
      if (Number.isFinite(task.round)) {
        const list = byRoundTasks.get(task.round) || [];
        list.push(task);
        byRoundTasks.set(task.round, list);
      }
    }
    if (!byRoundTasks.size) return false;
    const byRound = new Map(execution.rounds.map(r => [r.round, { ...r }]));
    const at = nowIso();
    for (const [round, tasks] of byRoundTasks) {
      const entry = byRound.get(round) || { round, archived: 0, completed: 0 };
      const known = new Set(entry.taskIds || []);
      const newlyArchived = tasks.filter(task => !known.has(task.id));
      entry.archived = (entry.archived || 0) + newlyArchived.length;
      entry.completed = (entry.completed || 0) + newlyArchived.length;
      entry.taskIds = [...new Set([...(entry.taskIds || []), ...tasks.map(task => task.id)])];
      entry.archivedAt = at;
      byRound.set(round, entry);
    }
    execution.rounds = [...byRound.values()].sort((a, b) => a.round - b.round);
    execution.updatedAt = at;
    await writeJsonAtomic(executionFile, JSON.stringify(execution, null, 2));
    return true;
  };

  /**
   * 当前轮次摘要——轮次边界决策（停/续）的数据来源。
   *
   * 当前轮 = 活动任务中最大的轮次号。已交付却未归档的旧轮次任务（round 更小）
   * 不计入：它们不属于任何在途工作，混进分母会让进度倒退。
   * complete = 当前轮全部任务 done/cancelled：按队列模式此时应归档并续轮；
   * 只要还有 blocked/todo/doing/review，队列就不能越过它自动继续。
   */
  const roundSummary = async () => {
    const groups = await listGroups();
    const all = groups.flatMap(g => (Array.isArray(g.tasks) ? g.tasks : []));
    const inferredRound = all.reduce((m, t) => Math.max(m, Number.isFinite(t.round) ? t.round : 0), 0) || null;
    const execution = await readExecution();
    let activeRound = execution._activeRoundExplicit ? execution.activeRound : (execution.activeRound || inferredRound);
    let scoped = activeRound ? all.filter(t => t.round === activeRound) : [];
    // 自愈：交付不只发生在 complete-round——任务也可能经直接归档（POST /archive）
    // 或删除路径全部离开本轮。activeRound 残留而本轮已无任何活跃任务时，模式锁
    // 会永不释放（实测第 8 轮直接归档后锁死），这里把「轮次已结束」写回 execution。
    if (activeRound != null && scoped.length === 0) {
      execution.activeRound = null;
      execution.updatedAt = nowIso();
      await saveExecution(execution);
      activeRound = null;
    }
    const counts = {};
    for (const t of scoped) counts[t.status] = (counts[t.status] || 0) + 1;
    const outstanding = (counts.todo || 0) + (counts.doing || 0) + (counts.review || 0) + (counts.blocked || 0);
    const obstacles = scoped
      .filter(t => !TERMINAL_STATUS_SET.has(t.status))
      .map(t => ({ id: t.id, status: t.status }));
    await refreshExecutionTotals(execution);
    return {
      mode: execution.mode,
      activeRound,
      runner: execution.runner,
      totals: execution.totals,
      currentRound: activeRound,
      total: scoped.length,
      counts,
      obstacles,
      complete: activeRound != null && scoped.length > 0 && outstanding === 0,
      queued: all.filter(t => t.round == null && (t.status === 'todo' || t.status === 'doing')).length,
    };
  };

  /**
   * 轮次交付释放：activeRound 冻结于首个 doing，但交付不只发生在
   * complete-round——任务也可能经直接归档（POST /archive）或删除路径
   * 全部离开本轮。本轮已无任何活跃任务时清掉 activeRound，否则面板的
   * 模式锁会永久卡住（实测第 8 轮直接归档后锁死）。
   */
  const releaseRoundIfDelivered = async () => {
    const execution = await readExecution();
    if (execution.activeRound == null) return false;
    const groups = await listGroups();
    const inFlight = groups.some(g => (Array.isArray(g.tasks) ? g.tasks : []).some(t => t.round === execution.activeRound));
    if (inFlight) return false;
    execution.activeRound = null;
    execution.updatedAt = nowIso();
    await saveExecution(execution);
    return true;
  };


  /**
   * 历史最大轮次号：活动组 + 归档一起扫。
   * 归档也要计入——归档会删除组文件，若计数器只看活动组，
   * 交付完成后轮次号会回退（实测第二轮又从 1 开始）。
   */
  const maxRoundEver = async () => {
    let max = 0;
    const consider = t => { if (Number.isFinite(t?.round)) max = Math.max(max, t.round); };
    for (const g of await listGroups()) {
      for (const t of g.tasks) consider(t);
      consider({ round: g.meta?.round });
    }
    try {
      const names = (await fs.readdir(archiveDir)).filter(n => n.endsWith('.json'));
      for (const name of names) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(archiveDir, name), 'utf8'));
          for (const t of raw.tasks || []) consider(t);
          consider({ round: raw.meta?.round });
        } catch {
          // 单个损坏的归档文件不计入，但不能中断整体
        }
      }
    } catch {
      // 归档目录不存在时没有可扫描的归档
    }
    return max;
  };

  /**
   * 轮次（round）的定稿与并入。
   *
   * 轮次的定稿时刻是「模型开始处理任务」——本系统里可观察的信号是第一次
   * 状态写入 doing（模型直接读取任务文件，服务端感知不到那次读取）。
   * 定稿时，任务文件里当时的全部待处理任务就是确定派发的集合，一并纳入
   * 本轮；**在此之后新增的批注不带轮次号，自动排队下一轮**。
   *
   * 已有进行中的轮次时（存在 doing/review 的已派发任务），个别任务开始推进
   * 则并入当前轮次——它确实正在被处理，进度应当如实反映。
   *
   * ⚠️ 调用约定：本函数只写 **currentGroup 之外的组**。currentGroup 的任务
   * 由调用方（updateTask 等）在自己那份「读—改—写」里一并打标并写回——
   * 若这里也写 currentGroup，调用方稍后用自己的旧快照整份写回，会把本次
   * 定稿覆盖掉（实测 round 字段因此丢失）。
   *
   * 返回 { round, froze }：froze=true 表示本次是「定稿」（开启了新一轮），
   * 调用方需把当前组内其余待处理任务一并打上同一轮次号。
   */
  const resolveRound = async (exceptGroupId, pendingTasks) => {
    const groups = await listGroups();
    let inFlight = false;
    for (const g of groups) {
      for (const t of g.tasks) {
        if ((t.status === 'doing' || t.status === 'review') && Number.isFinite(t.round)) inFlight = true;
      }
      if (g.id === exceptGroupId) {
        for (const t of pendingTasks || []) {
          if ((t.status === 'doing' || t.status === 'review') && Number.isFinite(t.round)) inFlight = true;
        }
      }
    }
    // 轮次号必须连归档一起扫：归档会删除组文件，若只看活动组，
    // 交付完成后计数器回退（实测第二轮又从 1 开始）
    const max = await maxRoundEver();
    // 有在途任务：并入当前轮次（它正在被处理，进度应如实计入）
    if (inFlight) return { round: max, froze: false };
    // 任一已定稿轮次仍 blocked 时，不能偷偷越过它开启新轮。
    // 必须由用户/主线程显式取消、解决或延期后，才允许下一轮。
    const blocked = groups.flatMap(g => g.tasks).find(t => t.status === 'blocked' && Number.isFinite(t.round));
    if (blocked) throw new Error(`blocked task prevents next round: ${blocked.id}`);
    // 定稿：开启新一轮，把**其它组**里尚未分派的待处理任务一并纳入
    const round = max + 1;
    for (const g of groups) {
      if (g.id === exceptGroupId) continue;
      let changed = false;
      for (const t of g.tasks) {
        if (t.round == null && (t.status === 'todo' || t.status === 'doing')) {
          t.round = round;
          t.history.push({ at: nowIso(), event: 'round_assigned', detail: `第 ${round} 轮` });
          changed = true;
        }
      }
      if (changed) {
        g.meta = { ...(g.meta || {}), round };
        g.updatedAt = nowIso();
        await writeGroup(g);
      }
    }
    return { round, froze: true };
  };

  /** 读取某任务组的归档索引（task id → 已归档任务）。目录不存在或文件损坏时视为空。 */
  const readArchiveTasks = async groupId => {
    const byId = new Map();
    try {
      const raw = JSON.parse(await fs.readFile(archiveFileFor(groupId), 'utf8'));
      for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
        if (t?.id) byId.set(t.id, t);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return byId;
      // 归档损坏不能按「没有归档」处理：否则 append 会复活旧任务，
      // archive 会覆盖历史，prune 还可能删除归档引用的附件。
      throw new Error(`corrupt annotation archive: ${groupId}`);
    }
    return byId;
  };

  /**
   * 看板用户偏好（主题等）：落在项目 .zwa/runtime/board-prefs.json，
   * 跨浏览器/设备记忆——「用户改了要保存到项目里」。只接受白名单键，
   * 单个未知字段不落盘；文件损坏按空偏好处理（下次保存即自愈）。
   */
  const BOARD_PREFS_FILE = path.join(root, '.zwa', 'runtime', 'board-prefs.json');
  const BOARD_THEMES = ['dark', 'light'];

  const readBoardPrefs = async () => {
    try {
      const raw = JSON.parse(await fs.readFile(BOARD_PREFS_FILE, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 损坏的偏好文件不值得让看板挂掉：按空偏好处理，写入时覆盖修复
      }
      return {};
    }
  };

  const writeBoardPrefs = async patch => {
    const current = await readBoardPrefs();
    const accepted = {};
    if (patch && BOARD_THEMES.includes(patch.theme)) accepted.theme = patch.theme;
    if (!Object.keys(accepted).length) throw new Error(`no valid preference keys (theme: ${BOARD_THEMES.join('|')})`);
    const next = { ...current, ...accepted, updatedAt: nowIso() };
    await writeJsonAtomic(BOARD_PREFS_FILE, JSON.stringify(next, null, 2));
    return next;
  };

  /**
   * 归档总览（只读）：读出 archive/ 下全部页面组的精简视图，供看板展示
   * 历史归档任务。归档文件与任务组同 schema，但任务里带截图引用、历史
   * 记录等看板用不到的大字段，这里只挑渲染需要的字段；单个损坏文件进
   * diagnostics，不拖垮整个总览（与 listGroupsWithDiagnostics 同一策略）。
   */
  const listArchives = async () => {
    const archives = [];
    const diagnostics = [];
    let names = [];
    try {
      names = (await fs.readdir(archiveDir)).filter(n => n.endsWith('.json'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        diagnostics.push({ kind: 'archive-read-error', file: archiveDir, message: error.message });
      }
      return { archives, diagnostics };
    }
    for (const name of names) {
      const file = path.join(archiveDir, name);
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map(t => ({
          id: t.id,
          seq: t.seq,
          status: t.status,
          round: t.round == null ? null : t.round,
          instruction: t.instruction || '',
          completedAt: t.completedAt || null,
          updatedAt: t.updatedAt || null,
          element: t.element ? {
            selector: t.element.selector || '',
            tagName: t.element.tagName || '',
            accessibleName: t.element.accessibleName || '',
            text: typeof t.element.text === 'string' ? t.element.text.slice(0, 300) : '',
          } : null,
        }));
        archives.push({
          id: raw.id || name.replace(/\.json$/, ''),
          file,
          page: raw.page ? { url: raw.page.url || '', title: raw.page.title || '' } : null,
          updatedAt: raw.updatedAt || null,
          taskCount: tasks.length,
          counts: tasks.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {}),
          tasks,
        });
      } catch (error) {
        diagnostics.push({ kind: 'corrupt-archive', file, message: error?.message || 'invalid JSON' });
      }
    }
    // 最近有归档动作的页面组排前面，稳定的次序键兜底
    archives.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id));
    return { archives, diagnostics };
  };

  /**
   * 按页面归并任务。先按任务 ID 匹配，再按元素选择器兜底，
   * 使组件重新加载或重复保存时是幂等更新而不是新增。
   */
  const appendTasks = async input => {
    const url = input?.page?.url;
    if (!url) throw new Error('page.url is required');
    const incomingTasks = Array.isArray(input.tasks) ? input.tasks.filter(t => t?.id) : [];
    if (!incomingTasks.length) throw new Error('no tasks to append');
    for (const incoming of incomingTasks) {
      validateTaskId(incoming.id);
      if (typeof incoming.instruction === 'string' && incoming.instruction.length > MAX_INSTRUCTION_LENGTH) {
        throw new Error(`instruction too long: ${incoming.id}`);
      }
      if (Array.isArray(incoming.images) && incoming.images.length > MAX_IMAGES_PER_TASK) {
        throw new Error(`too many images: ${incoming.id}`);
      }
    }

    const id = pageKey(url);
    let group;
    try {
      group = await readGroup(id);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`corrupt annotation group: ${id}`);
      const at = nowIso();
      group = {
        version: '1.0',
        id,
        createdAt: at,
        updatedAt: at,
        page: { url, title: input.page.title || url, capturedAt: at },
        tasks: [],
      };
    }

    // 防复活：浏览器 localStorage 里的旧缓冲会被全量重新同步，组文件已
    // 删/已不含该任务时会走新建分支，把已归档任务重新建成 todo，归档
    // 必须拦住它。但元素的 task id 由 stableTaskId(url, selector) 确定性
    // 生成，用户重新标注同一元素得到的是同一个 id（客户端表现为编辑
    // 旧任务），不能按 id 一刀切跳过。
    //
    // 判据是「严格早于归档副本才算过期缓冲」，注意是严格早于而不是不晚于：
    // 归档副本的 updatedAt 来自服务端同步时刻，而浏览器的编辑时刻总不晚于
    // 它，所以真正的过期缓冲一定是严格早于（照旧被拦住）；而两者落在同一
    // 毫秒时无法区分新旧，此时必须倒向「保留用户的改动」——把一次真实的
    // 重新标注静默丢掉是无声的数据丢失，而误复活一个已归档任务是可见的、
    // 再归档一次即可。存档不能以丢失用户输入为代价。
    const archivedById = await readArchiveTasks(id);
    const isStaleBuffer = (incoming, archived) =>
      (Date.parse(incoming.updatedAt || incoming.createdAt) || 0)
        < (Date.parse(archived.updatedAt || archived.createdAt) || 0);
    const freshTasks = incomingTasks.filter(t => {
      const archived = archivedById.get(t.id);
      return !archived || !isStaleBuffer(t, archived);
    });
    if (!freshTasks.length && !group.tasks.length) {
      // 传入任务全部已归档且组内无任务：没有可落盘的内容。
      // 不写出一个 0 任务的组文件，也不重建刚被归档删除的组。
      // skipped 必须显式标出：调用方据此得知「没有任何文件被写出」，
      // 否则会把下面这个并不存在的 path 当成可打开的地址发给模型。
      return { group, file: `${id}.json`, path: fileFor(id), added: 0, updated: 0, attachments: 0, skipped: true };
    }

    const at = nowIso();
    const byId = new Map(group.tasks.map(t => [t.id, t]));
    const bySelector = new Map(group.tasks.filter(t => t.element?.selector).map(t => [t.element.selector, t]));
    let added = 0;
    let updated = 0;

    // 编号在任务组内必须唯一。浏览器本地状态被清空后重新标注时，
    // 新任务的 seq 可能与已保存任务冲突，这里按现有最大值重新分配。
    let maxSeq = group.tasks.reduce((max, t) => Math.max(max, Number(t.seq) || 0), 0);
    const usedSeq = new Set(group.tasks.map(t => Number(t.seq) || 0));

    for (const incoming of freshTasks) {
      const existing = byId.get(incoming.id) || (incoming.element?.selector ? bySelector.get(incoming.element.selector) : null);
      if (existing) {
        if (incoming.element) existing.element = incoming.element;
        // 指令变更的两条路径：
        // - todo（含未领取的本批任务）：处理者还没开始，原位更新、留在本批；
        // - 非 todo（doing/review/done/blocked）：批次已冻结、当前指令对应着
        //   在途工作或已验收的结论，直接改会作废它（doing）或把任务拉回
        //   当前批（review/done）——都违背「冻结集合在处理期间不可变」。
        //   新指令存为 pendingInstruction 暂存：当前状态/结果/分母一律不动，
        //   批次交付（completeRound）时统一重开为无轮次 todo，被下一批纳入。
        //   重复追加取最新值；客户端全量同步经 incoming.pendingInstruction
        //   或变化后的 instruction 都能触达同一条暂存路径。
        const incomingText = (typeof incoming.pendingInstruction === 'string' && incoming.pendingInstruction.trim())
          ? incoming.pendingInstruction
          : (typeof incoming.instruction === 'string' ? incoming.instruction : '');
        if (incomingText.trim() && incomingText !== existing.instruction && incomingText !== existing.pendingInstruction) {
          if (existing.status === 'todo') {
            existing.history.push({ at, event: 'instruction_updated', detail: incomingText });
            existing.instruction = incomingText;
            if (existing.pendingInstruction) delete existing.pendingInstruction;
          } else {
            existing.pendingInstruction = incomingText;
            existing.history.push({ at, event: 'pending_instruction_updated', detail: incomingText });
          }
        }
        // 职责划分：任务「内容」（element/instruction）由浏览器拥有，
        // 「状态与结果」由模型/工作台经 updateTask 拥有。浏览器的全量
        // 同步从不上报有意义的状态变化（创建时写死 todo），这里若采纳
        // 传入 status，模型刚回写的 done 会在用户下一次标注时被冲回
        // todo，因此 appendTasks 对已存在任务故意忽略入参里的 status
        // 与 result。新建分支的兜底状态不受此约束。
        existing.updatedAt = at;
        byId.set(existing.id, existing);
        if (existing.element?.selector) bySelector.set(existing.element.selector, existing);
        updated++;
      } else {
        const created = {
          result: null,
          ...incoming,
          instruction: typeof incoming.instruction === 'string' ? incoming.instruction : '',
          // 新任务只能从 todo 进入状态机；浏览器旧缓存或伪造请求携带的
          // doing/done/cancelled 都不能跳过领取、待验收和验收阶段。
          status: 'todo',
          createdAt: incoming.createdAt || at,
          updatedAt: at,
          startedAt: incoming.startedAt || null,
          completedAt: incoming.completedAt || null,
          history: Array.isArray(incoming.history) && incoming.history.length ? incoming.history : [{ at, event: 'created' }],
        };
        // 冲突或缺失编号时，按现有最大值往后分配，保证组内唯一且只增不减
        const incomingSeq = Number(created.seq) || 0;
        if (!incomingSeq || usedSeq.has(incomingSeq)) {
          maxSeq += 1;
          created.seq = maxSeq;
        } else {
          maxSeq = Math.max(maxSeq, incomingSeq);
        }
        usedSeq.add(created.seq);
        group.tasks.push(created);
        byId.set(created.id, created);
        if (created.element?.selector) bySelector.set(created.element.selector, created);
        added++;
      }
    }

    group.page = { url, title: input.page.title || group.page.title, capturedAt: group.page.capturedAt || at };
    group.updatedAt = at;
    if (input.meta && typeof input.meta === 'object') group.meta = { ...(group.meta || {}), ...input.meta };

    // 图片以真实文件落盘，JSON 中只保留相对路径。
    // 只处理 freshTasks：被防复活拦下的任务若也落附件，
    // 会产生没有任何任务引用的孤儿文件。
    const attachments = await persistAttachments(group, freshTasks);

    await writeGroup(group);
    notifyChange();
    return { group, file: `${id}.json`, path: fileFor(id), added, updated, attachments };
  };

  /** 更新单个任务状态或结果，供工作台与 MCP 共用。 */
  const updateTask = async (groupId, patch = {}) => {
    const group = await readGroup(groupId);
    const task = group.tasks.find(t => t.id === patch.taskId);
    if (!task) throw new Error('task not found');
    if (patch.status && !STATUS_SET.has(patch.status)) throw new Error('invalid status');
    // task-agent 只能把源码处理结果交给主线程验收。这个 actor 由适配器
    // 从 x-zwa-client header 注入；不对没有显式声明的兼容调用收紧权限。
    if (patch.actor === 'task-agent' && patch.status === 'done' && task.status !== 'done') {
      throw new Error('task-agent cannot mark done; main thread review is required');
    }
    const at = nowIso();
    if (patch.status && patch.status !== task.status) {
      const allowed = STATUS_TRANSITIONS[task.status] || new Set();
      if (!allowed.has(patch.status) && !(patch.reopen === true && patch.status === 'todo' && ['done', 'blocked', 'cancelled'].includes(task.status))) {
        throw new Error(`invalid status transition: ${task.status} -> ${patch.status}`);
      }
      task.status = patch.status;
      task.history.push({ at, event: 'status_changed', detail: patch.status });
      if (patch.status === 'todo' && patch.reopen === true) {
        task.result = null;
        task.reviewAt = null;
        task.completedAt = null;
        task.history.push({ at, event: 'reopened', detail: 'explicit reopen' });
      }
      if (patch.status === 'doing') task.startedAt = task.startedAt || at;
      // review = 开发完成、等待验收。提交时刻单独记，验收耗时才有据可查。
      if (patch.status === 'review') task.reviewAt = at;
      if (patch.status === 'done') task.completedAt = at;
      // 没有轮次号的任务一旦开始推进（模型派发时读取的就是当时文件里的
      // 任务集合），自动定稿/并入轮次，保证进度条能跟踪到它。
      if (!task.round && (patch.status === 'doing' || patch.status === 'review')) {
        // 顺序：先解析轮次号（可能写其它组的文件），再把本组内的待处理任务
        // 一并打标——它们随后随本函数的 writeGroup 一次性落盘。
        const { round, froze } = await resolveRound(groupId, group.tasks);
        task.round = round;
        task.history.push({ at, event: 'round_assigned', detail: `第 ${round} 轮` });
        if (froze) {
          // 定稿：本组内其余无轮次的待处理任务一并纳入（同一份写回，
          // 避免被本函数稍后的整份写回覆盖）。并入轮次时其余任务不动。
          for (const t of group.tasks) {
            if (t !== task && t.round == null && (t.status === 'todo' || t.status === 'doing')) {
              t.round = round;
              t.history.push({ at, event: 'round_assigned', detail: `第 ${round} 轮` });
            }
          }
          group.meta = { ...(group.meta || {}), round };
        }
      }
    }
    if (typeof patch.result === 'string' && patch.result !== task.result) {
      task.result = patch.result;
      task.history.push({ at, event: 'result_updated', detail: task.result });
    }
    task.updatedAt = at;
    group.updatedAt = at;
    await writeGroup(group);
    // 声明 activeRound 必须在任务落盘之后：先声明后写盘的窗口里，并发
    // roundSummary 会看到「activeRound 有值但本轮无活跃任务」而误自愈清空。
    const execution = await readExecution();
    if (execution.activeRound !== task.round && task.round != null) {
      execution.activeRound = task.round;
      execution.runner = { status: 'running', updatedAt: at };
      await saveExecution(execution);
    }
    notifyChange();
    return { group, task };
  };

  /**
   * 人工验收：把 `review`（待验收）任务批量置为 `done`，推进进度条最后一段。
   *
   * 这是协议「done 只能由主线程浏览器验收后回写」的执行入口。此前子 agent 能
   * 经 PATCH 写 review，而 review→done 除裸 PATCH 外没有任何面向人的入口，
   * 主线程只好让用户「去浏览器点验收」——面板上看不到那个按钮，于是每次都
   * 卡在同一个地方。验收必须是显式的人工动作，所以由这个接口承担，
   * 而不是让任何自动化路径顺手把任务标成已完成。
   *
   * 只动 `review`：todo 还没开工、doing 正在改、blocked 没做成，都不能被
   * 「验收」吞掉；它们连同伴随的 task-agent 身份一起如实回报，不伪装成通过。
   */
  const acceptTasks = async (options = {}) => {
    // 身份由适配器从请求头注入。这个动作等价于「人看过页面了」，因此
    // 只认主线程/人工路径：子 agent 自查自己写的代码不算验收。
    if (options.actor === 'task-agent') {
      throw new Error('task-agent cannot accept tasks; main thread verification is required');
    }
    const round = Number.isInteger(options.round) && options.round > 0 ? options.round : null;
    const wanted = Array.isArray(options.ids) && options.ids.length
      ? new Set(options.ids.map(String))
      : null;
    const groups = await listGroups();
    const at = nowIso();
    const accepted = [];
    const pending = [];
    for (const group of groups) {
      let changed = false;
      for (const task of group.tasks) {
        // 传入 round 时只验收该轮；不传则是对全部待验收任务的一次性确认。
        if (round != null && task.round !== round) continue;
        if (wanted && !wanted.has(task.id)) continue;
        if (task.status === 'review') {
          task.status = 'done';
          task.completedAt = at;
          task.history.push({ at, event: 'accepted', detail: '主线程验收通过' });
          task.updatedAt = at;
          accepted.push({ groupId: group.id, id: task.id, round: task.round ?? null });
          changed = true;
        } else if (!TERMINAL_STATUS_SET.has(task.status)) {
          pending.push({ id: task.id, status: task.status });
        }
      }
      if (changed) {
        group.updatedAt = at;
        await writeGroup(group);
      }
    }
    if (accepted.length) {
      notifyChange();
      await releaseRoundIfDelivered();
    }
    return {
      round,
      accepted: accepted.length,
      tasks: accepted,
      // 未通过验收的任务照实列出：验收动作绝不顺带把它们也标成完成。
      pending,
      summary: await roundSummary(),
    };
  };

  /**
   * 清理无主附件，避免工作区堆积垃圾文件。
   * 保活集合必须来自磁盘上全部任务组与归档文件，而不是调用方涉及的那
   * 一组：attachments/ 是所有页面共用的目录，只看单组会把别的页面仍在
   * 引用的附件当成垃圾删掉。调用方必须先完成组文件写入/删除再调用，
   * 这样磁盘现状（含被清空的组）自然就是正确的保活依据。
   */
  const pruneAttachments = async () => {
    const keep = new Set();
    let readable = true;
    const collect = group => {
      for (const task of group.tasks || []) {
        for (const image of task.images || []) {
          if (image.file) keep.add(path.basename(image.file));
        }
      }
    };
    try {
      const names = (await fs.readdir(taskDir)).filter(n => n.endsWith('.json'));
      for (const name of names) {
        try {
          collect(validateGroup(JSON.parse(await fs.readFile(path.join(taskDir, name), 'utf8'))));
        } catch {
          readable = false;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') readable = false;
    }
    // 归档任务仍保留图片引用；任何活动组或归档组读不全时都不能根据
    // 不完整 keep 集合删除附件，宁可暂时留下孤儿文件也不能删用户图片。
    try {
      const names = (await fs.readdir(archiveDir)).filter(n => n.endsWith('.json'));
      for (const name of names) {
        try {
          collect(validateGroup(JSON.parse(await fs.readFile(path.join(archiveDir, name), 'utf8'))));
        } catch {
          readable = false;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') readable = false;
    }
    if (!readable) return 0;
    let removed = 0;
    try {
      const names = await fs.readdir(attachmentsDir);
      for (const name of names) {
        if (!keep.has(name)) {
          await fs.rm(path.join(attachmentsDir, name), { force: true });
          removed++;
        }
      }
    } catch {
      // 附件目录不存在时无需清理
    }
    return removed;
  };

  /**
   * 从任务组中删除任务。按 id 或元素选择器匹配，
   * 删除后自动清理不再被引用的附件，并在任务清空时移除整个 JSON 文件。
   * groupId 可由页面 URL 解析，避免客户端伪造任意路径。
   *
   * 默认**跳过 doing 的任务**：这类任务已被某个处理者领取、正在改代码，
   * 删掉它会让回写的 done 与结果失去对应关系，用户也看不到「刚才在改什么」。
   * 要删需显式传 `force: true`（供确实需要清理的场景，例如归档后回收）。
   * 被跳过的 id 会一并返回，让调用方能如实告知用户而不是静默不做。
   */
  const removeTasks = async (groupIdOrUrl, selectors = {}) => {
    const groupId = selectors.byPageUrl ? groupIdForPage(groupIdOrUrl) : groupIdOrUrl;
    const ids = new Set((selectors.ids || []).filter(Boolean));
    const selectorList = new Set((selectors.selectors || []).filter(Boolean));
    const deleteAll = !!selectors.all;
    const force = !!selectors.force;
    if (!groupId) throw new Error('groupId is required');

    let group;
    try {
      group = await readGroup(groupId);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { groupId, removed: 0, remaining: 0, fileRemoved: false, attachmentsRemoved: 0, skipped: [] };
      }
      throw new Error(`corrupt annotation group: ${groupId}`);
    }

    const before = group.tasks.length;
    // 先算出「本次请求会命中哪些任务」，再从命中集合里挑出被保护的处理中任务。
    // 只对命中集合报 skipped：否则删别的任务时，把无关的处理中任务也当成
    // 「被跳过」提示给用户，会让人以为操作被拦了。
    const matches = task => {
      if (deleteAll) return true;
      if (ids.has(task.id)) return true;
      if (task.element?.selector && selectorList.has(task.element.selector)) return true;
      return false;
    };
    const protectedIds = new Set(
      force ? [] : group.tasks.filter(t => t.status === 'doing' && matches(t)).map(t => t.id),
    );
    const isProtected = task => protectedIds.has(task.id);

    // filter 保留谓词为真的元素：命中的一律丢弃，但被保护的要留下。
    group.tasks = group.tasks.filter(task => isProtected(task) || !matches(task));
    const removed = before - group.tasks.length;
    const skipped = [...protectedIds];

    // 任务全部删完时直接删掉 JSON 文件，保持工作区干净。
    // prune 必须在文件删除/写回之后执行：保活集合读的是磁盘现状。
    if (!group.tasks.length) {
      await fs.rm(fileFor(groupId), { force: true });
      const attachmentsRemoved = await pruneAttachments();
      notifyChange();
      const roundReleased = removed > 0 ? await releaseRoundIfDelivered() : false;
      return { groupId, removed, remaining: 0, fileRemoved: true, attachmentsRemoved, skipped, roundReleased };
    }

    group.updatedAt = nowIso();
    await writeGroup(group);
    const attachmentsRemoved = await pruneAttachments();
    notifyChange();
    const roundReleased = removed > 0 ? await releaseRoundIfDelivered() : false;
    return { groupId, removed, remaining: group.tasks.length, fileRemoved: false, attachmentsRemoved, skipped, roundReleased };
  };

  /**
   * 归档：把组内命中状态（默认 done/cancelled）的任务移入
   * archive/<groupId>.json。归档文件与任务组同 schema，可被同一套
   * 校验读回；同一组多次归档按任务 id 幂等合并——再次归档同一任务
   * 时更新副本，绝不重复追加。
   */
  const archiveTasks = async (groupIdOrUrl, options = {}) => {
    const groupId = options.byPageUrl ? groupIdForPage(groupIdOrUrl) : groupIdOrUrl;
    if (!groupId) throw new Error('groupId is required');
    const statuses = new Set(options.statuses || TERMINAL_STATUSES);
    for (const status of statuses) {
      if (!TERMINAL_STATUS_SET.has(status)) throw new Error(`invalid archive status: ${status}`);
    }
    const targetRound = options.round == null ? null : Number(options.round);

    let group;
    try {
      group = await readGroup(groupId);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { groupId, archived: 0, remaining: 0, fileRemoved: false, archiveFile: null };
      }
      throw new Error(`corrupt annotation group: ${groupId}`);
    }

    const hits = group.tasks.filter(t => statuses.has(t.status) && (targetRound == null || t.round === targetRound));
    if (!hits.length) {
      // 没有命中就不改写任何文件，避免无意义的 updatedAt 翻动
      return { groupId, archived: 0, remaining: group.tasks.length, fileRemoved: false, archiveFile: null };
    }

    const rest = group.tasks.filter(t => !hits.includes(t));
    const file = archiveFileFor(groupId);
    let archiveGroup;
    try {
      archiveGroup = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`corrupt annotation archive: ${groupId}`);
      // 归档文件不存在时新建。解析失败绝不能静默重建并覆盖历史。
      archiveGroup = null;
    }
    const at = nowIso();
    if (!archiveGroup) {
      archiveGroup = { version: '1.0', id: groupId, createdAt: at, updatedAt: at, page: group.page, tasks: [] };
    }
    const byId = new Map((Array.isArray(archiveGroup.tasks) ? archiveGroup.tasks : []).map(t => [t.id, t]));
    for (const t of hits) byId.set(t.id, t);
    archiveGroup.version = '1.0';
    archiveGroup.id = groupId;
    archiveGroup.page = archiveGroup.page || group.page;
    archiveGroup.createdAt = archiveGroup.createdAt || at;
    archiveGroup.updatedAt = at;
    archiveGroup.tasks = [...byId.values()];
    validateGroup(archiveGroup);
    await writeJsonAtomic(file, JSON.stringify(archiveGroup, null, 2));

    // 先落归档文件再动当前组，pruneAttachments 才能把归档任务的附件保活
    let fileRemoved = false;
    if (!rest.length) {
      // 与 removeTasks 一致：任务清空后不留下空组文件
      await fs.rm(fileFor(groupId), { force: true });
      fileRemoved = true;
    } else {
      group.tasks = rest;
      group.updatedAt = at;
      await writeGroup(group);
    }
    await pruneAttachments();
    // 轮次归档日志在移动完成之后记录：失败不能回滚归档本身，
    // 因此单独 try——日志缺失只影响历史展示，不影响数据。
    try {
      await recordArchivedRounds(await readExecution(), hits);
    } catch {
      /* 日志写失败不阻塞归档 */
    }
    notifyChange();
    // 直接归档路径交付轮次：本轮任务全部离开活动组时释放 activeRound（模式锁）
    const roundReleased = await releaseRoundIfDelivered();
    return { groupId, archived: hits.length, remaining: rest.length, fileRemoved, archiveFile: file, roundReleased };
  };

  /**
   * 清理归档。指定 groupId（或页面 URL）时默认删该组的整个归档文件；
   * 带 options.ids / options.statuses 时按任务粒度删除（保留其余归档）；
   * 省略参数或 options.all 为 true 时清空整个归档目录。purged/removed 是
   * 被清除的归档任务数，filesRemoved 是被删除的归档文件数，remaining 是
   * 粒度删除后该组剩余的归档任务数；删完清理失去引用的附件。
   */
  const purgeArchive = async (groupIdOrUrl, options = {}) => {
    let purged = 0;
    let filesRemoved = 0;

    const countTasks = raw => (Array.isArray(raw?.tasks) ? raw.tasks.length : 0);

    if (options.all || groupIdOrUrl == null || groupIdOrUrl === '') {
      let names = [];
      try {
        names = (await fs.readdir(archiveDir)).filter(n => n.endsWith('.json'));
      } catch {
        // 归档目录不存在：无事可清
      }
      for (const name of names) {
        try {
          purged += countTasks(JSON.parse(await fs.readFile(path.join(archiveDir, name), 'utf8')));
        } catch {
          // 损坏的归档文件也要删掉，只是统计不到其中的任务数
        }
      }
      if (names.length) await fs.rm(archiveDir, { recursive: true, force: true });
      const attachmentsRemoved = await pruneAttachments();
      return { purged, filesRemoved: names.length, attachmentsRemoved };
    }

    const groupId = options.byPageUrl ? groupIdForPage(groupIdOrUrl) : groupIdOrUrl;
    if (!groupId) throw new Error('groupId is required');
    const file = archiveFileFor(groupId);
    // 任务粒度：ids 按任务 id 精确删，statuses 按终态批量删（如只清 cancelled）
    const ids = Array.isArray(options.ids) ? options.ids.map(String) : null;
    const statuses = Array.isArray(options.statuses) ? options.statuses.filter(s => STATUS_SET.has(s)) : null;
    const granular = !!(ids?.length || statuses?.length);

    let raw = null;
    let missing = false;
    let corrupt = false;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') missing = true;
      else corrupt = true;
    }
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];

    if (granular) {
      // 粒度删除必须建立在可解析的归档上：损坏文件不能当「空」静默处理
      if (corrupt) throw new Error(`corrupt annotation archive: ${groupId}`);
      if (missing) {
        return { groupId, purged: 0, removed: 0, remaining: 0, fileRemoved: false, filesRemoved: 0, attachmentsRemoved: 0 };
      }
      const keep = tasks.filter(t => !(ids?.includes(String(t.id)) || (statuses && statuses.includes(t.status))));
      const removed = tasks.length - keep.length;
      if (!removed) {
        return { groupId, purged: 0, removed: 0, remaining: tasks.length, fileRemoved: false, filesRemoved: 0, attachmentsRemoved: 0 };
      }
      let fileRemoved = false;
      if (keep.length) {
        raw.tasks = keep;
        raw.updatedAt = nowIso();
        await writeJsonAtomic(file, JSON.stringify(raw, null, 2));
      } else {
        await fs.rm(file, { force: true });
        fileRemoved = true;
      }
      const attachmentsRemoved = await pruneAttachments();
      return { groupId, purged: removed, removed, remaining: keep.length, fileRemoved, filesRemoved: fileRemoved ? 1 : 0, attachmentsRemoved };
    }

    if (missing) {
      const attachmentsRemoved = await pruneAttachments();
      return { groupId, purged: 0, removed: 0, remaining: 0, fileRemoved: false, filesRemoved: 0, attachmentsRemoved };
    }
    // 整文件删除：损坏的归档也一并清掉，只是统计不到其中的任务数
    const purgedCount = corrupt ? 0 : tasks.length;
    await fs.rm(file, { force: true });
    const attachmentsRemoved = await pruneAttachments();
    return { groupId, purged: purgedCount, removed: purgedCount, remaining: 0, fileRemoved: true, filesRemoved: 1, attachmentsRemoved };
  };

  // 写操作在**对外边界**统一排队，内部实现之间仍直连（见上方 queueWrite 注释）。
  // 只包对外这几个：内部 appendTasks 会调 writeGroup，若把内部调用也排队，
  // 就会在等待自己所属的那个队列任务时自我死锁。
  return {
    workspace: root,
    taskDir,
    attachmentsDir,
    archiveDir,
    executionFile,
    fileFor,
    readGroup,
    listGroups,
    listGroupsWithDiagnostics,
    listArchives,
    diagnostics,
    appendTasks: input => queueWrite(() => appendTasks(input)),
    updateTask: (groupId, patch) => queueWrite(() => updateTask(groupId, patch)),
    acceptTasks: options => queueWrite(() => acceptTasks(options)),
    removeTasks: (groupIdOrUrl, options) => queueWrite(() => removeTasks(groupIdOrUrl, options)),
    archiveTasks: (groupIdOrUrl, options) => queueWrite(() => archiveTasks(groupIdOrUrl, options)),
    completeRound: round => queueWrite(() => completeRound(round)),
    purgeArchive: (groupIdOrUrl, options) => queueWrite(() => purgeArchive(groupIdOrUrl, options)),
    readExecution,
    readBoardPrefs,
    writeBoardPrefs: patch => queueWrite(() => writeBoardPrefs(patch)),
    setMode: mode => queueWrite(() => setMode(mode)),
    roundSummary,
    groupIdForPage,
    buildSendPayload,
  };
}
