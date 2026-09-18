#!/usr/bin/env node
/**
 * 并行子 agent 工作区隔离 —— git worktree / 非 git 快照双模
 *
 * 用法：
 *   node scripts/workspace.mjs open  --root <项目> --task <id> [--link]  建工作区，返回 {mode,workspace}
 *   node scripts/workspace.mjs diff  --root <项目> --task <id>           预览改动与冲突风险
 *   node scripts/workspace.mjs merge --root <项目> --task <id>           合回主线（冲突显式列出，不静默覆盖）
 *   node scripts/workspace.mjs close --root <项目> --task <id> [--discard]  清理工作区
 *   node scripts/workspace.mjs list  --root <项目>                       列出活跃工作区
 *
 * git 项目：worktree add <root>/.zwa/.ws/<task> -b zwa/ws-<task>
 *   - 本地私有分支，不 push 远端永不可见；.zwa 本就 gitignore，工作区不污染 git status
 *   - 默认不软链 node_modules/.env.local：symlink 在 git 眼里是文件，node_modules/ 目录级
 *     忽略规则不覆盖它，一旦误入分支，merge 检出会覆盖主仓真实目录（实测毁过 node_modules）。
 *     merge 前置污染闸拦截兜底；确需在 worktree 跑 build/test 时显式加 --link
 *   - merge 用 --no-ff 显式合回，文件域重叠产出真实 git 冲突而不是静默覆盖
 *
 * 非 git 项目：整仓快照到 .zwa/.ws/<task>（排除 node_modules/.git/.zwa/dist/.DS_Store）
 *   - open 时记录全量文件 sha1 清单
 *   - merge 按「主线文件哈希 == 快照哈希」判定安全覆盖；主线也动过的文件列为冲突，整体拒绝
 *
 * 输出统一 JSON，方便 agent 解析。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WS_BASE = '.zwa/.ws';
const BRANCH_PREFIX = 'zwa/ws-';
const SNAPSHOT_EXCLUDES = new Set(['node_modules', '.git', '.zwa', 'dist', '.DS_Store']);
const LINK_CANDIDATES = ['node_modules', '.env.local'];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(t);
  }
  return args;
}

const out = (obj) => { console.log(JSON.stringify(obj, null, 2)); };
const fail = (msg, extra = {}) => { out({ ok: false, error: msg, ...extra }); process.exit(1); };

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
};

const sha1 = async (file) => crypto.createHash('sha1').update(await fs.readFile(file)).digest('hex');
const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-');

async function gitInfo(root) {
  const inside = run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], root);
  if (inside.code !== 0 || inside.stdout !== 'true') return null;
  const top = run('git', ['-C', root, 'rev-parse', '--show-toplevel'], root);
  if (top.code !== 0 || !top.stdout) return null;
  return { repoRoot: top.stdout, projectRel: path.relative(top.stdout, path.resolve(root)) || '.' };
}

/** meta 放工作区外侧（.zwa/.ws/<id>.meta.json），绝不进入 git 跟踪范围，防止 add -A 污染分支 */
const metaPath = (root, id) => path.join(root, WS_BASE, `${id}.meta.json`);
const readMeta = async (root, id) => {
  try { return JSON.parse(await fs.readFile(metaPath(root, id), 'utf8')); } catch { return null; }
};

async function walkFiles(dir, base = dir, acc = []) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (SNAPSHOT_EXCLUDES.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkFiles(p, base, acc);
    else if (ent.isFile()) acc.push(path.relative(base, p));
  }
  return acc;
}

async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    if (SNAPSHOT_EXCLUDES.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyTree(s, d);
    else if (ent.isFile()) { await fs.mkdir(path.dirname(d), { recursive: true }); await fs.copyFile(s, d); }
  }
}

