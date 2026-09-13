import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installProject,
  inspectProject,
  planInstall,
  patchViteConfigContent,
  isPatched,
  detectProject,
  RUNTIME_FILES,
  WORK_ROOT,
  META_FILE,
  TASKS_DIR,
  SKILL_VERSION,
} from '../scripts/index.mjs';

async function tempProject(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-install-'));
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

test('plan detects a fresh Vite project and creates config', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  const plan = await planInstall(dir);
  assert.equal(plan.detected.isVite, true);
  assert.equal(plan.detected.viteConfig, null);
  const actions = plan.steps.map(s => s.action);
  assert.ok(actions.includes('copy-runtime'));
  assert.ok(actions.includes('init-workspace'));
  assert.ok(actions.includes('create-config'));
});

test('install copies a self-contained runtime into the project', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  const result = await installProject(dir);
  assert.equal(result.ok, true);
  // 新契约：strategy 决定接入方式，framework 描述检测到的框架
  assert.equal(result.strategy, 'vite');
  assert.equal(result.framework, 'vue');
  assert.equal(result.frameworkMajor, 3);
  assert.equal(result.runtimeFiles.length, RUNTIME_FILES.length);

  for (const rel of RUNTIME_FILES) {
    await fs.access(path.join(dir, WORK_ROOT, 'runtime', rel));
  }
  // 运行时自包含：配置只引用项目内相对路径
  const cfg = await fs.readFile(path.join(dir, 'vite.config.mjs'), 'utf8');
  assert.match(cfg, /\.\/\.zwa\/runtime\/vite\/index\.mjs/);
  assert.doesNotMatch(cfg, /\/Users\//);
});

test('install initializes workspace, metadata and gitignore', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);
  await fs.access(path.join(dir, WORK_ROOT, 'tasks'));
  const meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8'));
  assert.equal(meta.skill, 'zw-web-annotations');
  // 版本必须真实落盘：曾因技能里没有 package.json 而永远写成 0.0.0，升级判断失效
  assert.equal(meta.skillVersion, SKILL_VERSION);
  assert.notEqual(meta.skillVersion, '0.0.0');
  assert.equal(meta.source, 'copy');
  assert.equal(meta.strategy, 'vite');
  assert.equal(meta.framework, 'vue');
  assert.equal(meta.frameworkMajor, 3);
  const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /\.zwa\/tasks\//);
});

test('githubignore is appended without clobbering existing content', async () => {
  const dir = await tempProject({
    'package.json': VITE_PKG,
    '.gitignore': 'node_modules\ndist\n',
  });
  await installProject(dir);
  const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /node_modules/);
  assert.match(ignore, /dist/);
  assert.match(ignore, /\.zwa\/tasks\//);
});

