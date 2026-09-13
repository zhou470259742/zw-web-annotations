import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAnnotationsMiddleware, injectAnnotatorScript } from './scripts/runtime/adapters/http.mjs';
import { DEFAULT_DIR } from './scripts/runtime/core/store.mjs';

function request(port, { method = 'GET', path: urlPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: body ? { 'content-type': 'application/json' } : {} }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withServer(workspace, fn) {
  const server = http.createServer(createAnnotationsMiddleware({ workspace }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const page = { url: 'http://localhost:3000/dashboard', title: '仪表盘' };
const makeTask = () => ({
  id: 'task_1',
  instruction: '调整宽度',
  status: 'todo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  result: null,
  element: {
    tagName: 'button',
    accessibleName: '提交',
    text: '提交',
    selector: '#submit',
    xpath: '/html/body/button[1]',
    parentSummary: '',
    domSnippet: '<button id="submit">提交</button>',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    frame: 'top',
  },
  history: [{ at: '2026-01-01T00:00:00.000Z', event: 'created' }],
});

test('middleware writes annotations to the local workspace', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const health = await request(port, { path: '/__zcode/annotations/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json().workspace, dir);

    const saved = await request(port, { method: 'POST', path: '/__zcode/annotations/append', body: { page, tasks: [makeTask()] } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().added, 1);
    assert.match(saved.json().relativePath, /^\.zcode\/web-annotations\/tasks\//);

    const listed = await request(port, { path: '/__zcode/annotations/tasks' });
    assert.equal(listed.json().groups.length, 1);
  });

  // 落盘位置必须与 store 的规范目录一致
  const files = await fs.readdir(path.join(dir, DEFAULT_DIR));
  assert.equal(files.filter(f => f.endsWith('.json')).length, 1);
});

test('middleware serves the client script and rejects unknown routes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const client = await request(port, { path: '/__zcode/annotations/client.js' });
    assert.equal(client.status, 200);
    assert.match(client.text, /mountAnnotator/);

    const missing = await request(port, { path: '/__zcode/annotations/nope' });
    assert.equal(missing.status, 404);
  });
});

test('middleware returns 400 for invalid payload instead of crashing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const bad = await request(port, { method: 'POST', path: '/__zcode/annotations/append', body: { tasks: [makeTask()] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json().error, /page\.url/);
  });
});

test('injectAnnotatorScript adds the tag once', () => {
  const html = '<html><body><h1>x</h1></body></html>';
  const once = injectAnnotatorScript(html);
  assert.match(once, /data-zcode-annotations/);
  assert.equal(injectAnnotatorScript(once), once);
});

