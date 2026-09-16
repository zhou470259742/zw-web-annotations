/**
 * 网页标注 Vite 插件
 *
 * 作用：
 * 1. 仅在 dev 模式下把标注组件注入页面（构建产物不包含它）；
 * 2. 提供同源接口 /__zw-web-annotations/*，直接把任务写入本地工作区。
 *
 * 用法（vite.config.js）：
 *   import { zwAnnotations } from './.zwa/runtime/vite/index.mjs';
 *   export default { plugins: [zwAnnotations()] };
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore, createTaskChangeHub, ensureEndpointManifest, normalizeEndpointPath, MAX_BODY_BYTES, RUNTIME_VERSION, validateHttpRequest } from '../core/store.mjs';
import { renderBoardHtml } from '../board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.resolve(here, '..', 'client', 'annotator.mjs');
// 执行要求文件与适配器同在 runtime/ 根下（RUNTIME_FILES 拷贝保证），提示词
// 只指向它而不内联协议文本——协议只维护这一份，提示词不再随文案演进膨胀。
const PROTOCOL_FILE = path.resolve(here, '..', 'execution-protocol.md');
const ROUTE_PREFIX = '/__zw-web-annotations';

/** 执行要求文件存在时返回绝对路径，供客户端复制进提示词；缺失返回 null（fail-closed）。 */
async function protocolPathOrNull() {
  try {
    await fs.access(PROTOCOL_FILE);
    return PROTOCOL_FILE;
  } catch {
    return null;
  }
}

/**
 * 判断是否要临时关掉标注能力。
 *
 * 关掉整条链路（注入 + 接口），而不只是藏掉 UI：只藏 UI 的话接口仍在
 * 监听，「关了还在写文件」比不关更让人意外。默认值一律视为开启，
 * 只有显式写出关闭词才算关，避免环境里一个空值把功能误关掉。
 */
