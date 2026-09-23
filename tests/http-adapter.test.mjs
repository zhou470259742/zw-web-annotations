import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAnnotationsMiddleware, injectAnnotatorScript } from '../scripts/runtime/adapters/http.mjs';
import { DEFAULT_DIR } from '../scripts/runtime/core/store.mjs';

function request(port, { method = 'GET', path: urlPath, body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: requestHeaders }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (rawBody != null) req.write(rawBody);
    else if (body) req.write(JSON.stringify(body));
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
    const health = await request(port, { path: '/__zw-web-annotations/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json().workspace, dir);
    assert.equal(health.json().endpoint, '/__zw-web-annotations');
    assert.equal(health.json().endpointManifestPath, path.join(dir, '.zwa', 'runtime', 'endpoint.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(health.json().endpointManifestPath, 'utf8')).endpoint, '/__zw-web-annotations');

    const saved = await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { page, tasks: [makeTask()] } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().added, 1);
    assert.match(saved.json().relativePath, /^\.zwa\/tasks\//);

    const listed = await request(port, { path: '/__zw-web-annotations/tasks' });
    assert.equal(listed.json().groups.length, 1);
    // 协议文件随运行时分发、与适配器同目录解析；提示词的执行要求地址来自这里
    assert.match(listed.json().protocolPath, /execution-protocol\.md$/);
  });

  // 落盘位置必须与 store 的规范目录一致
  const files = await fs.readdir(path.join(dir, DEFAULT_DIR));
  assert.equal(files.filter(f => f.endsWith('.json')).length, 1);
});

test('middleware serves the client script and rejects unknown routes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const client = await request(port, { path: '/__zw-web-annotations/client.js' });
    assert.equal(client.status, 200);
    assert.match(client.text, /mountAnnotator/);

    const missing = await request(port, { path: '/__zw-web-annotations/nope' });
    assert.equal(missing.status, 404);
  });
});

test('middleware returns 400 for invalid payload instead of crashing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const bad = await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { tasks: [makeTask()] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json().error, /page\.url/);
  });
});

test('injectAnnotatorScript adds the tag once', () => {
  const html = '<html><body><h1>x</h1></body></html>';
  const once = injectAnnotatorScript(html);
  assert.match(once, /data-zw-annotations/);
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
    assert.match(page.text, /\/__zw-web-annotations\/client\.js/);
    assert.match(page.text, /data-zw-annotations/);
    assert.match(page.text, /id="root"/, '原有内容不能被破坏');

    // client.js 必须是自带自动挂载的版本
    const client = await request(port, { path: '/__zw-web-annotations/client.js' });
    assert.equal(client.status, 200);
    assert.match(client.text, /__zwAutoMount/);
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
  await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { page: pageA, tasks: [makeTask()] } });
  const taskB = { ...makeTask(), id: 'task_b', element: { ...makeTask().element, selector: '#login-btn' } };
  const savedB = await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { page: pageB, tasks: [taskB] } });
  return savedB.json().groupId;
}

test('/tasks lists every page group with its absolute file path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    await seedTwoPages(port);

    const listed = await request(port, { path: '/__zw-web-annotations/tasks' });
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

test('/tasks carries the authoritative round summary so the client never infers it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    await seedTwoPages(port);

    const data = (await request(port, { path: '/__zw-web-annotations/tasks' })).json();
    // 客户端用它定进度分母：缺了它只能自己从任务里推断当前轮，旧轮未归档就会算错
    assert.ok(data.round && typeof data.round === 'object', '/tasks 必须返回 round 摘要');
    assert.ok('activeRound' in data.round, 'round.activeRound 键必须存在（可为 null）');
    assert.ok('complete' in data.round, 'round.complete 用于判断本轮是否可交付');
    assert.equal(typeof data.round.queued, 'number', 'round.queued 供面板显示下一轮条数');
    assert.ok(data.round.runner, 'round.runner 供面板显示处理者状态');
    // 未开轮（全部任务 round=null）时服务端必须明确说 activeRound 为 null，
    // 而不是把某个旧轮翻出来当成当前轮
    assert.equal(data.round.activeRound, null);
  });
});

