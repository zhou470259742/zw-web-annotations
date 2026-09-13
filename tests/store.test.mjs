import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, pageKey, validateGroup, buildSendPayload, ARCHIVE_DIRNAME } from '../scripts/runtime/core/store.mjs';

const page = { url: 'https://example.com/login', title: '登录页' };

/** 1x1 PNG，与 images.test.mjs 使用相同素材。 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function task(overrides = {}) {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: 'task_abc',
    instruction: '调整宽度',
    status: 'todo',
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
    result: null,
    element: {
      tagName: 'button',
      accessibleName: '登录',
      text: '登录',
      selector: '#login',
      xpath: '/html/body/button[1]',
      parentSummary: '',
      domSnippet: '<button id="login">登录</button>',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      frame: 'top',
    },
    history: [{ at, event: 'created' }],
    ...overrides,
  };
}

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-annot-'));
  return createStore(dir);
}

test('validateGroup accepts a complete group and rejects malformed input', () => {
  const group = { version: '1.0', id: 'g1', createdAt: 'x', updatedAt: 'x', page, tasks: [task()] };
  assert.equal(validateGroup(group).id, 'g1');
  assert.throws(() => validateGroup({ id: 'x', tasks: [] }));
  assert.throws(() => validateGroup({ ...group, tasks: [task({ status: 'wrong' })] }));
});

test('pageKey is stable, filesystem safe, and differs per URL', () => {
  const a = pageKey('https://example.com/a?b=1');
  assert.equal(a, pageKey('https://example.com/a?b=1'));
  assert.match(a, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(a, pageKey('https://example.com/a?b=2'));
});

test('appendTasks writes JSON to the workspace and is idempotent', async () => {
  const store = await tempStore();
  const first = await store.appendTasks({ page, tasks: [task()] });
  assert.equal(first.added, 1);
  assert.equal(first.updated, 0);
  assert.equal(first.group.tasks.length, 1);

  // 同一任务再次保存：更新而不是新增
  const second = await store.appendTasks({ page, tasks: [task({ instruction: '调整高度' })] });
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.group.tasks.length, 1);
  assert.equal(second.group.tasks[0].instruction, '调整高度');

  const files = (await fs.readdir(store.taskDir)).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
});

test('appendTasks merges by selector when task id changes', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  // 模拟组件重新加载后 ID 变化，但选择器不变
  const result = await store.appendTasks({ page, tasks: [task({ id: 'task_changed', instruction: '改写文字' })] });
  assert.equal(result.group.tasks.length, 1);
  assert.equal(result.group.tasks[0].instruction, '改写文字');
});

test('appendTasks rejects input without page url or tasks', async () => {
  const store = await tempStore();
  await assert.rejects(() => store.appendTasks({ tasks: [task()] }), /page\.url/);
  await assert.rejects(() => store.appendTasks({ page, tasks: [] }), /no tasks/);
});

test('updateTask advances status with history and timestamps', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);
  const doing = await store.updateTask(id, { taskId: 'task_abc', status: 'doing' });
  assert.equal(doing.task.status, 'doing');
  assert.ok(doing.task.startedAt);
  const done = await store.updateTask(id, { taskId: 'task_abc', status: 'done', result: '已改为 200px' });
  assert.equal(done.task.status, 'done');
  assert.ok(done.task.completedAt);
  assert.equal(done.task.result, '已改为 200px');
  assert.ok(done.task.history.some(h => h.event === 'status_changed'));
  await assert.rejects(() => store.updateTask(id, { taskId: 'task_abc', status: 'nope' }), /invalid status/);
});

test('listGroups skips malformed files instead of failing', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  await fs.writeFile(path.join(store.taskDir, 'broken.json'), '{ not json', 'utf8');
  const groups = await store.listGroups();
  assert.equal(groups.length, 1);
});

test('buildSendPayload includes only pending tasks with locating context', () => {
  const group = {
    version: '1.0',
    id: 'g1',
    createdAt: 'x',
    updatedAt: 'x',
    page,
    tasks: [task(), task({ id: 'task_done', status: 'done', instruction: '已完成项' })],
  };
  const payload = buildSendPayload(group);
  assert.match(payload, /调整宽度/);
  assert.match(payload, /#login/);
  assert.doesNotMatch(payload, /已完成项/);
});

/**
 * 缺陷 1 回归：浏览器端从不上报有意义的状态变化（创建时写死 todo），
 * 全量同步若采纳传入 status，模型刚回写的 done 会在用户下一次标注时
 * 被冲回 todo，模型的工作被反复作废。
 */
