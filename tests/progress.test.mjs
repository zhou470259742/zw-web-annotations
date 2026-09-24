/**
 * 进度模型与「待验收」状态。
 *
 * 需求：子 agent 改完源码后把任务标成 review（待验收），由主线程验收后
 * 才回写 done；面板显示跨越所有页面的总体进度。
 * 权重分配：分派 10% + 开发 70% + 验收 20%。
 *
 * 这里只测纯逻辑（权重与计数），DOM 部分在真实浏览器里验证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUSES, STATUS_SET } from '../scripts/runtime/core/store.mjs';
// 进度与状态文案同属「展示层」概念，与 STATUS_LABELS 一起放在客户端模块里
// （客户端是无 import 的单文件，必须自带这些纯函数）。interaction.test.mjs
// 同样直接从 annotator.mjs 导入纯函数做测试。
import { computeProgress, PROGRESS_WEIGHTS, selectProgressTasks, buildAddressPrompt, mergeRemoteTasks, resolveRoundScope } from '../scripts/runtime/client/annotator.mjs';

const t = status => ({ id: `task_${status}_${Math.random().toString(36).slice(2, 6)}`, status });

test('review is a valid status', () => {
  assert.ok(STATUSES.includes('review'));
  assert.ok(STATUS_SET.has('review'));
});

/**
 * 权重必须合计 100：需求原文给的是 10/70/30，相加 110% 会让进度条溢出。
 * 这里把不变式钉住——以后谁调整权重，超 100 会立刻失败。
 */
test('progress weights sum to exactly 100', () => {
  const sum = PROGRESS_WEIGHTS.dispatch + PROGRESS_WEIGHTS.dev + PROGRESS_WEIGHTS.verify;
  assert.equal(sum, 100);
});

test('empty task list reports zero without dividing by zero', () => {
  const p = computeProgress([]);
  assert.equal(p.percent, 0);
  assert.equal(p.total, 0);
});

/**
 * 需求里最明确的例子：7 个小任务，每完成 1 个增加 10%。
 * 这要求开发段为 70%，且每项的涨幅在取整后仍为整数 10。
 */
test('seven tasks: each finished task adds ~10% (dev span is 70%)', () => {
  const seven = n => Array.from({ length: 7 }, (_, i) => t(i < n ? 'review' : 'todo'));

  // 全部还是 todo：一个都还没分派出去，进度为 0（分派是关卡，没人开工就没分）
  assert.equal(computeProgress(seven(0)).percent, 0);

  // 分派关卡 10% + 每完成一项 70/7 = 10%
  const per = (PROGRESS_WEIGHTS.dev / 7);
  assert.equal(per, 10);
  assert.equal(computeProgress(seven(1)).percent, 20);
  assert.equal(computeProgress(seven(4)).percent, 50);

  // 全部开发完成、等待验收：分派 10 + 开发 70 = 80，验收段尚未拿到
  assert.equal(computeProgress(seven(7)).percent, 80);
});

test('verification is only credited for done, not review', () => {
  const tasks = [t('review'), t('review'), t('review'), t('review'), t('review'), t('review'), t('review')];
  const all = computeProgress(tasks);
  assert.equal(all.verified, 0, 'review 不算验收通过');

  const done = computeProgress(tasks.map(x => ({ ...x, status: 'done' })));
  assert.equal(done.percent, 100, '全部验收后进度到顶');
  assert.equal(done.verified, 7);
});

/**
 * 分派是一次性关卡而非斜坡：只要有任何一项离开 todo 就该拿满 10%。
 * 若按比例摊薄，7 项任务每项只涨 1.4%，「每完成 1 个 +10%」就不成立了。
 */
test('dispatch is a one-shot gate paid in full once anything starts', () => {
  const tasks = [t('doing'), ...Array.from({ length: 9 }, () => t('todo'))];
  const p = computeProgress(tasks);
  assert.equal(p.started, 1);
  // 10（分派）+ 70×0.5/10=3.5（doing 在途开发记半份）≈ 14
  assert.equal(p.percent, 14);
});

test('doing earns half dev weight so the bar moves mid-work', () => {
  // 4 条全在 doing：10 + 70×(4×0.5)/4 = 45，而不是钉死在 10
  const p = computeProgress([t('doing'), t('doing'), t('doing'), t('doing')]);
  assert.equal(p.percent, 45);
});

test('cancelled tasks are excluded from the denominator', () => {
  // 2 项完成、1 项被用户取消：分母是 2 而不是 3，否则永远到不了 100%
  const p = computeProgress([t('done'), t('done'), t('cancelled')]);
  assert.equal(p.total, 2);
  assert.equal(p.percent, 100);
});

