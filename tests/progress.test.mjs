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
import { computeProgress, PROGRESS_WEIGHTS } from '../scripts/runtime/client/annotator.mjs';

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
  // 10（分派）+ 0（还没进 review）+ 0（还没 done）
  assert.equal(p.percent, 10);
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