test('browser full sync keeps model-written status and result', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'done', result: '已改为 200px' });

  // 模拟浏览器再次全量同步：localStorage 里的任务原样上报，status 仍是 todo
  const synced = await store.appendTasks({ page, tasks: [task()] });
  assert.equal(synced.updated, 1);
  assert.equal(synced.group.tasks[0].status, 'done', '浏览器同步不得把 done 冲回 todo');
  assert.equal(synced.group.tasks[0].result, '已改为 200px');
});

/**
 * 缺陷 2 回归：attachments/ 是所有页面共用的目录，prune 的保活集合
 * 若只来自「传入的这一组任务」，删除页面 A 会把页面 B 仍在引用的
 * 附件一并删掉，造成静默数据丢失。
 */
test('deleting page A keeps attachments still referenced by page B', async () => {
  const store = await tempStore();
  const pageB = { url: 'https://example.com/other', title: '其他页' };
  const a = await store.appendTasks({ page, tasks: [task({ id: 'task_a', images: [{ id: 'i1', dataUrl: PNG_1PX }] })] });
  const b = await store.appendTasks({
    page: pageB,
    tasks: [task({ id: 'task_b', element: { ...task().element, selector: '#b' }, images: [{ id: 'i1', dataUrl: PNG_1PX }] })],
  });
  assert.equal((await fs.readdir(store.attachmentsDir)).length, 2);

  await store.removeTasks(a.group.id, { all: true });

  const remaining = await fs.readdir(store.attachmentsDir);
  assert.deepEqual(remaining, ['task_b-i1.png'], '页面 B 的附件不能被连带删除');
  await fs.access(path.join(store.workspace, b.group.tasks[0].images[0].file));
});

/**
 * 处理中的任务必须受保护：它已被某个处理者领取、正在改代码，
 * 删掉或改掉指令会让回写的 done 与结果失去对应记录，用户也看不到
 * 「刚才在改什么」。删除应被拒并回报被跳过的 id，而不是静默照做。
 */
test('removeTasks refuses to delete a doing task and reports it as skipped', async () => {
  const store = await tempStore();
  const saved = await store.appendTasks({
    page,
    tasks: [
      task({ id: 'task_doing', images: [{ id: 'i1', dataUrl: PNG_1PX }] }),
      task({ id: 'task_todo', element: { ...task().element, selector: '#todo' } }),
    ],
  });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_doing', status: 'doing' });

  const result = await store.removeTasks(id, { ids: ['task_doing'] });

  assert.equal(result.removed, 0, '处理中的任务不得被删除');
  assert.deepEqual(result.skipped, ['task_doing'], '应回报被跳过的任务，便于如实提示用户');
  const group = await store.readGroup(id);
  assert.deepEqual(group.tasks.map(t => t.id).sort(), ['task_doing', 'task_todo']);
  // 保住了任务，就必须同时保住它的附件
  assert.equal((await fs.readdir(store.attachmentsDir)).length, 1);
  await fs.access(path.join(store.workspace, saved.group.tasks[0].images[0].file));
});

test('clearing a page keeps doing tasks instead of wiping the whole file', async () => {
  const store = await tempStore();
  const saved = await store.appendTasks({
    page,
    tasks: [
      task({ id: 'task_doing' }),
      task({ id: 'task_todo', element: { ...task().element, selector: '#todo' } }),
    ],
  });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_doing', status: 'doing' });

  const result = await store.removeTasks(id, { all: true });

  assert.equal(result.fileRemoved, false, '尚有任务在跑时不能删掉整个组文件');
  assert.equal(result.removed, 1);
  assert.deepEqual(result.skipped, ['task_doing']);
  const group = await store.readGroup(saved.group.id);
  assert.deepEqual(group.tasks.map(t => t.id), ['task_doing']);
  assert.equal(group.tasks[0].status, 'doing');
});

