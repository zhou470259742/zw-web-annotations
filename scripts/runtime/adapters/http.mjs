/**
 * 非 Vite 开发服务器的接入方案。
 *
 * 提供两个能力：
 * 1. 把标注组件脚本挂到任意开发服务器上，由中间件注入 HTML（webpack-dev-server、
 *    Next.js 自定义 server、Express、Koa、Fastify 均可复用这个 handler）；
 * 2. 提供同源写盘接口，把任务保存到本地工作区。
 *
 * 以 Express 为例：
 *   import express from 'express';
 *   import { createAnnotationsMiddleware } from './.zwa/runtime/adapters/http.mjs';
 *   const app = express();
 *   app.use(createAnnotationsMiddleware({ workspace: process.cwd() }));
 *
 * 以 webpack-dev-server 为例，在 devServer.setupMiddlewares 中挂载同样的中间件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchTaskDir, createTaskChangeHub, createStore, ensureEndpointManifest, normalizeEndpointPath, MAX_BODY_BYTES, RUNTIME_VERSION, validateHttpRequest } from '../core/store.mjs';
import { renderBoardHtml } from '../board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.resolve(here, '..', 'client', 'annotator.mjs');
// 执行要求文件与适配器同在 runtime/ 根下（与 Vite 插件的解析方式一致），
// 缺失时 /tasks 返回 null，客户端按 fail-closed 拒绝复制提示词。
const PROTOCOL_FILE = path.resolve(here, '..', 'execution-protocol.md');

async function protocolPathOrNull() {
  try {
    await fs.access(PROTOCOL_FILE);
    return PROTOCOL_FILE;
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function sendJs(res, source) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(source);
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

/**
 * 创建一个 connect 风格中间件（Express/Connect/webpack-dev-server 通用）。
 * 只处理 /__zw-web-annotations 前缀，其他请求交给 next()。
 */
