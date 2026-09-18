# 排查手册

装完不生效时按下面顺序排查。每一步都给出可执行的验证命令。

## 1. 先自检

```bash
node "<技能目录>/scripts/cli.mjs" doctor --root "<项目目录>"
```

`checks` 里哪一项 `ok: false`，就按对应小节处理。

## 2. 没检测到前端项目

`frontend-detected` 为 false。

- 确认 `--root` 指向的是前端项目目录，而不是工作区根目录；
- 用 `detect --root "$PWD"` 扫一遍工作区，看项目是否在子目录里；
- 项目确实没有前端依赖（纯后端）时，本技能不适用，不要强行安装。

## 3. 运行时没装全

`runtime-installed` 显示不足。重新安装并强制覆盖：

```bash
node "<技能目录>/scripts/cli.mjs" install --root "<项目目录>" --force
```

## 4. 页面右下角没有胶囊

按可能性从高到低检查：

**接口不通**。先确认中间件/插件已生效：

```bash
curl -s http://localhost:<端口>/__zw-web-annotations/health
```

应当返回 `{"ok":true,...}`。返回 HTML 说明请求被 dev server 的 fallback 接走了，即**插件没加载**。

地址必须与浏览器里访问页面时用的 host 一致，且**优先用 `localhost`**：Vite 默认只监听 IPv6 回环（`[::1]`），此时 `curl http://127.0.0.1:<端口>` 会连接被拒（`curl: (7) Failed to connect`），容易被误判成接口不存在。两种地址是否都通，可以先看监听情况：

```bash
lsof -nP -iTCP:<端口> -sTCP:LISTEN
```

出现 `TCP *:<端口> (LISTEN)` 才是所有地址都通；只有 `TCP [::1]:<端口>` 就说明 IPv4 回环不通，换用 `localhost` 或给 dev server 配 `server.host`。

**插件没加载**。检查构建配置：

```bash
grep -n "zwAnnotations" vite.config.* 2>/dev/null
```

没有输出说明没接上，重新执行 install。若有输出但仍不生效：

- 确认开发服务器是重新启动过的（配置改动需要重启）；
- 确认是开发模式（`apply: 'serve'` 只在 dev 生效，构建产物不含标注器）。

**手动接入模式漏了挂载**。`manual-integration` 时安装器只输出代码，需要用户自己粘贴。逐项核对 `integration.snippet.files[]` 是否都粘到位。

## 5. 胶囊出现，但标注存不下来

UI 能显示说明脚本加载成功，问题在写盘接口。

- 检查 Network 里 `POST /__zw-web-annotations/append` 的状态码；
- **404**：中间件没注册。Vue CLI / webpack 项目最常见的就是漏了 `setupMiddlewares` 那一段，见 `integration.md`；
- **400** 且提示 `invalid annotation group`：payload 不完整，属于组件问题，请带上响应内容反馈；
- **CORS 报错**：接口和页面不同源。确认访问页面的地址与接口地址同一 host:port。

## 6. 任务没落到预期目录

检查安装元数据里声明的目录：

```bash
cat "<项目>/.zwa/install.json"
```

对比 `tasksDir` 与实际落盘位置：

```bash
find "<项目>/.zwa" -name "*.json" -not -path "*/runtime/*"
```

**常见原因**：中间件没传 `dir`，于是回退到默认目录 `.zwa/`，而安装器初始化的是 `.zwa/tasks/`。
解决：给 `createAnnotationsMiddleware` 显式传 `dir: '.zwa/tasks'`。

## 7. 图片附件打不开

任务里的 `images[].file` 是相对工作区根目录的路径。检查文件是否真的存在：

```bash
ls "<项目>/<images[].file 的值>"
```

附件与任务 JSON 同目录下的 `attachments/` 中。删任务时会自动清理不再被引用的附件。

## 8. 配置被改坏了

接入时备份为 `*.zw-backup`：

```bash
ls vite.config.*.zw-backup
cp vite.config.ts.zw-backup vite.config.ts
```

安装器在写入前会做 `node --check` 语法校验，校验失败会自动回滚并报错，因此正常情况下不会留下坏配置。
若配置里没有 `plugins` 数组，安装器会拒绝改动并保持原文件不变——此时用 `--framework manual` 走手动接入。

## 9. 改了代码但页面没更新

