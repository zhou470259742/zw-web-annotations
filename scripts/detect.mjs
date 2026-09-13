/**
 * 前端项目与框架检测。
 *
 * 标注组件最终是要装进“前端项目”的，因此安装前必须先回答两个问题：
 * 1. 当前工作区里到底有没有前端项目？在哪个子目录？
 * 2. 它用什么框架、哪个大版本、什么构建器？据此决定接入方式。
 *
 * 这里只做只读探测，不修改任何文件，便于 Skill 先汇报再执行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 需要在工作区里跳过的目录，避免扫描 node_modules 拖慢探测。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '.zcode', 'coverage', '.cache', '.turbo', 'vendor', 'target', '.venv', 'venv',
]);

const MAX_SCAN_DEPTH = 3;

/** 框架识别表：命中 dependencies/devDependencies 里的包名即可判定。 */
const FRAMEWORKS = [
  { name: 'vue', label: 'Vue', packages: ['vue'] },
  { name: 'react', label: 'React', packages: ['react'] },
  { name: 'preact', label: 'Preact', packages: ['preact'] },
  { name: 'svelte', label: 'Svelte', packages: ['svelte'] },
  { name: 'solid', label: 'Solid', packages: ['solid-js'] },
  { name: 'angular', label: 'Angular', packages: ['@angular/core'] },
  { name: 'astro', label: 'Astro', packages: ['astro'] },
];

/** 元框架识别表：优先级高于基础框架，用于决定接入入口。 */
const META_FRAMEWORKS = [
  { name: 'next', label: 'Next.js', packages: ['next'] },
  { name: 'nuxt', label: 'Nuxt', packages: ['nuxt', 'nuxt3'] },
  { name: 'remix', label: 'Remix', packages: ['@remix-run/react', '@remix-run/node'] },
  { name: 'vite-plugin-vue', label: 'Vue + Vite', packages: [] },
];

/** 构建器识别表。 */
const BUNDLERS = [
  { name: 'vite', label: 'Vite', packages: ['vite'] },
  { name: 'vue-cli', label: 'Vue CLI (webpack)', packages: ['@vue/cli-service'] },
  { name: 'webpack', label: 'webpack', packages: ['webpack', 'webpack-dev-server'] },
  { name: 'rspack', label: 'Rspack', packages: ['@rspack/core'] },
  { name: 'parcel', label: 'Parcel', packages: ['parcel'] },
];