test('cross-page delete by groupId only removes tasks from that page group', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const groupIdB = await seedTwoPages(port);

    // 按组 id 删除 B 页任务（不带 pageUrl）：在其它页面的分组里点删除走的就是这条路
    const removed = await request(port, {
      method: 'POST',
      path: '/__zw-web-annotations/delete',
      body: { groupId: groupIdB, ids: ['task_b'] },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.json().removed, 1);
    assert.equal(removed.json().fileRemoved, true, 'B 页任务清空后组文件应被移除');

    const listed = await request(port, { path: '/__zw-web-annotations/tasks' });
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
      path: '/__zw-web-annotations/append',
      body: { page: pageB, tasks: [{ ...taskB, instruction: '改为主色按钮' }] },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json().groupId, groupIdB, '必须写回 B 页自己的组');

    const listed = await request(port, { path: '/__zw-web-annotations/tasks' });
    const groups = listed.json().groups;
    const groupA = groups.find(g => g.page.url === pageA.url);
    const groupB = groups.find(g => g.page.url === pageB.url);
    assert.equal(groupA.tasks.length, 1, 'A 页组不受其它页编辑影响');
    assert.equal(groupB.tasks.find(t => t.id === 'task_b').instruction, '改为主色按钮');
    assert.equal(groupB.tasks.length, 1, '同一任务的重复同步必须幂等，不得重复生成');
  });
});

test('events endpoint pushes tasks-changed to SSE clients on task writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-'));
  await withServer(dir, async port => {
    const stream = await new Promise((resolve, reject) => {
      let buf = '';
      const req = http.request({ host: '127.0.0.1', port, path: '/__zw-web-annotations/events' }, res => {
        res.setEncoding('utf8');
        res.on('data', c => {
          buf += c;
          if (buf.includes('tasks-changed')) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', reject);
      req.end();
      // 连接建立后写入一条任务：store onChange → hub 推送 tasks-changed
      setTimeout(() => {
        request(port, {
          method: 'POST',
          path: '/__zw-web-annotations/append',
          body: { page, tasks: [makeTask()] },
        }).catch(() => {});
      }, 150);
      setTimeout(() => {
        req.destroy();
        reject(new Error('SSE 未在 5s 内推送 tasks-changed'));
      }, 5000);
    });
    assert.match(stream, /retry: 3000/);
    assert.match(stream, /tasks-changed/);
  });
});

test('middleware rejects cross-origin and non-JSON mutations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-security-'));
  await withServer(dir, async port => {
    const evilOrigin = await request(port, {
      method: 'POST', path: '/__zw-web-annotations/execution',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      rawBody: JSON.stringify({ mode: 'queue' }),
    });
    assert.equal(evilOrigin.status, 403);
    const wrongType = await request(port, {
      method: 'POST', path: '/__zw-web-annotations/execution',
      headers: { 'content-type': 'text/plain' }, rawBody: '{"mode":"queue"}',
    });
    assert.equal(wrongType.status, 415);
  });
});

test('task-agent header cannot write done, while main-thread path remains compatible', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-actor-'));
  await withServer(dir, async port => {
    const saved = await request(port, {
      method: 'POST', path: '/__zw-web-annotations/append', body: { page, tasks: [makeTask()] },
    });
    const groupId = saved.json().groupId;
    const base = `/__zw-web-annotations/${encodeURIComponent(groupId)}/tasks/task_1`;
    const headers = { 'x-zwa-client': 'task-agent' };
    assert.equal((await request(port, { method: 'PATCH', path: base, body: { status: 'doing' }, headers })).status, 200);
    assert.equal((await request(port, { method: 'PATCH', path: base, body: { status: 'review' }, headers })).status, 200);
    const rejected = await request(port, { method: 'PATCH', path: base, body: { status: 'done' }, headers });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json().error, /task-agent cannot mark done/);
    const accepted = await request(port, { method: 'PATCH', path: base, body: { status: 'done' } });
    assert.equal(accepted.status, 200);
  });
});

