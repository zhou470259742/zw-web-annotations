/**
 * 交互模型的纯逻辑测试。
 *
 * DOM 组件本身在真实浏览器里验证；这里覆盖不依赖 DOM 的核心约束：
 * 编号分配规则、确认语义、按添加时间排序。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { stableTaskId, canonicalPageUrl } from '../scripts/runtime/client/annotator.mjs';

/** 复刻组件的编号分配规则：按已存在的最大编号递增，删除后不重排。 */
function nextSeq(tasks) {
  return tasks.reduce((max, t) => Math.max(max, Number(t.seq) || 0), 0) + 1;
}

test('stableTaskId is idempotent per page and selector', () => {
  const a = stableTaskId('https://example.com/', '#submit');
  assert.equal(a, stableTaskId('https://example.com/', '#submit'));
  assert.notEqual(a, stableTaskId('https://example.com/', '#cancel'));
  assert.notEqual(a, stableTaskId('https://example.com/other', '#submit'));
  assert.match(a, /^task_[a-z0-9]+$/);
});

/**
 * 回归：页内锚点不改变"这是哪个页面"。
 * URL 出现 hash（如点击 # 锚点链接）后若按原始 href 归组，面板会匹配不上
 * 自己的任务组（显示"当前页 0"），锚点状态下标注还会生成重复组文件。
 */
test('canonicalPageUrl strips the hash but keeps path and query', () => {
  assert.equal(canonicalPageUrl('http://localhost:5173/campus.html'), 'http://localhost:5173/campus.html');
  assert.equal(canonicalPageUrl('http://localhost:5173/campus.html#top'), 'http://localhost:5173/campus.html');
  assert.equal(canonicalPageUrl('http://localhost:5173/campus.html?a=1&b=2#x'), 'http://localhost:5173/campus.html?a=1&b=2');
  assert.equal(
    stableTaskId(canonicalPageUrl('http://localhost:5173/campus.html#hash'), '#account'),
    stableTaskId('http://localhost:5173/campus.html', '#account'),
    '带锚点与不带锚点必须派生同一个任务 id',
  );
  // file: 协议没有 host，也不能丢路径
  assert.equal(canonicalPageUrl('file:///Users/x/demo/index.html#s'), 'file:///Users/x/demo/index.html');
  assert.equal(canonicalPageUrl('not a url'), 'not a url');
});

test('seq increases with insertion order starting at 1', () => {
  const tasks = [];
  tasks.push({ seq: nextSeq(tasks) });
  tasks.push({ seq: nextSeq(tasks) });
  tasks.push({ seq: nextSeq(tasks) });
  assert.deepEqual(tasks.map(t => t.seq), [1, 2, 3]);
});

test('seq does not renumber after deletion, leaving a stable gap', () => {
  const tasks = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  // 删除 2 号
  const remaining = tasks.filter(t => t.seq !== 2);
  // 新标注应拿到 4 号，而不是补位成 3 号，避免用户口述编号错位
  assert.equal(nextSeq(remaining), 4);
  assert.deepEqual(remaining.map(t => t.seq), [1, 3]);
});

test('list order follows insertion order (adding time), not selector', () => {
  const tasks = [
    { seq: 1, id: 'task_a', selector: '#zebra' },
    { seq: 2, id: 'task_b', selector: '#apple' },
  ];
  // 编号顺序即添加顺序；重新排序不应按 selector 字母序改变用户认知
  const ordered = [...tasks].sort((a, b) => a.seq - b.seq);
  assert.deepEqual(ordered.map(t => t.id), ['task_a', 'task_b']);
});

/** 复刻确认语义：空内容不生成任务。 */
function confirmsToTask(text, isNew) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return { instruction: trimmed, isNew };
}

test('confirming empty text does not create a task', () => {
  assert.equal(confirmsToTask('', true), null);
  assert.equal(confirmsToTask('   ', true), null);
  assert.equal(confirmsToTask('\n\t ', false), null);
});

test('confirming non-empty text creates a task and trims whitespace', () => {
  assert.deepEqual(confirmsToTask('  调整宽度 ', true), { instruction: '调整宽度', isNew: true });
});

test('multi-line instructions are preserved, not collapsed', () => {
  const text = '调整宽度\n并改为 200px';
  assert.equal(confirmsToTask(text, true).instruction, text);
});

/**
 * 回归测试：按钮点击的动作解析。
 *
 * 真实点击常落在按钮内部的文字 span 或 svg 图标上，此时 event.target
 * 不带 data-act 属性。若只用 target.getAttribute('data-act') 判断，
 * 所有按钮都会静默失效（点下去没反应）。必须用 closest() 向上查找。
 */
function resolveAction(target) {
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest('[data-act]')?.getAttribute('data-act') ?? null;
}

/** 最小 DOM 桩：支持 closest 与属性查询。 */
function makeEl(attrs = {}, ancestors = []) {
  const self = {
    attrs,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    closest(selector) {
      const name = selector.replace(/^\[|\]$/g, '');
      const has = node => !!node && name in node.attrs;
      if (has(self)) return self;
      for (const a of ancestors) if (has(a)) return a;
      return null;
    },
  };
  return self;
}

test('clicking a button resolves its action', () => {
  const btn = makeEl({ 'data-act': 'toggle' });
  assert.equal(resolveAction(btn), 'toggle');
});

test('clicking a child element inside a button still resolves the action', () => {
  const btn = makeEl({ 'data-act': 'expand' });
  const span = makeEl({}, [btn]);
  const svg = makeEl({}, [span, btn]);
  assert.equal(resolveAction(span), 'expand');
  assert.equal(resolveAction(svg), 'expand', 'svg 图标内的点击也必须命中按钮动作');
});

test('clicking outside any action button resolves to null', () => {
  const plain = makeEl({ class: 'card' });
  assert.equal(resolveAction(plain), null);
  assert.equal(resolveAction(null), null);
});

test('nested buttons resolve to the nearest action', () => {
  const outer = makeEl({ 'data-act': 'expand' });
  const inner = makeEl({ 'data-act': 'collapse' }, [outer]);
  assert.equal(resolveAction(inner), 'collapse');
});
