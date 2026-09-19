/**
 * 网页标注：项目安装器
 *
 * 职责（全部为确定性文件操作，不依赖模型自由发挥）：
 * 1. 把运行时拷贝到目标项目的 .zwa/runtime/，使项目自包含；
 * 2. 初始化工作区目录与忽略规则；
 * 3. 幂等接入构建配置（默认 Vite），写入前备份并做语法校验，失败自动回滚；
 * 4. 写入安装元数据，供后续检测、升级与卸载使用。
 *
 * 对外只暴露 installProject / detectProject / planInstall，便于测试与 Skill 调用。
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  'client/domshot.mjs',
  'vite/index.mjs',
  'adapters/http.mjs',
  'board.mjs',
  'adapters/bridge.mjs',
  'adapters/vue3.mjs',
  'adapters/vue2.mjs',
  'schema/annotations.schema.json',
  'schema/execution.schema.json',
  // 执行要求（提示词只给这份文件的地址，协议细节都在里面）。
  // 必须与适配器同在 runtime/ 根下：适配器按「自身位置上一级」解析它。
  'execution-protocol.md',
];

export const WORK_ROOT = '.zwa';
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
export const SKILL_NAME = 'zw-web-annotations';
export const SKILL_VERSION = '0.31.2';

/**
 * 任务目录。
 * 必须与 core/store.mjs 的 DEFAULT_DIR 完全一致——桥接服务、MCP 与运行时
 * 都按那个常量解析落盘位置。installer 被打包进技能后位于 scripts/ 下，
 * 无法相对导入 core/store.mjs，因此这里保留字面量，
 * 并由 tests/consistency.test.mjs 断言两者相等，防止再次漂移。
 */
export const TASKS_DIR = `${WORK_ROOT}/tasks`;

/**
 * 传给标注运行时（createStore / zwAnnotations）的任务目录。
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
async function prepareRuntime(root, options = {}) {
  const sourceRoot = runtimeSourceRoot(options);
  const finalTarget = path.join(root, WORK_ROOT, 'runtime');
  const staging = path.join(root, WORK_ROOT, `.runtime-staging-${process.pid}-${Date.now()}`);
  const previous = path.join(root, WORK_ROOT, `.runtime-previous-${process.pid}-${Date.now()}`);
  const written = [];
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const rel of RUNTIME_FILES) {
      const src = path.join(sourceRoot, rel);
      const dest = path.join(staging, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      written.push(path.relative(root, path.join(finalTarget, rel)));
    }
    // endpoint.json 与 board-prefs.json 是运行时按项目生成的动态元数据/用户
    // 偏好，不属于技能静态 fingerprint；升级替换整个 runtime/ 时要先带过去，
    // 避免协议文件在请求前暂时失去自定义 endpoint 信息、用户主题偏好被清掉。
    for (const name of ['endpoint.json', 'board-prefs.json']) {
      try {
        await fs.copyFile(path.join(finalTarget, name), path.join(staging, name));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const stagedFingerprint = await runtimeFingerprint({ runtimeSource: staging });
    const sourceFingerprint = await runtimeFingerprint({ runtimeSource: sourceRoot });
    if (stagedFingerprint !== sourceFingerprint) throw new Error('runtime staging fingerprint mismatch');
    return { staging, finalTarget, previous, written };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function commitRuntime(prepared) {
  const { staging, finalTarget, previous, written } = prepared;
  const hadPrevious = await exists(finalTarget);
  if (hadPrevious) await fs.rename(finalTarget, previous);
  try {
    await fs.rename(staging, finalTarget);
  } catch (error) {
    if (hadPrevious && await exists(previous)) await fs.rename(previous, finalTarget);
    throw error;
  }
  if (await exists(previous)) await fs.rm(previous, { recursive: true, force: true });
  return written;
}

async function discardRuntime(prepared) {
  if (!prepared) return;
  await fs.rm(prepared.staging, { recursive: true, force: true });
}

async function initWorkspace(root, options) {
  const tasksDir = path.join(root, TASKS_DIR);
  await fs.mkdir(tasksDir, { recursive: true });
  const keep = path.join(tasksDir, '.gitkeep');
  if (!(await exists(keep))) await fs.writeFile(keep, '', 'utf8');

  const gitignore = path.join(root, '.gitignore');
  const entry = `${WORK_ROOT}/`;
  let gitignoreUpdated = false;
  let current = (await exists(gitignore)) ? await fs.readFile(gitignore, 'utf8') : '';
  // 0.24 及更早只忽略 tasks/；升级到完整工作区忽略时删除旧行，保留其余内容。
  const legacyEntry = `${WORK_ROOT}/tasks/`;
  const normalizedLines = current.split('\n').filter(line => line.trim() !== legacyEntry);
  const normalized = normalizedLines.join('\n');
  if (normalized !== current) {
    current = normalized;
    gitignoreUpdated = true;
  }
  if (!current.split('\n').some(line => line.trim() === entry)) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    current = `${current}${prefix}\n# 网页标注产生的本地工作空间\n${entry}\n`;
    gitignoreUpdated = true;
  }
  if (gitignoreUpdated) await fs.writeFile(gitignore, current, 'utf8');
  return { tasksDir: path.relative(root, tasksDir), gitignoreUpdated };
}

/**
 * 生成 Vite 配置的接入代码片段。
 * 用相对路径引用拷贝进项目的运行时，不依赖插件绝对路径。
 * 显式传入 dir，使任务落盘目录与安装器初始化的目录一致；
 * 该相对路径由运行时按项目根目录（process.cwd）解析。
 */
