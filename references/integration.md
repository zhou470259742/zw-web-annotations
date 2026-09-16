# 各框架接入细节

运行时安装到 `<项目>/.zwa/runtime/` 后，各框架的接入方式如下。
安装器会按检测结果自动处理 Vite；其余情况输出代码片段，需要粘进用户项目。

## 通用原理

接入本质上只需要一件事：**在 dev server 上注册一个中间件**。

这个中间件同时负责两半：

1. **接口**：提供 `/__zw-web-annotations/*`，把任务写进 `.zwa/tasks/`；
2. **UI**：自动把标注脚本注入它下游返回的 HTML。

Vite 插件在内部做的就是这件事，所以 Vite 项目自动接入即可用。其他构建器只需把同一段中间件代码粘到各自的 dev server 配置里，**一处即可**，不需要再单独挂适配器。

## Vite / Nuxt 3（自动）

安装器自动注入：

```js
import { zwAnnotations } from './.zwa/runtime/vite/index.mjs';

export default {
  plugins: [zwAnnotations({ dir: '.zwa/tasks' })],
};
```

`apply: 'serve'` 保证只在开发模式生效，构建产物不含标注器。

## Vue 3 / Vue 2 适配器（可选）

Vite 项目不需要它们——插件已经把 UI 注入了。**非 Vite 项目也优先用中间件**（它会自动注入 UI，一处搞定）。

只有在「不能用中间件注入 HTML」的场景才需要适配器：例如 dev server 把 HTML 生成权交给了别的进程，或者你希望在特定路由/条件下才显示标注条。

Vue 3：

```js
// src/main.js
import { createApp } from 'vue';
import { createAnnotations } from './.zwa/runtime/adapters/vue3.mjs';

const app = createApp(App);
app.use(createAnnotations());
app.mount('#app');
```

Vue 2：

```js
// src/main.js
import Vue from 'vue';
import { createAnnotations } from './.zwa/runtime/adapters/vue2.mjs';

Vue.use(createAnnotations());
new Vue({ render: h => h(App) }).$mount('#app');
```

两版 API 一致：`createAnnotations()` 安装，`useAnnotations()` / `this.$annotations` 取到 controller（`mount` / `unmount` / `start` / `stop` / `count`）。适配器不 `import 'vue'`，由调用方传入构造器，因此不会因版本差异加载失败。

注意：适配器只负责挂 UI，**不提供写盘接口**。用了适配器仍然要配中间件提供 `/__zw-web-annotations/*`。

## Vue CLI

在 `vue.config.js` 注册中间件，一处即可（UI 由中间件自动注入）：

```js
const { createAnnotationsMiddleware } = require('./.zwa/runtime/adapters/http.mjs');

module.exports = {
  devServer: {
    setupMiddlewares(middlewares, devServer) {
      devServer.app.use(createAnnotationsMiddleware({
        workspace: __dirname,
        dir: '.zwa/tasks',
      }));
      return middlewares;
    },
  },
};
```

## webpack-dev-server / React / Svelte / Solid

同样一处即可，中间件会自己注入 UI：

```js
const { createAnnotationsMiddleware } = require('./.zwa/runtime/adapters/http.mjs');

module.exports = {
  devServer: {
    setupMiddlewares(middlewares, devServer) {
      devServer.app.use(createAnnotationsMiddleware({
        workspace: __dirname,
        dir: '.zwa/tasks',
      }));
      return middlewares;
    },
  },
};
```

React / Svelte / Solid 等没有专用适配器，因为它们不需要：标注组件是框架无关的，直接挂到 `document` 即可，而中间件已经做了这件事。

## Express / Connect / Koa / Fastify

任何能挂 connect 风格中间件的服务器都可以：

```js
import { createAnnotationsMiddleware } from './.zwa/runtime/adapters/http.mjs';

app.use(createAnnotationsMiddleware({
  workspace: process.cwd(),
  dir: '.zwa/tasks',
}));
```

## 参数说明

`createAnnotationsMiddleware(options)`：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `route` | `/__zw-web-annotations` | 接口前缀 |
| `clientPath` | `/__zw-web-annotations/client.js` | 组件脚本路径 |
| `workspace` | `process.cwd()` | 工作区根目录，决定任务落盘位置 |
| `dir` | 空（回退到 `.zwa/tasks`） | 任务目录，相对 workspace 解析 |
| `injectHtml` | `true` | 是否自动把脚本注入下游 HTML；设 `false` 则只提供接口 |

**建议始终显式传 `dir`**，与安装器初始化的目录保持一致。

接口一览（Vite 插件同一套，前缀随 `endpoint` 选项）：`GET /tasks`、`GET|POST /execution`、`POST /complete-round`、`POST /accept-tasks`（人工验收 `review→done`：传 `round` 验收本轮全部待验收任务，或传 `ids` 验收指定任务；带 `x-zwa-client: task-agent` 会被拒绝）、`PATCH /<groupId>/tasks/<taskId>`（`blocked→todo` 为人工重新入列转移）、`GET /board`（只读任务看板）、`GET /archive`（归档只读总览，供看板展示历史任务）、`POST /purge-archive`（清理归档：整组/全部，或按 `ids`/`statuses` 任务粒度删除）、`GET|POST /board-prefs`（看板偏好，主题记忆落盘 `.zwa/runtime/board-prefs.json`）、`GET /events`（SSE）、`GET /health`。看板在浏览器打开 `<同源><route>/board` 即可用：整页铺满视口、滚动在各面板内部，右上角切换看板/表格布局与明亮/暗色主题（默认暗色、记忆在项目里），已归档任务并入看板终态列，支持关键词搜索与状态/页面/归档过滤，并经 SSE 实时刷新；看板仅提供三个带二次确认的人工动作：待验收卡的「验收」、已取消卡的归档「删除」、阻塞卡的「重新加入」。

自动注入只作用于 `text/html` 且**未被压缩**的响应；遇到 gzip/brotli 正文会原样放行，不会写坏内容。若你的 dev server 在中间件之前就把 HTML 发走了，改用 `injectAnnotatorScript()` 手动注入：

```js
import { injectAnnotatorScript } from './.zwa/runtime/adapters/http.mjs';

html = injectAnnotatorScript(html);
```

## 回滚

接入构建配置时若有备份（`*.zw-backup`），复制回原名即可：

```bash
cp vite.config.ts.zw-backup vite.config.ts
```

完全移除：删除 `.zwa/` 目录，并撤销对构建配置的改动。
