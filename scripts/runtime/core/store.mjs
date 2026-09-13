import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUSES = ['todo', 'doing', 'done', 'blocked', 'cancelled'];
export const STATUS_SET = new Set(STATUSES);
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
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
export const RUNTIME_VERSION = '0.12.0';
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

export function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
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
    if (!task.id || typeof task.instruction !== 'string' || !STATUS_SET.has(task.status) || !Array.isArray(task.history)) {
      throw new Error(`invalid task: ${task.id || 'unknown'}`);
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

  const attachmentsDir = path.join(taskDir, ATTACHMENTS_DIRNAME);
  const archiveDir = path.join(taskDir, ARCHIVE_DIRNAME);

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

  const listGroups = async () => {
    await fs.mkdir(taskDir, { recursive: true });
    const names = (await fs.readdir(taskDir)).filter(n => n.endsWith('.json'));
    const groups = [];
    for (const name of names) {
      try {
        groups.push(validateGroup(JSON.parse(await fs.readFile(path.join(taskDir, name), 'utf8'))));
      } catch {
        // 跳过损坏或不符合 schema 的文件，避免一个坏文件让整个列表不可用
      }
    }
    return groups.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  };

  const archiveFileFor = id => path.join(archiveDir, `${safeId(id)}.json`);

  /** 读取某任务组的归档索引（task id → 已归档任务）。目录不存在或文件损坏时视为空。 */
  const readArchiveTasks = async groupId => {
    const byId = new Map();
    try {
      const raw = JSON.parse(await fs.readFile(archiveFileFor(groupId), 'utf8'));
      for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
        if (t?.id) byId.set(t.id, t);
      }
    } catch {
      // 没有归档是常态，不能让归档索引反过来阻塞正常同步
    }
    return byId;
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

    const id = pageKey(url);
    let group;
    try {
      group = await readGroup(id);
    } catch {
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
        // doing 任务的指令不接受覆盖：处理者正按当前指令改代码，中途换掉指令会让
        // 它回写的 done 与结果描述的是另一件事，用户看到的记录也会前后矛盾。
        // 要改需先由处理者回写状态（done/blocked/cancelled），再重新编辑。
        const locked = existing.status === 'doing';
        if (!locked && typeof incoming.instruction === 'string' && incoming.instruction.trim()) {
          if (incoming.instruction !== existing.instruction) {
            existing.history.push({ at, event: 'instruction_updated', detail: incoming.instruction });
            existing.instruction = incoming.instruction;
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
          status: STATUS_SET.has(incoming.status) ? incoming.status : 'todo',
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
    return { group, file: `${id}.json`, path: fileFor(id), added, updated, attachments };
  };

  /** 更新单个任务状态或结果，供工作台与 MCP 共用。 */
  const updateTask = async (groupId, patch = {}) => {
    const group = await readGroup(groupId);
    const task = group.tasks.find(t => t.id === patch.taskId);
    if (!task) throw new Error('task not found');
    if (patch.status && !STATUS_SET.has(patch.status)) throw new Error('invalid status');
    const at = nowIso();
    if (patch.status && patch.status !== task.status) {
      task.status = patch.status;
      task.history.push({ at, event: 'status_changed', detail: patch.status });
      if (patch.status === 'doing') task.startedAt = task.startedAt || at;
      if (patch.status === 'done') task.completedAt = at;
    }
    if (typeof patch.result === 'string' && patch.result !== task.result) {
      task.result = patch.result;
      task.history.push({ at, event: 'result_updated', detail: patch.result });
    }
    task.updatedAt = at;
    group.updatedAt = at;
    await writeGroup(group);
    return { group, task };
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
    const collect = group => {
      for (const task of group.tasks || []) {
        for (const image of task.images || []) {
          if (image.file) keep.add(path.basename(image.file));
        }
      }
    };
    for (const group of await listGroups()) collect(group);
    // 归档任务仍保留图片引用，归档文件必须与活动组一起参与保活
    try {
      const names = (await fs.readdir(archiveDir)).filter(n => n.endsWith('.json'));
      for (const name of names) {
        try {
          collect(JSON.parse(await fs.readFile(path.join(archiveDir, name), 'utf8')));
        } catch {
          // 单个损坏的归档文件不参与保活，但不能中断整体清理
        }
      }
    } catch {
      // 归档目录不存在时没有可扫描的归档
    }
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
    } catch {
      // 文件已不存在：视为已删除，保持幂等
      return { groupId, removed: 0, remaining: 0, fileRemoved: false, attachmentsRemoved: 0, skipped: [] };
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
      return { groupId, removed, remaining: 0, fileRemoved: true, attachmentsRemoved, skipped };
    }

    group.updatedAt = nowIso();
    await writeGroup(group);
    const attachmentsRemoved = await pruneAttachments();
    return { groupId, removed, remaining: group.tasks.length, fileRemoved: false, attachmentsRemoved, skipped };
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
    const statuses = new Set(options.statuses || ['done', 'cancelled']);

    let group;
    try {
      group = await readGroup(groupId);
    } catch {
      // 组不存在：无可归档，与 removeTasks 一致保持幂等
      return { groupId, archived: 0, remaining: 0, fileRemoved: false, archiveFile: null };
    }

    const hits = group.tasks.filter(t => statuses.has(t.status));
    if (!hits.length) {
      // 没有命中就不改写任何文件，避免无意义的 updatedAt 翻动
      return { groupId, archived: 0, remaining: group.tasks.length, fileRemoved: false, archiveFile: null };
    }

    const rest = group.tasks.filter(t => !statuses.has(t.status));
    const file = archiveFileFor(groupId);
    let archiveGroup;
    try {
      archiveGroup = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      // 归档文件不存在时新建。无法解析的旧文件在这里重建是安全的：
      // 内容本已读不回来；能解析但过不了校验的文件走下面的 validateGroup 抛错，
      // 宁可拒绝归档也不静默覆盖一份看起来是有意编辑过的归档。
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
    return { groupId, archived: hits.length, remaining: rest.length, fileRemoved, archiveFile: file };
  };

  /**
   * 清空归档。指定 groupId（或页面 URL）时只删该组的归档文件；省略参数
   * 或 options.all 为 true 时清空整个归档目录。purged 是被清除的归档任务
   * 数，filesRemoved 是被删除的归档文件数；删完后清理失去引用的附件。
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
    let exists = true;
    try {
      purged = countTasks(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') exists = false;
      // 其余情况（损坏 JSON）同样删掉，只是任务数统计不到
    }
    if (exists) {
      await fs.rm(file, { force: true });
      filesRemoved = 1;
    }
    const attachmentsRemoved = await pruneAttachments();
    return { purged, filesRemoved, attachmentsRemoved };
  };

  return {
    workspace: root,
    taskDir,
    attachmentsDir,
    archiveDir,
    fileFor,
    readGroup,
    writeGroup,
    listGroups,
    appendTasks,
    updateTask,
    removeTasks,
    archiveTasks,
    purgeArchive,
    groupIdForPage,
    pruneAttachments,
    persistAttachments,
    buildSendPayload,
  };
}