export function createAnnotationsMiddleware(options = {}) {
  const route = normalizeEndpointPath(options.route || '/__zw-web-annotations');
  const config = {
    route,
    clientPath: options.clientPath || `${route}/client.js`,
    workspace: options.workspace || process.cwd(),
    dir: options.dir,
    collapsed: options.collapsed !== false,
    // 默认自动把脚本注入 HTML 响应。这样没有框架适配器的项目
    // （React/Vue + webpack 等）只需挂中间件，UI 就会自己出现。
    injectHtml: options.injectHtml !== false,
  };
  const hub = createTaskChangeHub();
  const store = createStore(config.workspace, { dir: config.dir, onChange: () => hub.notify() });
  // 监听任务目录，覆盖 MCP 等进程外写入；目录尚未建立或平台不支持时静默
  // 退化为轮询兜底。ensureWatcher 幂等：首个请求时目录多半已存在。
  let dirWatcher = null;
  const ensureWatcher = () => {
    if (dirWatcher) return;
    try {
      dirWatcher = watchTaskDir(store.taskDir, () => hub.notify());
    } catch {
      /* 目录不存在等：只靠轮询兜底 */
    }
  };

  /** 组件脚本 + 自动挂载引导，与 Vite 插件的做法保持一致。 */
  async function clientSource() {
    const source = await fs.readFile(CLIENT_FILE, 'utf8');
    const bootstrap = { endpoint: config.route, collapsed: config.collapsed, version: RUNTIME_VERSION };
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

  return async function zwAnnotationsMiddleware(req, res, next) {
    const raw = req.url || '';
    const [pathname] = raw.split('?');
    const query = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');

    if (pathname === config.clientPath) {
      return sendJs(res, await clientSource());
    }
    // 截图子模块：annotator 按需 dynamic import，独立文件不增大主包
    if (pathname === `${config.route}/client/domshot.mjs`) {
      return sendJs(res, await fs.readFile(path.resolve(here, '..', 'client', 'domshot.mjs'), 'utf8'));
    }

    // 只读看板：所有页面的任务按状态分列，页面自行拉取 ./tasks 并经 SSE 实时刷新
    if (pathname === `${config.route}/board` && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      return res.end(renderBoardHtml({ version: RUNTIME_VERSION }));
    }

    // 标注接口之外的请求交给下游，但顺手把脚本注入它返回的 HTML，
    // 否则没有任何东西会去挂载标注 UI。
    if (!pathname.startsWith(config.route)) {
      if (!next) return sendJson(res, 404, { error: 'not found' });
      if (config.injectHtml) wrapHtmlResponse(req, res, config);
      return next();
    }

    const route = pathname.slice(config.route.length) || '/';
    // 任务附件回源：服务端落盘的图片没有 dataUrl，浏览器需经接口取回
    if (req.method === 'GET' && route.startsWith('/files/')) {
      const name = path.basename(decodeURIComponent(route.slice(7)));
      if (!name || name.includes('..')) return sendJson(res, 400, { error: 'invalid file name' });
      const file = path.join(store.attachmentsDir, name);
      try {
        const buf = await fs.readFile(file);
        res.statusCode = 200;
        res.setHeader('content-type', { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream');
        // 附件文件名带随机串、内容不可变——强缓存让缩略图二次渲染零回源
        res.setHeader('cache-control', 'public, max-age=86400, immutable');
        return res.end(buf);
      } catch {
        return sendJson(res, 404, { error: 'attachment not found' });
      }
    }
    if (req.method === 'GET' && route === '/events') {
      // SSE 实时推送：任务文件变化时通知页面立即拉取，轮询（10s）作为兜底
      ensureWatcher();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      hub.add(res);
      return;
    }
    ensureWatcher();
    try {
      validateHttpRequest(req, { mutating: req.method !== 'GET' });
      if (req.method === 'GET' && (route === '/' || route === '/health')) {
        const endpointManifestPath = await ensureEndpointManifest(store.workspace, config.route);
        return sendJson(res, 200, {
          ok: true,
          version: RUNTIME_VERSION,
          workspace: store.workspace,
          taskDir: store.taskDir,
          endpoint: config.route,
          endpointManifestPath,
          clientPath: config.clientPath,
          eventClients: hub.clientCount,
          diagnostics: await store.diagnostics(),
        });
      }
      if (req.method === 'GET' && route === '/tasks') {
        const groups = await store.listGroups();
        const endpointManifestPath = await ensureEndpointManifest(store.workspace, config.route);
        // absolutePath 供客户端分组列表与复制提示词使用（与 Vite 插件保持一致）；
        // round 是服务端权威轮次摘要，客户端据此定分母，不再自行推断当前轮。
        return sendJson(res, 200, {
          groups: groups.map(group => ({ ...group, absolutePath: store.fileFor(group.id) })),
          diagnostics: await store.diagnostics(),
          execution: await store.readExecution(),
          round: await store.roundSummary(),
          executionPath: store.executionFile,
          endpoint: config.route,
          endpointManifestPath,
          tasksPath: store.taskDir,
          protocolPath: await protocolPathOrNull(),
        });
      }
      // 执行模式：读取带轮次摘要，写入即切换并广播（与 Vite 插件保持一致）
      if (req.method === 'GET' && route === '/execution') {
        return sendJson(res, 200, {
          ok: true,
          execution: await store.readExecution(),
          executionPath: store.executionFile,
          round: await store.roundSummary(),
        });
      }
      if (req.method === 'POST' && route === '/execution') {
        const raw = await readBody(req);
        const execution = await store.setMode((raw ? JSON.parse(raw) : {}).mode);
        // 带回落盘后的权威摘要，客户端回执不必再自行推断当前轮
        return sendJson(res, 200, { ok: true, execution, round: await store.roundSummary() });
      }
      if (req.method === 'POST' && route === '/complete-round') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const result = await store.completeRound(payload.round === 'active' ? 'active' : Number(payload.round));
        return sendJson(res, 200, { ok: true, ...result });
      }
      // 人工验收（review→done）：身份只认请求头，task-agent 自查不算验收。
      if (req.method === 'POST' && route === '/accept-tasks') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const actor = req.headers['x-zwa-client'] === 'task-agent' ? 'task-agent' : undefined;
        const result = await store.acceptTasks({
          round: payload.round === 'active' ? 'active' : (payload.round == null ? null : Number(payload.round)),
          ids: Array.isArray(payload.ids) ? payload.ids : null,
          ...(actor ? { actor } : {}),
        });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (req.method === 'POST' && route === '/append') {
        const raw = await readBody(req);
        const result = await store.appendTasks(raw ? JSON.parse(raw) : {});
        if (result.skipped) {
          // 什么都没写出（任务全部已归档），不能返回一个不存在的文件地址
          return sendJson(res, 200, { ok: true, skipped: true, archived: true, groupId: result.group.id });
        }
        return sendJson(res, 200, {
          ok: true,
          groupId: result.group.id,
          file: result.file,
          relativePath: path.relative(store.workspace, result.path),
          // 绝对路径才是模型能直接打开的地址：relativePath 相对项目目录，
          // 而模型的工作目录是工作区根，项目常在工作区子目录下，照抄会读不到。
          absolutePath: result.path,
          added: result.added,
        attachments: result.attachments || 0,
          updated: result.updated,
          taskCount: result.group.tasks.length,
        });
      }
      if (req.method === 'GET' && route === '/send-payload') {
        return sendJson(res, 410, { error: 'send-payload is retired', tasksPath: store.taskDir, protocolPath: await protocolPathOrNull() });
      }
      // 删除任务：按页面 URL 解析任务组，删除后同步清理 JSON 与无主附件
      if (req.method === 'POST' && route === '/delete') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const pageUrl = payload.pageUrl || (payload.page && payload.page.url);
        if (!pageUrl && !payload.groupId) return sendJson(res, 400, { error: 'pageUrl is required' });
        const result = pageUrl
          ? await store.removeTasks(pageUrl, {
              ids: payload.ids || [],
              selectors: payload.selectors || [],
              all: !!payload.all,
              // force 供确实要清理处理中任务的场景；不传则服务端按默认保护它们
              force: !!payload.force,
              byPageUrl: true,
            })
          : await store.removeTasks(payload.groupId, {
              ids: payload.ids || [],
              selectors: payload.selectors || [],
              all: !!payload.all,
              force: !!payload.force,
            });
        return sendJson(res, 200, { ok: true, ...result });
      }
      // 看板用户偏好（主题等）：保存在项目 .zwa/runtime/board-prefs.json，跨浏览器记忆
      if (req.method === 'GET' && route === '/board-prefs') {
        return sendJson(res, 200, { ok: true, prefs: await store.readBoardPrefs() });
      }
      if (req.method === 'POST' && route === '/board-prefs') {
        const raw = await readBody(req);
        const prefs = await store.writeBoardPrefs(raw ? JSON.parse(raw) : {});
        return sendJson(res, 200, { ok: true, prefs });
      }

      // 归档总览（只读）：看板用它展示历史归档任务，与下面的 POST /archive（归档动作）对称
      if (req.method === 'GET' && route === '/archive') {
        const { archives, diagnostics } = await store.listArchives();
        return sendJson(res, 200, { ok: true, archives, diagnostics, archiveDir: store.archiveDir });
      }

      // 归档：把已完成/已取消的任务移入 archive/，与 Vite 插件保持同一能力
      if (req.method === 'POST' && route === '/archive') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const pageUrl = payload.pageUrl || (payload.page && payload.page.url);
        if (!pageUrl && !payload.groupId) return sendJson(res, 400, { error: 'pageUrl is required' });
        const result = pageUrl
          ? await store.archiveTasks(pageUrl, { statuses: payload.statuses, round: payload.round, byPageUrl: true })
          : await store.archiveTasks(payload.groupId, { statuses: payload.statuses, round: payload.round });
        return sendJson(res, 200, { ok: true, ...result });
      }
      // 清理归档：不传目标且 all=true 时清空整个归档目录；
      // 带 ids/statuses 时按任务粒度删除该组归档（看板「删除」按钮走这里）
      if (req.method === 'POST' && route === '/purge-archive') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const pageUrl = payload.pageUrl || (payload.page && payload.page.url);
        if (!pageUrl && !payload.groupId && !payload.all) {
          return sendJson(res, 400, { error: 'pageUrl or all is required' });
        }
        const result = pageUrl
          ? await store.purgeArchive(pageUrl, { byPageUrl: true, ids: payload.ids, statuses: payload.statuses })
          : await store.purgeArchive(payload.groupId, { all: !!payload.all, ids: payload.ids, statuses: payload.statuses });
        return sendJson(res, 200, { ok: true, ...result });
      }
      const taskMatch = route.match(/^\/([^/]+)\/tasks\/([^/]+)$/);
      if (taskMatch && (req.method === 'PATCH' || req.method === 'POST')) {
        const raw = await readBody(req);
        const parsedPatch = raw ? JSON.parse(raw) : {};
        const { actor: _ignoredActor, ...patch } = parsedPatch;
        const actor = req.headers['x-zwa-client'] === 'task-agent' ? 'task-agent' : undefined;
        const result = await store.updateTask(decodeURIComponent(taskMatch[1]), {
          ...patch,
          // 身份只认请求头，不信任请求体里自报的 actor。
          ...(actor ? { actor } : {}),
          taskId: decodeURIComponent(taskMatch[2]),
        });
        return sendJson(res, 200, { ok: true, group: result.group, task: result.task });
      }
      return sendJson(res, 404, { error: 'not found', route });
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message });
    }
  };
}

