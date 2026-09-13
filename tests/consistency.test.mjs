import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, DEFAULT_DIR, RUNTIME_VERSION } from '../scripts/runtime/core/store.mjs';
import { TASKS_DIR, WORK_ROOT, SKILL_VERSION, SKILL_NAME } from '../scripts/index.mjs';

/**
 * 这组测试锁死各模块对“任务落盘位置”的共识。
 * 任何一处写死别的路径，都会让用户遇到「安装器说装好了，
 * 标注却写进了另一个目录」这类静默故障。
 */

test('runtime version matches the skill version', () => {
  // 版本号有两份必需的副本：技能侧（安装器写 install.json）与运行时侧
  // （随运行时进项目，供页面里的组件上报自己跑的是哪一版）。
  // 两者不一致时，doctor 的 runtime-version 检查会给出错误结论。
  assert.equal(RUNTIME_VERSION, SKILL_VERSION);
  assert.notEqual(RUNTIME_VERSION, '0.0.0');
});

test('skill version matches the repository version', async () => {
  // 技能会被单独压缩分发，仓库根的 package.json 不随它走，
  // 所以技能必须自带版本号；这里防止两处各自漂移。
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(SKILL_VERSION, pkg.version);
  assert.equal(SKILL_NAME, pkg.name);
  assert.notEqual(SKILL_VERSION, '0.0.0');
});

test('installer tasks dir matches the store default dir', () => {
  assert.equal(TASKS_DIR, DEFAULT_DIR);
  assert.equal(DEFAULT_DIR, '.zw-web-annotations/tasks');
  assert.ok(DEFAULT_DIR.startsWith(`${WORK_ROOT}/`));
});

test('a store created without dir writes into the installer tasks dir', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-consistency-'));
  const store = createStore(workspace);
  assert.equal(store.taskDir, path.join(workspace, TASKS_DIR));
});

// mcp/ 与 bridge/ 是归档仓库期的附属物，不随技能分发；只有在包含它们的
// 目录里运行测试（如归档仓库）时才校验，技能目录内自动跳过。
const mcpSkip = existsSync(new URL('../mcp/server.mjs', import.meta.url))
  ? false
  : 'mcp/ 不随技能分发，仅在包含它的归档仓库中校验';
test('MCP server resolves the same directory as the installer', { skip: mcpSkip }, async () => {
  const source = await fs.readFile(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  // MCP 曾自己复刻一份文件读写，导致归档、附件保活等规则与运行时各自演化；
  // 现在必须走 createStore，与 bridge 用同一套实现。
  assert.match(source, /createStore/);
  assert.doesNotMatch(source, /path\.join\(workspace,\s*'\.zcode',\s*'web-annotations'\)/);
  // 归档与清理归档必须暴露给模型，否则「已处理的任务请进行归档」无从执行
  assert.match(source, /archive_annotation_tasks/);
  assert.match(source, /purge_annotation_archive/);
});

const bridgeSkip = existsSync(new URL('../bridge/server.mjs', import.meta.url))
  ? false
  : 'bridge/ 不随技能分发，仅在包含它的归档仓库中校验';
test('bridge server resolves the same directory as the installer', { skip: bridgeSkip }, async () => {
  const source = await fs.readFile(new URL('../bridge/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /createStore/);
  // bridge 通过 createStore 拿到默认目录，不应出现硬编码的任务路径
  assert.doesNotMatch(source, /'\.zcode',\s*'web-annotations',\s*'tasks'/);
});

test('attachment file references resolve to a real file', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-consistency-'));
  const store = createStore(workspace, { dir: TASKS_DIR });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  await store.appendTasks({
    page: { url: 'http://example.test/', title: 't' },
    tasks: [{
      id: 'task_img', seq: 1, instruction: '加个图标', status: 'todo',
      kind: 'manual', element: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      images: [{ id: 'i1', dataUrl: png }],
      history: [],
    }],
  });

  const [group] = await store.listGroups();
  const file = group.tasks[0].images[0].file;
  // file 是相对工作区的路径，必须能直接定位到真实文件
  await fs.access(path.join(workspace, file));
  assert.match(file, /attachments\//);
});

test('listGroups ignores non-group json such as install metadata', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-consistency-'));
  const store = createStore(workspace, { dir: TASKS_DIR });
  await fs.mkdir(path.dirname(path.join(workspace, TASKS_DIR)), { recursive: true });
  // 元数据在 WORK_ROOT 下、任务目录之外，不应被当成任务组
  await fs.writeFile(path.join(workspace, WORK_ROOT, 'install.json'), JSON.stringify({ skill: 'x' }), 'utf8');
  const groups = await store.listGroups();
  assert.deepEqual(groups, []);
});
