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
import { watchTaskDir, createTaskChangeHub, createStore, MAX_BODY_BYTES, buildSendPayload, RUNTIME_VERSION } from '../core/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.resolve(here, '..', 'client', 'annotator.mjs');

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
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * 创建一个 connect 风格中间件（Express/Connect/webpack-dev-server 通用）。
 * 只处理 /__zw-web-annotations 前缀，其他请求交给 next()。
 */
export function createAnnotationsMiddleware(options = {}) {
  const config = {
    route: options.route || '/__zw-web-annotations',
    clientPath: options.clientPath || '/__zw-web-annotations/client.js',
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

    // 标注接口之外的请求交给下游，但顺手把脚本注入它返回的 HTML，
    // 否则没有任何东西会去挂载标注 UI。
    if (!pathname.startsWith(config.route)) {
      if (!next) return sendJson(res, 404, { error: 'not found' });
      if (config.injectHtml) wrapHtmlResponse(req, res, config);
      return next();
    }

    const route = pathname.slice(config.route.length) || '/';
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
      if (req.method === 'GET' && (route === '/' || route === '/health')) {
        return sendJson(res, 200, { ok: true, version: RUNTIME_VERSION, workspace: store.workspace, taskDir: store.taskDir, clientPath: config.clientPath, eventClients: hub.clientCount });
      }
      if (req.method === 'GET' && route === '/tasks') {
        const groups = await store.listGroups();
        // absolutePath 供客户端分组列表与复制提示词使用（与 Vite 插件保持一致）
        return sendJson(res, 200, {
          groups: groups.map(group => ({ ...group, absolutePath: store.fileFor(group.id) })),
        });
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
        const groups = await store.listGroups();
        const groupId = query.get('groupId');
        const group = groupId ? groups.find(g => g.id === groupId) : groups[0];
        if (!group) return sendJson(res, 404, { error: 'group not found' });
        return sendJson(res, 200, { groupId: group.id, payload: buildSendPayload(group) });
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
      // 归档：把已完成/已取消的任务移入 archive/，与 Vite 插件保持同一能力
      if (req.method === 'POST' && route === '/archive') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const pageUrl = payload.pageUrl || (payload.page && payload.page.url);
        if (!pageUrl && !payload.groupId) return sendJson(res, 400, { error: 'pageUrl is required' });
        const result = pageUrl
          ? await store.archiveTasks(pageUrl, { statuses: payload.statuses, byPageUrl: true })
          : await store.archiveTasks(payload.groupId, { statuses: payload.statuses });
        return sendJson(res, 200, { ok: true, ...result });
      }
      // 清理归档：不传目标且 all=true 时清空整个归档目录
      if (req.method === 'POST' && route === '/purge-archive') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const pageUrl = payload.pageUrl || (payload.page && payload.page.url);
        if (!pageUrl && !payload.groupId && !payload.all) {
          return sendJson(res, 400, { error: 'pageUrl or all is required' });
        }
        const result = pageUrl
          ? await store.purgeArchive(pageUrl, { byPageUrl: true })
          : await store.purgeArchive(payload.groupId, { all: !!payload.all });
        return sendJson(res, 200, { ok: true, ...result });
      }
      const taskMatch = route.match(/^\/([^/]+)\/tasks\/([^/]+)$/);
      if (taskMatch && (req.method === 'PATCH' || req.method === 'POST')) {
        const raw = await readBody(req);
        const result = await store.updateTask(decodeURIComponent(taskMatch[1]), {
          ...(raw ? JSON.parse(raw) : {}),
          taskId: decodeURIComponent(taskMatch[2]),
        });
        return sendJson(res, 200, { ok: true, group: result.group, task: result.task });
      }
      return sendJson(res, 404, { error: 'not found', route });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
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