test('force removes a doing task when the caller explicitly asks', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ id: 'task_doing' })] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_doing', status: 'doing' });

  const result = await store.removeTasks(id, { ids: ['task_doing'], force: true });

  assert.equal(result.removed, 1, '显式 force 时应能删除');
  assert.deepEqual(result.skipped, []);
  assert.equal(result.fileRemoved, true);
});

/**
 * 指令被改动会与处理者正在执行的代码不一致，其 done 结果描述的将是另一件事。
 * 所以已存在且处于 doing 的任务，不接受浏览器全量同步带来的指令覆盖。
 */
test('appendTasks does not overwrite the instruction of a doing task', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ instruction: '改成：登录' })] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'doing' });

  const synced = await store.appendTasks({ page, tasks: [task({ instruction: '改成：注册' })] });

  assert.equal(synced.group.tasks[0].instruction, '改成：登录', '处理中的指令不得被覆盖');
  assert.equal(synced.group.tasks[0].status, 'doing');
  assert.ok(
    !synced.group.tasks[0].history.some(h => h.event === 'instruction_updated'),
    '被拒绝的修改不应留下历史记录',
  );
});

test('appendTasks still updates the instruction of a todo task', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ instruction: '旧要求' })] });
  const id = pageKey(page.url);

  const synced = await store.appendTasks({ page, tasks: [task({ instruction: '新要求' })] });

  assert.equal(synced.group.tasks[0].instruction, '新要求', '未处理的任务仍可改指令');
  await store.readGroup(id);
});

/**
 * 缺陷 3 回归：归档把命中状态的任务移出当前组、写入归档文件，
 * 归档任务的附件仍被引用，不能被 prune 当垃圾清理。
 */
test('archiveTasks moves done/cancelled tasks into the archive file', async () => {
  const store = await tempStore();
  await store.appendTasks({
    page,
    tasks: [
      task({ id: 'task_done', images: [{ id: 'i1', dataUrl: PNG_1PX }] }),
      task({ id: 'task_open', element: { ...task().element, selector: '#open' } }),
      task({ id: 'task_cancel', element: { ...task().element, selector: '#cancel' }, status: 'cancelled' }),
    ],
  });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_done', status: 'done' });

  const result = await store.archiveTasks(id);
  assert.equal(result.archived, 2, '默认归档 done 与 cancelled');
  assert.equal(result.remaining, 1);
  assert.equal(result.fileRemoved, false);
  assert.ok(result.archiveFile.startsWith(path.join(store.taskDir, ARCHIVE_DIRNAME)));

  const live = await store.readGroup(id);
  assert.deepEqual(live.tasks.map(t => t.id), ['task_open']);
  // 归档文件沿用任务组结构，必须能被同一套 schema 校验读回
  const archived = validateGroup(JSON.parse(await fs.readFile(result.archiveFile, 'utf8')));
  assert.deepEqual(archived.tasks.map(t => t.id).sort(), ['task_cancel', 'task_done']);
  assert.equal(archived.tasks.find(t => t.id === 'task_done').status, 'done');
  // 归档副本仍保留附件引用，这正是附件不能被 prune 删除的原因
  assert.match(archived.tasks.find(t => t.id === 'task_done').images[0].file, /attachments\//);
  assert.equal((await fs.readdir(store.attachmentsDir)).length, 1, '归档任务的附件仍被引用');
});

test('re-archiving the same task updates the archive copy instead of duplicating', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ id: 'task_a', status: 'done' })] });
  const id = pageKey(page.url);
  const first = await store.archiveTasks(id);
  assert.equal(first.archived, 1);
  assert.equal(first.fileRemoved, true, '组被清空后应删除组文件');

  // 同一任务重新出现在活动组（例如手工恢复），再次归档应更新而非重复追加
  await store.writeGroup({ version: '1.0', id, createdAt: 'x', updatedAt: 'x', page, tasks: [task({ id: 'task_a', status: 'done', result: 'v2' })] });
  const second = await store.archiveTasks(id);
  assert.equal(second.archived, 1);
  const archived = JSON.parse(await fs.readFile(second.archiveFile, 'utf8'));
  assert.equal(archived.tasks.length, 1, '按 task id 去重，不得重复追加');
  assert.equal(archived.tasks[0].result, 'v2', '再次归档应更新副本');
});