export function buildViteSnippet() {
  const importLine = `import { zwAnnotations } from './${WORK_ROOT}/runtime/vite/index.mjs';`;
  const pluginLine = `zwAnnotations({ dir: '${TASKS_DIR}' })`;
  return { importLine, pluginLine };
}

/** 判断配置是否已接入。 */
export function isPatched(content) {
  return typeof content === 'string' && content.includes('zwAnnotations') && content.includes(WORK_ROOT);
}

/**
 * 在 Vite 配置源码中注入插件。
 * 只做最小、可预测的文本改写：
 * - 在最后一个 import 之后插入 import 语句；
 * - 在 plugins 数组开头插入 zwAnnotations()。
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
  // Node 20/22 的 --check 不能解析 TypeScript 类型语法；把合法 vite.config.ts
  // 当成 JS 判错会阻断安装。TS 配置只做确定性的文本改写+备份，交给 Vite 自己
  // 的 TS loader 在启动时校验；JS/MJS/CJS 仍用 Node 语法检查。
  if (/\.(?:ts|mts|cts)$/i.test(filePath)) return { ok: true, skipped: true, reason: 'typescript config validated by Vite' };
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
    const backupPath = `${cfgPath}.zw-backup`;
    // 备份只在首次接入时写：重复安装/升级会走到这里，无条件覆盖会把
    // 最初的干净原文换成已注入的内容，备份从此失去回滚价值。
    if (!(await exists(backupPath))) await fs.copyFile(cfgPath, backupPath);
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
 * 1. 一个提供 /__zw-web-annotations/* 接口的 dev server 中间件（负责写盘）；
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

const LEGACY_WORKSPACES = ['.zcode/web-annotations', '.zw-web-annotations'];
const LEGACY_CONFIG_PREFIXES = ['.zcode/web-annotations', '.zw-web-annotations'];

/** 旧配置规范化：函数名更名、旧工作区路径映射到当前 WORK_ROOT、去重。 */
function normalizeLegacyConfigRefs(content) {
  let out = String(content)
    .split('zcodeAnnotations')
    .join('zwAnnotations');
  for (const legacy of LEGACY_CONFIG_PREFIXES) {
    out = out.split(legacy).join(WORK_ROOT);
  }
  // 去重 import 行：迁移可能同时留下旧名与新名两行
  const seen = new Set();
  out = out
    .split('\n')
    .filter(line => {
      const m = line.match(/import \{ zwAnnotations \} from '([^']+)';/);
      if (!m) return true;
      if (seen.has(m[1])) return false;
      seen.add(m[1]);
      return true;
    })
    .join('\n');
  // 去重插件调用：保留第一个 zwAnnotations({...})，其余连同前导逗号删除
  const callMatches = [...out.matchAll(/zwAnnotations\(\{[^}]*\}\)/g)].map(m => m[0]);
  if (callMatches.length > 1) {
    const drop = new Set(callMatches.slice(1));
    let seenCalls = 0;
    out = out
      .replace(/,?\s*zwAnnotations\(\{[^}]*\}\)/g, m => {
        const bare = m.replace(/^[,\s]+/, '');
        seenCalls += 1;
        return seenCalls === 1 ? bare : drop.has(bare) ? '' : bare;
      })
      .replace(/,\s*,/g, ',')
      .replace(/\[\s*,/g, '[')
      .replace(/,\s*\]/g, ']');
  }
  return out;
}