/**
 * 把标注组件的 script 标签注入 HTML 字符串。
 * 适用于任何能在响应 HTML 前改写的开发服务器。
 */
export function injectAnnotatorScript(html, options = {}) {
  const clientPath = options.clientPath || '/__zw-web-annotations/client.js';
  if (html.includes(clientPath)) return html;
  const tag = `<script type="module" src="${clientPath}" data-zw-annotations data-endpoint="${options.route || '/__zw-web-annotations'}" data-collapsed="${options.collapsed === false ? 'false' : 'true'}"></script>`;
  return html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : `${html}\n${tag}`;
}

/**
 * 包装 res，把 script 标签注入它返回的 HTML。
 *
 * 两个必须处理的现实问题：
 * 1. HTML 可能分多次 write 写出，所以要缓冲到 end 再统一注入；
 * 2. 若响应被 gzip/brotli 压缩，正文是二进制，注入会把内容写坏——
 *    因此一旦发现 content-encoding，就原样放行已缓冲的数据。
 */
function wrapHtmlResponse(req, res, options) {
  const clientPath = options.clientPath || '/__zw-web-annotations/client.js';
  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let decided = false;
  let intercept = false;

  const decide = () => {
    if (decided) return;
    decided = true;
    const type = String(res.getHeader('content-type') || '');
    const encoding = res.getHeader('content-encoding');
    // 压缩过的正文不能按文本注入，否则浏览器拿到的是坏数据
    intercept = type.includes('text/html') && !encoding;
  };

  /** 放弃注入：把已缓冲的数据原样交回底层。 */
  const flushRaw = (...rest) => {
    intercept = false;
    if (chunks.length) {
      const buffered = Buffer.concat(chunks);
      chunks.length = 0;
      originalWrite(buffered);
    }
    return rest;
  };

  res.write = (chunk, ...rest) => {
    if (!decided) decide();
    if (intercept && chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }
    return originalWrite(chunk, ...rest);
  };

  res.end = (chunk, ...rest) => {
    if (!decided) decide();
    if (chunk) {
      if (intercept) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      else return originalEnd(chunk, ...rest);
    }
    if (!intercept) {
      flushRaw();
      return originalEnd(...rest);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    chunks.length = 0;
    const injected = injectAnnotatorScript(html, { ...options, clientPath });
    // 注入后长度变化，必须重算 content-length，否则响应会被截断
    res.removeHeader('content-length');
    res.setHeader('content-length', String(Buffer.byteLength(injected)));
    return originalEnd(injected, ...rest);
  };
}

export const createAnnotationsStore = (workspace, options) => createStore(workspace, options);
