/**
 * Z Code 网页标注：项目安装器
 *
 * 职责（全部为确定性文件操作，不依赖模型自由发挥）：
 * 1. 把运行时拷贝到目标项目的 .zcode/web-annotations/runtime/，使项目自包含；
 * 2. 初始化工作区目录与忽略规则；
 * 3. 幂等接入构建配置（默认 Vite），写入前备份并做语法校验，失败自动回滚；
 * 4. 写入安装元数据，供后续检测、升级与卸载使用。
 *
 * 对外只暴露 installProject / detectProject / planInstall，便于测试与 Skill 调用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { detectFrontendAt, recommendIntegration } from './detect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 运行时文件所在目录。
 * 技能自带一份（scripts/runtime/），因此技能可以整个压缩发给别人，
 * 对方解压到技能目录即可使用，不依赖任何插件仓库或环境变量。
 */
export const RUNTIME_ROOT = path.join(here, 'runtime');

/** 需要拷贝进目标项目的运行时相对路径。 */
export const RUNTIME_FILES = [
  'core/store.mjs',
  'client/annotator.mjs',
  'vite/index.mjs',
  'adapters/http.mjs',
  'adapters/bridge.mjs',
  'adapters/vue3.mjs',
  'adapters/vue2.mjs',
  'schema/annotations.schema.json',
];

export const WORK_ROOT = '.zcode/web-annotations';
export const META_FILE = `${WORK_ROOT}/install.json`;

/**
 * 技能版本号 —— 唯一事实来源。
 *
 * 技能是自包含目录，仓库根的 package.json 不会随技能一起分发，
 * 所以版本必须写在技能自己身上。此处曾回落到读取 SKILL_ROOT/package.json，
 * 该文件在技能里并不存在，导致 install.json 永远记录 0.0.0，
 * 升级判断因此失效。tests/consistency.test.mjs 断言它等于仓库版本，防止两处漂移。
 *
 * 改动 runtime/ 下任何文件都必须同时提升此版本号：doctor 的 runtime-version
 * 检查靠它发现「技能升级了、项目里还是旧运行时」。版本不变时该检查会通过，
 * 项目就静默停留在旧代码上。
 */
export const SKILL_NAME = 'zcode-web-annotations';
export const SKILL_VERSION = '0.10.8';

/**
 * 任务目录。
 * 必须与 core/store.mjs 的 DEFAULT_DIR 完全一致——桥接服务、MCP 与运行时
 * 都按那个常量解析落盘位置。installer 被打包进技能后位于 scripts/ 下，
 * 无法相对导入 core/store.mjs，因此这里保留字面量，
 * 并由 tests/consistency.test.mjs 断言两者相等，防止再次漂移。
 */
export const TASKS_DIR = `${WORK_ROOT}/tasks`;

/**
 * 传给标注运行时（createStore / zcodeAnnotations）的任务目录。
 * 与 TASKS_DIR 保持一致，避免安装器宣称的目录与实际落盘目录不一致。
 */
export const RUNTIME_TASKS_DIR = TASKS_DIR;

/** 生成相对导入路径，用于改写配置时引用拷贝后的运行时。 */
export function runtimeEntry(projectRoot, file = 'vite/index.mjs') {
  return `./${WORK_ROOT}/runtime/${file}`;
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

/** 探测目标项目类型与已有接入状态。 */
export async function detectProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const pkg = await readJsonSafe(path.join(root, 'package.json'));

  const viteConfigNames = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'];
  let viteConfig = null;
  for (const name of viteConfigNames) {
    const full = path.join(root, name);
    if (await exists(full)) {
      viteConfig = { name, path: full, content: await fs.readFile(full, 'utf8') };
      break;
    }
  }

  const meta = await readJsonSafe(path.join(root, META_FILE));
  const runtimeInstalled = await exists(path.join(root, WORK_ROOT, 'runtime', 'vite', 'index.mjs'));

  // 框架与构建器检测：决定用哪种接入方式，以及用 Vue2 还是 Vue3 适配器
  const frontend = await detectFrontendAt(root);
  const recommendation = recommendIntegration(frontend);

  return {
    root,
    packageName: pkg?.name || null,
    hasPackageJson: !!pkg,
    viteConfig,
    isVite: !!viteConfig || !!pkg?.devDependencies?.vite || !!pkg?.dependencies?.vite,
    installed: runtimeInstalled,
    patched: !!viteConfig && viteConfig.content.includes(WORK_ROOT),
    meta,
    frontend,
    recommendation,
  };
}

