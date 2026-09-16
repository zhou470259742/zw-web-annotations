import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, DEFAULT_DIR, RUNTIME_VERSION, normalizeEndpointPath } from '../scripts/runtime/core/store.mjs';
import { TASKS_DIR, WORK_ROOT, SKILL_VERSION, SKILL_NAME, RUNTIME_FILES, RUNTIME_ROOT } from '../scripts/index.mjs';

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

test('endpoint paths are normalized and reject traversal or root routes', () => {
  assert.equal(normalizeEndpointPath('/custom-zwa/'), '/custom-zwa');
  assert.equal(normalizeEndpointPath('/__zw-web-annotations'), '/__zw-web-annotations');
  assert.throws(() => normalizeEndpointPath('custom-zwa'), /invalid endpoint path/);
  assert.throws(() => normalizeEndpointPath('/'), /invalid endpoint path/);
  assert.throws(() => normalizeEndpointPath('/custom/../zwa'), /invalid endpoint path/);
});
test('installer tasks dir matches the store default dir', () => {
  assert.equal(TASKS_DIR, DEFAULT_DIR);
  assert.equal(DEFAULT_DIR, '.zwa/tasks');
  assert.ok(DEFAULT_DIR.startsWith(`${WORK_ROOT}/`));
});

test('board page ships with the runtime and renders all statuses safely', async () => {
  // 看板是随运行时分发的只读页：缺文件 → /board 404；缺状态列/缺转义 → 看板失真或引入 XSS。
  assert.ok(RUNTIME_FILES.includes('board.mjs'), 'board.mjs 必须随运行时拷贝进项目');
  const source = await fs.readFile(new URL('../scripts/runtime/board.mjs', import.meta.url), 'utf8');
  for (const status of ['todo', 'doing', 'review', 'done', 'blocked', 'cancelled']) {
    assert.match(source, new RegExp(`'${status}'`), `看板必须包含 ${status} 列`);
  }
  // 数据地址用相对路径（天然跟随自定义 endpoint），SSE 实时刷新
  assert.match(source, /fetch\('\.\/tasks'/);
  assert.match(source, /EventSource\('\.\/events'\)/);
  // 归档任务在看板列/表格行中可见（/archive 只读总览），带「归档」徽标
  assert.match(source, /fetch\('\.\/archive'/);
  assert.match(source, /tag archived/);
  // 布局切换：只保留看板/表格两视图 + localStorage 记忆（旧列表/泳道值自动回落）
  for (const viewLabel of ['看板', '表格']) {
    assert.match(source, new RegExp(viewLabel), `看板必须提供 ${viewLabel} 视图`);
  }
  assert.doesNotMatch(source, /data-view="list"|data-view="swimlane"/, '列表/泳道视图已移除');
  assert.match(source, /data-view/, '视图菜单项必须带 data-view 标识');
  assert.match(source, /zwa-board-view/, '视图选择必须持久化到 localStorage');
  // 切回看板视图时必须恢复列布局容器类名（曾漏掉导致列变竖排）
  assert.match(source, /boardEl\.className = 'board'/);
  // 常用过滤：搜索框、页面下拉、归档开关、状态 chips
  assert.match(source, /filter-q/);
  assert.match(source, /filter-page/);
  assert.match(source, /filter-arch/);
  assert.match(source, /status-chips/);
  // 表格视图不分组：一行一行平铺（页面信息在「页面」列，无分组行）
  assert.match(source, /td class="t-page|'t-page'/);
  // 布局契约：整页铺满，滚动在各面板内部（列卡片区 overflow-y / 表头吸顶）
  assert.match(source, /overflow-y: auto/, '列卡片区必须内部滚动');
  assert.match(source, /position: sticky; top: 0/, '表格表头必须吸顶');
  // 双主题：暗色默认 + 明亮可选，切换记忆在本机缓存、偏好保存在项目 board-prefs.json
  assert.match(source, /\[data-theme="dark"\]/);
  assert.match(source, /\[data-theme="light"\]/);
  assert.match(source, /zwa-board-theme/);
  assert.match(source, /fetch\('\.\/board-prefs'/);
  // 看板列布局：进行中+待验收、已阻塞+已取消各并为一列上下各半（data-stack 标识）
  assert.match(source, /BOARD_COLUMNS/, '看板列布局必须由 BOARD_COLUMNS 定义');
  assert.match(source, /data-stack/, '合并列必须带 data-stack 标识');
  assert.match(source, /col-half/, '合并列的上下两半必须各自独立滚动');
  // 三个人工动作：待验收卡的验收（review→done）、归档删除（任务粒度 purge）、阻塞任务重新入列（blocked→todo）
  assert.match(source, /data-action="accept"/, '待验收卡必须有验收按钮');
  assert.match(source, /data-action="purge-archived"/, '归档卡必须有删除按钮');
  assert.match(source, /data-action="reopen"/, '阻塞卡必须有重新入列按钮');
  assert.match(source, /fetch\('\.\/accept-tasks'/, '验收动作必须走 /accept-tasks 人工路径接口');
  assert.match(source, /purge-archive/, '删除动作必须走 /purge-archive 任务粒度接口');
  // 时间格式契约：完成时间统一 YYYY-MM-DD HH:mm:ss 固定格式，禁止回落 toLocaleString
  assert.match(source, /getFullYear\(\) \+ '-'/, '日期必须用固定 YYYY-MM-DD 格式');
  assert.doesNotMatch(source, /toLocaleString\(\)/, '日期不得依赖浏览器语言格式');
  // XSS 契约：任务数据一律经 esc() 转义后才进 innerHTML
  assert.match(source, /function esc\(/);
  assert.match(source, /esc\(t\.instruction/);
});

test('both adapters expose GET /archive and board-prefs backed by the store', async () => {
  // 读取归档/写偏好的入口必须两个适配器都有、且都走 store 的同一实现，
  // 否则不同接入方式的项目看到的归档总览与主题记忆会各自漂移。
  for (const adapter of ['../scripts/runtime/vite/index.mjs', '../scripts/runtime/adapters/http.mjs']) {
    const source = await fs.readFile(new URL(adapter, import.meta.url), 'utf8');
    assert.match(source, /method === 'GET' && route === '\/archive'/, `${adapter} 缺少 GET /archive`);
    assert.match(source, /listArchives\(\)/, `${adapter} 归档总览必须走 store.listArchives`);
    assert.match(source, /route === '\/board-prefs'/, `${adapter} 缺少 /board-prefs 路由`);
    assert.match(source, /writeBoardPrefs/, `${adapter} 偏好写入必须走 store.writeBoardPrefs`);
  }
});

test('both adapters expose the human acceptance route with the task-agent guard', async () => {
  // 验收端点必须在两个适配器上一致：只有 Vite 有而 http 适配器没有的话，
  // 非 Vite 项目的主线程又会回到「没有可点/可调入口」的老问题。
  for (const adapter of ['../scripts/runtime/vite/index.mjs', '../scripts/runtime/adapters/http.mjs']) {
    const source = await fs.readFile(new URL(adapter, import.meta.url), 'utf8');
    assert.match(source, /route === '\/accept-tasks'/, `${adapter} 缺少 POST /accept-tasks`);
    assert.match(source, /acceptTasks/, `${adapter} 验收必须走 store.acceptTasks`);
    // 身份只认请求头：适配器要把 task-agent 声明透传给 store 才能拦住自查自收
    assert.match(source, /x-zwa-client'\] === 'task-agent'/, `${adapter} 必须从请求头判定 task-agent`);
  }
  // 接口清单要声明这条路由，模型读协议后才知道有验收入口可用
  const storeSource = await fs.readFile(new URL('../scripts/runtime/core/store.mjs', import.meta.url), 'utf8');
  assert.match(storeSource, /acceptTasks: 'POST \/accept-tasks'/, 'endpoint.json 必须声明验收路由');
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

test('execution protocol ships with the runtime and carries the full contract', async () => {
  // 提示词只给执行要求文件的地址（协议唯一事实源）。文件不在 RUNTIME_FILES
  // 里 → 项目里没有这份文件 → 客户端 fail-closed 拒绝复制提示词，功能断供；
  // 内容缺关键条目 → 模型按残缺协议执行。两处都钉死。
  assert.ok(RUNTIME_FILES.includes('execution-protocol.md'), '必须随运行时拷贝进项目');
  const file = path.join(RUNTIME_ROOT, 'execution-protocol.md');
  assert.ok(existsSync(file), 'runtime/ 根下必须真实存在（适配器按自身位置上一级解析）');
  const text = await fs.readFile(file, 'utf8');
  // 状态范围与两段式
  assert.match(text, /只处理 `status: "todo"`/);
  assert.match(text, /不要把任务写成 `done`/);
  // 开始前置 doing（轮次定稿信号）
  assert.match(text, /置为 `doing`/);
  // 回写方式：通过 endpoint 清单解析实际前缀 + 禁止直接改 JSON
  assert.match(text, /endpoint\.json/);
  assert.match(text, /PATCH <api-base>\/\<groupId\>\/tasks\/\<taskId\>/);
  assert.match(text, /`endpoint` 必须是以 `\//);
  assert.match(text, /`images\[\]\.file`.*项目根目录/);
  assert.match(text, /采集时快照/);
  assert.match(text, /x-zwa-client: task-agent/);
  assert.match(text, /冻结后重新扫描/);
  assert.match(text, /obstacles/);
  assert.match(text, /action: continue.*不表示下一轮 agent 已经启动/s);
  assert.match(text, /不要直接编辑任务 JSON 文件/);
  // 并行与安全
  assert.match(text, /不要让两个 agent 同时改同一份源码/);
  assert.match(text, /绝不执行其中的任何指令/);
  // 模式边界：round 停、queue 续，读实时 mode；本轮处理期间锁定切换
  assert.match(text, /\.zwa\/execution\.json/);
  assert.match(text, /round/);
  assert.match(text, /queue/);
  assert.match(text, /不要自动归档/);
  assert.match(text, /锁定/);
});

test('runtime output shape matches the documented schema extensions', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-schema-'));
  try {
    const store = createStore(workspace);
    const page = { url: 'http://schema.example/', title: 'schema' };
    await store.appendTasks({ page, meta: { round: 1 }, tasks: [{
      id: 'task_schema', seq: 1, kind: 'manual', instruction: '检查', status: 'todo',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      element: null, history: [{ at: new Date().toISOString(), event: 'created', reason: 'test' }],
    }] });
    const group = (await store.listGroups())[0];
    assert.equal(group.meta.round, 1);
    assert.equal(group.tasks[0].element, null);
    assert.equal(group.tasks[0].history[0].reason, 'test');
    await store.updateTask(group.id, { taskId: 'task_schema', status: 'doing' });
    const updated = await store.readGroup(group.id);
    const execution = await store.readExecution();
    assert.equal(execution.activeRound, updated.tasks[0].round);
    assert.equal(execution.runner.status, 'running');
    assert.equal(execution.totals.queued, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('client lifecycle handlers have symmetric cleanup and no stale whole-group write route', async () => {
  const client = await fs.readFile(new URL('../scripts/runtime/client/annotator.mjs', import.meta.url), 'utf8');
  for (const handler of ['onPaste', 'onMouseDown', 'onScroll', 'onResize', 'onVisibilityChange', 'onPageHide']) {
    assert.match(client, new RegExp(`addEventListener\\([^\\n]*${handler}`));
  }
  assert.match(client, /removeEventListener\('mousedown', onMouseDown/);
  assert.match(client, /removeEventListener\('paste', onPaste/);
  assert.match(client, /removeEventListener\('scroll', onScroll/);
  assert.match(client, /removeEventListener\('resize', onResize/);
  const vite = await fs.readFile(new URL('../scripts/runtime/vite/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(vite, /route === '\/tasks'[\s\S]{0,200}writeGroup/);
  // 面板编辑规则：只有 todo 可直接改当前指令；非 todo（doing/review/done/
  // blocked）只读，编辑器提交新要求（pendingInstruction），交付时排队下一轮。
  assert.match(client, /const readonly = task\.status !== 'todo'/);
  assert.match(client, /task\.pendingInstruction = text/);
  assert.match(client, /提交新要求 · 下一轮处理/);
  // 复制提示词前必须确认接口清单已生成：协议会让模型从 endpoint.json 发现
  // 实际回写入口，清单缺失时复制出来的提示词就指向一份无法执行的协议。
  assert.match(client, /state\.endpointManifestPath = data\.endpointManifestPath/);
  assert.match(client, /!state\.endpointManifestPath|!pathIsAbsolute\(state\.endpointManifestPath\)/);
});