test('archiveTasks on a missing group is idempotent', async () => {
  const store = await tempStore();
  const result = await store.archiveTasks('no-such-group');
  assert.equal(result.archived, 0);
  assert.equal(result.remaining, 0);
  assert.equal(result.fileRemoved, false);
  assert.equal(result.archiveFile, null);
});

/**
 * 防复活回归：归档后浏览器 localStorage 里的过期缓冲会被全量重新同步，
 * 若走新建分支会把已归档任务重新建成 todo，归档就形同虚设。
 */
test('appendTasks does not resurrect archived tasks from the stale browser buffer', async () => {
  const store = await tempStore();
  await store.appendTasks({
    page,
    tasks: [
      task({ id: 'task_done' }),
      task({ id: 'task_open', element: { ...task().element, selector: '#open' } }),
    ],
  });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_done', status: 'done' });
  await store.archiveTasks(id);

  // 全量同步带着已归档的 task_done 回来（fixture 的 updatedAt 早于归档副本）
  const synced = await store.appendTasks({
    page,
    tasks: [
      task({ id: 'task_done' }),
      task({ id: 'task_open', element: { ...task().element, selector: '#open' } }),
    ],
  });
  assert.equal(synced.added, 0, '已归档任务不得被过期缓冲复活');
  assert.deepEqual(synced.group.tasks.map(t => t.id), ['task_open']);
});

/**
 * 过期缓冲全部命中归档时，服务端不会写出任何文件，必须用 skipped 明确
 * 告知调用方；否则「复制提示词」会把返回的 path 当成真实地址复制出去，
 * 模型照着读只会扑空。
 */
test('appendTasks flags skipped when nothing was written so no bogus path is reported', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ id: 'task_done' })] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_done', status: 'done' });
  await store.archiveTasks(id);

  const synced = await store.appendTasks({ page, tasks: [task({ id: 'task_done' })] });
  assert.equal(synced.skipped, true, '没有写出文件时必须标出 skipped');
  assert.equal(synced.added, 0);
  assert.equal(synced.updated, 0);
  await assert.rejects(fs.access(synced.path), 'skipped 时该路径不应存在');
});

/**
 * stableTaskId(url, selector) 是确定性的：重新标注同一元素得到的是
 * 同一个 id（客户端表现为编辑旧任务并刷新 updatedAt）。防复活只能拦
 * 「严格早于归档副本」的过期缓冲，不能拦真正的重新标注。
 *
 * 时间戳必须显式写成「远晚于归档副本」，不能靠 `new Date()` 与归档时刻
 * 抢毫秒：两者落在同一毫秒时判据无法区分新旧，测试会随机失败。这里把
 * 未来时间写死，测的就是判据本身而不是运行速度。
 */
test('re-annotating an archived element with a newer local edit still lands', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'done' });
  const first = await store.archiveTasks(id);
  assert.equal(first.fileRemoved, true);

  const resynced = await store.appendTasks({
    page,
    tasks: [task({ instruction: '重新标注', updatedAt: '2099-01-01T00:00:00.000Z' })],
  });
  assert.equal(resynced.added, 1);
  assert.equal(resynced.group.tasks[0].status, 'todo');
});

/**
 * 归档副本与传入任务时间戳相同时，必须保留用户的改动而不是当过期缓冲丢掉。
 * 把一次真实的重新标注静默丢弃是无声的数据丢失，而误复活一个已归档任务
 * 是可见的、再归档一次即可——两害相权，判据取严格早于。
 */
test('equal timestamps keep the user edit instead of dropping it as stale', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'done' });
  const { archiveFile } = await store.archiveTasks(id);

  // 取归档副本的 updatedAt，用它作为「同一时刻」的编辑时间
  const archived = JSON.parse(await fs.readFile(archiveFile, 'utf8'));
  const stamp = archived.tasks[0].updatedAt;

  const resynced = await store.appendTasks({
    page,
    tasks: [task({ instruction: '同时刻编辑', updatedAt: stamp })],
  });
  assert.equal(resynced.added, 1, '时间戳无法区分新旧的改动应被保留，不能静默丢弃');
});