/** 不改动任何文件，只描述将要做什么。 */
export async function planInstall(projectRoot, options = {}) {
  const detected = await detectProject(projectRoot);
  const steps = [];

  if (!detected.frontend.isFrontend) {
    steps.push({
      action: 'no-frontend-project',
      detail: '当前目录未检测到前端项目（缺少框架依赖与 index.html），请确认目录或指定 --root',
      blocked: true,
    });
    return { detected, steps, blocked: true };
  }

  steps.push({
    action: 'copy-runtime',
    detail: `拷贝 ${RUNTIME_FILES.length} 个运行时文件到 ${WORK_ROOT}/runtime/`,
    skip: detected.installed && !options.force,
  });
  steps.push({ action: 'init-workspace', detail: `创建 ${TASKS_DIR}/ 与 ${META_FILE}` });

  const strategy = options.framework || detected.recommendation.strategy;
  const frontend = detected.frontend;
  const label = frontend.frameworkLabel
    ? `${frontend.frameworkLabel}${frontend.frameworkMajor ? ' ' + frontend.frameworkMajor : ''}`
    : '未知框架';

  if (strategy === 'vite') {
    steps.push({ action: 'detected', detail: `检测到前端项目：${label} + ${frontend.bundlerLabel || 'Vite'}` });
    if (!detected.viteConfig) {
      steps.push({
        action: 'create-config',
        detail: '项目缺少 vite.config.*，将新建 vite.config.mjs 并接入标注插件',
        needsConfig: true,
      });
    } else {
      steps.push({
        action: 'patch-config',
        detail: detected.patched
          ? `${detected.viteConfig.name} 已接入，将跳过`
          : `向 ${detected.viteConfig.name} 注入标注插件（写入前备份）`,
        skip: detected.patched,
      });
    }
  } else if (strategy === 'vue-plugin') {
    const adapter = frontend.frameworkMajor === 2 ? 'vue2.mjs' : 'vue3.mjs';
    steps.push({ action: 'detected', detail: `检测到 ${label}，未识别到 Vite` });
    steps.push({
      action: 'manual-integration',
      detail: `提供 ${adapter} 接入代码，请在入口文件中挂载`,
      manual: true,
      adapter,
    });
  } else {
    steps.push({
      action: 'manual-integration',
      detail: `${detected.recommendation.reason}，将拷贝运行时并输出接入代码`,
      manual: true,
    });
  }

  return { detected, steps };
}

/** 运行时源目录：技能自带的 scripts/runtime/，可用 runtimeSource 覆盖。 */
function runtimeSourceRoot(options = {}) {
  return options.runtimeSource ? path.resolve(options.runtimeSource) : RUNTIME_ROOT;
}

/** 递归拷贝运行时文件，保持目录结构。 */
async function copyRuntime(root, options = {}) {
  const sourceRoot = runtimeSourceRoot(options);
  const target = path.join(root, WORK_ROOT, 'runtime');
  const written = [];
  for (const rel of RUNTIME_FILES) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(target, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    written.push(path.relative(root, dest));
  }
  return written;
}

async function initWorkspace(root, options) {
  const tasksDir = path.join(root, TASKS_DIR);
  await fs.mkdir(tasksDir, { recursive: true });
  const keep = path.join(tasksDir, '.gitkeep');
  if (!(await exists(keep))) await fs.writeFile(keep, '', 'utf8');

  const gitignore = path.join(root, '.gitignore');
  const entry = `${WORK_ROOT}/tasks/`;
  let gitignoreUpdated = false;
  const current = (await exists(gitignore)) ? await fs.readFile(gitignore, 'utf8') : '';
  if (!current.split('\n').some(line => line.trim() === entry)) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    await fs.writeFile(gitignore, `${current}${prefix}\n# Z Code 网页标注产生的本地任务\n${entry}\n`, 'utf8');
    gitignoreUpdated = true;
  }
  return { tasksDir: path.relative(root, tasksDir), gitignoreUpdated };
}

/**
 * 生成 Vite 配置的接入代码片段。
 * 用相对路径引用拷贝进项目的运行时，不依赖插件绝对路径。
 * 显式传入 dir，使任务落盘目录与安装器初始化的目录一致；
 * 该相对路径由运行时按项目根目录（process.cwd）解析。
 */
export function buildViteSnippet() {
  const importLine = `import { zcodeAnnotations } from './${WORK_ROOT}/runtime/vite/index.mjs';`;
  const pluginLine = `zcodeAnnotations({ dir: '${TASKS_DIR}' })`;
  return { importLine, pluginLine };
}