test('declared tasks dir matches where the runtime actually writes', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  const result = await installProject(dir);
  const meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8'));

  // 配置里声明的 dir 必须与安装器初始化的目录一致
  const cfg = await fs.readFile(path.join(dir, 'vite.config.mjs'), 'utf8');
  assert.match(cfg, new RegExp(TASKS_DIR.replace(/\//g, '\\/')));

  // 用与运行时相同的方式解析，确认落盘位置就是 tasks/
  const { createStore } = await import('../scripts/runtime/core/store.mjs');
  const store = createStore(dir, { dir: TASKS_DIR });
  const expected = path.join(dir, TASKS_DIR);
  assert.equal(store.taskDir, expected);
  assert.equal(result.workspace.tasksDir, TASKS_DIR);
  assert.equal(meta.tasksDir, TASKS_DIR);

  await store.appendTasks({
    page: { url: 'http://localhost:1/', title: 't' },
    tasks: [{
      id: 'task_x', seq: 1, instruction: 'x', status: 'todo',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      startedAt: null, completedAt: null, result: null,
      element: { tagName: 'div', accessibleName: '', text: '', selector: '#a', xpath: '/div[1]', parentSummary: '', domSnippet: '<div>', rect: { x: 0, y: 0, width: 1, height: 1 }, frame: 'top' },
      history: [],
    }],
  });
  const files = await fs.readdir(expected);
  assert.ok(files.some(f => f.endsWith('.json')), '任务应落在 tasks/ 目录内');
});

test('install patches an existing config while preserving other plugins', async () => {
  const dir = await tempProject({
    'package.json': VITE_PKG,
    'vite.config.ts': [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      '',
      'export default defineConfig({',
      '  plugins: [react()],',
      '  server: { port: 3000 },',
      '});',
      '',
    ].join('\n'),
  });
  const result = await installProject(dir);
  assert.equal(result.integration.action, 'patched');
  assert.equal(result.integration.backup, 'vite.config.ts.zw-backup');

  const patched = await fs.readFile(path.join(dir, 'vite.config.ts'), 'utf8');
  assert.match(patched, /zwAnnotations/);
  assert.match(patched, /react\(\)/); // 原有插件必须保留
  assert.match(patched, /port: 3000/); // 原有配置必须保留
  // 备份内容等于原始内容
  const backup = await fs.readFile(path.join(dir, 'vite.config.ts.zw-backup'), 'utf8');
  assert.doesNotMatch(backup, /zwAnnotations/);
});

test('install is idempotent', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  const first = await installProject(dir);
  const before = await fs.readFile(path.join(dir, 'vite.config.mjs'), 'utf8');

  const second = await installProject(dir);
  assert.equal(second.integration.action, 'skipped');
  assert.equal(second.runtimeFiles.length, 0);

  const after = await fs.readFile(path.join(dir, 'vite.config.mjs'), 'utf8');
  assert.equal(before, after);
  assert.equal((after.match(/zwAnnotations/g) || []).length, 2); // import + 调用，各一次
  assert.equal(first.integration.action, 'created');
});

test('install fails safely when config has no plugins array, leaving it untouched', async () => {
  const original = 'export default { server: { port: 4000 } };\n';
  const dir = await tempProject({ 'package.json': VITE_PKG, 'vite.config.mjs': original });
  await assert.rejects(() => installProject(dir), /plugins/);
  const after = await fs.readFile(path.join(dir, 'vite.config.mjs'), 'utf8');
  assert.equal(after, original);
  // 不应留下备份残骸
  const entries = await fs.readdir(dir);
  assert.equal(entries.filter(n => n.includes('zw-backup')).length, 0);
});

test('install reports manual integration for non-Vite projects', async () => {
  // Vue 2 + webpack-dev-server：不自动改配置，走手动接入
  const dir = await tempProject({
    'package.json': JSON.stringify({
      name: 'webpack-app',
      private: true,
      dependencies: { vue: '^2.6.14' },
      devDependencies: { webpack: '^5.90.0', 'webpack-dev-server': '^5.0.0' },
    }),
    'src/index.html': '<div id="app"></div>',
    'src/main.js': '',
  });
  const result = await installProject(dir);
  assert.equal(result.strategy, 'webpack');
  assert.equal(result.framework, 'vue');
  assert.equal(result.frameworkMajor, 2);
  assert.equal(result.integration.action, 'manual');
  // Vue 2 必须选到 vue2 适配器，而不是默认的 Vue 3
  assert.equal(result.integration.adapter, 'vue2.mjs');
  // 仍然拷贝运行时并初始化工作区
  assert.equal(result.runtimeFiles.length, RUNTIME_FILES.length);
  await fs.access(path.join(dir, WORK_ROOT, 'tasks'));
});

test('install refuses a directory that is not a frontend project', async () => {
  const dir = await tempProject({
    'package.json': JSON.stringify({ name: 'api', private: true, dependencies: { express: '^4.18.0' } }),
  });
  // 装错地方会让人以为成功了却完全不生效，因此必须直接拒绝
  await assert.rejects(() => installProject(dir), /未在.*检测到前端项目/);
  const entries = await fs.readdir(dir);
  assert.equal(entries.filter(n => n.includes('.zcode')).length, 0);
});

test('install can override the frontend guard explicitly', async () => {
  const dir = await tempProject({
    'package.json': JSON.stringify({ name: 'api', private: true, dependencies: { express: '^4.18.0' } }),
  });
  const result = await installProject(dir, { allowNonFrontend: true });
  assert.equal(result.ok, true);
  assert.equal(result.detected.isFrontend, false);
  assert.equal(result.integration.action, 'manual');
});

test('Vue project without a bundler gets middleware plus an optional mount', async () => {
  const dir = await tempProject({
    'package.json': JSON.stringify({ name: 'vue3-app', private: true, dependencies: { vue: '^3.4.21' } }),
    'index.html': '<div id="app"></div>',
    'src/main.js': '',
  });
  const result = await installProject(dir);
  assert.equal(result.integration.action, 'manual');
  const files = result.integration.snippet.files;
  // 首选方案是中间件（它会自动注入 UI，一步到位）
  assert.match(files[0].lines, /createAnnotationsMiddleware/);
  // 同时给出入口挂载作为备选，用 vue3 适配器
  const mount = files.find(f => f.file === 'src/main.js');
  assert.ok(mount, '应提供入口挂载备选');
  assert.match(mount.lines, /app\.use\(createAnnotations\(\)\)/);
  assert.match(mount.lines, /vue3\.mjs/);
});

test('Vue CLI snippet needs only the dev server middleware', async () => {
  const dir = await tempProject({
    'package.json': JSON.stringify({
      name: 'v2-cli',
      private: true,
      dependencies: { vue: '^2.6.14' },
      devDependencies: { '@vue/cli-service': '^5.0.8' },
    }),
    'public/index.html': '<div id="app"></div>',
    'src/main.js': '',
  });
  const result = await installProject(dir);
  assert.equal(result.strategy, 'vue-cli');
  const files = result.integration.snippet.files;
  // 中间件自身就会把 UI 注入页面，因此只需粘一处
  assert.equal(files.length, 1);
  assert.equal(files[0].file, 'vue.config.js');
  assert.match(files[0].lines, /createAnnotationsMiddleware/);
});

test('React on webpack also gets a complete, single-paste snippet', async () => {
  const dir = await tempProject({
    'package.json': JSON.stringify({
      name: 'react-webpack',
      private: true,
      dependencies: { react: '^18.2.0' },
      devDependencies: { webpack: '^5.90.0', 'webpack-dev-server': '^5.0.0' },
    }),
    'public/index.html': '<div id="root"></div>',
    'src/index.js': '',
  });
  const result = await installProject(dir);
  assert.equal(result.strategy, 'webpack');
  assert.equal(result.framework, 'react');
  const files = result.integration.snippet.files;
  assert.equal(files.length, 1, 'React 无适配器，中间件一步到位');
  assert.match(files[0].lines, /createAnnotationsMiddleware/);
  // 不能只给接口不给 UI，否则页面永远不出现标注条
  assert.doesNotMatch(files[0].lines, /injectAnnotatorScript/);
});

test('patchViteConfigContent is a pure, repeatable transform', () => {
  const input = "import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [],\n});\n";
  const once = patchViteConfigContent(input);
  assert.equal(once.changed, true);
  assert.match(once.content, /zwAnnotations\(\{ dir:/);
  assert.equal(isPatched(once.content), true);
  const twice = patchViteConfigContent(once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('patchViteConfigContent inserts import after the last existing import', () => {
  const input = [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    '',
    'export default defineConfig({ plugins: [react()] });',
  ].join('\n');
  const { content } = patchViteConfigContent(input);
  const importIdx = content.indexOf('zwAnnotations }');
  const reactImportIdx = content.indexOf('@vitejs/plugin-react');
  const exportIdx = content.indexOf('export default');
  assert.ok(importIdx > reactImportIdx, 'import 应放在已有 import 之后');
  assert.ok(importIdx < exportIdx, 'import 应放在 export 之前');
});

test('inspectProject reports installed state and tasks dir', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  const before = await inspectProject(dir);
  assert.equal(before.installed, false);

  await installProject(dir);
  const after = await inspectProject(dir);
  assert.equal(after.installed, true);
  assert.equal(after.runtimeFiles.length, RUNTIME_FILES.length);
  assert.equal(after.tasksDir, path.join(dir, WORK_ROOT, 'tasks'));
  assert.ok(after.meta);
});

test('detectProject recognizes an already patched config', async () => {
  const dir = await tempProject({ 'package.json': VITE_PKG });
  await installProject(dir);
  const detected = await detectProject(dir);
  assert.equal(detected.patched, true);
  assert.equal(detected.installed, true);
});