test('all cancelled reports zero rather than NaN', () => {
  const p = computeProgress([t('cancelled'), t('cancelled')]);
  assert.equal(p.total, 0);
  assert.equal(p.percent, 0);
});

test('todo-only list sits at zero percent', () => {
  const p = computeProgress([t('todo'), t('todo')]);
  assert.equal(p.percent, 0, '尚未分派时不应有进度');
  assert.equal(p.devDone, 0);
});

test('blocked still counts toward the denominator', () => {
  // blocked 是「做不完」而非「不用做」，不能像 cancelled 那样剔除分母
  const p = computeProgress([t('done'), t('blocked')]);
  assert.equal(p.total, 2);
  assert.equal(p.percent, 55, '10 + 70/2 + 20/2 = 55');
});

test('malformed entries are ignored instead of throwing', () => {
  const p = computeProgress([null, undefined, { status: 'todo' }, t('todo')]);
  assert.equal(p.total, 2, '缺 id 的裸对象仍按 status 计入，null/undefined 被丢弃');
});

/* ---------------- 进度分母：统一为本轮定稿集合 ---------------- */

const tr = (round, status) => ({ id: `task_r${round}_${status}_${Math.random().toString(36).slice(2, 6)}`, round, status });

test('scope is the current round only, queued tasks stay outside', () => {
  const all = [
    tr(1, 'done'),      // 旧轮已交付但未归档：不进当前轮分母
    tr(2, 'review'),
    tr(2, 'done'),
    { id: 'task_q1', round: null, status: 'todo' },  // 定稿后新增：排队
    { id: 'task_q2', round: null, status: 'doing' },
  ];
  const scope = selectProgressTasks(all);
  assert.equal(scope.currentRound, 2);
  assert.equal(scope.dispatched.length, 2);
  assert.equal(scope.queued, 2);
  // 分母只有当前轮 2 项，而不是 5——否则旧轮残留会把进度压住
  assert.equal(computeProgress(scope.dispatched).total, 2);
});

test('no rounds yet: nothing to count, everything is queued', () => {
  const scope = selectProgressTasks(
    [{ id: 'a', round: null, status: 'todo' }, { id: 'b', round: null, status: 'todo' }],
  );
  assert.equal(scope.currentRound, null);
  assert.equal(scope.dispatched.length, 0);
  assert.equal(scope.queued, 2);
});

test('tasks merged mid-round grow the denominator (3 -> 6)', () => {
  // 处理中新增的标注被处理者接手后并入当前轮：分母如实 +1，
  // 而不是把整批活动任务摊进总账。
  const all = [
    tr(1, 'done'), tr(1, 'doing'), tr(1, 'review'),
    tr(1, 'todo'), tr(1, 'doing'), tr(1, 'review'),   // 定稿后并入本轮的 3 条
    { id: 'task_q1', round: null, status: 'todo' },   // 新加还没人接：排队，不进分母
  ];
  const scope = selectProgressTasks(all);
  assert.equal(scope.currentRound, 1);
  assert.equal(scope.dispatched.length, 6);
  assert.equal(scope.queued, 1);
  assert.equal(computeProgress(scope.dispatched).total, 6);
});

test('delivered round disappears from the denominator once activeRound is null', () => {
  // 用户拍板：第二次处理前已完成 10 条，第二次分母也不应带上它们。
  // 归档存量只留在轮次日志里，进度条每轮从 0 重新计。
  const all = [{ id: 'a', round: 1, status: 'done' }, { id: 'b', round: 1, status: 'done' }];
  const scope = resolveRoundScope(all, { mode: 'queue' }, {
    activeRound: null, complete: false, queued: 0, counts: {}, runner: { status: 'idle' },
  });
  assert.equal(scope.dispatched.length, 0);
  assert.equal(computeProgress(scope.dispatched).total, 0);
});

test('address prompt contains exactly task directory and protocol addresses', () => {
  const prompt = buildAddressPrompt('/tmp/project/.zwa/tasks', '/tmp/project/.zwa/runtime/execution-protocol.md');
  assert.match(prompt, /任务目录：\/tmp\/project\/\.zwa\/tasks/);
  assert.match(prompt, /执行要求：\/tmp\/project\/\.zwa\/runtime\/execution-protocol\.md/);
  assert.doesNotMatch(prompt, /项目执行模式|任务文件：/);
  assert.equal(buildAddressPrompt('.zwa/tasks', '/tmp/protocol.md'), null);
});

test('remote refresh merges model fields without overwriting local outbox content', () => {
  const remote = [{ id: 'a', status: 'doing', instruction: 'server-old', result: null }];
  const local = [{ id: 'a', status: 'todo', instruction: 'user-new', element: { selector: '#a' }, images: [] }, { id: 'b', status: 'todo', instruction: 'local-only' }];
  const merged = mergeRemoteTasks(remote, local, [{ seq: 1, op: 'append' }]);
  assert.equal(merged.find(t => t.id === 'a').status, 'doing');
  assert.equal(merged.find(t => t.id === 'a').instruction, 'user-new');
  assert.ok(merged.find(t => t.id === 'b'));
});

