/**
 * 图片附件与手动任务的测试。
 *
 * 重点覆盖：
 * - 图片以真实文件落盘，JSON 中只保留相对路径；
 * - 类型白名单，非图片 data URL 被拒绝；
 * - 手动任务（无 element）能通过校验；
 * - 发送载荷包含尺寸、截图路径与手动任务信息。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, parseDataUrl, validateGroup, buildSendPayload, IMAGE_TYPES, ATTACHMENTS_DIRNAME, DEFAULT_DIR } from '../scripts/runtime/core/store.mjs';

const page = { url: 'https://example.com/page', title: '测试页' };
const at = '2026-01-01T00:00:00.000Z';

/** 1x1 PNG。 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-img-'));
  return { store: createStore(dir), dir };
}

function elementTask(overrides = {}) {
  return {
    id: 'task_a',
    seq: 1,
    kind: 'element',
    instruction: '调整宽度',
    status: 'todo',
    createdAt: at,
    updatedAt: at,
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
      rect: { x: 10, y: 20, width: 120, height: 36 },
      frame: 'top',
    },
    history: [],
    ...overrides,
  };
}

test('parseDataUrl accepts whitelisted image types', () => {
  const parsed = parseDataUrl(PNG_1PX);
  assert.ok(parsed);
  assert.equal(parsed.type, 'image/png');
  assert.equal(parsed.ext, 'png');
  assert.ok(parsed.buffer.length > 0);
  assert.ok(Object.keys(IMAGE_TYPES).length >= 4);
});

test('parseDataUrl rejects non-image and malformed input', () => {
  assert.equal(parseDataUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(parseDataUrl('data:application/pdf;base64,AAAA'), null);
  assert.equal(parseDataUrl(''), null);
  assert.equal(parseDataUrl('not a data url'), null);
  assert.equal(parseDataUrl('javascript:alert(1)'), null);
  // 没有 base64 载荷的图片类型也应被拒绝
  assert.equal(parseDataUrl('data:image/png;base64,'), null);
});

test('images are written to disk and JSON keeps only the relative path', async () => {
  const { store, dir } = await tempStore();
  const result = await store.appendTasks({
    page,
    tasks: [
      elementTask({
        images: [
          { id: 'img_1', name: 'shot.png', source: 'paste', mimeType: 'image/png', dataUrl: PNG_1PX },
        ],
      }),
    ],
  });

  assert.equal(result.attachments, 1);
  const task = result.group.tasks[0];
  assert.equal(task.images.length, 1);
  // dataUrl 必须被移除，避免 JSON 臃肿
  assert.equal(task.images[0].dataUrl, undefined);
  assert.match(task.images[0].file, new RegExp(`${ATTACHMENTS_DIRNAME}/`));
  assert.ok(task.images[0].bytes > 0);

  // 文件真实存在
  const abs = path.join(dir, task.images[0].file);
  const stat = await fs.stat(abs);
  assert.ok(stat.size > 0);

  // JSON 序列化后不应包含 base64 内容
  const raw = await fs.readFile(result.path, 'utf8');
  assert.doesNotMatch(raw, /iVBORw0KGgo/);
  assert.match(raw, /attachments/);
});

test('duplicate image ids do not create duplicate attachments', async () => {
  const { store } = await tempStore();
  await store.appendTasks({ page, tasks: [elementTask({ images: [{ id: 'img_1', dataUrl: PNG_1PX }] })] });
  const second = await store.appendTasks({
    page,
    tasks: [elementTask({ images: [{ id: 'img_1', dataUrl: PNG_1PX }] })],
  });
  assert.equal(second.group.tasks.length, 1);
});

test('manual tasks have no element and still validate', async () => {
  const { store } = await tempStore();
  const manual = {
    id: 'manual_1',
    seq: 1,
    kind: 'manual',
    instruction: '标题文案改成设备总览',
    status: 'todo',
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
    result: null,
    element: null,
    images: [],
    history: [],
  };
  const result = await store.appendTasks({ page, tasks: [manual] });
  assert.equal(result.added, 1);
  assert.equal(result.group.tasks[0].element, null);
  assert.equal(result.group.tasks[0].kind, 'manual');
});

test('validateGroup rejects element tasks without element', () => {
  assert.throws(
    () => validateGroup({ version: '1.0', id: 'g', createdAt: at, updatedAt: at, page, tasks: [elementTask({ element: null })] }),
    /missing element/,
  );
});

test('manual task with images only (no text) is accepted', async () => {
  const { store } = await tempStore();
  const manual = {
    id: 'manual_img',
    seq: 1,
    kind: 'manual',
    instruction: '',
    status: 'todo',
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
    result: null,
    element: null,
    images: [{ id: 'i1', dataUrl: PNG_1PX }],
    history: [],
  };
  const result = await store.appendTasks({ page, tasks: [manual] });
  assert.equal(result.attachments, 1);
  assert.equal(result.group.tasks[0].element, null);
});

test('send payload includes size, screenshot path and manual marker', () => {
  const group = {
    version: '1.0',
    id: 'g',
    createdAt: at,
    updatedAt: at,
    page,
    tasks: [
      elementTask({ images: [{ id: 'i', file: '.zw-web-annotations/attachments/task_a-i.png' }] }),
      {
        id: 'manual_1',
        seq: 2,
        kind: 'manual',
        instruction: '整体配色偏暗，请调亮',
        status: 'todo',
        createdAt: at,
        updatedAt: at,
        history: [],
        element: null,
        images: [],
      },
    ],
  };
  const payload = buildSendPayload(group);
  assert.match(payload, /尺寸：120×36/);
  assert.match(payload, /截图：.*attachments/);
  assert.match(payload, /手动添加的任务/);
  assert.match(payload, /整体配色偏暗/);
});

test('send payload skips done tasks but keeps pending manual ones', () => {
  const group = {
    version: '1.0',
    id: 'g',
    createdAt: at,
    updatedAt: at,
    page,
    tasks: [
      elementTask({ id: 'done1', status: 'done', instruction: '已完成项' }),
      { id: 'm1', seq: 2, kind: 'manual', instruction: '待办手动项', status: 'todo', createdAt: at, updatedAt: at, history: [], element: null, images: [] },
    ],
  };
  const payload = buildSendPayload(group);
  assert.doesNotMatch(payload, /已完成项/);
  assert.match(payload, /待办手动项/);
});

test('seq stays unique when local state was cleared and resaved', async () => {
  const { store } = await tempStore();
  // 已保存一个 seq=1 的任务
  await store.appendTasks({ page, tasks: [elementTask({ seq: 1 })] });
  // 浏览器本地被清空后重新标注，新任务也带着 seq=1
  const second = await store.appendTasks({
    page,
    tasks: [
      elementTask({
        id: 'task_b',
        seq: 1,
        instruction: '第二个任务',
        element: { ...elementTask().element, selector: '#other' },
      }),
    ],
  });
  const seqs = second.group.tasks.map(t => t.seq);
  assert.equal(new Set(seqs).size, seqs.length, `编号应唯一，实际 ${JSON.stringify(seqs)}`);
  assert.deepEqual([...seqs].sort((a, b) => a - b), [1, 2]);
});

test('explicit non-conflicting seq is preserved', async () => {
  const { store } = await tempStore();
  const result = await store.appendTasks({ page, tasks: [elementTask({ seq: 7 })] });
  assert.equal(result.group.tasks[0].seq, 7);
});

/**
 * 删除同步：删除任务必须同时清理 JSON 数据与无主附件，
 * 避免本地删掉了、工作区里还留着。
 */