test('complete-round exposes obstacles when the current round is incomplete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-obstacles-'));
  await withServer(dir, async port => {
    const saved = await request(port, {
      method: 'POST', path: '/__zw-web-annotations/append', body: { page, tasks: [makeTask()] },
    });
    const groupId = saved.json().groupId;
    const base = `/__zw-web-annotations/${encodeURIComponent(groupId)}/tasks/task_1`;
    await request(port, { method: 'PATCH', path: base, body: { status: 'doing' }, headers: { 'x-zwa-client': 'task-agent' } });
    const summary = (await request(port, { path: '/__zw-web-annotations/execution' })).json().round;
    const result = await request(port, { method: 'POST', path: '/__zw-web-annotations/complete-round', body: { round: summary.activeRound } });
    assert.equal(result.status, 200);
    assert.equal(result.json().action, 'blocked');
    assert.deepEqual(result.json().obstacles, [{ id: 'task_1', status: 'doing' }]);
  });
});
test('http custom route derives the client path and writes the manifest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-endpoint-'));
  const server = http.createServer(createAnnotationsMiddleware({ workspace: dir, route: '/custom-zwa' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const health = await request(port, { path: '/custom-zwa/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json().endpoint, '/custom-zwa');
    assert.equal(health.json().clientPath, '/custom-zwa/client.js');
    assert.equal(health.json().endpointManifestPath, path.join(dir, '.zwa', 'runtime', 'endpoint.json'));
    const client = await request(port, { path: '/custom-zwa/client.js' });
    assert.equal(client.status, 200);
    const manifest = JSON.parse(await fs.readFile(health.json().endpointManifestPath, 'utf8'));
    assert.equal(manifest.endpoint, '/custom-zwa');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('board page is served on the configured route with relative data addresses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-board-'));
  const server = http.createServer(createAnnotationsMiddleware({ workspace: dir, route: '/custom-zwa' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const board = await request(port, { path: '/custom-zwa/board' });
    assert.equal(board.status, 200);
    assert.match(board.headers['content-type'] || '', /text\/html/);
    assert.match(board.text, /标注任务看板/);
    assert.match(board.text, /fetch\('\.\/tasks'/, '看板用相对地址取数，天然跟随自定义 endpoint');
    assert.match(board.text, /EventSource\('\.\/events'\)/, 'SSE 实时刷新');
    // 六个状态列齐全
    for (const label of ['待处理', '进行中', '待验收', '已完成', '已阻塞', '已取消']) {
      assert.match(board.text, new RegExp(label));
    }
    // 布局切换菜单：看板/表格两个视图入口随页面分发
    for (const viewLabel of ['看板', '表格']) {
      assert.match(board.text, new RegExp(viewLabel));
    }
    assert.match(board.text, /view-menu/);
    // 常用过滤工具行：搜索、页面下拉、归档开关、状态 chips
    assert.match(board.text, /filter-q/);
    assert.match(board.text, /filter-page/);
    assert.match(board.text, /filter-arch/);
    assert.match(board.text, /status-chips/);
    // XSS 契约：任务数据必须经 esc() 转义后才能进 innerHTML
    assert.match(board.text, /function esc\(/);
    assert.match(board.text, /esc\(t\.instruction/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('GET /archive serves the read-only archive overview for the board', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-archview-'));
  await withServer(dir, async port => {
    const saved = await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { page, tasks: [makeTask()] } });
    assert.equal(saved.status, 200);
    const groupId = saved.json().groupId;
    const patch = status =>
      request(port, { method: 'PATCH', path: `/__zw-web-annotations/${groupId}/tasks/task_1`, body: { status } });
    assert.equal((await patch('doing')).status, 200);
    assert.equal((await patch('review')).status, 200);
    assert.equal((await patch('done')).status, 200);
    // 两阶段归档：done 留在 live 等人工归档，archived 才进归档文件
    assert.equal((await patch('archived')).status, 200);

    const empty = await request(port, { path: '/__zw-web-annotations/archive' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json().archives, [], '归档前总览为空');

    const archived = await request(port, { method: 'POST', path: '/__zw-web-annotations/archive', body: { groupId } });
    assert.equal(archived.status, 200);

    const view = await request(port, { path: '/__zw-web-annotations/archive' });
    assert.equal(view.status, 200);
    assert.equal(view.json().archives.length, 1);
    assert.equal(view.json().archives[0].taskCount, 1);
    assert.equal(view.json().archives[0].tasks[0].id, 'task_1');
    assert.equal(view.json().archives[0].tasks[0].status, 'archived');
    assert.ok(!('history' in view.json().archives[0].tasks[0]), '总览不携带历史记录大字段');

    // 任务粒度删除：按 id 只删归档里的这一条
    const granular = await request(port, {
      method: 'POST',
      path: '/__zw-web-annotations/purge-archive',
      body: { groupId, ids: ['task_1'] },
    });
    assert.equal(granular.status, 200);
    assert.equal(granular.json().removed, 1);
    assert.equal(granular.json().remaining, 0);
    const after = await request(port, { path: '/__zw-web-annotations/archive' });
    assert.deepEqual(after.json().archives, [], '删到 0 条后归档文件随之移除');
  });
});
test('blocked task reopens to todo through the PATCH endpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-reopen-'));
  await withServer(dir, async port => {
    const saved = await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { page, tasks: [makeTask()] } });
    const groupId = saved.json().groupId;
    const patch = status =>
      request(port, { method: 'PATCH', path: `/__zw-web-annotations/${groupId}/tasks/task_1`, body: { status } });
    await patch('doing');
    assert.equal((await patch('blocked')).status, 200);
    const reopened = await patch('todo');
    assert.equal(reopened.status, 200, 'blocked→todo 是留给人工的重新入列转移');
    assert.equal(reopened.json().task.status, 'todo');
  });
});

/**
 * 验收端点：主线程人工路径能写 done，子 agent 身份被拒。
 * 这条锁死「让用户去浏览器点验收」那个死循环的修复——界面上有按钮，
 * 接口也认主线程，模型不必再把验收甩给用户。
 */
test('accept-tasks promotes review to done for the human path and rejects task-agent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-accept-'));
  await withServer(dir, async port => {
    const saved = await request(port, { method: 'POST', path: '/__zw-web-annotations/append', body: { page, tasks: [makeTask()] } });
    const groupId = saved.json().groupId;
    const base = `/__zw-web-annotations/${encodeURIComponent(groupId)}/tasks/task_1`;
    // 任务先走到待验收：这是子 agent 交活后的常态
    await request(port, { method: 'PATCH', path: base, body: { status: 'doing' } });
    await request(port, { method: 'PATCH', path: base, body: { status: 'review' } });

    // 子 agent 自查不算验收
    const selfCheck = await request(port, {
      method: 'POST', path: '/__zw-web-annotations/accept-tasks',
      body: { ids: ['task_1'] }, headers: { 'x-zwa-client': 'task-agent' },
    });
    assert.equal(selfCheck.status, 400);
    assert.match(selfCheck.json().error, /task-agent cannot accept tasks/);

    // 主线程人工路径放行
    const accepted = await request(port, {
      method: 'POST', path: '/__zw-web-annotations/accept-tasks', body: { ids: ['task_1'] },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json().accepted, 1);
    assert.deepEqual(accepted.json().pending, []);

    const listed = await request(port, { path: '/__zw-web-annotations/tasks' });
    const task = listed.json().groups[0].tasks.find(t => t.id === 'task_1');
    assert.equal(task.status, 'done');
    assert.ok(task.completedAt, '验收时刻落盘');
  });
});
test('GET/POST /board-prefs persists the board theme inside the project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-http-prefs-'));
  await withServer(dir, async port => {
    const empty = await request(port, { path: '/__zw-web-annotations/board-prefs' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json().prefs, {});

    const saved = await request(port, { method: 'POST', path: '/__zw-web-annotations/board-prefs', body: { theme: 'light' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().prefs.theme, 'light');

    const bad = await request(port, { method: 'POST', path: '/__zw-web-annotations/board-prefs', body: { theme: 'solarized' } });
    assert.equal(bad.status, 400, '白名单之外的主题值拒绝');

    const again = await request(port, { path: '/__zw-web-annotations/board-prefs' });
    assert.equal(again.json().prefs.theme, 'light');
  });
  const raw = JSON.parse(await fs.readFile(path.join(dir, '.zwa', 'runtime', 'board-prefs.json'), 'utf8'));
  assert.equal(raw.theme, 'light', '偏好确实落盘在项目里');
});
test('Vite custom endpoint uses the configured route prefix', async () => {
  const { zwAnnotations } = await import('../scripts/runtime/vite/index.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-vite-endpoint-'));
  try {
    const plugin = zwAnnotations({ workspace: dir, endpoint: '/custom-zwa' });
    let middleware;
    const server = { watcher: { add() {}, on() {} }, ws: { send() {} }, middlewares: { use(fn) { middleware = fn; } } };
    plugin.configureServer(server);
    const req = { url: '/custom-zwa/health', method: 'GET', headers: { host: 'localhost:5173' } };
    let body = '';
    const res = { statusCode: 0, setHeader() {}, end(value) { body = value || ''; } };
    await middleware(req, res, () => { throw new Error('unexpected next'); });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(body).endpoint, '/custom-zwa');
    assert.equal(JSON.parse(body).endpointManifestPath, path.join(dir, '.zwa', 'runtime', 'endpoint.json'));
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, '.zwa', 'runtime', 'endpoint.json'), 'utf8')).endpoint, '/custom-zwa');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