/** 判断配置是否已接入。 */
export function isPatched(content) {
  return typeof content === 'string' && content.includes('zcodeAnnotations') && content.includes(WORK_ROOT);
}

/**
 * 在 Vite 配置源码中注入插件。
 * 只做最小、可预测的文本改写：
 * - 在最后一个 import 之后插入 import 语句；
 * - 在 plugins 数组开头插入 zcodeAnnotations()。
 * 无法安全改写时抛出错误，由调用方决定是否降级为手动接入。
 */
export function patchViteConfigContent(content) {
  if (isPatched(content)) return { content, changed: false };
  if (typeof content !== 'string') throw new Error('config content is required');

  const { importLine, pluginLine } = buildViteSnippet();

  // 1) 插入 import：放在所有顶层 import 之后
  const importRe = /^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm;
  let lastImportEnd = -1;
  let match;
  while ((match = importRe.exec(content)) !== null) {
    lastImportEnd = match.index + match[0].length;
  }
  let next = content;
  if (lastImportEnd >= 0) {
    next = `${content.slice(0, lastImportEnd)}\n${importLine}${content.slice(lastImportEnd)}`;
  } else {
    next = `${importLine}\n${content}`;
  }

  // 2) 插入 plugins 调用
  const pluginsEmpty = /plugins\s*:\s*\[\s*\]/;
  const pluginsFilled = /plugins\s*:\s*\[/;
  if (pluginsEmpty.test(next)) {
    next = next.replace(pluginsEmpty, `plugins: [${pluginLine}]`);
  } else if (pluginsFilled.test(next)) {
    next = next.replace(pluginsFilled, `plugins: [${pluginLine}, `);
  } else {
    throw new Error('未找到 plugins 数组，无法自动接入');
  }
  return { content: next, changed: true };
}

/** 极简语法校验：用 node 解析模块语法，不执行配置。 */
async function validateSyntax(filePath) {
  const { spawn } = await import('node:child_process');
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', () => resolve({ ok: false, error: '无法启动语法校验进程' }));
    child.on('close', code => resolve({ ok: code === 0, error: stderr.trim() }));
  });
}

/** 接入 Vite 配置：备份 → 写入 → 校验 → 失败回滚。 */
async function integrateVite(root, detected) {
  const result = { action: null, file: null, backup: null, snippet: buildViteSnippet() };

  if (detected.viteConfig) {
    const { name, path: cfgPath, content } = detected.viteConfig;
    if (isPatched(content)) {
      result.action = 'skipped';
      result.file = name;
      return result;
    }
    const { content: patched, changed } = patchViteConfigContent(content);
    if (!changed) {
      result.action = 'skipped';
      result.file = name;
      return result;
    }
    const backupPath = `${cfgPath}.zcode-backup`;
    await fs.copyFile(cfgPath, backupPath);
    await fs.writeFile(cfgPath, patched, 'utf8');
    const check = await validateSyntax(cfgPath);
    if (!check.ok) {
      // 回滚，保证用户配置不被破坏
      await fs.copyFile(backupPath, cfgPath);
      await fs.rm(backupPath, { force: true });
      throw new Error(`配置语法校验失败，已回滚：${check.error}`);
    }
    result.action = 'patched';
    result.file = name;
    result.backup = path.basename(backupPath);
    return result;
  }

  // 没有配置文件：新建一个最小可用的 ESM 配置
  const cfgPath = path.join(root, 'vite.config.mjs');
  const { importLine, pluginLine } = buildViteSnippet();
  const created = [
    importLine,
    '',
    'export default {',
    `  plugins: [${pluginLine}],`,
    '};',
    '',
  ].join('\n');
  await fs.writeFile(cfgPath, created, 'utf8');
  const check = await validateSyntax(cfgPath);
  if (!check.ok) {
    await fs.rm(cfgPath, { force: true });
    throw new Error(`新建配置语法校验失败，已删除：${check.error}`);
  }
  result.action = 'created';
  result.file = 'vite.config.mjs';
  return result;
}

/**
 * 按检测结果生成手动接入片段。
 *
 * 接入一共需要两件事，缺一不可：
 * 1. 一个提供 /__zcode/annotations/* 接口的 dev server 中间件（负责写盘）；
 * 2. 把标注 UI 挂到页面上——Vite 插件自动注入，其他情况用框架适配器或中间件注入。
 *
 * 因此非 Vite 项目的接入代码同时包含中间件与挂载两部分。
 */