/* ---------------- 轮次权威来源（resolveRoundScope） ---------------- */

test('server round summary wins over local inference', () => {
  // 任务里最大轮次是 3，但服务端已交付并置空 activeRound：必须以服务端为准，
  // 否则旧轮会被当成当前轮，进度条显示一个早已交付的轮次。
  const all = [{ id: 'a', round: 3, status: 'done' }, { id: 'b', round: null, status: 'todo' }];
  const scope = resolveRoundScope(all, { mode: 'round' }, {
    activeRound: null, complete: false, queued: 1, counts: {}, runner: { status: 'idle' },
  });
  assert.equal(scope.currentRound, null);
  assert.equal(scope.dispatched.length, 0, 'authoritative null must not resurrect an old round');
  assert.equal(scope.queued, 1);
});

test('local inference is the fallback when server summary is absent', () => {
  const all = [{ id: 'a', round: 2, status: 'review' }, { id: 'b', round: null, status: 'todo' }];
  const scope = resolveRoundScope(all, { mode: 'round' }, null);
  assert.equal(scope.currentRound, 2, '旧版运行时不返回 round 摘要，回落本地推断');
  assert.equal(scope.dispatched.length, 1);
  assert.equal(scope.queued, 1);
});

test('unarchived old round does not pollute the authoritative current round', () => {
  const all = [
    { id: 'old', round: 1, status: 'done' },
    { id: 'cur1', round: 2, status: 'doing' },
    { id: 'cur2', round: 2, status: 'review' },
  ];
  const scope = resolveRoundScope(all, { mode: 'round' }, {
    activeRound: 2, complete: false, queued: 0, counts: { doing: 1, review: 1 }, runner: { status: 'running' },
  });
  assert.equal(scope.currentRound, 2);
  assert.equal(scope.dispatched.length, 2);
  assert.equal(computeProgress(scope.dispatched).total, 2, '旧轮残留不进分母');
  assert.equal(scope.blocked, false);
});

test('blocked round is reported and prevents describing it as in-flight progress', () => {
  const all = [{ id: 'a', round: 2, status: 'doing' }, { id: 'b', round: 2, status: 'blocked' }];
  const scope = resolveRoundScope(all, { mode: 'round' }, {
    activeRound: 2, complete: false, queued: 0, counts: { doing: 1, blocked: 1 }, runner: { status: 'idle' },
  });
  assert.equal(scope.blocked, true, 'blocked 任务必须让面板显示阻塞而不是静默停住');
  assert.equal(scope.complete, false);
});

test('queue mode shares the round denominator and obeys the same authority', () => {
  // 用户拍板：队列与轮次分母同口径（本轮定稿集合），区别只在边界行为。
  // 归档轮次（旧轮 done）与排队任务都不进分母。
  const all = [
    { id: 'old', round: 1, status: 'done' },
    { id: 'cur', round: 2, status: 'doing' },
    { id: 'queued', round: null, status: 'todo' },
  ];
  const scope = resolveRoundScope(all, { mode: 'queue' }, {
    activeRound: 2, complete: false, queued: 1, counts: { doing: 1 }, runner: { status: 'running' },
  });
  assert.equal(scope.currentRound, 2);
  assert.equal(scope.dispatched.length, 1, '队列分母 = 本轮定稿集合，不是全部活动任务');
  assert.equal(scope.queued, 1, '队列同样显示下一轮排队数');
  assert.equal(computeProgress(scope.dispatched).total, 1);
});

test('blocked is visible in queue mode too, not just round mode', () => {
  // 队列同样会被 blocked 卡住（completeRound 返回 blocked、不续轮）；
  // 若把 blocked 写死 false，用户看到「等待处理者接续」却不知道真因。
  const all = [{ id: 'a', round: 1, status: 'blocked' }, { id: 'b', round: null, status: 'todo' }];
  const scope = resolveRoundScope(all, { mode: 'queue' }, { activeRound: 1, complete: false, queued: 1, counts: { blocked: 1 }, runner: { status: 'idle' } });
  assert.equal(scope.blocked, true);
});

test('runner blocked status alone is enough to surface the warning', () => {
  const all = [{ id: 'a', round: 2, status: 'doing' }];
  const scope = resolveRoundScope(all, { mode: 'round' }, { activeRound: 2, complete: false, queued: 0, counts: { doing: 1 }, runner: { status: 'blocked' } });
  assert.equal(scope.blocked, true);
  assert.equal(scope.complete, false);
});