test('middleware auto-injects the UI script into HTML responses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  const middleware = createAnnotationsMiddleware({ workspace: dir });

  // 模拟一个普通 dev server：中间件之外自己返回 HTML
  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      const html = '<!doctype html><html><body><div id="root"></div></body></html>';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const page = await request(port, { path: '/' });
    // 只挂中间件也必须能出现标注 UI，否则 React/webpack 这类无适配器项目永远看不到面板
    assert.match(page.text, /\/__zcode\/annotations\/client\.js/);
    assert.match(page.text, /data-zcode-annotations/);
    assert.match(page.text, /id="root"/, '原有内容不能被破坏');

    // client.js 必须是自带自动挂载的版本
    const client = await request(port, { path: '/__zcode/annotations/client.js' });
    assert.equal(client.status, 200);
    assert.match(client.text, /__zcodeAutoMount/);
    assert.match(client.text, /mountAnnotator/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('middleware does not corrupt compressed responses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  const middleware = createAnnotationsMiddleware({ workspace: dir });
  const zlib = await import('node:zlib');
  const body = Buffer.from('<!doctype html><html><body>二进制正文</body></html>', 'utf8');
  const gzipped = zlib.gzipSync(body);

  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipped);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const raw = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(raw.encoding, 'gzip');
    // 压缩正文必须原样透传，按文本注入会把 HTML 写坏
    assert.deepEqual(raw.body, gzipped);
    assert.equal(zlib.gunzipSync(raw.body).toString('utf8'), body.toString('utf8'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

/**
 * 跨页面标注：任务按页面分成多个组文件，/tasks 一次性返回全部组。
 * 客户端的分组列表与复制提示词依赖这里的行为：每组的 absolutePath
 * （模型能直接打开的文件地址）与按 groupId 的跨组删除/更新。
 */
const pageA = { url: 'http://localhost:5173/', title: '首页' };
const pageB = { url: 'http://localhost:5173/campus.html', title: '校园登录页' };

async function seedTwoPages(port) {
  await request(port, { method: 'POST', path: '/__zcode/annotations/append', body: { page: pageA, tasks: [makeTask()] } });
  const taskB = { ...makeTask(), id: 'task_b', element: { ...makeTask().element, selector: '#login-btn' } };
  const savedB = await request(port, { method: 'POST', path: '/__zcode/annotations/append', body: { page: pageB, tasks: [taskB] } });
  return savedB.json().groupId;
}

test('/tasks lists every page group with its absolute file path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    await seedTwoPages(port);

    const listed = await request(port, { path: '/__zcode/annotations/tasks' });
    const groups = listed.json().groups;
    assert.equal(groups.length, 2);
    for (const group of groups) {
      // absolutePath 必须是真实存在的文件：复制提示词会把它直接交给模型
      assert.ok(path.isAbsolute(group.absolutePath), `absolutePath 应为绝对路径: ${group.absolutePath}`);
      await fs.access(group.absolutePath);
    }
    const campus = groups.find(g => g.page.url === pageB.url);
    assert.equal(campus.tasks.length, 1);
    assert.equal(campus.tasks[0].id, 'task_b');
  });
});

test('cross-page delete by groupId only removes tasks from that page group', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const groupIdB = await seedTwoPages(port);

    // 按组 id 删除 B 页任务（不带 pageUrl）：在其它页面的分组里点删除走的就是这条路
    const removed = await request(port, {
      method: 'POST',
      path: '/__zcode/annotations/delete',
      body: { groupId: groupIdB, ids: ['task_b'] },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.json().removed, 1);
    assert.equal(removed.json().fileRemoved, true, 'B 页任务清空后组文件应被移除');

    const listed = await request(port, { path: '/__zcode/annotations/tasks' });
    const groups = listed.json().groups;
    assert.equal(groups.length, 1, 'A 页任务组不受影响');
    assert.equal(groups[0].page.url, pageA.url);
    assert.equal(groups[0].tasks.length, 1);
  });
});

test('instruction edit for another page task lands in that page group, not the current one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const groupIdB = await seedTwoPages(port);
    const taskB = {
      ...makeTask(),
      id: 'task_b',
      instruction: '原始要求',
      element: { ...makeTask().element, selector: '#login-btn' },
    };

    // 客户端在 A 页编辑 B 页任务的指令：以 B 页面归组重新 append（幂等更新）。
    // 若按页面归组出错，任务会被错误写进 A 页的组文件或凭空新建组。
    const edited = await request(port, {
      method: 'POST',
      path: '/__zcode/annotations/append',
      body: { page: pageB, tasks: [{ ...taskB, instruction: '改为主色按钮' }] },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json().groupId, groupIdB, '必须写回 B 页自己的组');

    const listed = await request(port, { path: '/__zcode/annotations/tasks' });
    const groups = listed.json().groups;
    const groupA = groups.find(g => g.page.url === pageA.url);
    const groupB = groups.find(g => g.page.url === pageB.url);
    assert.equal(groupA.tasks.length, 1, 'A 页组不受其它页编辑影响');
    assert.equal(groupB.tasks.find(t => t.id === 'task_b').instruction, '改为主色按钮');
    assert.equal(groupB.tasks.length, 1, '同一任务的重复同步必须幂等，不得重复生成');
  });
});