/**
 * 旧版工作区迁移：品牌中立化前的安装布局有两代——
 * `.zcode/web-annotations/`（≤0.11）与 `.zw-web-annotations/`（0.12 过渡版），
 * 现在统一是 `<项目>/.zwa/`。tasks/（含归档与附件）必须整体搬移——
 * 任务数据是用户唯一不可再生数据，迁移是搬而不是删；构建配置原位规范化
 * （函数名更名 + 旧路径映射 + 去重），旧 runtime 由安装流程重新生成。
 */
async function migrateLegacyWorkspace(root) {
  const modernRoot = path.join(root, WORK_ROOT);
  const legacyRoots = LEGACY_WORKSPACES.map(dir => path.join(root, dir)).filter(dir => existsSync(dir));
  if (!legacyRoots.length) return { migrated: false };
  await fs.mkdir(modernRoot, { recursive: true });

  let previousSkillVersion = null;
  let tasksMigrated = false;
  const patched = [];

  for (const legacyRoot of legacyRoots) {
    const legacyMeta = await readJsonSafe(path.join(legacyRoot, 'install.json'));
    previousSkillVersion = previousSkillVersion || legacyMeta?.skillVersion || null;

    // 1) 任务数据整体搬移（含 tasks/archive、tasks/attachments）。
    //    现代目录还是空壳（只有 .gitkeep，没有任何任务与归档）时直接顶替；
    //    现代目录已有真实数据（理论上只在异常中断后出现）时，把旧数据挪进
    //    带时间戳的抢救目录，绝不覆盖任何一方。
    const legacyTasks = path.join(legacyRoot, 'tasks');
    const modernTasks = path.join(modernRoot, 'tasks');
    if (await exists(legacyTasks)) {
      const modernHasContent =
        (await countTaskGroupFiles(root)) > 0 || existsSync(path.join(modernTasks, 'archive'));
      if (!modernHasContent) {
        await fs.rm(modernTasks, { recursive: true, force: true });
        await fs.rename(legacyTasks, modernTasks);
      } else {
        await fs.rename(legacyTasks, path.join(modernRoot, `tasks-legacy-${Date.now()}`));
      }
      tasksMigrated = true;
    }

    // 2) 构建配置原位规范化：旧函数名更名、旧路径映射到 .zwa、去重 import
    //    与插件调用。不做"还原备份"——重复安装会把备份覆盖成过期内容，
    //    规范化对任意混乱程度都能收敛到唯一正确形态。
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
      const cfgPath = path.join(root, name);
      if (!(await exists(cfgPath))) continue;
      const content = await fs.readFile(cfgPath, 'utf8');
      const needsFix =
        LEGACY_CONFIG_PREFIXES.some(prefix => content.includes(prefix)) || content.includes('zcodeAnnotations');
      if (!needsFix) continue;
      const normalized = normalizeLegacyConfigRefs(content);
      if (normalized !== content) await fs.writeFile(cfgPath, normalized, 'utf8');
      patched.push(name);
    }

    // 3) .gitignore 旧条目移除（新条目由 initWorkspace 追加），其余内容原样保留
    const gitignore = path.join(root, '.gitignore');
    if (await exists(gitignore)) {
      const current = await fs.readFile(gitignore, 'utf8');
      const legacyEntries = new Set(LEGACY_WORKSPACES.map(dir => `${dir}/tasks/`));
      const updated = current
        .split('\n')
        .filter(line => !legacyEntries.has(line.trim()))
        .join('\n');
      if (updated !== current) {
        await fs.writeFile(gitignore, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');
      }
    }

    // 4) 旧目录移除（数据已搬走，runtime 由安装流程在新位置重新生成）
    await fs.rm(legacyRoot, { recursive: true, force: true });
  }

  return {
    migrated: true,
    legacyRoots: legacyRoots.map(dir => path.relative(root, dir)),
    tasksMigrated,
    patched,
    previousSkillVersion: previousSkillVersion || null,
  };
}

