# zw-web-annotations

AI agent 技能：给前端项目安装**网页元素批量标注**能力。用户在本地开发页面上直接点选/框选元素、就地写调整要求，任务自动落盘成 JSON，随后交给 AI agent 按轮次批量处理、验收、归档。

## 工作方式

```
用户标注（浏览器面板） → 任务 JSON 落盘（.zwa/tasks/） → agent 批处理
  → 验收（review → done） → 人工归档（archived） → 轮次交付（complete-round）
```

## 功能

- **元素标注**：点选、拖拽框选、Shift 多选，自动捕获 selector/xpath/源码位置/上下文截图
- **三态面板**：固定面板 ⇄ 悬耳（贴边细条+进度条）⇄ 悬浮药丸，拖拽吸边，布局持久化
- **任务状态机**：`todo → doing → review → done → archived`（另有 blocked/cancelled 旁路），服务端强制转移校验
- **两阶段归档**：done 留 live 等人工归档（待归档检验区），archived/cancelled 才进 `archive/` 文件
- **轮次执行**：轮次冻结集合 + 排队下一轮（queue 模式自动续轮），模式在途锁定
- **双模运行**：dev server 在线走 HTTP API + SSE 推送；掉线降级为文件模式 CLI
- **并行子 agent**：git worktree / 快照隔离工作区，主线程统一 merge
- **截图证据**：DOM 序列化上下文截图（DOM 变更感知缓存失效），双图策略（语境裁剪 + 全视口备查）

## 使用

技能不自动运行，由用户触发：

- 自然语言：「初始化网页标注」「给项目接入标注」「安装标注插件」
- 显式调用：`/zw-web-annotations`

```bash
# 体检（每次调用先做）
node scripts/cli.mjs status --root "$PWD"

# 检测工作区里的前端项目（框架/构建器自动识别）
node scripts/cli.mjs detect --root "$PWD"

# 安装运行时
node scripts/cli.mjs install --root "<项目目录>"

# dev server 掉线时的文件模式任务操作
node scripts/cli.mjs tasks --root "<项目目录>"
node scripts/cli.mjs task-patch --root "<项目目录>" --group <组id> --task <任务id> --status doing --assignee <名字>

# 并行子 agent 工作区（git worktree / 快照双模）
node scripts/workspace.mjs open  --root "<项目目录>" --task <任务id>
node scripts/workspace.mjs merge --root "<项目目录>" --task <任务id>
```

## 目录结构

```
SKILL.md                    技能入口（安装/升级/处理任务的完整协议）
references/                 集成说明、任务协议、排障手册
scripts/
  cli.mjs                   安装/体检/升级/文件模式任务操作入口
  detect.mjs                前端项目与框架构建器检测
  workspace.mjs             并行子 agent 工作区隔离
  runtime/
    client/annotator.mjs    浏览器端标注 UI（Shadow DOM 自包含）
    client/domshot.mjs      DOM 序列化截图
    core/store.mjs          任务存储与状态机（SSOT）
    adapters/               http / vue2 / vue3 / bridge 适配器
    board.mjs               任务看板页面
    execution-protocol.md   任务执行协议
    schema/                 任务/执行 JSON Schema
    vite/index.mjs          Vite 插件集成
tests/                      node:test 测试套件
```

## 测试

```bash
npm test   # node --test tests/*.test.mjs
```

## 依赖

Node ≥ 20，无外部 npm 依赖（运行时与测试全部自包含）。