test('purgeArchive removes a single archive file and its orphaned attachments', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ images: [{ id: 'i1', dataUrl: PNG_1PX }] })] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'done' });
  const result = await store.archiveTasks(id);
  assert.equal(result.fileRemoved, true);
  assert.equal((await fs.readdir(store.attachmentsDir)).length, 1, '归档引用保住了附件');

  const purged = await store.purgeArchive(id);
  assert.equal(purged.purged, 1);
  assert.equal(purged.filesRemoved, 1);
  await assert.rejects(() => fs.stat(result.archiveFile), /ENOENT/);
  assert.deepEqual(await fs.readdir(store.attachmentsDir), [], '归档删除后附件失去引用，应被清理');

  const again = await store.purgeArchive(id);
  assert.equal(again.purged, 0);
  assert.equal(again.filesRemoved, 0, '重复清空应幂等');
});

test('purgeArchive without a group clears the whole archive directory', async () => {
  const store = await tempStore();
  const pageB = { url: 'https://example.com/other', title: '其他页' };
  await store.appendTasks({ page, tasks: [task({ status: 'done' })] });
  await store.appendTasks({ page: pageB, tasks: [task({ id: 'task_b', element: { ...task().element, selector: '#b' }, status: 'done' })] });
  await store.archiveTasks(pageKey(page.url));
  await store.archiveTasks(pageKey(pageB.url));

  const purged = await store.purgeArchive();
  assert.equal(purged.purged, 2);
  assert.equal(purged.filesRemoved, 2);
  await assert.rejects(() => fs.stat(store.archiveDir), /ENOENT/);
});

/** SSE 实时推送的驱动源：任务数据的每次变更都要触发 onChange 回调。 */
test('store notifies onChange after every task mutation (doing 锁照常生效)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-annot-'));
  let calls = 0;
  const store = createStore(dir, { onChange: () => { calls++; } });

  await store.appendTasks({ page, tasks: [task()] });
  await store.updateTask(pageKey(page.url), { taskId: 'task_abc', status: 'doing' });
  assert.equal(calls, 2, 'append 与 doing 回写各触发一次');

  // doing 锁：无 force 的删除会重写文件保留处理中任务，同样触发通知
  const kept = await store.removeTasks(pageKey(page.url), { all: true });
  assert.deepEqual(kept.skipped, ['task_abc']);
  assert.equal(calls, 3);
  await fs.access(store.fileFor(pageKey(page.url)));

  // force 删除真正移除文件，触发最后一次通知
  await store.removeTasks(pageKey(page.url), { all: true, force: true });
  assert.equal(calls, 4);
  await assert.rejects(() => fs.access(store.fileFor(pageKey(page.url))), /ENOENT/);

  // 幂等的重复删除没有写出任何文件，不应触发通知
  await store.removeTasks(pageKey(page.url), { all: true });
  assert.equal(calls, 4);
});

/* ---------------- 待验收（review）状态 ---------------- */

test('updateTask accepts review and records reviewAt without completing', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);

  const { task: t2 } = await store.updateTask(id, { taskId: 'task_abc', status: 'review', result: '已改 Home.vue:3' });

  assert.equal(t2.status, 'review');
  assert.ok(t2.reviewAt, '待验收应记录提交时刻');
  assert.equal(t2.completedAt, null, '待验收不等于完成，不能写 completedAt');
  assert.ok(t2.history.some(h => h.event === 'status_changed' && h.detail === 'review'));
});

test('review then done completes the task and keeps both timestamps', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);

  await store.updateTask(id, { taskId: 'task_abc', status: 'review' });
  const { task: t2 } = await store.updateTask(id, { taskId: 'task_abc', status: 'done' });

  assert.equal(t2.status, 'done');
  assert.ok(t2.reviewAt, '验收过程不应抹掉提交时刻');
  assert.ok(t2.completedAt);
});

/**
 * 待验收的任务被改了要求：已改的代码是按旧要求做的，不再作数，
 * 必须退回 todo 重新走一遍。否则进度条会一直把这份「开发完成」算进去，
 * 而它对应的需求其实已经变了。
 */