/** 从 semver 范围里取主版本号：^3.4.1 / ~2.7.0 / 3.x / 2 都能解析。 */
export function majorOf(range) {
  const match = String(range || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** 把依赖表合并成一个便于查包的映射。 */
function mergeDeps(pkg) {
  return {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
    ...(pkg?.peerDependencies || {}),
  };
}

/** 按识别表挑出命中的包，返回名称、版本范围和主版本。 */
function matchTable(table, deps) {
  for (const entry of table) {
    for (const pkgName of entry.packages) {
      if (deps[pkgName]) {
        return { name: entry.name, label: entry.label, package: pkgName, range: deps[pkgName], major: majorOf(deps[pkgName]) };
      }
    }
  }
  return null;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

/** 找出项目里的入口文件候选，供手动接入时提示插入位置。 */
async function findEntryCandidates(root) {
  const candidates = [
    'src/main.ts', 'src/main.js', 'src/main.mjs', 'src/main.jsx', 'src/main.tsx',
    'src/index.ts', 'src/index.js', 'src/index.jsx', 'src/index.tsx',
    'src/App.vue', 'src/app.vue', 'main.ts', 'main.js', 'index.js', 'index.ts',
  ];
  const found = [];
  for (const rel of candidates) {
    if (await exists(path.join(root, rel))) found.push(rel);
  }
  return found;
}

/** 探测单个项目目录：框架、构建器、入口文件与接入建议。 */
export async function detectFrontendAt(root) {
  const pkg = await readJsonSafe(path.join(root, 'package.json'));
  const deps = mergeDeps(pkg);
  const framework = matchTable(FRAMEWORKS, deps);
  const metaFramework = matchTable(META_FRAMEWORKS, deps);
  const bundler = matchTable(BUNDLERS, deps);

  const hasIndexHtml = await exists(path.join(root, 'index.html'));
  const entryCandidates = await findEntryCandidates(root);

  // 判定为前端项目需要同时满足两点：
  // 1. 有可解析的 package.json——只有 index.html 的目录（docs/、静态示例）
  //    没有可接入的构建流程，扫描工作区时当成项目会造成误报；
  // 2. 出现前端信号——识别到框架、元框架、构建器，或存在 index.html。
  //    单纯依赖 express 的后端项目虽然有 package.json，但没有任何前端信号。
  const isFrontend = !!pkg && !!(framework || metaFramework || bundler || hasIndexHtml);

  // Vue 的具体大版本：直接决定用 Vue2 还是 Vue3 适配器
  let frameworkMajor = framework?.major ?? null;
  if (framework?.name === 'vue') frameworkMajor = majorOf(deps.vue) ?? null;

  return {
    root,
    packageName: pkg?.name || null,
    hasPackageJson: !!pkg,
    isFrontend,
    framework: framework?.name || (metaFramework ? metaFramework.name : null),
    frameworkLabel: framework?.label || metaFramework?.label || null,
    frameworkMajor,
    frameworkVersion: framework?.range || null,
    metaFramework: metaFramework?.name || null,
    bundler: bundler?.name || (pkg && hasIndexHtml ? 'static' : null),
    bundlerLabel: bundler?.label || null,
    hasIndexHtml,
    entryCandidates,
  };
}

/**
 * 在工作区里寻找前端项目。
 * 先看根目录本身，再向下最多 3 层找 package.json，
 * 因为用户常常把前端放在 frontend/、web/、apps/web 这类子目录里。
 */
export async function findFrontendProjects(workspace, options = {}) {
  const root = path.resolve(workspace);
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const found = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const names = new Set(entries.map(e => e.name));
    if (names.has('package.json')) {
      const info = await detectFrontendAt(dir);
      if (info.isFrontend) {
        found.push({ ...info, depth });
        // 命中后不再深入它的子目录，避免把嵌套示例项目重复算进来
        return;
      }
    }

    if (depth === maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);

  // 根目录项目优先，其次按目录层级由浅到深
  found.sort((a, b) => a.depth - b.depth || a.root.localeCompare(b.root));
  return found;
}

/**
 * 根据检测结果给出接入策略。
 * 这是安装器的决策依据，也是 Skill 向用户解释“为什么这么接”的依据。
 */
export function recommendIntegration(info) {
  if (!info?.isFrontend) {
    return { strategy: 'none', reason: '未检测到前端项目' };
  }
  if (info.metaFramework === 'next') {
    return { strategy: 'http-middleware', reason: 'Next.js 使用自定义 dev server 中间件接入' };
  }
  if (info.metaFramework === 'nuxt') {
    return { strategy: 'vite', reason: 'Nuxt 3 基于 Vite，按 Vite 插件接入' };
  }
  if (info.bundler === 'vite') {
    return { strategy: 'vite', reason: 'Vite 项目，自动注入插件' };
  }
  if (info.bundler === 'vue-cli') {
    return { strategy: 'vue-cli', reason: 'Vue CLI 项目，改写 vue.config.js 的 devServer' };
  }
  if (info.bundler === 'webpack') {
    return { strategy: 'webpack', reason: 'webpack-dev-server 项目，改写 devServer 中间件' };
  }
  if (info.framework === 'vue') {
    return { strategy: 'vue-plugin', reason: 'Vue 项目但构建器未识别，使用框架适配器手动挂载' };
  }
  return { strategy: 'manual', reason: '未识别构建器，输出手动接入代码' };
}
