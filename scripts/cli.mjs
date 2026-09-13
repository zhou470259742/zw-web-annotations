#!/usr/bin/env node
/**
 * 安装器 CLI —— 技能调用它完成检测、安装与自检。
 *
 * 用法：
 *   node scripts/cli.mjs detect  [--root <工作区>]              在工作区里寻找前端项目
 *   node scripts/cli.mjs inspect [--root <项目目录>]            只读查看现状
 *   node scripts/cli.mjs plan    [--root <项目目录>]            先看将要改什么
 *   node scripts/cli.mjs install [--root <项目目录>] [--framework vite|manual|vue-plugin] [--force]
 *   node scripts/cli.mjs doctor  [--root <项目目录>]            安装后自检
 *   node scripts/cli.mjs status  [--root <项目目录>]            只读版本体检（每次调用技能前先跑）
 *   node scripts/cli.mjs upgrade [--root <项目目录>] [--force]  兼容升级：替换运行时，不动任务数据
 *
 * 输出统一为 JSON，方便 Agent 解析后向用户汇报。
 * 运行时位于技能自身的 scripts/runtime/，因此技能整个压缩发出去即可用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  installProject,
  planInstall,
  inspectProject,
  runtimeFingerprint,
  discoverFrontends,
  checkStatus,
  upgradeProject,
  WORK_ROOT,
  TASKS_DIR,
  META_FILE,
  RUNTIME_FILES,
  SKILL_VERSION,
} from './index.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

/** 安装后自检：目录、运行时、接入状态、元数据一次说清。 */
async function runDoctor(root) {
  const info = await inspectProject(root);
  const checks = [];

  checks.push({
    name: 'frontend-detected',
    ok: info.isFrontend,
    detail: info.isFrontend
      ? `${info.frameworkLabel || info.framework}${info.frameworkMajor ? ' ' + info.frameworkMajor : ''} + ${info.bundlerLabel || info.bundler}`
      : '未检测到前端项目',
  });

  checks.push({
    name: 'runtime-installed',
    ok: info.runtimeFiles.length === RUNTIME_FILES.length,
    detail: `${info.runtimeFiles.length}/${RUNTIME_FILES.length} 个运行时文件`,
  });

  const tasksDir = path.join(root, TASKS_DIR);
  const tasksExists = await fs.access(tasksDir).then(() => true).catch(() => false);
  checks.push({ name: 'tasks-dir', ok: tasksExists, detail: path.relative(root, tasksDir) });

  const manual = info.meta?.integration?.action === 'manual';
  checks.push({
    name: 'config-integrated',
    ok: info.patched || manual,
    detail: info.patched
      ? `已接入 ${info.configFile}`
      : manual
        ? '手动接入模式，需按提示在入口文件挂载'
        : '配置未接入',
  });

  checks.push({
    name: 'install-meta',
    ok: !!info.meta,
    detail: info.meta ? `安装于 ${info.meta.installedAt}` : '缺少 install.json',
  });

  // 比对元数据版本与技能版本：技能升级后，旧项目必须 --force 重装运行时才会更新。
  // 不比对的话，用户会以为技能升级即生效，实际项目里跑的还是旧运行时。
  const installedVersion = info.meta?.skillVersion || null;
  const versionKnown = !!installedVersion && installedVersion !== '0.0.0';
  checks.push({
    name: 'runtime-version',
    ok: versionKnown && installedVersion === SKILL_VERSION,
    detail: !info.meta
      ? '无元数据，无法判断'
      : !versionKnown
        ? '元数据未记录版本（旧版安装），建议 --force 重装'
        : installedVersion === SKILL_VERSION
          ? `${installedVersion}（与技能一致）`
          : `已装 ${installedVersion}，技能为 ${SKILL_VERSION}，建议 --force 重装`,
  });

  return {
    root,
    ok: checks.every(c => c.ok),
    checks,
    skillVersion: SKILL_VERSION,
    installedVersion,
    tasksDir,
    metaFile: path.join(root, META_FILE),
    workRoot: WORK_ROOT,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'detect';
  const root = path.resolve(args.root || process.env.ZCODE_PROJECT_DIR || process.cwd());
  const options = {
    framework: args.framework,
    force: !!args.force,
    allowNonFrontend: !!args['allow-non-frontend'],
  };

  try {
    if (command === 'detect') {
      const projects = await discoverFrontends(root, {
        maxDepth: args.depth ? Number(args.depth) : undefined,
      });
      return { ok: true, command, workspace: root, count: projects.length, projects };
    }
    if (command === 'inspect') {
      const info = await inspectProject(root, options);
      const fingerprint = await runtimeFingerprint(options);
      return { ok: true, command, runtimeFingerprint: fingerprint, ...info };
    }
    if (command === 'plan') {
      const plan = await planInstall(root, options);
      return { ok: true, command, root, ...plan };
    }
    if (command === 'install') {
      const result = await installProject(root, options);
      return { ok: true, command, ...result };
    }
    if (command === 'doctor') {
      const result = await runDoctor(root);
      return { ok: result.ok, command, ...result };
    }
    if (command === 'status') {
      const result = await checkStatus(root);
      return { ok: true, command, ...result };
    }
    if (command === 'upgrade') {
      const result = await upgradeProject(root, options);
      return { ok: true, command, ...result };
    }
    return { ok: false, error: `未知命令：${command}`, valid: ['detect', 'inspect', 'plan', 'install', 'doctor', 'status', 'upgrade'] };
  } catch (error) {
    return { ok: false, command, root, error: error.message };
  }
}

const result = await main();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