export function buildManualSnippet(projectRoot, detected, adapter) {
  const importPath = `./${WORK_ROOT}/runtime`;
  const vueMajor = detected?.frontend?.frameworkMajor;
  const isVue = detected?.frontend?.framework === 'vue';
  const bundler = detected?.frontend?.bundler;
  const entry = detected?.frontend?.entryCandidates?.[0] || (isVue ? 'src/main.js' : 'src/index.js');

  const middlewareLines = [
    `import { createAnnotationsMiddleware } from '${importPath}/adapters/http.mjs';`,
    ``,
    `const annotations = createAnnotationsMiddleware({`,
    `  workspace: process.cwd(),`,
    `  dir: '${TASKS_DIR}',`,
    `});`,
  ];

  // Vue CLI：在 vue.config.js 注册 devServer 中间件
  if (bundler === 'vue-cli') {
    return {
      adapter: 'http.mjs',
      entry,
      files: [
        {
          file: 'vue.config.js',
          note: '注册中间件：提供写盘接口，并自动把标注 UI 注入页面（无需再挂适配器）',
          lines: [
            `const { createAnnotationsMiddleware } = require('${importPath}/adapters/http.mjs');`,
            ``,
            `module.exports = {`,
            `  devServer: {`,
            `    setupMiddlewares(middlewares, devServer) {`,
            `      devServer.app.use(createAnnotationsMiddleware({`,
            `        workspace: __dirname,`,
            `        dir: '${TASKS_DIR}',`,
            `      }));`,
            `      return middlewares;`,
            `    },`,
            `  },`,
            `};`,
          ].join('\n'),
        },
      ],
      lines: middlewareLines.join('\n'),
    };
  }

  // webpack-dev-server：在 devServer.setupMiddlewares 注册
  if (bundler === 'webpack') {
    return {
      adapter: 'http.mjs',
      entry,
      files: [
        {
          file: 'webpack.config.js',
          note: '注册中间件：提供写盘接口，并自动把标注 UI 注入页面（无需再挂适配器）',
          lines: [
            `const { createAnnotationsMiddleware } = require('${importPath}/adapters/http.mjs');`,
            ``,
            `module.exports = {`,
            `  // ...你的既有配置`,
            `  devServer: {`,
            `    setupMiddlewares(middlewares, devServer) {`,
            `      devServer.app.use(createAnnotationsMiddleware({`,
            `        workspace: __dirname,`,
            `        dir: '${TASKS_DIR}',`,
            `      }));`,
            `      return middlewares;`,
            `    },`,
            `  },`,
            `};`,
          ].join('\n'),
        },
      ],
      lines: middlewareLines.join('\n'),
    };
  }

  // Vue 项目但构建器未识别：给中间件 + 入口挂载两种选择
  if (isVue) {
    return {
      adapter: adapter || (vueMajor === 2 ? 'vue2.mjs' : 'vue3.mjs'),
      entry,
      files: [
        {
          file: 'dev server 配置',
          note: '在 dev server 注册中间件（自动注入 UI，最省事）',
          lines: middlewareLines.join('\n'),
        },
        {
          file: entry,
          note: '或者不用中间件注入，直接在入口挂载组件（此时仍需另配接口来源）',
          lines: vueMajor === 2
            ? [
                `import Vue from 'vue';`,
                `import { createAnnotations } from '${importPath}/adapters/vue2.mjs';`,
                ``,
                `Vue.use(createAnnotations());`,
              ].join('\n')
            : [
                `import { createApp } from 'vue';`,
                `import { createAnnotations } from '${importPath}/adapters/vue3.mjs';`,
                ``,
                `const app = createApp(App);`,
                `app.use(createAnnotations());`,
                `app.mount('#app');`,
              ].join('\n'),
        },
      ],
      lines: middlewareLines.join('\n'),
    };
  }

  return {
    adapter: 'http.mjs',
    entry: 'dev server 配置',
    files: [
      {
        file: 'dev server 入口',
        note: '注册中间件即可：提供标注接口，并自动把 UI 注入 HTML',
        lines: middlewareLines.join('\n'),
      },
    ],
    lines: middlewareLines.join('\n'),
  };
}

/**
 * 执行安装。幂等：重复执行为跳过而非报错。
 * @returns 安装结果摘要
 */