async function countTaskGroupFiles(root) {
  const tasksDir = path.join(root, TASKS_DIR);
  try {
    return (await fs.readdir(tasksDir)).filter(name => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

async function workspaceDataFingerprint(root) {
  const workRoot = path.join(path.resolve(root), WORK_ROOT);
  const tasksRoot = path.join(workRoot, 'tasks');
  const files = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.gitkeep') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(tasksRoot);
  // execution.json 与 tasks 同级，是运行状态的一部分；install.json 不是用户任务数据，
  // 升级会正常更新它，绝不能把它算进 preserved 判断。
  const executionFile = path.join(workRoot, 'execution.json');
  if (await exists(executionFile)) files.push(executionFile);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(workRoot, file));
    hash.update(await fs.readFile(file));
  }
  return { digest: hash.digest('hex'), files: files.map(file => path.relative(workRoot, file)) };
}

/**
 * 执行安装。幂等：重复执行为跳过而非报错。
 * @returns 安装结果摘要
 */
export async function installProject(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  if (!(await exists(root))) throw new Error(`项目目录不存在：${root}`);

  // 旧布局迁移先行：任务数据必须先搬到新位置，安装才落到新目录
  const migration = await migrateLegacyWorkspace(root);

  const detected = await detectProject(root);

  // 前端项目检测是硬前置：装错地方会让用户以为成功了却完全不生效。
  if (!detected.frontend.isFrontend && !options.allowNonFrontend) {
    throw new Error(
      `未在 ${root} 检测到前端项目（缺少框架依赖与 index.html）。` +
      `请确认路径，或使用 --allow-non-frontend 跳过校验。`
    );
  }

  const strategy = options.framework || detected.recommendation.strategy;

  const shouldCopyRuntime = options.force || !detected.installed;
  const preparedRuntime = shouldCopyRuntime ? await prepareRuntime(root, options) : null;
  const written = preparedRuntime?.written || [];
  const runtimeManifest = await runtimeFileManifest();
  const runtimeFingerprintValue = await runtimeFingerprint();
  let workspace;
  let integration;
  try {
    workspace = await initWorkspace(root, options);
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
  } catch (error) {
    await discardRuntime(preparedRuntime);
    throw error;
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
    runtimeFingerprint: runtimeFingerprintValue,
    runtimeManifest,
    source: 'copy',
  };
  if (preparedRuntime) await commitRuntime(preparedRuntime);
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
    migration,
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

/** 语义化版本比较：a<b 返回 -1，a>b 返回 1，相等返回 0。只比较数字段。 */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 版本体检（只读）：技能每次被调用时的第一步。
 *
 * 技能自带运行时的更新不会自动传导到项目里——项目里跑的是安装时拷贝的
 * 副本。这里判断项目里的组件是「未安装 / 落后于技能 / 已是最新」，由技能
 * 据此决定走安装流程，还是**先询问用户**是否兼容升级：升级必须征得用户
 * 同意，不允许静默替换项目里的运行时代码。
 */
export async function checkStatus(projectRoot) {
  const root = path.resolve(projectRoot);
  const detected = await detectProject(root);
  const installedVersion = detected.meta?.skillVersion || null;
  const versionKnown = !!installedVersion && installedVersion !== '0.0.0';
  const integrity = detected.installed ? await runtimeIntegrity(root) : { matches: false };
  let action;
  if (!detected.frontend.isFrontend) action = 'not-frontend';
  else if (!detected.installed || !versionKnown) action = 'install';
  else if (installedVersion !== SKILL_VERSION || !integrity.matches) action = 'upgrade';
  else action = 'current';
  return {
    root,
    isFrontend: detected.frontend.isFrontend,
    framework: detected.frontend.framework,
    bundler: detected.frontend.bundler,
    skillVersion: SKILL_VERSION,
    installedVersion,
    upToDate: action === 'current',
    action,
    runtimeInstalled: detected.installed,
    runtimeIntegrity: integrity,
    metaFile: META_FILE,
  };
}

/**
 * 兼容升级：把项目里的运行时替换为技能当前版本。
 *
 * 只动 runtime/，绝不触碰 tasks/ 与归档——标注数据是用户唯一不可再生
 * 数据，升级前后都会点数校验并在结果里如实上报。必须整目录删除后重拷
 * 而不是增量覆盖：否则已废弃的旧运行时文件会残留在项目里被继续加载。
 */
export async function upgradeProject(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  // 旧布局先迁移（搬任务数据、修正配置与 gitignore），再按新布局判断安装状态
  const migration = await migrateLegacyWorkspace(root);
  const detected = await detectProject(root);
  if (!detected.installed || !detected.meta) {
    // 旧布局迁移后项目在新位置是未安装状态：按全新安装落地，同样视为
    // 一次升级（任务数据已由迁移整体搬移保留）。
    if (!migration.migrated) {
      throw new Error('该项目尚未安装标注组件，请先运行 install（status 的 action 为 install）。');
    }
    const taskGroupsBefore = await countTaskGroupFiles(root);
    const result = await installProject(root, { ...options, force: true });
    const taskGroupsAfter = await countTaskGroupFiles(root);
    const meta = JSON.parse(await fs.readFile(path.join(root, META_FILE), 'utf8'));
    meta.previousSkillVersion = migration.previousSkillVersion || null;
    meta.upgradedAt = new Date().toISOString();
    meta.migratedFromLegacy = true;
    await fs.writeFile(path.join(root, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      root,
      action: 'upgraded',
      from: migration.previousSkillVersion || 'unknown',
      to: SKILL_VERSION,
      migration,
      runtimeFiles: result.runtimeFiles,
      tasks: {
        dir: TASKS_DIR,
        before: taskGroupsBefore,
        after: taskGroupsAfter,
        preserved: taskGroupsBefore === taskGroupsAfter,
      },
      integration: result.integration,
      metaFile: META_FILE,
    };
  }
  const from = detected.meta.skillVersion || '0.0.0';
  const integrity = await runtimeIntegrity(root);
  if (from === SKILL_VERSION && integrity.matches && !options.force) {
    return {
      ok: true,
      root,
      action: 'current',
      from,
      to: SKILL_VERSION,
      message: `运行时已是 ${SKILL_VERSION}，无需升级。`,
    };
  }

  const taskSnapshotBefore = await workspaceDataFingerprint(root);
  const result = await installProject(root, { ...options, force: true });
  const taskSnapshotAfter = await workspaceDataFingerprint(root);
  const meta = JSON.parse(await fs.readFile(path.join(root, META_FILE), 'utf8'));
  meta.previousSkillVersion = from === '0.0.0' ? null : from;
  meta.upgradedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    root,
    action: 'upgraded',
    from,
    to: SKILL_VERSION,
    runtimeFiles: result.runtimeFiles,
    tasks: {
      dir: TASKS_DIR,
      before: taskSnapshotBefore,
      after: taskSnapshotAfter,
      preserved: taskSnapshotBefore.digest === taskSnapshotAfter.digest && JSON.stringify(taskSnapshotBefore.files) === JSON.stringify(taskSnapshotAfter.files),
    },
    integration: result.integration,
    metaFile: META_FILE,
  };
}

export async function runtimeFingerprint(options = {}) {
  const sourceRoot = runtimeSourceRoot(options);
  const hash = crypto.createHash('sha256');
  for (const rel of [...RUNTIME_FILES].sort()) {
    hash.update(rel);
    hash.update(await fs.readFile(path.join(sourceRoot, rel)));
  }
  return hash.digest('hex');
}

async function runtimeFileManifest(options = {}) {
  const sourceRoot = runtimeSourceRoot(options);
  const result = {};
  for (const rel of [...RUNTIME_FILES].sort()) {
    const data = await fs.readFile(path.join(sourceRoot, rel));
    result[rel] = { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }
  return result;
}

async function runtimeIntegrity(root) {
  const target = path.join(path.resolve(root), WORK_ROOT, 'runtime');
  const expected = await runtimeFileManifest();
  const actual = {};
  for (const rel of Object.keys(expected)) {
    const file = path.join(target, rel);
    try {
      const data = await fs.readFile(file);
      actual[rel] = { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
    } catch {
      actual[rel] = null;
    }
  }
  const matches = JSON.stringify(expected) === JSON.stringify(actual);
  return { matches, expected, actual };
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
    runtimeIntegrity: await runtimeIntegrity(detected.root),
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