/** git 模式：给 worktree 补 untracked 依赖（node_modules/.env.local 软链主仓） */
async function linkUntrackedDeps(meta) {
  const linked = [];
  const dirs = new Set(['.', meta.projectRel].filter(Boolean));
  for (const rel of dirs) {
    for (const name of LINK_CANDIDATES) {
      const src = path.join(meta.repoRoot, rel === '.' ? '' : rel, name);
      const dst = path.join(meta.workspace, rel === '.' ? '' : rel, name);
      if (!existsSync(src) || existsSync(dst)) continue;
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.symlink(src, dst, 'junction');
        linked.push(`${rel === '.' ? '' : rel + '/'}${name}`);
      } catch { /* 链接失败不阻塞：子 agent 可退化为只改代码不跑测试 */ }
    }
  }
  return linked;
}

async function cmdOpen(root, taskId, opts = {}) {
  const id = sanitize(taskId);
  if (!id) fail('需要 --task <id>');
  const wsPath = path.join(root, WS_BASE, id);
  if (existsSync(wsPath)) fail(`工作区已存在: ${wsPath}（先 close 或换 --task）`);
  await fs.mkdir(path.dirname(wsPath), { recursive: true });

  const git = await gitInfo(root);
  if (git) {
    const branch = `${BRANCH_PREFIX}${id}`;
    // 历史残留分支：未被任何 worktree 占用才允许删除重建
    const br = run('git', ['-C', git.repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`], root);
    if (br.code === 0) {
      const listed = run('git', ['-C', git.repoRoot, 'worktree', 'list', '--porcelain'], root);
      if (listed.stdout.includes(`refs/heads/${branch}`)) fail(`分支 ${branch} 已被其它 worktree 占用`);
      run('git', ['-C', git.repoRoot, 'branch', '-D', branch], root);
    }
    const add = run('git', ['-C', git.repoRoot, 'worktree', 'add', wsPath, '-b', branch], root);
    if (add.code !== 0) fail(`git worktree add 失败: ${add.stderr || add.stdout}`);
    const meta = {
      taskId, mode: 'git', branch, workspace: wsPath,
      repoRoot: git.repoRoot, projectRel: git.projectRel,
      baseRef: run('git', ['-C', git.repoRoot, 'rev-parse', 'HEAD'], root).stdout,
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(metaPath(root, id), JSON.stringify(meta, null, 2));
    // --link 才软链 untracked 依赖；link 时写 worktree 私有 info/exclude 尽力屏蔽
    // （部分 git 版本不支持 worktree 级 exclude，merge 的污染闸是最终防线）
    const linked = opts.link ? await linkUntrackedDeps(meta) : [];
    if (linked.length) {
      const gitdir = run('git', ['-C', wsPath, 'rev-parse', '--absolute-git-dir'], root).stdout;
      if (gitdir) {
        try {
          await fs.mkdir(path.join(gitdir, 'info'), { recursive: true });
          await fs.appendFile(path.join(gitdir, 'info', 'exclude'), 'node_modules\n.env.local\n');
        } catch { /* 保底：merge 污染闸拦截 */ }
      }
    }
    out({ ok: true, mode: 'git', workspace: wsPath, branch, projectDir: path.join(wsPath, git.projectRel === '.' ? '' : git.projectRel), linked });
    return;
  }

  // 非 git：整仓快照 + open 期哈希清单
  await copyTree(root, wsPath);
  const files = {};
  for (const rel of await walkFiles(wsPath)) {
    if (rel === '.ws-meta.json') continue;
    files[rel] = await sha1(path.join(wsPath, rel));
  }
  const meta = {
    taskId, mode: 'snapshot', workspace: wsPath, repoRoot: path.resolve(root),
    files, createdAt: new Date().toISOString()
  };
  await fs.writeFile(metaPath(root, id), JSON.stringify(meta, null, 2));
  out({ ok: true, mode: 'snapshot', workspace: wsPath, snapshotted: Object.keys(files).length });
}

/** 快照模式：对比 worktree 与 open 清单，得出 added/modified/deleted 与冲突风险 */
async function snapshotDiff(meta, root) {
  const wsFiles = await walkFiles(meta.workspace);
  const changed = { added: [], modified: [], deleted: [] };
  const wsSet = new Set(wsFiles.filter(f => f !== '.ws-meta.json'));
  for (const rel of wsSet) {
    const h = await sha1(path.join(meta.workspace, rel));
    if (!(rel in meta.files)) changed.added.push(rel);
    else if (meta.files[rel] !== h) changed.modified.push(rel);
  }
  for (const rel of Object.keys(meta.files)) {
    if (!wsSet.has(rel)) changed.deleted.push(rel);
  }
  // 冲突风险：工作区动过的文件，主线相对快照也变了 → 不可安全覆盖
  const conflicts = [];
  for (const rel of [...changed.modified, ...changed.deleted]) {
    const mainFile = path.join(root, rel);
    const mainHash = existsSync(mainFile) ? await sha1(mainFile) : null;
    if (mainHash !== meta.files[rel]) conflicts.push(rel);
  }
  for (const rel of changed.added) {
    const mainFile = path.join(root, rel);
    if (existsSync(mainFile) && (await sha1(mainFile)) !== (await sha1(path.join(meta.workspace, rel)))) {
      conflicts.push(rel);
    }
  }
  return { ...meta, changed, conflicts };
}

async function cmdDiff(root, taskId) {
  const meta = await loadMeta(root, taskId);
  if (meta.mode === 'git') {
    const dirty = run('git', ['-C', meta.workspace, 'status', '--short'], root).stdout;
    const stat = run('git', ['-C', meta.repoRoot, 'diff', '--stat', `${meta.baseRef}...${meta.branch}`], root).stdout;
    out({ ok: true, mode: 'git', branch: meta.branch, uncommitted: dirty ? dirty.split('\n') : [], diffStat: stat });
    return;
  }
  const d = await snapshotDiff(meta, root);
  out({ ok: true, mode: 'snapshot', changed: d.changed, conflicts: d.conflicts });
}

async function cmdMerge(root, taskId) {
  const meta = await loadMeta(root, taskId);
  if (meta.mode === 'git') {
    const dirty = run('git', ['-C', meta.workspace, 'status', '--short'], root).stdout;
    if (dirty) {
      run('git', ['-C', meta.workspace, 'add', '-A', '--', '.', ':(exclude)**/node_modules', ':(exclude)**/.env.local'], root);
      const c = run('git', ['-C', meta.workspace, 'commit', '-m', `zwa ws ${taskId} 自动提交`], root);
      if (c.code !== 0) fail(`工作区有未提交改动且自动提交失败: ${c.stderr}`);
    }
    // 安全闸：分支若含软链/meta 污染（info/exclude 失效或手工 add 绕过），merge 会把
    // symlink 检出覆盖主仓真实 node_modules 目录（实测发生过，node_modules 被毁须 npm ci 重建）
    const branchFiles = run('git', ['-C', meta.repoRoot, 'diff', '--name-only', `${meta.baseRef}...${meta.branch}`], root).stdout.split('\n').filter(Boolean);
    const polluted = branchFiles.filter(f => /(^|\/)node_modules$/.test(f) || /(^|\/)\.env\.local$/.test(f) || f === '.ws-meta.json');
    if (polluted.length) {
      out({ ok: false, merged: false, polluted,
        message: '分支含工作区软链/meta 文件，merge 会覆盖主仓真实目录，已拒绝。' +
          `处理：git -C ${meta.workspace} rm --cached ${polluted.join(' ')} 后重试，或 close --discard 重建。` });
      return;
    }
    const m = run('git', ['-C', meta.repoRoot, 'merge', '--no-ff', '-m', `merge zwa ws ${taskId}`, meta.branch], root);
    if (m.code !== 0) {
      const conf = run('git', ['-C', meta.repoRoot, 'diff', '--name-only', '--diff-filter=U'], root).stdout;
      out({ ok: false, merged: false, conflicts: conf ? conf.split('\n').filter(Boolean) : [], detail: m.stderr || m.stdout });
      return;
    }
    out({ ok: true, merged: true, mode: 'git', detail: m.stdout });
    return;
  }

  const d = await snapshotDiff(meta, root);
  if (d.conflicts.length) {
    out({ ok: false, merged: false, conflicts: d.conflicts, changed: d.changed,
      message: '以下文件主线与工作区都发生了变更，未做任何合入；请人工裁决后重试或 close --discard。' });
    return;
  }
  const merged = [];
  for (const rel of [...d.changed.added, ...d.changed.modified]) {
    const src = path.join(meta.workspace, rel);
    const dst = path.join(root, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    merged.push(rel);
  }
  for (const rel of d.changed.deleted) {
    await fs.rm(path.join(root, rel), { force: true });
    merged.push(`-${rel}`);
  }
  // 合入后刷新清单基线：close 的「未合入改动」判定以当前清单为准，
  // 不刷新会把已合入差异误判为未合入改动
  const files = {};
  for (const rel of await walkFiles(meta.workspace)) {
    if (rel === '.ws-meta.json') continue;
    files[rel] = await sha1(path.join(meta.workspace, rel));
  }
  meta.files = files;
  meta.mergedAt = new Date().toISOString();
  await fs.writeFile(metaPath(root, sanitize(taskId)), JSON.stringify(meta, null, 2));
  out({ ok: true, merged: true, mode: 'snapshot', files: merged });
}

async function cmdClose(root, taskId, discard) {
  const meta = await loadMeta(root, taskId);
  if (meta.mode === 'git') {
    const dirty = run('git', ['-C', meta.workspace, 'status', '--short'], root).stdout;
    const unmerged = run('git', ['-C', meta.repoRoot, 'branch', '--no-merged', 'HEAD', '--list', meta.branch], root).stdout;
    if ((dirty || unmerged.includes(meta.branch)) && !discard) {
      fail('工作区存在未提交或未合入的改动；确认放弃请加 --discard', { dirty: dirty ? dirty.split('\n') : [], unmerged: !!unmerged });
    }
    run('git', ['-C', meta.repoRoot, 'worktree', 'remove', meta.workspace, '--force'], root);
    run('git', ['-C', meta.repoRoot, 'branch', '-D', meta.branch], root);
    await fs.rm(metaPath(root, sanitize(taskId)), { force: true });
    out({ ok: true, closed: meta.workspace });
    return;
  }
  const d = await snapshotDiff(meta, root);
  const hasChanges = d.changed.added.length || d.changed.modified.length || d.changed.deleted.length;
  if (hasChanges && !discard) fail('快照工作区存在未合入改动；确认放弃请加 --discard', { changed: d.changed });
  await fs.rm(meta.workspace, { recursive: true, force: true });
  await fs.rm(metaPath(root, sanitize(taskId)), { force: true });
  out({ ok: true, closed: meta.workspace });
}

async function cmdList(root) {
  const base = path.join(root, WS_BASE);
  if (!existsSync(base)) { out({ ok: true, workspaces: [] }); return; }
  const list = [];
  for (const ent of await fs.readdir(base, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.meta.json')) continue;
    const meta = await readMeta(root, ent.name.slice(0, -'.meta.json'.length));
    if (meta) list.push({ taskId: meta.taskId, mode: meta.mode, workspace: meta.workspace, createdAt: meta.createdAt });
  }
  out({ ok: true, workspaces: list });
}

async function loadMeta(root, taskId) {
  const id = sanitize(taskId);
  const meta = await readMeta(root, id);
  if (!meta) fail(`工作区不存在或缺 meta: ${metaPath(root, id)}`);
  return meta;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const root = path.resolve(args.root || process.cwd());
const taskId = args.task;

switch (cmd) {
  case 'open': await cmdOpen(root, taskId, args); break;
  case 'diff': await cmdDiff(root, taskId); break;
  case 'merge': await cmdMerge(root, taskId); break;
  case 'close': await cmdClose(root, taskId, !!args.discard); break;
  case 'list': await cmdList(root); break;
  default:
    out({ ok: false, error: '用法: workspace.mjs open|diff|merge|close|list --root <项目> --task <id> [--discard]' });
    process.exit(1);
}