export async function installProject(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  if (!(await exists(root))) throw new Error(`项目目录不存在：${root}`);

  const detected = await detectProject(root);

  // 前端项目检测是硬前置：装错地方会让用户以为成功了却完全不生效。
  if (!detected.frontend.isFrontend && !options.allowNonFrontend) {
    throw new Error(
      `未在 ${root} 检测到前端项目（缺少框架依赖与 index.html）。` +
      `请确认路径，或使用 --allow-non-frontend 跳过校验。`
    );
  }

  const strategy = options.framework || detected.recommendation.strategy;

  const written = options.force || !detected.installed ? await copyRuntime(root, options) : [];
  const workspace = await initWorkspace(root, options);

  let integration;
  if (strategy === 'vite') {
    integration = await integrateVite(root, detected);
  } else {
    const adapter = detected.frontend.framework === 'vue'
      ? (detected.frontend.frameworkMajor === 2 ? 'vue2.mjs' : 'vue3.mjs')
      : 'http.mjs';
    integration = {
      action: 'manual',
      file: null,
      adapter,
      reason: detected.recommendation.reason,
      snippet: buildManualSnippet(root, detected, adapter),
    };
  }

  const meta = {
    version: 1,
    skill: SKILL_NAME,
    skillVersion: SKILL_VERSION,
    installedAt: new Date().toISOString(),
    projectRoot: root,
    strategy,
    framework: detected.frontend.framework,
    frameworkMajor: detected.frontend.frameworkMajor,
    bundler: detected.frontend.bundler,
    runtimeDir: `${WORK_ROOT}/runtime`,
    tasksDir: TASKS_DIR,
    integration,
    files: written,
    source: 'copy',
  };
  await fs.writeFile(path.join(root, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    root,
    strategy,
    framework: detected.frontend.framework,
    frameworkMajor: detected.frontend.frameworkMajor,
    runtimeFiles: written,
    workspace,
    integration,
    metaFile: META_FILE,
    detected: {
      hasPackageJson: detected.hasPackageJson,
      isFrontend: detected.frontend.isFrontend,
      framework: detected.frontend.framework,
      frameworkMajor: detected.frontend.frameworkMajor,
      bundler: detected.frontend.bundler,
      configFile: detected.viteConfig?.name || null,
      alreadyInstalled: detected.installed,
      recommendation: detected.recommendation,
      entryCandidates: detected.frontend.entryCandidates,
    },
  };
}

/** 计算运行时的内容哈希，用于判断是否需要升级。 */
export async function runtimeFingerprint(options = {}) {
  const sourceRoot = runtimeSourceRoot(options);
  const hash = crypto.createHash('sha1');
  for (const rel of [...RUNTIME_FILES].sort()) {
    hash.update(rel);
    hash.update(await fs.readFile(path.join(sourceRoot, rel)));
  }
  return hash.digest('hex').slice(0, 12);
}

/** 只读检测：供 Skill 在安装前汇报现状，以及安装后校验。 */
export async function inspectProject(projectRoot) {
  const detected = await detectProject(projectRoot);
  const runtimeDir = path.join(detected.root, WORK_ROOT, 'runtime');
  const runtimeFiles = [];
  if (await exists(runtimeDir)) {
    for (const rel of RUNTIME_FILES) {
      if (await exists(path.join(runtimeDir, rel))) runtimeFiles.push(rel);
    }
  }
  return {
    root: detected.root,
    packageName: detected.packageName,
    isFrontend: detected.frontend.isFrontend,
    framework: detected.frontend.framework,
    frameworkLabel: detected.frontend.frameworkLabel,
    frameworkMajor: detected.frontend.frameworkMajor,
    frameworkVersion: detected.frontend.frameworkVersion,
    metaFramework: detected.frontend.metaFramework,
    bundler: detected.frontend.bundler,
    bundlerLabel: detected.frontend.bundlerLabel,
    entryCandidates: detected.frontend.entryCandidates,
    recommendation: detected.recommendation,
    isVite: detected.isVite,
    configFile: detected.viteConfig?.name || null,
    patched: detected.patched,
    installed: detected.installed,
    runtimeFiles,
    tasksDir: path.join(detected.root, TASKS_DIR),
    metaFile: path.join(detected.root, META_FILE),
    meta: detected.meta,
  };
}

/** 在工作区里寻找所有前端项目，供 Skill 选择安装目标。 */
export async function discoverFrontends(workspace, options = {}) {
  const { findFrontendProjects } = await import('./detect.mjs');
  const projects = await findFrontendProjects(workspace, options);
  return projects.map(p => ({
    root: p.root,
    relative: path.relative(path.resolve(workspace), p.root) || '.',
    depth: p.depth,
    packageName: p.packageName,
    framework: p.framework,
    frameworkLabel: p.frameworkLabel,
    frameworkMajor: p.frameworkMajor,
    bundler: p.bundler,
    entryCandidates: p.entryCandidates,
    recommendation: recommendIntegration(p),
  }));
}
