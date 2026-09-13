import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectFrontendAt,
  findFrontendProjects,
  recommendIntegration,
  majorOf,
} from '../scripts/detect.mjs';

/** 建一个临时项目目录，写入给定文件。 */
async function project(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-detect-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

const pkg = deps => JSON.stringify({ name: 'app', private: true, ...deps }, null, 2);

test('majorOf parses common semver range forms', () => {
  assert.equal(majorOf('^3.4.21'), 3);
  assert.equal(majorOf('~2.6.14'), 2);
  assert.equal(majorOf('5.0.8'), 5);
  assert.equal(majorOf('>=4.0.0'), 4);
  assert.equal(majorOf('latest'), null);
  assert.equal(majorOf(undefined), null);
});

test('detects Vue 3 on Vite', async () => {
  const dir = await project({
    'package.json': pkg({ dependencies: { vue: '^3.4.21' }, devDependencies: { vite: '^5.2.0' } }),
    'index.html': '<div id="app"></div>',
    'src/main.js': '',
  });
  const info = await detectFrontendAt(dir);
  assert.equal(info.isFrontend, true);
  assert.equal(info.framework, 'vue');
  assert.equal(info.frameworkMajor, 3);
  assert.equal(info.bundler, 'vite');
  assert.deepEqual(info.entryCandidates, ['src/main.js']);
  assert.equal(recommendIntegration(info).strategy, 'vite');
});

test('detects Vue 2 on Vue CLI', async () => {
  const dir = await project({
    'package.json': pkg({ dependencies: { vue: '^2.6.14' }, devDependencies: { '@vue/cli-service': '^5.0.8' } }),
    'public/index.html': '<div id="app"></div>',
    'src/main.js': '',
  });
  const info = await detectFrontendAt(dir);
  assert.equal(info.framework, 'vue');
  assert.equal(info.frameworkMajor, 2);
  assert.equal(info.bundler, 'vue-cli');
  assert.equal(recommendIntegration(info).strategy, 'vue-cli');
});

test('distinguishes Vue 2 and Vue 3 by major version', async () => {
  const v2 = await project({ 'package.json': pkg({ dependencies: { vue: '^2.7.16' }, devDependencies: { vite: '^5.0.0' } }) });
  const v3 = await project({ 'package.json': pkg({ dependencies: { vue: '^3.0.0' }, devDependencies: { vite: '^5.0.0' } }) });
  assert.equal((await detectFrontendAt(v2)).frameworkMajor, 2);
  assert.equal((await detectFrontendAt(v3)).frameworkMajor, 3);
});

test('detects React and Svelte projects', async () => {
  const react = await project({
    'package.json': pkg({ dependencies: { react: '^18.2.0' }, devDependencies: { vite: '^5.0.0' } }),
    'index.html': '<div id="root"></div>',
  });
  const svelte = await project({
    'package.json': pkg({ dependencies: { svelte: '^4.0.0' }, devDependencies: { vite: '^5.0.0' } }),
    'index.html': '<div></div>',
  });
  const r = await detectFrontendAt(react);
  const s = await detectFrontendAt(svelte);
  assert.equal(r.framework, 'react');
  assert.equal(s.framework, 'svelte');
  // 没有专用适配器时，仍然通过 vite 接入
  assert.equal(recommendIntegration(r).strategy, 'vite');
  assert.equal(recommendIntegration(s).strategy, 'vite');
});

test('detects Next.js and recommends middleware', async () => {
  const dir = await project({
    'package.json': pkg({ dependencies: { next: '^14.0.0', react: '^18.2.0' } }),
  });
  const info = await detectFrontendAt(dir);
  assert.equal(info.metaFramework, 'next');
  assert.equal(recommendIntegration(info).strategy, 'http-middleware');
});

test('detects Nuxt as a Vite project', async () => {
  const dir = await project({
    'package.json': pkg({ dependencies: { nuxt: '^3.9.0', vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
  });
  const info = await detectFrontendAt(dir);
  assert.equal(info.metaFramework, 'nuxt');
  assert.equal(recommendIntegration(info).strategy, 'vite');
});

test('a plain backend project is not a frontend project', async () => {
  const dir = await project({
    'package.json': pkg({ dependencies: { express: '^4.18.0', pino: '^8.0.0' } }),
  });
  const info = await detectFrontendAt(dir);
  assert.equal(info.isFrontend, false);
  assert.equal(recommendIntegration(info).strategy, 'none');
});

test('a bare index.html without a package.json is not treated as a project', async () => {
  // 只有 index.html 的目录（例如 docs/）没有可接入的构建流程，
  // 扫描工作区时把它当成项目会造成误报，因此要求必须有 package.json。
  const dir = await project({ 'index.html': '<div></div>' });
  const info = await detectFrontendAt(dir);
  assert.equal(info.isFrontend, false);
  assert.equal(info.hasPackageJson, false);
});

test('a package.json with index.html but no known bundler is still frontend', async () => {
  const dir = await project({
    'package.json': pkg({ dependencies: { vue: '^3.4.21' } }),
    'index.html': '<div id="app"></div>',
  });
  const info = await detectFrontendAt(dir);
  assert.equal(info.isFrontend, true);
  assert.equal(info.framework, 'vue');
  assert.equal(info.bundler, 'static');
});

test('findFrontendProjects locates nested projects and skips node_modules', async () => {
  const root = await project({
    'web/package.json': pkg({ dependencies: { vue: '^3.4.21' }, devDependencies: { vite: '^5.0.0' } }),
    'web/index.html': '<div id="app"></div>',
    'node_modules/fake/package.json': pkg({ dependencies: { vue: '^3.0.0' }, devDependencies: { vite: '^5.0.0' } }),
    'node_modules/fake/index.html': '<div></div>',
  });
  const found = await findFrontendProjects(root);
  assert.equal(found.length, 1, 'node_modules 里的假项目必须被跳过');
  assert.equal(path.relative(root, found[0].root), 'web');
  assert.equal(found[0].framework, 'vue');
});

test('findFrontendProjects prefers the shallowest project', async () => {
  const root = await project({
    'package.json': pkg({ dependencies: { vue: '^3.4.21' }, devDependencies: { vite: '^5.0.0' } }),
    'index.html': '<div id="app"></div>',
    'packages/admin/package.json': pkg({ dependencies: { vue: '^3.0.0' }, devDependencies: { vite: '^5.0.0' } }),
    'packages/admin/index.html': '<div id="app"></div>',
  });
  const found = await findFrontendProjects(root);
  assert.ok(found.length >= 1);
  assert.equal(found[0].depth, 0, '根目录项目应排在前面');
});

test('findFrontendProjects returns empty for a workspace without frontend', async () => {
  const root = await project({ 'README.md': '# nothing here' });
  const found = await findFrontendProjects(root);
  assert.equal(found.length, 0);
});

test('detection does not blow up on malformed package.json', async () => {
  const dir = await project({ 'package.json': '{ not json', 'index.html': '<div></div>' });
  const info = await detectFrontendAt(dir);
  assert.equal(info.hasPackageJson, false);
  // 解析失败时按未知处理，不抛异常，也不能被当成可安装项目
  assert.equal(info.framework, null);
  assert.equal(info.isFrontend, false);
});
