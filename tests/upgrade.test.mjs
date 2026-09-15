/**
 * 升级机制回归：版本体检（status）与兼容升级（upgrade）。
 *
 * 核心约束：升级只替换 runtime/，任务数据（tasks/）绝不能被触碰；
 * 增量拷贝会残留已废弃的旧运行时文件，必须整目录替换。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../scripts/runtime/core/store.mjs';
import {
  checkStatus,
  upgradeProject,
  installProject,
  compareVersions,
  RUNTIME_FILES,
  WORK_ROOT,
  META_FILE,
  SKILL_VERSION,
} from '../scripts/index.mjs';

async function tempProject(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-upgrade-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

const VITE_PKG = JSON.stringify({
  name: 'app',
  private: true,
  type: 'module',
  dependencies: { vue: '^3.4.21' },
  devDependencies: { vite: '^5.4.0', '@vitejs/plugin-vue': '^5.0.0' },
}, null, 2);

async function seedTask(dir, instruction) {
  const store = createStore(dir, { dir: '.zwa/tasks' });
  await store.appendTasks({
    page: { url: 'http://example.test/', title: 't' },
    tasks: [{
      id: 'task_keep', seq: 1, instruction, status: 'todo',
      kind: 'manual', element: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      history: [],
    }],
  });
}

test('compareVersions orders semver numerically, not lexically', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.10.0'), 0);
  assert.equal(compareVersions('0.10.1', '0.10.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('status reports install for a fresh project and current after install', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  const fresh = await checkStatus(dir);
  assert.equal(fresh.action, 'install');
  assert.equal(fresh.upToDate, false);

  await installProject(dir);
  const after = await checkStatus(dir);
  assert.equal(after.action, 'current');
  assert.equal(after.upToDate, true);
  assert.equal(after.installedVersion, SKILL_VERSION);
});

test('status reports not-frontend outside a frontend project', async () => {
  const dir = await tempProject({ 'README.md': 'not a frontend' });
  const status = await checkStatus(dir);
  assert.equal(status.action, 'not-frontend');
});

test('upgrade replaces the runtime, clears stale files and preserves tasks', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);

  // 模拟旧版本安装：元数据写回旧版本号，并在项目运行时里塞一个新版本已废弃的文件
  const metaPath = path.join(dir, META_FILE);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  meta.skillVersion = '0.9.0';
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  const stale = path.join(dir, WORK_ROOT, 'runtime', 'core', 'removed-in-new-version.mjs');
  await fs.writeFile(stale, 'export const stale = true;\n', 'utf8');

  // 造一条真实任务：升级绝不能动它
  await seedTask(dir, '升级期间数据必须原样保留');

  const result = await upgradeProject(dir);
  assert.equal(result.action, 'upgraded');
  assert.equal(result.from, '0.9.0');
  assert.equal(result.to, SKILL_VERSION);
  assert.equal(result.tasks.preserved, true, '任务组文件数升级前后必须一致');

  // 任务数据原样可读
  const after = createStore(dir, { dir: '.zwa/tasks' });
  const [group] = await after.listGroups();
  assert.equal(group.tasks[0].instruction, '升级期间数据必须原样保留');
  // 残留旧文件被清掉；新运行时完整
  await assert.rejects(() => fs.access(stale));
  for (const rel of RUNTIME_FILES) {
    await fs.access(path.join(dir, WORK_ROOT, 'runtime', rel));
  }
  // 元数据记录升级来源，供回溯
  const metaAfter = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(metaAfter.skillVersion, SKILL_VERSION);
  assert.equal(metaAfter.previousSkillVersion, '0.9.0');
  assert.ok(metaAfter.upgradedAt);
});

test('upgrade on an up-to-date project is a no-op that leaves meta untouched', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);
  const before = await fs.readFile(path.join(dir, META_FILE), 'utf8');
  const result = await upgradeProject(dir);
  assert.equal(result.action, 'current');
  const after = await fs.readFile(path.join(dir, META_FILE), 'utf8');
  assert.equal(after, before);
});

test('upgrade refuses when the project has no installation', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await assert.rejects(() => upgradeProject(dir), /尚未安装/);
});

test('runtime integrity detects a modified installed file and upgrade repairs it', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);
  const target = path.join(dir, WORK_ROOT, 'runtime', 'client', 'annotator.mjs');
  await fs.appendFile(target, '\n// tampered\n');
  const before = await checkStatus(dir);
  assert.equal(before.action, 'upgrade');
  const result = await upgradeProject(dir);
  assert.equal(result.action, 'upgraded');
  assert.equal(result.tasks.preserved, true);
  const repaired = await checkStatus(dir);
  assert.equal(repaired.action, 'current');
});

test('upgrade preserves the dynamic endpoint manifest while replacing static runtime files', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);
  const manifestPath = path.join(dir, WORK_ROOT, 'runtime', 'endpoint.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    version: '1.0', runtimeVersion: 'custom', endpoint: '/custom-zwa',
    routes: { updateTask: 'PATCH /<groupId>/tasks/<taskId>', completeRound: 'POST /complete-round' },
  }, null, 2));
  const metaPath = path.join(dir, META_FILE);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  meta.skillVersion = '0.1.0';
  await fs.writeFile(metaPath, JSON.stringify(meta));
  const result = await upgradeProject(dir);
  assert.equal(result.tasks.preserved, true);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), {
    version: '1.0', runtimeVersion: 'custom', endpoint: '/custom-zwa',
    routes: { updateTask: 'PATCH /<groupId>/tasks/<taskId>', completeRound: 'POST /complete-round' },
  });
});
test('upgrade preserves active tasks, archives, attachments and execution state by hash', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);
  await seedTask(dir, 'active');
  const archiveDir = path.join(dir, WORK_ROOT, 'tasks', 'archive');
  const attachmentsDir = path.join(dir, WORK_ROOT, 'tasks', 'attachments');
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.mkdir(attachmentsDir, { recursive: true });
  await fs.writeFile(path.join(archiveDir, 'keep.json'), '{"archive":"keep"}');
  await fs.writeFile(path.join(attachmentsDir, 'keep.png'), Buffer.from([1,2,3,4]));
  await fs.writeFile(path.join(dir, WORK_ROOT, 'execution.json'), JSON.stringify({ version:'1.0', mode:'queue', rounds:[] }));
  const prefsPath = path.join(dir, WORK_ROOT, 'runtime', 'board-prefs.json');
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify({ theme: 'light' }));
  const metaPath = path.join(dir, META_FILE);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  meta.skillVersion = '0.1.0';
  await fs.writeFile(metaPath, JSON.stringify(meta));
  const result = await upgradeProject(dir);
  assert.equal(result.tasks.preserved, true);
  assert.deepEqual(await fs.readFile(path.join(attachmentsDir, 'keep.png')), Buffer.from([1,2,3,4]));
  assert.match(await fs.readFile(path.join(archiveDir, 'keep.json'), 'utf8'), /keep/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, WORK_ROOT, 'execution.json'), 'utf8')).mode, 'queue');
  assert.equal(JSON.parse(await fs.readFile(prefsPath, 'utf8')).theme, 'light', '看板偏好（主题）升级后保留');
});