组件脚本带内容哈希（`?v=<sha1>`），源码变化时 URL 会变，浏览器必然重新拉取。
Vite 插件同时监听文件变化并触发整页刷新。若仍不生效：

- 确认改的是项目内 `.zwa/runtime/client/annotator.mjs`（运行时是副本，改仓库源码不会影响已安装的项目）；
- 重启开发服务器。

**升级运行时的正确方式是重新安装**：

```bash
node "<技能目录>/scripts/cli.mjs" install --root "<项目目录>" --force
```

## 10. 页面有严格 CSP

若页面设置了严格的 `Content-Security-Policy`（不允许内联脚本或非同源脚本），注入可能被浏览器拦截。
这种情况属于失败关闭：如实告知用户被 CSP 阻止，建议在开发环境放宽 CSP，或用 `--framework manual` 自行调整接入方式。

## 11. 想临时关掉标注

两种方式，任选其一，都需要**重启开发服务器**（配置在插件初始化时读取）：

**环境变量**（推荐临时用，不必改仓库里的文件）：

```bash
ZW_ANNOTATIONS=off npm run dev
```

**插件选项**（适合长期关闭某个项目）：

```js
// vite.config.mjs
zwAnnotations({ dir: '.zwa/tasks', enabled: false })
```

关闭是**整条链路一起关**：页面不再注入组件，接口 `/__zw-web-annotations/*` 也返回 404。
不会出现「界面没了但还在往工作区写文件」这种半关状态。

辨认方法：`ZW_ANNOTATIONS` 只有明确写成 `0` / `off` / `false` / `no` / `disable` / `disabled` 才算关闭，
其他值（含空值、`on`、随便一个字符串）都保持开启——避免环境里一个无关变量把功能误关掉。
关闭状态访问接口会得到：

```json
{ "error": "annotations disabled", "hint": "ZW_ANNOTATIONS=off" }
```

**生产构建不受此开关影响**：插件是 `apply: 'serve'`，只在开发模式生效，构建产物里本来就没有标注器（见下条）。

## 12. 生产环境是否有标注器

没有。插件声明了 `apply: 'serve'`，Vite 在 `build` 时不会加载它，因此：

- 构建产物里**不会**有组件脚本，也不会有 `data-zw-annotations` 注入标签；
- 接口只在 dev server 上存在，生产环境没有这个路由。

想自己确认，构建后在产物里搜特征串：

```bash
npm run build
grep -rl "zcode-annotations\|__zw\|mountAnnotator" dist/ || echo "✅ 无残留"
```

有输出才说明出了问题，请带上输出反馈。注意 `--mode production` 之类的参数不影响这个结论，
因为关掉它的不是环境变量而是 `apply: 'serve'`。

## 13. 任务文件在磁盘上、但接口看不到/验收返回 0

症状：`accept-tasks` 返回 `accepted: 0`、`/tasks` 缺组、`activeRound` 被清空、`complete-round` 报 `active round mismatch`。

**先查 diagnostics**——组文件 schema 校验失败会被隔离进 diagnostics 而不是崩溃：

```bash
curl -s http://localhost:<port>/__zw-web-annotations/tasks | python3 -c "import json,sys;print(json.load(sys.stdin).get('diagnostics'))"
# [{"kind":"corrupt-group","file":"...json","message":"invalid task history: task_xxx"}, ...]
```

**典型根因**：绕过 PATCH 接口直接改任务 JSON，且写入的 `history` 条目格式不对。
`validateGroup` 要求每条 history 是 `{at: string, event: string}`（detail 可选）；
写 `{ts, from, to}` 之类的自创格式会让整组被判 corrupt → 服务端完全忽略该组 →
roundSummary 自愈逻辑随后把 `activeRound` 清成 null，队列呈现「卡住不动」。

**修复**：把非法 history 条目改回 `{at, event, detail}` 格式（或删掉），接口立即恢复可见；
之后按 `accept-tasks` → `complete-round` 正常收尾。若自愈已把 `activeRound` 清空，
在 `execution.json` 里把 `activeRound` 写回该轮次号再调 `complete-round`（无对应 API，此属合法 SSOT 修复）。

**预防**：状态回写只走 `PATCH <api-base>/<groupId>/tasks/<taskId>`（服务端串行化写入+schema 校验）；
dev server 掉线时用 `cli.mjs task-patch`（同一把状态机与文件锁），绝不手改任务 JSON。