function isDisabled(value) {
  return /^(0|off|false|no|disable|disabled)$/i.test(String(value ?? '').trim());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function parseBody(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

export function zwAnnotations(options = {}) {
  const config = {
    // 保留调用方扩展字段，但下面几个协议字段由运行时统一规范化，
    // 防止 `...options` 把已校验的 endpoint 再覆盖成非法或带尾斜杠的值。
    ...options,
    // 默认写入当前项目根目录；可显式指定其他工作区目录
    workspace: options.workspace || process.cwd(),
    dir: options.dir,
    endpoint: normalizeEndpointPath(options.endpoint || ROUTE_PREFIX),
    inject: options.inject !== false,
    collapsed: options.collapsed !== false,
    meta: options.meta,
    // 临时关闭：enabled: false 或环境变量 ZW_ANNOTATIONS=off。
    // 环境变量优先，便于不改配置文件就关掉（改配置要重启，改 env 也要重启，
    // 但 env 不必动仓库里被 git 跟踪的文件）。
    enabled: options.enabled !== false && !isDisabled(process.env.ZW_ANNOTATIONS),
  };

  /** @type {import('../core/store.mjs').createStore extends (...a:any)=>infer R ? R : never} */
  let store = null;
  let hub = null;
  const getHub = () => (hub ||= createTaskChangeHub());
  const getStore = () =>
    (store ||= createStore(config.workspace, { dir: config.dir, onChange: () => getHub().notify() }));

  const clientRoute = `${config.endpoint}/client.js`;

  async function clientSource() {
    const source = await fs.readFile(CLIENT_FILE, 'utf8');
    const bootstrap = {
      endpoint: config.endpoint,
      label: options.label || '网页标注',
      collapsed: config.collapsed,
      // 版本随配置下发，供组件 API 与排查时确认"页面里跑的是哪一版运行时"。
      // 组件不自己写版本号，避免两处各自漂移。
      version: RUNTIME_VERSION,
    };
    // ES 模块中 document.currentScript 恒为 null，因此这里显式挂载，
    // 不依赖组件内部的 data 属性自动挂载分支。
    return [
      source,
      `const __zwConfig = ${JSON.stringify(bootstrap)};`,
      `if (typeof window !== 'undefined') { window.__zwAnnotationsConfig = __zwConfig; }`,
      `function __zwAutoMount() { if (typeof window !== 'undefined') mountAnnotator({ ...__zwConfig }); }`,
      `if (typeof document !== 'undefined') {`,
      `  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __zwAutoMount, { once: true });`,
      `  else __zwAutoMount();`,
      `}`,
      `export default mountAnnotator;`,
    ].join('\n');
  }

  return {
    name: 'zw-web-annotations',
    apply: 'serve',

    async transformIndexHtml(html) {
      if (!config.enabled || !config.inject) return html;
      // 用源码内容哈希做查询串：源码变化时 URL 变化，浏览器必然重新拉取，
      // 不会拿到旧缓存。脚本由本插件的中间件以真实文件响应提供，
      // 不走虚拟模块，避免查询串破坏模块解析。
      let version = 'dev';
      try {
        const source = await fs.readFile(CLIENT_FILE, 'utf8');
        version = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10);
      } catch {
        /* 读不到时退化为 dev */
      }
      const tag = {
        tag: 'script',
        attrs: {
          type: 'module',
          src: `${clientRoute}?v=${version}`,
          'data-zw-annotations': '',
          'data-endpoint': config.endpoint,
          'data-collapsed': config.collapsed ? 'true' : 'false',
        },
        injectTo: 'body',
      };
      return { html, tags: [tag] };
    },

    configureServer(server) {
      // 组件源码变化时触发浏览器整页刷新，避免改代码看不到效果。
      server.watcher.add(CLIENT_FILE);
      const invalidate = changed => {
        if (path.resolve(changed) !== CLIENT_FILE) return;
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('change', invalidate);
      server.watcher.on('add', invalidate);

      if (config.enabled) {
        // 任务文件变化（含 MCP 等进程外写入）→ 推送 SSE，页面立即拉取。
        // 进程内写入由 store 的 onChange 回调覆盖，这里补进程外的部分。
        const hub = getHub();
        const taskDirRoot = path.resolve(getStore().taskDir);
        server.watcher.add(taskDirRoot);
        const onTaskFile = changed => {
          const p = path.resolve(String(changed));
          if (p.startsWith(taskDirRoot) && p.endsWith('.json')) hub.notify();
        };
        server.watcher.on('change', onTaskFile);
        server.watcher.on('add', onTaskFile);
        server.watcher.on('unlink', onTaskFile);
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith(config.endpoint)) return next();
        // 关闭时不注册任何接口：留着接口会出现「界面没了但还在写文件」，
        // 比明确 404 更让人困惑。
        if (!config.enabled) return sendJson(res, 404, { error: 'annotations disabled', hint: 'ZW_ANNOTATIONS=off' });
        const url = new URL(req.url, 'http://localhost');
        const route = url.pathname.slice(config.endpoint.length) || '/';

        if (req.method === 'GET' && route === '/events') {
          // SSE 实时推送：任务文件变化时通知页面立即拉取，轮询（10s）作为兜底。
          // 长连接不进入 try/catch，也绝不调用 next()/sendJson()。
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          getHub().add(res);
          return;
        }

        try {
          validateHttpRequest(req, { mutating: req.method !== 'GET' });
          if (req.method === 'GET' && (route === '/' || route === '/health')) {
            const endpointManifestPath = await ensureEndpointManifest(getStore().workspace, config.endpoint);
            return sendJson(res, 200, {
              ok: true,
              // 排查时先看这里：能直接确认接口来自哪一版运行时，
              // 不必去翻项目里的文件
              version: RUNTIME_VERSION,
              workspace: getStore().workspace,
              taskDir: getStore().taskDir,
              endpoint: config.endpoint,
              endpointManifestPath,
              eventClients: getHub().clientCount,
              diagnostics: await getStore().diagnostics(),
            });
          }

          if (req.method === 'GET' && route === '/tasks') {
            const groups = await getStore().listGroups();
            const endpointManifestPath = await ensureEndpointManifest(getStore().workspace, config.endpoint);
            // absolutePath 供客户端分组列表与复制提示词使用：提示词必须指向
            // 模型能直接打开的真实文件，客户端无法自己从组 id 推出落盘位置。
            // execution 与 round 摘要随任务一并下发：客户端一次请求就能拿到模式、
            // 权威 activeRound、阻塞与 runner 状态，不必自己从任务里推断当前轮。
            return sendJson(res, 200, {
              groups: groups.map(group => ({ ...group, absolutePath: getStore().fileFor(group.id) })),
              diagnostics: await getStore().diagnostics(),
              execution: await getStore().readExecution(),
              round: await getStore().roundSummary(),
              executionPath: getStore().executionFile,
              endpoint: config.endpoint,
              endpointManifestPath,
              tasksPath: getStore().taskDir,
              protocolPath: await protocolPathOrNull(),
            });
          }

          // 执行模式：读取带当前轮次摘要（轮次边界决策的数据来源），
          // 写入即切换模式并经 SSE 广播到所有页面。
          if (req.method === 'GET' && route === '/execution') {
            return sendJson(res, 200, {
              ok: true,
              execution: await getStore().readExecution(),
              executionPath: getStore().executionFile,
              round: await getStore().roundSummary(),
            });
          }
          if (req.method === 'POST' && route === '/execution') {
            const payload = parseBody(await readBody(req));
            const execution = await getStore().setMode(payload.mode);
            // 回执要描述「本轮是否在途」，必须带回切换后的权威摘要，
            // 否则客户端只能自己推断当前轮，正好是这次要消除的漂移源。
            return sendJson(res, 200, { ok: true, execution, round: await getStore().roundSummary() });
          }

          if (req.method === 'POST' && route === '/complete-round') {
            const payload = parseBody(await readBody(req));
            const result = await getStore().completeRound(Number(payload.round));
            return sendJson(res, 200, { ok: true, ...result });
          }

          // 人工验收（review→done）。身份只认请求头：带 task-agent 声明的
          // 调用方是在自证自己刚写的代码，不算主线程浏览器验收，由 store 拒绝。
          if (req.method === 'POST' && route === '/accept-tasks') {
            const payload = parseBody(await readBody(req));
            const actor = req.headers['x-zwa-client'] === 'task-agent' ? 'task-agent' : undefined;
            const result = await getStore().acceptTasks({
              round: payload.round == null ? null : Number(payload.round),
              ids: Array.isArray(payload.ids) ? payload.ids : null,
              ...(actor ? { actor } : {}),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }

          // 源码变化时哈希变化，必然重新拉取。
          if (req.method === 'GET' && route === '/client.js') {
            const source = await clientSource();
            res.statusCode = 200;
            res.setHeader('content-type', 'application/javascript; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            return res.end(source);
          }

          // 只读看板：所有页面的任务按状态分列，页面自行拉取 ./tasks 并经 SSE 实时刷新。
          if (req.method === 'GET' && route === '/board') {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            return res.end(renderBoardHtml({ version: RUNTIME_VERSION }));
          }

          if (req.method === 'POST' && route === '/append') {
            const result = await getStore().appendTasks(parseBody(await readBody(req)));
            if (result.skipped) {
              // 传入任务全部已归档、组内也无任务：什么都没写出。
              // 此时若照常返回路径，客户端会把一个不存在的文件地址复制给模型。
              return sendJson(res, 200, { ok: true, skipped: true, archived: true, groupId: result.group.id });
            }
            return sendJson(res, 200, {
              ok: true,
              groupId: result.group.id,
              file: result.file,
              relativePath: path.relative(getStore().workspace, result.path),
              // 绝对路径才是模型能直接打开的地址：relativePath 是相对
              // 「项目目录」算的，而模型的工作目录是「工作区根」，项目常
              // 在工作区下的子目录里（如 workspace/login-pages/），照抄
              // relativePath 会读不到文件。由服务端给出绝对路径，
              // 客户端不必猜项目与工作区的层级关系。
              absolutePath: result.path,
              added: result.added,
              attachments: result.attachments || 0,
              updated: result.updated,
              taskCount: result.group.tasks.length,
            });
          }

          if (req.method === 'GET' && route === '/send-payload') {
            return sendJson(res, 410, { error: 'send-payload is retired', tasksPath: getStore().taskDir, protocolPath: await protocolPathOrNull() });
          }

          // 删除任务：按页面 URL 解析任务组，删除后同步清理 JSON 与无主附件
          if (req.method === 'POST' && route === '/delete') {
            const payload = parseBody(await readBody(req));
            const pageUrl = payload.pageUrl || payload.page?.url;
            if (!pageUrl && !payload.groupId) return sendJson(res, 400, { error: 'pageUrl is required' });
            const result = pageUrl
              ? await getStore().removeTasks(pageUrl, {
                  ids: payload.ids || [],
                  selectors: payload.selectors || [],
                  all: !!payload.all,
                  // force 供确实要清理处理中任务的场景；不传则服务端按默认保护它们
                  force: !!payload.force,
                  byPageUrl: true,
                })
              : await getStore().removeTasks(payload.groupId, {
                  ids: payload.ids || [],
                  selectors: payload.selectors || [],
                  all: !!payload.all,
                  force: !!payload.force,
                });
            return sendJson(res, 200, { ok: true, ...result });
          }

          // 看板用户偏好（主题等）：保存在项目 .zwa/runtime/board-prefs.json，跨浏览器记忆
          if (req.method === 'GET' && route === '/board-prefs') {
            return sendJson(res, 200, { ok: true, prefs: await getStore().readBoardPrefs() });
          }
          if (req.method === 'POST' && route === '/board-prefs') {
            const prefs = await getStore().writeBoardPrefs(parseBody(await readBody(req)));
            return sendJson(res, 200, { ok: true, prefs });
          }

          // 归档总览（只读）：看板用它展示历史归档任务，与下面的 POST /archive（归档动作）对称
          if (req.method === 'GET' && route === '/archive') {
            const { archives, diagnostics } = await getStore().listArchives();
            return sendJson(res, 200, { ok: true, archives, diagnostics, archiveDir: getStore().archiveDir });
          }

          // 归档：把已完成/已取消的任务移入 archive/，让任务清单只留待办。
          // 提示词承诺了「已处理的任务请进行归档」，必须真有这个入口。
          if (req.method === 'POST' && route === '/archive') {
            const payload = parseBody(await readBody(req));
            const pageUrl = payload.pageUrl || payload.page?.url;
            if (!pageUrl && !payload.groupId) return sendJson(res, 400, { error: 'pageUrl is required' });
            const result = pageUrl
              ? await getStore().archiveTasks(pageUrl, {
                  statuses: payload.statuses,
                  round: payload.round,
                  byPageUrl: true,
                })
              : await getStore().archiveTasks(payload.groupId, { statuses: payload.statuses, round: payload.round });
            return sendJson(res, 200, { ok: true, ...result });
          }

          // 清理归档：purgeArchive 不传目标即清空整个归档目录；
          // 带 ids/statuses 时按任务粒度删除该组归档（看板「删除」按钮走这里）
          if (req.method === 'POST' && route === '/purge-archive') {
            const payload = parseBody(await readBody(req));
            const pageUrl = payload.pageUrl || payload.page?.url;
            if (!pageUrl && !payload.groupId && !payload.all) {
              return sendJson(res, 400, { error: 'pageUrl or all is required' });
            }
            const result = pageUrl
              ? await getStore().purgeArchive(pageUrl, { byPageUrl: true, ids: payload.ids, statuses: payload.statuses })
              : await getStore().purgeArchive(payload.groupId, { all: !!payload.all, ids: payload.ids, statuses: payload.statuses });
            return sendJson(res, 200, { ok: true, ...result });
          }

          const taskMatch = route.match(/^\/([^/]+)\/tasks\/([^/]+)$/);
          if (taskMatch && (req.method === 'PATCH' || req.method === 'POST')) {
            const groupId = decodeURIComponent(taskMatch[1]);
            const taskId = decodeURIComponent(taskMatch[2]);
            const parsedPatch = parseBody(await readBody(req));
            const { actor: _ignoredActor, ...patch } = parsedPatch;
            const actor = req.headers['x-zwa-client'] === 'task-agent' ? 'task-agent' : undefined;
            const result = await getStore().updateTask(groupId, {
              ...patch,
              // 身份只认请求头，不信任请求体里自报的 actor。
              ...(actor ? { actor } : {}),
              taskId,
            });
            return sendJson(res, 200, { ok: true, group: result.group, task: result.task });
          }

          // 旧的整组 POST /tasks 已移除：它会绕过 append/update 的状态所有权、
          // 防复活、doing 锁和附件处理，不能再作为公开兼容入口。
          return sendJson(res, 404, { error: 'not found', route });
        } catch (error) {
          return sendJson(res, error.statusCode || 400, { error: error.message });
        }
      });
    },

    api: {
      getStore,
      saveTasks: input => getStore().appendTasks(input),
      listGroups: () => getStore().listGroups(),
      updateTask: (groupId, patch) => getStore().updateTask(groupId, patch),
    },
  };
}

export default zwAnnotations;