test('changing the instruction of a review task sends it back to todo', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ instruction: '改成：登录' })] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'review' });

  const synced = await store.appendTasks({ page, tasks: [task({ instruction: '改成：注册' })] });
  const t2 = synced.group.tasks[0];

  assert.equal(t2.instruction, '改成：注册', '待验收的任务允许改要求');
  assert.equal(t2.status, 'todo', '需求变了就得重做，不能继续算作已完成');
  assert.equal(t2.reviewAt, null, '退回后清掉提交时刻');
  assert.ok(
    t2.history.some(h => h.event === 'status_changed' && h.detail === 'todo' && h.reason === 'instruction changed'),
    '退回原因要留在历史里，便于回溯',
  );
});

test('a review task keeps its status when the instruction is unchanged', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ instruction: '改成：登录' })] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'review' });

  const synced = await store.appendTasks({ page, tasks: [task({ instruction: '改成：登录' })] });
  assert.equal(synced.group.tasks[0].status, 'review', '重同步同一内容不得把待验收打回待处理');
});

test('a done task is not resurrected by re-sync after a review round trip', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);
  await store.updateTask(id, { taskId: 'task_abc', status: 'review' });
  await store.updateTask(id, { taskId: 'task_abc', status: 'done' });

  const synced = await store.appendTasks({ page, tasks: [task()] });
  assert.equal(synced.group.tasks[0].status, 'done', 'done 不得被浏览器同步冲回 todo');
});

/* ---------------- 并发写串行化 ---------------- */

/**
 * 回归：用户标注与子 agent 回写状态并发的丢写。
 *
 * 每个变更原本是「读文件 → 改内存 → 写回整份文件」，无版本校验。并发时
 * 两者基于同一份旧快照各写各的，后写的覆盖先写的——实测 30/30 会让 agent
 * 回写的 done 被回退成 doing（另有一种较低频的失败是用户新标注整条消失）。
 * 修复方式是把对外写操作串到同一条 promise 链上（见 store.mjs queueWrite）。
 */
test('concurrent updateTask and appendTasks do not lose each other\'s writes', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task({ instruction: '改A', status: 'doing' })] });
  const id = pageKey(page.url);

  // 模拟「agent 回写 done」与「用户新增标注 B」几乎同时到达
  await Promise.all([
    store.updateTask(id, { taskId: 'task_abc', status: 'done', result: 'A 改完了' }),
    store.appendTasks({
      page,
      tasks: [
        task({ instruction: '改A', status: 'doing' }),
        task({ id: 'task_new', instruction: '新增B', element: { ...task().element, selector: '#new' } }),
      ],
    }),
  ]);

  const group = await store.readGroup(id);
  const a = group.tasks.find(t => t.id === 'task_abc');
  const b = group.tasks.find(t => t.id === 'task_new');

  assert.equal(a.status, 'done', 'agent 回写的 done 不得被并发的 append 回退');
  assert.ok(a.result, 'agent 写的结果不得丢失');
  assert.ok(b, '用户并发新增的标注不得被吞掉');
  assert.equal(b.instruction, '新增B');
});

/** 反复并发，确认串行化稳定（单次通过可能只是调度巧合）。 */
test('write serialization holds across repeated concurrent rounds', async () => {
  const store = await tempStore();
  const id = pageKey(page.url);
  await store.appendTasks({ page, tasks: [task({ instruction: '改A' })] });

  for (let round = 0; round < 12; round++) {
    await store.updateTask(id, { taskId: 'task_abc', status: 'doing' });
    await Promise.all([
      store.updateTask(id, { taskId: 'task_abc', status: 'done' }),
      store.appendTasks({ page, tasks: [task({ instruction: '改A', status: 'doing' })] }),
    ]);
    const group = await store.readGroup(id);
    assert.equal(
      group.tasks.find(t => t.id === 'task_abc').status,
      'done',
      `第 ${round + 1} 轮并发后状态被回退`,
    );
    await store.updateTask(id, { taskId: 'task_abc', status: 'todo' });
  }
});

/** 队列不能让失败卡住后续写入：前一个写抛错后，后面的仍要正常完成。 */
test('a failed write does not block the following writes', async () => {
  const store = await tempStore();
  await store.appendTasks({ page, tasks: [task()] });
  const id = pageKey(page.url);

  const failed = store.updateTask(id, { taskId: '不存在的任务', status: 'done' }).catch(e => e);
  const ok = store.updateTask(id, { taskId: 'task_abc', status: 'review' });
  // 两个都要先 await：队列是异步的，读文件必须等后续写入真正落盘。
  await failed;
  await ok;

  const group = await store.readGroup(id);
  assert.equal(group.tasks[0].status, 'review', '前一个写失败后，后续写入仍应生效');
});