test('deleting a task removes it from the JSON file', async () => {
  const { store } = await tempStore();
  const first = await store.appendTasks({ page, tasks: [elementTask({ id: 'a', seq: 1 })] });
  await store.appendTasks({
    page,
    tasks: [elementTask({ id: 'b', seq: 2, element: { ...elementTask().element, selector: '#other' } })],
  });

  const result = await store.removeTasks(first.group.id, { ids: ['a'] });
  assert.equal(result.removed, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.fileRemoved, false);

  const after = await store.readGroup(first.group.id);
  assert.deepEqual(after.tasks.map(t => t.id), ['b']);
});

test('deleting by selector works when the task id changed', async () => {
  const { store } = await tempStore();
  const saved = await store.appendTasks({ page, tasks: [elementTask({ id: 'a' })] });
  const result = await store.removeTasks(saved.group.id, { selectors: ['#submit'] });
  assert.equal(result.removed, 1);
  assert.equal(result.remaining, 0);
});

test('deleting the last task removes the JSON file entirely', async () => {
  const { store } = await tempStore();
  const saved = await store.appendTasks({ page, tasks: [elementTask()] });
  const result = await store.removeTasks(saved.group.id, { all: true });
  assert.equal(result.fileRemoved, true);
  assert.equal(result.remaining, 0);
  await assert.rejects(() => store.readGroup(saved.group.id), /ENOENT/);
});

test('deleting a task prunes its now-orphaned attachments', async () => {
  const { store, dir } = await tempStore();
  const saved = await store.appendTasks({
    page,
    tasks: [
      elementTask({ id: 'keep', seq: 1, images: [{ id: 'i1', dataUrl: PNG_1PX }] }),
      elementTask({
        id: 'drop',
        seq: 2,
        images: [{ id: 'i2', dataUrl: PNG_1PX }],
        element: { ...elementTask().element, selector: '#other' },
      }),
    ],
  });
  const attachmentsDir = path.join(dir, DEFAULT_DIR, 'attachments');
  assert.equal((await fs.readdir(attachmentsDir)).length, 2);

  await store.removeTasks(saved.group.id, { ids: ['drop'] });

  const remaining = await fs.readdir(attachmentsDir);
  assert.equal(remaining.length, 1, '被删任务的附件应一并清理');
  const kept = await store.readGroup(saved.group.id);
  assert.match(kept.tasks[0].images[0].file, new RegExp(remaining[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('delete resolves the group from the page url', async () => {
  const { store } = await tempStore();
  await store.appendTasks({ page, tasks: [elementTask()] });
  const result = await store.removeTasks(page.url, { byPageUrl: true, all: true });
  assert.equal(result.remaining, 0);
  assert.equal(result.fileRemoved, true);
});

test('deleting from a nonexistent group is idempotent', async () => {
  const { store } = await tempStore();
  const result = await store.removeTasks('does-not-exist', { all: true });
  assert.equal(result.removed, 0);
  assert.equal(result.remaining, 0);
});
