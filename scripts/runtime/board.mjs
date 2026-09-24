/**
 * 标注任务看板页（只读）。
 *
 * 一个自包含的 HTML 页面：展示项目里所有页面的标注任务，供用户在浏览器里
 * 总览全局进度。活动任务经同源 /tasks 获取，历史归档经 /archive 获取，SSE
 * 实时刷新 + 轮询兜底。看板对处理流程保持只读（状态机与角色规则的绕行
 * 通道仍是面板/接口），仅提供两个带二次确认的人工清理动作：删除归档任务
 * （/purge-archive 任务粒度）与把阻塞任务重新入列（blocked→todo）。
 *
 * 布局两种（右上角切换，localStorage 记忆）：看板（按状态从左往右等高分栏，
 * 已归档任务纳入终态列并带「归档」徽标）、表格（不分组的一行一行平铺，
 * 页面信息在「页面」列）。整页铺满视口不滚动，滚动发生在各列卡片区 /
 * 表格滚动区内。工具栏提供常用过滤：关键词搜索、按页面、归档显示开关、
 * 状态 chips。主题两套（暗色默认/明亮），右上角切换，偏好保存在项目
 * .zwa/runtime/board-prefs.json（localStorage 兜底）。
 *
 * 任务文本来自不可信页面：渲染一律经 esc()（textContent 语义）转义，
 * 禁止把任务数据直接拼进 innerHTML。
 */

/** 服务端侧的最小转义（仅用于注入受信任的运行时版本号等常量）。 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_ORDER = [
  ['todo', '待处理'],
  ['doing', '进行中'],
  ['review', '待验收'],
  ['done', '已完成'],
  ['archived', '已归档'],
  ['blocked', '已阻塞'],
  ['cancelled', '已取消'],
];

/** 看板列布局：单状态一列；多状态同列纵向分段（各段独立计数与滚动）。
 *  进行中/待验收/已阻塞/已取消合一列，已完成/已归档放最后两列。 */
const BOARD_COLUMNS = [
  ['todo'],
  ['doing', 'review', 'blocked', 'cancelled'],
  ['done'],
  ['archived'],
];