/* ---------------- 轮次（round）定稿与排队 ---------------- */

/**
 * 轮次定稿的时刻是「模型开始处理」（首个 doing 写入），不是复制提示词：
 * 复制之后、开始处理之前，用户仍可继续新增需求——定稿时文件里的全部
 * 待处理任务一并纳入本轮。
 */
test('first doing freezes the round: whole pending set joins at once', async () => {
  const store = await tempStore();
  const id = pageKey(page.url);
  await store.appendTasks({ page, tasks: [
    task({ id: 'task_A', element: { ...task().element, selector: '#a' } }),
    task({ id: 'task_B', instruction: 'B', element: { ...task().element, selector: '#b' } }),
  ] });

  await store.updateTask(id, { taskId: 'task_A', status: 'doing' });

  const group = await store.readGroup(id);
  const a = group.tasks.find(t => t.id === 'task_A');
  const b = group.tasks.find(t => t.id === 'task_B');
  assert.equal(a.round, 1);
  assert.equal(b.round, 1, '定稿时全部待处理任务一并纳入本轮（模型读取的就是这个集合）');
  assert.equal(group.meta.round, 1);
});

test('annotations added after the freeze stay queued for the next round', async () => {
  const store = await tempStore();
  const id = pageKey(page.url);
  await store.appendTasks({ page, tasks: [task({ instruction: '首轮', element: { ...task().element, selector: '#a' } })] });
  await store.updateTask(id, { taskId: 'task_abc', status: 'doing' }); // 定稿

  // 定稿之后新增的批注（模拟处理中新增标注）
  await store.appendTasks({ page, tasks: [
    task({ id: 'task_late', instruction: '后加的', element: { ...task().element, selector: '#late' } }),
  ] });

  const group = await store.readGroup(id);
  const late = group.tasks.find(t => t.id === 'task_late');
  assert.equal(late.round, undefined, '后加的批注不带轮次号（排队下一轮）');
});

test('a round-less task picked up mid-round joins the current round', async () => {
  const store = await tempStore();
  const id = pageKey(page.url);
  await store.appendTasks({ page, tasks: [task({ instruction: '首轮', element: { ...task().element, selector: '#a' } })] });
  await store.updateTask(id, { taskId: 'task_abc', status: 'doing' }); // 定稿，round=1
  await store.appendTasks({ page, tasks: [
    task({ id: 'task_late', instruction: '处理中新增', element: { ...task().element, selector: '#late' } }),
  ] });

  // 某 agent 实际接手了这条后加任务（置为 doing）→ 并入当前轮，进度如实反映
  await store.updateTask(id, { taskId: 'task_late', status: 'doing' });
  const group = await store.readGroup(id);
  assert.equal(group.tasks.find(t => t.id === 'task_late').round, 1);
});

test('round numbering is monotonically increasing across rounds', async () => {
  const store = await tempStore();
  const id = pageKey(page.url);
  await store.appendTasks({ page, tasks: [task({ instruction: 'r1', element: { ...task().element, selector: '#a' } })] });
  await store.updateTask(id, { taskId: 'task_abc', status: 'doing' });
  const first = (await store.readGroup(id)).tasks[0].round;

  // 第一轮完成并归档，随后重新标注同一元素进入第二轮。
  // fixture 必须在归档**之后**构造：真实用户是处理完成后才重新标注的，
  // updatedAt 一定晚于归档副本；若在归档前构造（timestamp 早于 done 写入），
  // 会被「防复活」正确拦下——那是另一条逻辑，不是本用例要测的。
  await store.updateTask(id, { taskId: 'task_abc', status: 'done' });
  await store.archiveTasks(id);
  const fresh = { ...task({ instruction: 'r2', element: { ...task().element, selector: '#a' } }), updatedAt: new Date().toISOString() };
  await store.appendTasks({ page, tasks: [fresh] });
  await store.updateTask(id, { taskId: 'task_abc', status: 'doing' });
  const second = (await store.readGroup(id)).tasks[0].round;

  assert.ok(second > first, '第二轮的轮次号必须大于第一轮');
});