const VIEW_ORDER = [  ['board', '看板', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>'],
  ['table', '表格', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="10" x2="12" y2="20"/></svg>'],
];

const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.3" y1="5.3" x2="7" y2="7"/><line x1="17" y1="17" x2="18.7" y2="18.7"/><line x1="5.3" y1="18.7" x2="7" y2="17"/><line x1="17" y1="7" x2="18.7" y2="5.3"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/></svg>';
const LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><line x1="9.2" y1="3.5" x2="9.2" y2="20.5"/><line x1="14.8" y1="3.5" x2="14.8" y2="20.5"/></svg>';

export function renderBoardHtml({ version = '' } = {}) {
  const versionBadge = version
    ? '<span class="ver" title="标注运行时版本">v' + escapeHtml(version) + '</span>'
    : '';
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>标注任务看板</title>
<style>
  /* 双主题：暗色为默认。状态色以 --st-* 变量按主题取值，内联样式引用同名变量 */
  :root, [data-theme="dark"] {
    color-scheme: dark;
    --bg: #141419;
    --bg-glow: radial-gradient(1100px 700px at 85% -12%, rgba(122, 102, 232, .10), transparent 60%),
               radial-gradient(900px 600px at -10% 110%, rgba(94, 140, 246, .07), transparent 55%);
    --panel: #1b1b21;
    --panel-2: #222229;
    --panel-3: #1a1a20;
    --border: #2a2a33;
    --border-2: #32323c;
    --border-3: #3a3a46;
    --text: #d8d8e2;
    --text-strong: #eceafd;
    --text-dim: #9c9caa;
    --text-faint: #7b7b89;
    --text-empty: #5f5f6d;
    --chip-bg: #26262f;
    --chip-active-bg: #312d4a;
    --chip-active-border: #57517e;
    --hover: #2d2d38;
    --seq-text: #ffffff;
    --arch-opacity: .62;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, .25);
    --shadow-md: 0 2px 6px rgba(0, 0, 0, .22), 0 12px 32px rgba(0, 0, 0, .16);
    --shadow-pop: 0 10px 28px rgba(0, 0, 0, .5);
    --accent: #8b7cf6;
    --accent-2: #5e8cf6;
    --st-todo: #7fa7e8;
    --st-doing: #e8935a;
    --st-review: #e0b464;
    --st-done: #7fce8f;
    --st-archived: #9a8fd0;
    --st-blocked: #e07a7a;
    --st-cancelled: #85858f;
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg: #eef0f6;
    --bg-glow: radial-gradient(1100px 700px at 85% -12%, rgba(122, 102, 232, .09), transparent 60%),
               radial-gradient(900px 600px at -10% 110%, rgba(94, 140, 246, .08), transparent 55%);
    --panel: #ffffff;
    --panel-2: #f6f7fb;
    --panel-3: #f1f2f8;
    --border: #e3e5ee;
    --border-2: #d9dce7;
    --border-3: #cdd1df;
    --text: #383e52;
    --text-strong: #1e2338;
    --text-dim: #5f6579;
    --text-faint: #8b90a3;
    --text-empty: #a6abbc;
    --chip-bg: #eef0f6;
    --chip-active-bg: #e7e4fa;
    --chip-active-border: #b9b0ea;
    --hover: #e9ebf4;
    --seq-text: #ffffff;
    --arch-opacity: .72;
    --shadow-sm: 0 1px 2px rgba(30, 35, 56, .06);
    --shadow-md: 0 2px 6px rgba(30, 35, 56, .05), 0 12px 32px rgba(30, 35, 56, .08);
    --shadow-pop: 0 10px 28px rgba(30, 35, 56, .16);
    --accent: #6a5ae0;
    --accent-2: #3f7be8;
    --st-todo: #4a7fd6;
    --st-doing: #d97a3d;
    --st-review: #b08a35;
    --st-done: #3f9e54;
    --st-archived: #7a63c9;
    --st-blocked: #cc5252;
    --st-cancelled: #6f7078;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background-color: var(--bg);
    background-image: var(--bg-glow);
    background-attachment: fixed;
    color: var(--text); overflow: hidden;
    display: flex; flex-direction: column;
    font: 13px/1.55 "Microsoft YaHei", "微软雅黑", "PingFang SC", -apple-system, sans-serif;
    transition: background-color .25s ease, color .25s ease;
  }
  /* 顶栏 = 标题行 + 过滤工具行（整页铺满，顶栏不滚动） */
  .topbar { flex: none; background: var(--panel); border-bottom: 1px solid var(--border); box-shadow: var(--shadow-sm); z-index: 2; }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 18px;
  }
  .logo { flex: none; width: 26px; height: 26px; border-radius: 8px; color: #fff;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          display: inline-flex; align-items: center; justify-content: center;
          box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent); }
  .logo svg { width: 15px; height: 15px; display: block; }
  header h1 { font-size: 15px; font-weight: 700; letter-spacing: .02em;
              background: linear-gradient(90deg, var(--text-strong), color-mix(in srgb, var(--accent) 72%, var(--text-strong)));
              -webkit-background-clip: text; background-clip: text; color: transparent; }
  .ver { font-size: 11px; color: var(--text-dim); border: 1px solid var(--border-3); border-radius: 5px; padding: 1px 6px; background: var(--panel-2); }
  .summary { display: flex; gap: 7px; flex-wrap: wrap; margin-left: 4px; }
  .chip { font-size: 11px; color: var(--text); background: var(--chip-bg); border: 1px solid var(--border);
          border-radius: 999px; padding: 1px 9px; }
  .chip b { color: var(--text-strong); font-weight: 700; }
  .chip.mode-round b { color: var(--st-todo); }
  .chip.mode-queue b { color: var(--st-review); }
  .updated { margin-left: auto; font-size: 11px; color: var(--text-faint); white-space: nowrap; }
  /* 主题切换 + 视图切换：右上角；图标与文字垂直居中对齐 */
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; line-height: 1;
              background: var(--chip-bg); border: 1px solid var(--border-2); color: var(--text);
              border-radius: 8px; padding: 6px 7px; cursor: pointer; font-family: inherit;
              transition: background .15s, border-color .15s, transform .15s; }
  .icon-btn:hover { background: var(--hover); border-color: var(--border-3); transform: translateY(-1px); }
  .icon-btn:active { transform: translateY(0); }
  .icon-btn svg { width: 14px; height: 14px; display: block; }
  .view-switch { position: relative; flex: none; }
  .view-btn { display: inline-flex; align-items: center; gap: 6px; line-height: 1;
              background: var(--chip-bg); border: 1px solid var(--border-2); color: var(--text); font-size: 12px;
              border-radius: 8px; padding: 6px 10px; cursor: pointer; font-family: inherit;
              transition: background .15s, border-color .15s, transform .15s; }
  .view-btn:hover { background: var(--hover); border-color: var(--border-3); transform: translateY(-1px); }
  .view-btn:active { transform: translateY(0); }
  #view-icon { display: inline-flex; align-items: center; }
  #view-label { display: inline-flex; align-items: center; }
  .view-btn svg { width: 14px; height: 14px; display: block; }
  .view-btn .chev { width: 12px; height: 12px; color: var(--text-faint); }
  .view-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 6; background: var(--panel-2);
               border: 1px solid var(--border-3); border-radius: 10px; padding: 5px; min-width: 128px;
               box-shadow: var(--shadow-pop); }
  .view-menu.hidden { display: none; }
  .view-menu-title { font-size: 10px; color: var(--text-faint); padding: 4px 10px 3px; letter-spacing: .06em; }
  .view-menu button { display: flex; width: 100%; align-items: center; gap: 8px; background: none; border: 0;
                      color: var(--text); font-size: 12px; padding: 7px 10px; border-radius: 7px; cursor: pointer;
                      text-align: left; font-family: inherit; transition: background .12s; }
  .view-menu button:hover { background: var(--hover); }
  .view-menu button svg { width: 14px; height: 14px; flex: none; display: block; }
  .view-menu button .check { margin-left: auto; color: var(--accent); visibility: hidden; font-weight: 700; }
  .view-menu button.active .check { visibility: visible; }
  /* 过滤工具行：搜索 / 页面 / 归档开关 / 状态 chips */
  .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 18px 10px; }
  .search-box { display: flex; align-items: center; gap: 6px; background: var(--panel-2); border: 1px solid var(--border-2);
                border-radius: 8px; padding: 4px 9px; transition: border-color .15s, box-shadow .15s; }
  .search-box:focus-within { border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  .search-box svg { width: 13px; height: 13px; color: var(--text-faint); flex: none; }
  .search-box input { background: none; border: 0; outline: none; color: var(--text); font-size: 12px;
                      width: 190px; font-family: inherit; }
  .search-box input::placeholder { color: var(--text-empty); }
  .toolbar select { background: var(--panel-2); border: 1px solid var(--border-2); color: var(--text); font-size: 12px;
                    border-radius: 8px; padding: 5px 8px; max-width: 220px; font-family: inherit;
                    transition: border-color .15s; }
  .toolbar select:hover { border-color: var(--border-3); }
  .ftoggle { font-size: 11px; border-radius: 999px; padding: 4px 11px; cursor: pointer; font-family: inherit; line-height: 1.4;
             background: var(--chip-bg); border: 1px solid var(--border-2); color: var(--text-faint);
             transition: all .15s; }
  .ftoggle:hover { background: var(--hover); }
  .ftoggle.active { color: var(--text-strong); border-color: #6f5aa8; background: color-mix(in srgb, #6f5aa8 14%, transparent); }
  .status-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .schip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; border-radius: 999px;
           padding: 4px 11px; background: var(--chip-bg); color: var(--text); border: 1px solid var(--border);
           cursor: pointer; font-family: inherit; line-height: 1.4; transition: all .15s; }
  .schip:hover { background: var(--hover); border-color: var(--border-2); }
  .schip .dot { width: 7px; height: 7px; border-radius: 50%; flex: none;
                box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--c) 22%, transparent); }
  .schip.active { color: var(--text-strong); border-color: color-mix(in srgb, var(--c, var(--accent)) 45%, transparent);
                  background: color-mix(in srgb, var(--c, var(--accent)) 12%, transparent); }
  /* 主体：整页铺满，滚动发生在各面板内部 */
  .board { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 18px 16px; overflow: hidden; }
  .board > .empty, .board > .error { margin: auto; }
  .board > .empty { font-size: 13px; text-align: center; }
  .cols { flex: 1; min-height: 0; display: flex; gap: 12px; overflow-x: auto; align-items: stretch; padding-bottom: 2px; }
  .col { flex: 1 1 0; min-width: 220px; display: flex; flex-direction: column; min-height: 0;
         background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 11px;
         box-shadow: var(--shadow-sm); transition: border-color .2s, box-shadow .2s, background-color .25s; }
  .col:hover { border-color: var(--border-2); box-shadow: var(--shadow-md); }
  /* 同列多状态：上下各占一半高度，分隔线区隔，各半独立滚动 */
  .col-half { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
  .col-half + .col-half { border-top: 1px dashed var(--border-2); margin-top: 6px; padding-top: 9px; }
  .col-half .cards { min-height: 56px; }
  /* 三段以上的合并列：各段按内容自然高度（封顶 260px 内滚），整列外层滚动，
     空段只占标题一行不再均分四分之一高度。 */
  .col.col-multi { overflow-y: auto; }
  .col.col-multi .col-half { flex: none; }
  .col.col-multi .col-half .cards { flex: none; max-height: 260px; }
  .col-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 2px 4px 11px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--c);
         box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 20%, transparent); }
  .col-head h2 { font-size: 12px; font-weight: 700; color: var(--text-strong); letter-spacing: .01em; }
  .col-head .count { margin-left: auto; font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums;
                     background: var(--chip-bg); border-radius: 999px; padding: 0 8px; line-height: 18px; }
  .cards { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
           padding: 2px 3px 6px 2px; }
  .card { flex: none; position: relative; background: var(--panel-2); border: 1px solid var(--border-2);
          border-left-width: 3px; border-radius: 10px; padding: 8px 10px 8px 12px;
          transition: border-color .15s, box-shadow .15s, transform .15s, background-color .25s; }
  .card:hover { border-color: var(--text-faint); box-shadow: var(--shadow-md); transform: translateY(-1px); }
  .card.archived { opacity: var(--arch-opacity); }
  .card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .seq { flex: none; min-width: 18px; height: 18px; border-radius: 6px; padding: 0 4px;
         background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: var(--seq-text);
         font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
  .card-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; color: var(--text-strong);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .page-badge { flex: none; font-size: 10px; color: var(--text-dim); background: var(--chip-bg); border-radius: 5px; padding: 1px 6px;
                max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .instruction { font-size: 12px; color: var(--text); white-space: pre-wrap; word-break: break-word;
                 display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card-thumbs { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
  .card-thumb { display: block; position: relative; width: 64px; height: 44px; border-radius: 6px;
                overflow: hidden; cursor: zoom-in; border: 1px solid var(--border-2); flex: none; }
  .card-thumb .thumb-n {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-style: normal; font-size: 11px; font-weight: 700; color: #fff;
    background: rgba(10, 12, 20, .5); pointer-events: none;
  }
  .card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .15s; }
  .card-thumb:hover img { transform: scale(1.06); }
  /* 灯箱：复用检验归档抽屉的交互（左右切/序号/文案/滚轮缩放） */
  .viewer { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
            background: rgba(10, 12, 20, .82); cursor: zoom-out; overflow: hidden; }
  .viewer.hidden { display: none; }
  .viewer img { max-width: 82vw; max-height: 92vh; border-radius: 8px; box-shadow: 0 12px 48px rgba(0,0,0,.5);
                background: #fff; transition: transform .12s ease-out; cursor: default; }
  .viewer-nav { position: fixed; top: 50%; transform: translateY(-50%); width: 40px; height: 56px;
                border: 0; border-radius: 10px; background: rgba(255,255,255,.12); color: #fff;
                display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .viewer-nav:hover { background: rgba(255,255,255,.22); }
  .viewer-nav.prev { left: 14px; } .viewer-nav.next { right: 14px; }
  .viewer-nav svg { width: 20px; height: 20px; }
  .viewer-nav.hidden { display: none; }
  .viewer-count { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
                  padding: 3px 12px; border-radius: 12px; background: rgba(30,30,40,.8);
                  color: #e8e8ee; font-size: 12px; font-variant-numeric: tabular-nums; }
  .viewer-count:empty { display: none; }
  .viewer-caption { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%);
                    max-width: 76vw; padding: 9px 20px; border-radius: 10px;
                    background: rgba(20,20,28,.88); color: #f2f2f8; font-size: 17px; line-height: 1.6;
                    white-space: pre-wrap; word-break: break-word; box-shadow: 0 4px 20px rgba(0,0,0,.4); }
  .viewer-caption:empty { display: none; }
  .card-foot { display: flex; align-items: center; gap: 5px; margin-top: 7px; flex-wrap: wrap; }
  .sel { font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tag { flex: none; font-size: 10px; border-radius: 5px; padding: 1px 6px; font-weight: 500; }
  .tag.round { color: var(--text-dim); border: 1px solid var(--border-2); background: var(--panel-3); }
  .tag.queued { color: #c9a35a; border: 1px dashed #8a6d35; background: color-mix(in srgb, #c9a35a 10%, transparent); }
  .tag.pending { color: #b48ce8; border: 1px solid #6f5aa8; cursor: help; background: color-mix(in srgb, #b48ce8 10%, transparent); }
  .tag.status { border: 1px solid; font-weight: 600; }
  .tag.archived { color: #b0a3d6; border: 1px solid #6f5aa8; background: color-mix(in srgb, #6f5aa8 12%, transparent); }
  /* 卡片上的显式清理动作（归档删除 / 阻塞重新入列）：平时半透明，悬停浮出 */
  .card-act { flex: none; font-size: 10px; border-radius: 5px; padding: 1px 7px; cursor: pointer; font-family: inherit;
              background: none; border: 1px solid var(--border-2); color: var(--text-faint); opacity: .55;
              transition: all .15s; }
  .card:hover .card-act { opacity: 1; }
  .card-act:hover { color: var(--text); border-color: var(--text-faint); background: var(--hover); }
  .card-act.del:hover { color: var(--st-blocked); border-color: var(--st-blocked); }
  .card-act.reopen:hover { color: var(--st-todo); border-color: var(--st-todo); }
  .card-act.accept:hover { color: var(--st-review); border-color: var(--st-review); }
  .card-act.armed { opacity: 1; color: #fff; font-weight: 600; background: var(--st-blocked); border-color: var(--st-blocked); }
  .card-act.reopen.armed { background: var(--st-todo); border-color: var(--st-todo); }
  .card-act.accept.armed { background: var(--st-review); border-color: var(--st-review); }
  .card-act.arch:hover { color: var(--st-archived); border-color: var(--st-archived); }
  .card-act.arch.armed { background: var(--st-archived); border-color: var(--st-archived); }
  /* armed 确认态悬停保持白字：.card-act.arch:hover 同优先级会把文字
     染成主题紫，叠在紫色 armed 底上等于隐形——这里强制盖回去 */
  .card-act.armed:hover { color: #fff; }
  /* 列内按页面分组：组头常驻（不随卡片悬停），页面级归档按钮在组头右侧 */
  .pg-group { margin-bottom: 4px; }
  .pg-head { display: flex; align-items: center; gap: 6px; padding: 4px 2px 3px;
             position: sticky; top: 0; z-index: 1; background: var(--panel);
             border-bottom: 1px solid var(--border); }
  .pg-name { flex: 1; min-width: 0; font-size: 10px; font-weight: 600; color: var(--text-dim);
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: .03em; }
  .pg-count { flex: none; font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .pg-arch, .col-arch { opacity: .75; }
  .pg-head:hover .pg-arch { opacity: 1; }
  .col-arch { margin-left: auto; }
  /* 已归档列页面组折叠：箭头指示 + 整头可点；折叠时卡片区整体隐藏 */
  .pg-collapsible .pg-head { cursor: pointer; user-select: none; }
  .pg-collapsible .pg-head:hover .pg-name { color: var(--text); }
  .pg-chev { flex: none; width: 10px; height: 10px; color: var(--text-faint);
             transform: rotate(90deg); transition: transform .15s; }
  .pg-group.collapsed .pg-chev { transform: rotate(0deg); }
  .pg-group.collapsed .pg-items { display: none; }
  /* 折叠组内缩略图不渲 img，留个占位底框（角标还在） */
  .card-thumb { background: var(--panel-2); }
  /* 已归档整列折叠：列收成只剩列头的窄条，卡片区整体隐藏 */
  .col-archived .col-head { cursor: pointer; user-select: none; }
  .col-archived .col-head:hover h2 { color: var(--text); }
  .col-archived.collapsed { flex: none; min-width: 0; }
  .col-archived.collapsed .cards { display: none; }
  .col-archived.collapsed .col-chev { transform: rotate(0deg); }
  .empty { font-size: 11px; color: var(--text-empty); padding: 8px 4px; text-align: center; }
  .empty-note { flex: none; font-size: 12px; color: var(--text-dim); padding: 0 2px 10px; }
  .error { max-width: 420px; text-align: center; color: var(--st-blocked); }
  /* 表格视图：不分组的一行一行，滚动区在表格容器内部，表头吸顶 */
  .table-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 12px;
                background: var(--panel); box-shadow: var(--shadow-sm); }
  table { width: 100%; border-collapse: separate; border-spacing: 0; }
  th, td { text-align: left; font-size: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--text-dim); font-weight: 600; background: var(--panel-2); font-size: 11px; white-space: nowrap;
       letter-spacing: .05em; position: sticky; top: 0; z-index: 1; }
  tr:last-child td { border-bottom: 0; }
  tbody tr:nth-child(even) td { background: var(--panel-3); }
  tbody tr { transition: background-color .12s; }
  tbody tr:hover td { background: var(--hover); }
  td.num { color: var(--text-dim); font-variant-numeric: tabular-nums; }
  td.t-page { color: var(--text-dim); font-size: 11px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.t-title { color: var(--text-strong); font-weight: 600; max-width: 220px; }
  td.t-instr { color: var(--text); max-width: 460px; word-break: break-word; }
  td.t-time { color: var(--text-faint); font-size: 11px; white-space: nowrap; }
  tr.arch-row td { opacity: var(--arch-opacity); }
  /* 面板内滚动的细滚动条 */
  .cards::-webkit-scrollbar, .table-wrap::-webkit-scrollbar, .cols::-webkit-scrollbar { width: 8px; height: 8px; }
  .cards::-webkit-scrollbar-track, .table-wrap::-webkit-scrollbar-track, .cols::-webkit-scrollbar-track { background: transparent; }
  .cards::-webkit-scrollbar-thumb, .table-wrap::-webkit-scrollbar-thumb, .cols::-webkit-scrollbar-thumb {
    background: var(--border-3); border-radius: 8px; }
  .cards::-webkit-scrollbar-thumb:hover, .table-wrap::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }
</style>
</head>
<body>
<div class="topbar">
  <header>
    <span class="logo" aria-hidden="true">${LOGO_SVG}</span>
    <h1>标注任务看板</h1>
    ${versionBadge}
    <div class="summary" id="summary"></div>
    <span class="updated" id="updated"></span>
    <button type="button" class="icon-btn" id="theme-btn" title="切换明亮/暗色主题"><span id="theme-icon"></span></button>
    <div class="view-switch" id="view-switch">
      <button type="button" class="view-btn" id="view-btn" aria-haspopup="menu" aria-expanded="false" title="切换布局">
        <span id="view-icon"></span><span id="view-label"></span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div class="view-menu hidden" id="view-menu" role="menu">
        <div class="view-menu-title">视图</div>
      </div>
    </div>
  </header>
  <div class="toolbar">
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>
      <input type="search" id="filter-q" placeholder="搜索标题、指令或编号…" autocomplete="off">
    </div>
    <select id="filter-page" title="按页面过滤"><option value="all">全部页面</option></select>
    <button type="button" class="ftoggle active" id="filter-arch" title="显示/隐藏已归档任务">归档</button>
    <div class="status-chips" id="status-chips"></div>
  </div>
</div>
<div class="board" id="board"><p class="empty">加载中…</p></div>
<div class="viewer hidden" id="viewer">
  <img alt="">
  <button type="button" class="viewer-nav prev hidden" aria-label="上一张"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg></button>
  <button type="button" class="viewer-nav next hidden" aria-label="下一张"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></button>
  <div class="viewer-caption"></div>
  <span class="viewer-count"></span>
</div>
<script>
(function () {
  'use strict';
  var STATUS_ORDER = ${JSON.stringify(STATUS_ORDER)};
  var BOARD_COLUMNS = ${JSON.stringify(BOARD_COLUMNS)};
  var STATUS_LABELS = {};
  STATUS_ORDER.forEach(function (s) { STATUS_LABELS[s[0]] = s[1]; });
  var VIEWS = ${JSON.stringify(VIEW_ORDER)};
  // 布局记忆：上次选中的视图，跨刷新保持（旧版本的列表/泳道值自动回落看板）
  var view = 'board';
  try {
    var saved = localStorage.getItem('zwa-board-view');
    if (saved && VIEWS.some(function (v) { return v[0] === saved; })) view = saved;
  } catch (e) { /* localStorage 不可用时保持默认 */ }
  var latest = null;
  /** 最近一次渲染的任务记录（批量归档按页面/全量取目标用） */
  var lastRecords = [];
  // 常用过滤条件：关键词 / 页面 / 归档开关 / 状态（不持久化，进页面即重置）
  var filters = { q: '', page: 'all', archived: true, status: 'all' };
  // 已归档列的页面组展开态：默认全折叠，点开一组记一组；
  // 内存级即可——SSE/定时重渲染不丢，页面刷新回到默认折叠。
  var archPgOpen = {};
  // 已归档整列折叠态：默认展开（组内默认折叠），点列头整列收成窄条。
  var archColCollapsed = false;

  // 任务文本来自不可信页面：一律经 textContent 语义转义后再进 innerHTML。
  function esc(value) {
    var d = document.createElement('div');
    d.textContent = value == null ? '' : String(value);
    return d.innerHTML;
  }

  function shortPage(url, title) {
    var name = '';
    try { name = new URL(url).pathname.replace(/^\\//, '') || '/'; } catch (e) { name = url || ''; }
    return title || name;
  }

  function chip(label, value, cls) {
    return '<span class="chip' + (cls ? ' ' + cls : '') + '">' + esc(label) + ' <b>' + esc(value) + '</b></span>';
  }

  /** 时间统一显示为本地时区的 YYYY-MM-DD HH:mm:ss（24 小时制），不跟随浏览器语言格式。 */
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function statusRank(status) {
    for (var i = 0; i < STATUS_ORDER.length; i++) { if (STATUS_ORDER[i][0] === status) return i; }
    return STATUS_ORDER.length;
  }

  /** 状态色取主题变量：未知状态回落到已取消的灰。 */
  function stVar(status) {
    return STATUS_LABELS[status] ? 'var(--st-' + status + ')' : 'var(--st-cancelled)';
  }

  function statusTag(status) {
    var v = stVar(status);
    return '<span class="tag status" style="color:' + v
      + ';border-color:color-mix(in srgb, ' + v + ' 35%, transparent)'
      + ';background:color-mix(in srgb, ' + v + ' 10%, transparent)">'
      + esc(STATUS_LABELS[status] || status || '?') + '</span>';
  }

  function taskTitle(t) {
    var el = t.element || {};
    return el.accessibleName || el.text || el.tagName || '手动任务';
  }

  /** 统一任务记录：活动数据来自 /tasks，归档数据来自 /archive。 */
  function collectRecords(data, archived) {
    var recs = [];
    var source = archived
      ? (lastArchiveDataOf(data).archives || [])
      : (Array.isArray(data.groups) ? data.groups : []);
    source.forEach(function (g) {
      var pageName = shortPage(g.page && g.page.url, g.page && g.page.title);
      (g.tasks || []).forEach(function (t) {
        recs.push({ t: t, page: pageName, url: (g.page && g.page.url) || '', group: g.id, archived: !!archived });
      });
    });
    return recs;
  }

  function lastArchiveDataOf(data) {
    return data.__archive || { archives: [], diagnostics: [] };
  }

  function applyFilters(records) {
    var q = filters.q.trim().toLowerCase();
    return records.filter(function (r) {
      if (!filters.archived && r.archived) return false;
      if (filters.status !== 'all' && (r.archived ? 'archived' : r.t.status) !== filters.status) return false;
      if (filters.page !== 'all' && r.url !== filters.page) return false;
      if (q) {
        var el = r.t.element || {};
        var hay = (taskTitle(r.t) + ' ' + (r.t.instruction || '') + ' ' + (el.selector || '') + ' '
          + r.page + ' ' + (r.t.seq == null ? '' : r.t.seq) + ' ' + (STATUS_LABELS[r.t.status] || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /**
   * 任务卡片：左缘状态条纹 + 悬停浮起。看板列/半区已经说明了状态，
   * 卡片上不再重复「归档」与状态标签（表格视图才有状态列）。
   */
  function cardHtml(r, noImg) {
    var t = r.t, el = t.element || {};
    var title = taskTitle(t);
    var instruction = t.instruction || '（未填写）';
    var html = '<div class="card' + (r.archived ? ' archived' : '') + '" style="border-left-color:' + stVar(t.status) + '">'
      + '<div class="card-head">'
      + '<span class="seq">' + esc(t.seq) + '</span>'
      + '<span class="card-title">' + esc(title) + '</span>'
      + '<span class="page-badge" title="' + esc(r.page) + '">' + esc(r.page) + '</span>'
      + '</div>'
      + '<div class="instruction" title="' + esc(instruction) + '">' + esc(instruction) + '</div>'
      + (function () {
        if (!Array.isArray(t.images) || !t.images.length) return '';
        var srcs = t.images.map(function (img) {
          var f = img && img.file ? String(img.file).split(/[\\/]/).pop() : '';
          return f ? './files/' + encodeURIComponent(f) : '';
        }).filter(Boolean);
        if (!srcs.length) return '';
        // 单图 + 张数角标，点击进灯箱左右切换（与检验归档抽屉同款交互）；
        // 全量清单挂 data-srcs，不渲隐藏 img——折叠卡片不发无谓请求。
        // data 属性内不能放裸双引号（esc 不转义引号会截断属性值），改用 URI 编码
        return '<div class="card-thumbs"><span class="card-thumb" data-srcs="'
          + encodeURIComponent(JSON.stringify(srcs)) + '" data-cap="' + encodeURIComponent(instruction) + '">'
          + (noImg ? '' : '<img src="' + srcs[0] + '" loading="lazy" alt="" onerror="var p=this.parentNode,l=[];try{l=JSON.parse(decodeURIComponent(p.dataset.srcs||\\\'[]\\\'))}catch(x){}var i=l.indexOf(this.getAttribute(\\\'src\\\'));if(i>-1&&i+1<l.length){this.src=l[i+1]}else{p.style.display=\\\'none\\\'}">')
          + (srcs.length > 1 ? '<i class="thumb-n">' + srcs.length + '</i>' : '')
          + '</span></div>';
      })()
      + '<div class="card-foot">'
      + (el.selector ? '<span class="sel" title="' + esc(el.selector) + '">' + esc(el.selector) + '</span>' : '<span class="sel">手动任务</span>')
      + (r.archived
        ? ((t.round != null ? '<span class="tag round">第 ' + esc(t.round) + ' 轮</span>' : '')
          + (t.completedAt ? '<span class="tag round" title="完成时间">' + esc(fmtTime(t.completedAt)) + '</span>' : '')
          + (t.status === 'cancelled' ? '<button type="button" class="card-act del" data-action="purge-archived" data-group="' + esc(r.group) + '" data-task="' + esc(t.id) + '" title="从归档中永久删除这条任务">删除</button>' : ''))
        : ((t.pendingInstruction ? '<span class="tag pending" title="已提交新要求（交付后另建一条任务进入下一轮）：' + esc(t.pendingInstruction) + '">新要求</span>' : '')
          + (t.round != null ? '<span class="tag round">第 ' + esc(t.round) + ' 轮</span>' : '<span class="tag queued" title="处理开始后新增，自动排队下一轮">下一轮</span>')
          // 待验收卡的正式人工出口：done 只能由主线程验收后回写，
          // 看板上给不出这个按钮，用户就只能被指去点一个不存在的东西。
          + (t.status === 'review' ? '<button type="button" class="card-act accept" data-action="accept" data-group="' + esc(r.group) + '" data-task="' + esc(t.id) + '" title="验收通过：确认这处改动符合要求，标记为已完成">验收</button>' : '')
          // 已完成卡的人工归档出口：归档后进入「已归档」列（任务级，非文件级）。
          + (t.status === 'done' ? '<button type="button" class="card-act arch" data-action="archive" data-group="' + esc(r.group) + '" data-task="' + esc(t.id) + '" title="归档此任务：移入「已归档」列">归档</button>' : '')
          + (t.status === 'blocked' ? '<button type="button" class="card-act reopen" data-action="reopen" data-group="' + esc(r.group) + '" data-task="' + esc(t.id) + '" title="重新入列：回到待处理，等下一轮处理">重新加入</button>' : '')))
      + '</div>'
      + '</div>';
    return html;
  }

  /** 任务时间字段：已完成/已归档按完成/归档时刻排序，其余按创建时刻。 */
  function recTime(r) {
    var t = r.t;
    return t.archivedAt || t.completedAt || t.reviewAt || t.startedAt || t.createdAt || '';
  }

  /** 看板视图：按 BOARD_COLUMNS 分栏，多状态列上下各半；列内按页面分组，
   * 已完成/已归档按任务时间倒序，其余状态升序；列内卡片区独立滚动。 */
  function renderBoardColumns(records, hasData) {
    if (!hasData) {
      return '<p class="empty">还没有标注任务。在页面右下角打开标注面板即可开始。</p>';
    }
    var note = records.length ? '' : '<p class="empty-note">没有匹配的任务，试试调整搜索或过滤条件。</p>';
    /** 有效状态：文件级归档记录一律按「已归档」归列（归档文件里的 done 不再是未归档）。 */
    function effStatus(r) {
      return r.archived ? 'archived' : r.t.status;
    }
    function countOf(key) {
      return records.filter(function (x) { return effStatus(x) === key; }).length;
    }
    function headHtml(key) {
      var batchBtn = key === 'done' && countOf(key)
        ? '<button type="button" class="card-act arch col-arch" data-action="archive-all-done" title="把已完成列全部任务移入「已归档」">全部归档</button>'
        : '';
      var colChev = key === 'archived'
        ? '<svg class="pg-chev col-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>'
        : '';
      return '<div class="col-head"' + (key === 'archived' ? ' data-arch-col title="点击折叠/展开已归档列"' : '') + '>'
        + colChev + '<span class="dot" style="--c:' + stVar(key) + '"></span>'
        + '<h2>' + esc(STATUS_LABELS[key]) + '</h2><span class="count">' + countOf(key) + '</span>' + batchBtn + '</div>';
    }
    /** 列内按页面分组：组内已完成/已归档时间倒序，其余序号升序。 */
    function cardsHtml(key) {
      var list = records.filter(function (x) { return effStatus(x) === key; });
      if (!list.length) return '<div class="cards"><p class="empty">—</p></div>';
      var desc = key === 'done' || key === 'archived';
      // 按 URL 分组：同标题页面（reports/driving?rpt=xxx 系列）必须独立成组；
      // 显示名 = 标题，有 query 时追加区分符（rpt=401/402… 全靠它分辨）。
      var pages = {};
      var order = [];
      list.forEach(function (r) {
        var k = r.url || r.page || '未命名页面';
        if (!pages[k]) { pages[k] = []; order.push(k); }
        pages[k].push(r);
      });
      order.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
      var html = order.map(function (k) {
        var recs = pages[k];
        var name = recs[0].page || k;
        var qi = k.indexOf('?');
        if (qi > 0) name += ' ' + k.slice(qi);
        // 已归档列：页面组默认折叠、点头展开；折叠组连缩略 img 都不渲，
        // 136+ 条归档卡片一次性铺开既卡又长，图片请求也全部省掉。
        var collapsible = key === 'archived';
        var open = !collapsible || !!archPgOpen[k];
        var items = recs.slice().sort(function (x, y) {
          if (desc) {
            var a = recTime(x), b = recTime(y);
            if (a !== b) return a > b ? -1 : 1;
            return (y.t.seq || 0) - (x.t.seq || 0);
          }
          return (x.t.seq || 0) - (y.t.seq || 0);
        }).map(function (x) { return cardHtml(x, collapsible && !open); }).join('');
        var pbtn = key === 'done'
          ? '<button type="button" class="card-act arch pg-arch" data-action="archive-page" data-page="' + esc(k) + '" title="归档此页面的全部已完成任务">归档本页</button>'
          : '';
        var chev = collapsible
          ? '<svg class="pg-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>'
          : '';
        return '<div class="pg-group' + (collapsible ? ' pg-collapsible' : '') + (open ? '' : ' collapsed') + '">'
          + '<div class="pg-head"' + (collapsible ? ' data-pg="' + esc(k) + '" title="点击展开/折叠此页面的归档任务"' : '') + '>'
          + chev + '<span class="pg-name" title="' + esc(k) + '">' + esc(name) + '</span>'
          + '<span class="pg-count">' + recs.length + '</span>' + pbtn + '</div>'
          + '<div class="pg-items">' + items + '</div></div>';
      }).join('');
      return '<div class="cards">' + html + '</div>';
    }
    var cols = BOARD_COLUMNS.map(function (group) {
      if (group.length === 1) {
        var archCls = group[0] === 'archived'
          ? ' col-archived' + (archColCollapsed ? ' collapsed' : '')
          : '';
        return '<div class="col' + archCls + '">' + headHtml(group[0]) + cardsHtml(group[0]) + '</div>';
      }
      var halves = group.map(function (key) {
        return '<div class="col-half">' + headHtml(key) + cardsHtml(key) + '</div>';
      }).join('');
      return '<div class="col' + (group.length > 2 ? ' col-multi' : '') + '" data-stack="' + group.join('+') + '">' + halves + '</div>';
    }).join('');
    return note + '<div class="cols">' + cols + '</div>';
  }

  /** 表格视图：不分组、一行一行，页面信息在「页面」列，表格容器内部滚动、表头吸顶。 */
  function renderTableView(records, hasData) {
    if (!hasData) {
      return '<p class="empty">还没有标注任务。在页面右下角打开标注面板即可开始。</p>';
    }
    if (!records.length) {
      return '<p class="empty-note">没有匹配的任务，试试调整搜索或过滤条件。</p>';
    }
    var sorted = records.slice().sort(function (x, y) {
      var d = (x.archived ? 1 : 0) - (y.archived ? 1 : 0);
      if (d) return d;
      d = statusRank(x.t.status) - statusRank(y.t.status);
      if (d) return d;
      d = x.page < y.page ? -1 : x.page > y.page ? 1 : 0;
      return d || ((x.t.seq || 0) - (y.t.seq || 0));
    });
    var head = '<thead><tr>' + ['状态', '序号', '页面', '任务', '指令', '轮次', '完成时间']
      .map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead>';
    var body = '<tbody>'
      + sorted.map(function (r) {
        var t = r.t, el = t.element || {};
        return '<tr' + (r.archived ? ' class="arch-row"' : '') + '>'
          + '<td>' + statusTag(t.status) + (r.archived ? ' <span class="tag archived">归档</span>' : '') + '</td>'
          + '<td class="num">' + esc(t.seq) + '</td>'
          + '<td class="t-page" title="' + esc(r.url) + '">' + esc(r.page) + '</td>'
          + '<td class="t-title" title="' + esc(el.selector || '') + '">' + esc(taskTitle(t)) + '</td>'
          + '<td class="t-instr">' + esc(t.instruction || '（未填写）') + '</td>'
          + '<td>' + (t.round != null ? '第 ' + esc(t.round) + ' 轮' : (r.archived ? '' : '下一轮')) + '</td>'
          + '<td class="t-time">' + esc(t.completedAt ? fmtTime(t.completedAt) : '') + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody>';
    return '<div class="table-wrap"><table>' + head + body + '</table></div>';
  }

  function render(data, archiveData) {
    data.__archive = archiveData || { archives: [], diagnostics: [] };
    latest = { data: data, archive: archiveData };
    var round = data.round || {};
    var execution = data.execution || {};

    var summary = document.getElementById('summary');
    var mode = execution.mode === 'queue' ? 'queue' : 'round';
    var counts = round.counts || {};
    var total = 0;
    STATUS_ORDER.forEach(function (s) { total += counts[s[0]] || 0; });
    var archivedTotal = (lastArchiveDataOf(data).archives || []).reduce(function (n, a) { return n + (a.taskCount || 0); }, 0);
    summary.innerHTML =
      chip('模式', mode === 'queue' ? '按队列' : '按轮次', 'mode-' + mode)
      + (round.activeRound != null ? chip('当前轮', '第 ' + round.activeRound + ' 轮') : '')
      + chip('任务', total)
      + (round.queued ? chip('下一轮排队', round.queued) : '')
      + (counts.blocked ? chip('阻塞', counts.blocked) : '')
      + (archivedTotal ? chip('归档', archivedTotal) : '');

    var records = applyFilters(collectRecords(data, false).concat(collectRecords(data, true)));
    lastRecords = records;
    var hasData = total > 0 || round.queued > 0 || archivedTotal > 0;
    syncPageOptions(collectRecords(data, false).concat(collectRecords(data, true)));

    var boardEl = document.getElementById('board');
    if (view === 'board') {
      boardEl.className = 'board';
      boardEl.innerHTML = renderBoardColumns(records, hasData);
    } else {
      boardEl.className = 'board page-main';
      boardEl.innerHTML = renderTableView(records, hasData);
    }

    var updated = document.getElementById('updated');
    updated.textContent = '最后更新 ' + new Date().toLocaleTimeString();
  }

  // ---- 页面过滤下拉：选项随数据重建，但仅在页面集合变化时刷新，避免打断交互 ----
  var pageSig = '';
  function syncPageOptions(allRecords) {
    var seen = {};
    var opts = [];
    allRecords.forEach(function (r) {
      if (r.url && !seen[r.url]) { seen[r.url] = true; opts.push({ url: r.url, page: r.page }); }
    });
    var sig = opts.map(function (o) { return o.url; }).join('|');
    if (sig === pageSig) return;
    pageSig = sig;
    var sel = document.getElementById('filter-page');
    sel.innerHTML = '<option value="all">全部页面</option>' + opts.map(function (o) {
      return '<option value="' + esc(o.url) + '">' + esc(o.page) + '</option>';
    }).join('');
    sel.value = filters.page;
    if (sel.value !== filters.page) { filters.page = 'all'; sel.value = 'all'; }
  }

  // ---- 过滤工具行（静态元素，只绑定一次；变更后用缓存数据即时重渲染） ----
  function rerender() {
    if (latest) render(latest.data, latest.archive);
  }

  document.getElementById('filter-q').addEventListener('input', function (e) {
    filters.q = e.target.value; rerender();
  });
  document.getElementById('filter-page').addEventListener('change', function (e) {
    filters.page = e.target.value; rerender();
  });
  var archBtn = document.getElementById('filter-arch');
  archBtn.addEventListener('click', function () {
    filters.archived = !filters.archived;
    archBtn.classList.toggle('active', filters.archived);
    rerender();
  });
  var chipsWrap = document.getElementById('status-chips');
  ['all'].concat(STATUS_ORDER.map(function (s) { return s[0]; })).forEach(function (key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-status', key);
    b.className = 'schip' + (key === filters.status ? ' active' : '');
    if (key === 'all') {
      b.textContent = '全部';
      b.style.setProperty('--c', 'var(--accent)');
    } else {
      b.style.setProperty('--c', stVar(key));
      b.innerHTML = '<span class="dot"></span>' + esc(STATUS_LABELS[key]);
    }
    b.addEventListener('click', function () {
      filters.status = key;
      Array.prototype.forEach.call(chipsWrap.children, function (c) {
        c.classList.toggle('active', c.getAttribute('data-status') === key);
      });
      rerender();
    });
    chipsWrap.appendChild(b);
  });

  // ---- 主题切换：暗色默认；偏好保存在项目 board-prefs.json（localStorage 兜底） ----
  var THEMES = ['dark', 'light'];
  var theme = 'dark';
  try {
    var savedTheme = localStorage.getItem('zwa-board-theme');
    if (THEMES.indexOf(savedTheme) !== -1) theme = savedTheme;
  } catch (e) { /* 忽略 */ }
  var themeIcon = document.getElementById('theme-icon');
  function applyTheme(next) {
    theme = next;
    document.documentElement.setAttribute('data-theme', theme);
    // 图标显示「将切换到」的主题：暗色时显示太阳（点击去明亮），反之月亮
    themeIcon.innerHTML = theme === 'dark' ? ${JSON.stringify(SUN_SVG)} : ${JSON.stringify(MOON_SVG)};
    try { localStorage.setItem('zwa-board-theme', theme); } catch (e) { /* 忽略 */ }
  }
  document.getElementById('theme-btn').addEventListener('click', function () {
    applyTheme(theme === 'dark' ? 'light' : 'dark');
    fetch('./board-prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: theme }),
    }).catch(function () { /* 服务端不可用时 localStorage 兜底 */ });
  });
  // 项目里保存过的偏好优先于本机缓存（跨浏览器记忆）
  fetch('./board-prefs', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var t = d && d.prefs && d.prefs.theme;
      if (t && THEMES.indexOf(t) !== -1 && t !== theme) applyTheme(t);
    })
    .catch(function () { /* 服务端不可用时保持本机选择 */ });
  applyTheme(theme);

  // ---- 视图切换（右上角菜单，选择记忆在 localStorage） ----
  var viewSwitchEl = document.getElementById('view-switch');
  var viewBtn = document.getElementById('view-btn');
  var viewMenu = document.getElementById('view-menu');
  var viewIcon = document.getElementById('view-icon');
  var viewLabel = document.getElementById('view-label');

  function syncViewSwitch() {
    var current = VIEWS.filter(function (v) { return v[0] === view; })[0] || VIEWS[0];
    viewIcon.innerHTML = current[2];
    viewLabel.textContent = current[1];
    Array.prototype.forEach.call(viewMenu.querySelectorAll('button[data-view]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
  }

  VIEWS.forEach(function (v) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('data-view', v[0]);
    b.innerHTML = v[2] + '<span>' + esc(v[1]) + '</span><span class="check">✓</span>';
    b.addEventListener('click', function () {
      view = v[0];
      try { localStorage.setItem('zwa-board-view', view); } catch (e) { /* 忽略 */ }
      closeMenu();
      syncViewSwitch();
      rerender();
    });
    viewMenu.appendChild(b);
  });

  function closeMenu() {
    viewMenu.classList.add('hidden');
    viewBtn.setAttribute('aria-expanded', 'false');
  }

  viewBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var hidden = viewMenu.classList.toggle('hidden');
    viewBtn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });
  document.addEventListener('click', function (e) {
    if (!viewSwitchEl.contains(e.target)) closeMenu();
  });
  syncViewSwitch();

  // ---- 卡片上的显式清理动作（事件委托绑定一次，重渲染不影响） ----
  // 删除归档任务走 /purge-archive 的任务粒度删除；阻塞任务重新入列走
  // PATCH status: todo（blocked→todo 是状态机里专门留给人工的转移）。
  // 两次点击确认：第一次只把按钮变成「确认…」，3 秒不点自动还原。
  var boardRoot = document.getElementById('board');
  var armedBtn = null;
  var armedTimer = null;
  var CONFIRM_LABELS = {
    'purge-archived': '确认删除', 'reopen': '确认入列', 'accept': '确认验收',
    'archive': '确认归档', 'archive-page': '确认归档本页', 'archive-all-done': '确认全部归档',
  };
  function disarmAction() {
    if (armedBtn) {
      armedBtn.textContent = armedBtn.dataset.label;
      armedBtn.classList.remove('armed');
      armedBtn = null;
    }
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
  }
  /* ---- 图片灯箱：与检验归档抽屉同款——左右切换、序号徽标、任务文案、滚轮缩放 ---- */
  var viewer = document.getElementById('viewer');
  var vImg = viewer.querySelector('img');
  var vCap = viewer.querySelector('.viewer-caption');
  var vCnt = viewer.querySelector('.viewer-count');
  var vPrev = viewer.querySelector('.viewer-nav.prev');
  var vNext = viewer.querySelector('.viewer-nav.next');
  var vList = [], vIdx = 0, vZoom = 1;
  function vRender() {
    if (!vList.length) return;
    vZoom = 1;
    vImg.style.transform = '';
    vImg.style.transformOrigin = '';
    vImg.src = vList[vIdx];
    vCnt.textContent = vList.length > 1 ? (vIdx + 1) + '/' + vList.length : '';
    vPrev.classList.toggle('hidden', vList.length < 2);
    vNext.classList.toggle('hidden', vList.length < 2);
  }
  function vOpen(list, idx, cap) {
    vList = list.filter(Boolean);
    if (!vList.length) return;
    vIdx = Math.min(Math.max(idx, 0), vList.length - 1);
    vCap.textContent = cap || '';
    vRender();
    viewer.classList.remove('hidden');
  }
  function vStep(d) { vIdx = (vIdx + d + vList.length) % vList.length; vRender(); }
  boardRoot.addEventListener('click', function (e) {
    var thumb = e.target && e.target.closest ? e.target.closest('.card-thumb') : null;
    if (!thumb || !boardRoot.contains(thumb)) return;
    e.preventDefault();
    e.stopPropagation();
    var srcs = [];
    try { srcs = JSON.parse(decodeURIComponent(thumb.dataset.srcs || '[]')); } catch (err) { srcs = [thumb.querySelector('img').src]; }
    vOpen(srcs, 0, decodeURIComponent(thumb.dataset.cap || ''));
  }, true);
  // 已归档折叠两层开关：列头点一下整列收成窄条；页面组头点一下
  // 单组开合。都跳过组内按钮，展开态记内存，SSE/定时刷新重渲染后保持。
  boardRoot.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-action]')) return;
    var colHead = e.target && e.target.closest ? e.target.closest('.col-head[data-arch-col]') : null;
    if (colHead && boardRoot.contains(colHead)) { archColCollapsed = !archColCollapsed; rerender(); return; }
    var head = e.target && e.target.closest ? e.target.closest('.pg-head[data-pg]') : null;
    if (!head || !boardRoot.contains(head)) return;
    var pgk = head.getAttribute('data-pg');
    if (archPgOpen[pgk]) delete archPgOpen[pgk]; else archPgOpen[pgk] = 1;
    rerender();
  });
  viewer.addEventListener('click', function (e) {
    if (e.target === viewer) { viewer.classList.add('hidden'); return; }
    if (e.target.closest('.prev')) vStep(-1);
    else if (e.target.closest('.next')) vStep(1);
  });
  document.addEventListener('keydown', function (e) {
    if (viewer.classList.contains('hidden')) return;
    if (e.key === 'Escape') viewer.classList.add('hidden');
    else if (e.key === 'ArrowLeft') vStep(-1);
    else if (e.key === 'ArrowRight') vStep(1);
  });
  viewer.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = vImg.getBoundingClientRect();
    var ox = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * 100;
    var oy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1) * 100;
    vZoom = Math.min(Math.max(vZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1), 6);
    vImg.style.transformOrigin = ox + '% ' + oy + '%';
    vImg.style.transform = 'scale(' + vZoom + ')';
  }, { passive: false });

  boardRoot.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn || !boardRoot.contains(btn)) return;
    e.stopPropagation();
    var action = btn.getAttribute('data-action');
    if (armedBtn !== btn) {
      disarmAction();
      armedBtn = btn;
      armedBtn.dataset.label = armedBtn.textContent;
      armedBtn.textContent = CONFIRM_LABELS[action] || '确认';
      armedBtn.classList.add('armed');
      armedTimer = setTimeout(disarmAction, 3000);
      return;
    }
    disarmAction();
    var groupId = btn.getAttribute('data-group');
    var taskId = btn.getAttribute('data-task');
    var call;
    if (action === 'purge-archived') {
      call = fetch('./purge-archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: groupId, ids: [taskId] }),
      });
    } else if (action === 'reopen') {
      call = fetch('./' + encodeURIComponent(groupId) + '/tasks/' + encodeURIComponent(taskId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'todo' }),
      });
    } else if (action === 'accept') {
      // 验收走 /accept-tasks：主线程人工路径，不带 task-agent 声明。
      call = fetch('./accept-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [taskId] }),
      });
    } else if (action === 'archive' || action === 'archive-page' || action === 'archive-all-done') {
      // 归档 = 任务级 status:archived（主线程人工路径）。单任务 / 按页面 / 全列三种粒度。
      var targets = [];
      if (action === 'archive') {
        targets = [{ group: groupId, task: taskId }];
      } else {
        var page = btn.getAttribute('data-page');
        targets = lastRecords.filter(function (r) {
          return r.t.status === 'done' && !r.archived
            && (action === 'archive-all-done' || (r.url || r.page) === page);
        }).map(function (r) { return { group: r.group, task: r.t.id }; });
      }
      if (!targets.length) { refresh(); return; }
      call = Promise.all(targets.map(function (x) {
        return fetch('./' + encodeURIComponent(x.group) + '/tasks/' + encodeURIComponent(x.task), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'archived' }),
        }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
      }));
    }
    if (call) {
      call.then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        refresh();
      }).catch(function (err) {
        window.alert('操作失败：' + err.message);
      });
    }
  });

  function refresh() {
    // 看板位于 <endpoint>/board，相对地址天然指向同源接口。
    // 归档取数失败不拖垮活动看板：降级为空归档。
    Promise.all([
      fetch('./tasks', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fetch('./archive', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function () { return { archives: [], diagnostics: [] }; }),
    ]).then(function (results) { render(results[0], results[1]); })
      .catch(function (e) {
        document.getElementById('board').innerHTML =
          '<p class="error">看板数据加载失败：' + esc(e.message) + '<br>请确认开发服务器正在运行。</p>';
      });
  }

  refresh();
  try {
    var es = new EventSource('./events');
    es.addEventListener('tasks-changed', refresh);
  } catch (e) { /* SSE 不可用时靠轮询兜底 */ }
  setInterval(refresh, 10000);
})();
</script>
</body>
</html>`;
}
