/**
 * 网页标注组件（框架无关）
 *
 * 交互模型：
 * - 点击元素 → 元素旁就地弹出编辑框 → Enter 确认即关闭并落盘 → 元素上出现编号图钉；
 * - 确认后标注模式保持开启，可直接点下一个元素，实现连续批量标注；
 * - 侧栏默认悬浮收缩为一个胶囊，显示已录入文字数量；展开后是按添加时间排序的列表，
 *   右上角提供快速操作（进入标注、复制、发送、清空、收起）。
 *
 * 持久化策略：
 * - 确认即同步写入 localStorage，保证刷新、跳转、关标签都不丢；
 * - 同时防抖合并同步到同源接口，写入工作区 JSON；失败只提示，不影响本地留存。
 *
 * 用法（Vite / 任意 ESM 环境）：
 *   import { mountAnnotator } from './annotator.mjs';
 *   mountAnnotator();
 */

/**
 * 页面上的指针事件是否应当被拦下（不穿透到页面控件）。
 *
 * 抽成纯函数以便直接测试：这个判断出错的后果很具体——遮罩看起来盖住了页面，
 * 但点击仍然生效（实测点复选框会被真的勾上），或者反过来把组件自己的 UI
 * 也一起拦死。两种都不能靠肉眼看出来。
 *
 * @param {object} s
 * @param {boolean} s.ownUi   事件目标是否属于组件自身 UI（面板/编辑器/图钉）
 * @param {boolean} s.editing 编辑器是否开着
 * @param {boolean} s.active  是否处于标注模式
 */
export function shouldBlockPageEvent({ ownUi, editing, active }) {
  // 组件自己的 UI 永远放行，否则面板按钮、编辑器输入会全部点不动
  if (ownUi) return false;
  return !!(editing || active);
}

const STATUS_LABELS = {
  todo: '待处理',
  doing: '进行中',
  // 子 agent 改完源码、等主线程验收。与 done 的区别是「代码已改但还没验」：
  // 主线程验收通过后再回写 done，进度条的最后一段才会推进。
  review: '待验收',
  done: '已完成',
  archived: '已归档',
  blocked: '已阻塞',
  cancelled: '已取消',
};

/**
 * 总体进度权重（百分比）。
 *
 * 需求原文是「分派 10% + 开发 70% + 验收 30%」，但三者相加为 110%，
 * 进度条会溢出。这里把验收压到 20% 使总和为 100——之所以动验收而不是动开发，
 * 是因为需求里给了「7 个小任务每完成 1 个增加 10%」这个明确例子，
 * 只有开发占 70% 才能让每项正好 +10%，破坏它用户一眼就能看出不对。
 * 分派是一次性关卡（有任务离开 todo 即算完成整个 10%），不按比例摊薄，
 * 否则每个任务的涨幅就不再是整数 10%。
 */
export const PROGRESS_WEIGHTS = { dispatch: 10, dev: 70, verify: 20 };

/**
 * 运行时尾部快照（被动录制）。
 *
 * 创建任务时把「最近 N 条网络请求 + 控制台错误/警告尾部」作为 meta.ctx
 * 随任务落盘——「这个查询报错」类标注自带案发现场，处理者不必手动回放
 * 定位。只录请求行（方法/URL/状态/耗时），不录 body，避免密码等敏感内容
 * 进任务文件；标注插件自身的同步流量、Vite HMR 通道一律过滤。
 */
const runtimeTail = (() => {
  const NET_MAX = 40;
  const LOG_MAX = 30;
  const net = [];
  const logs = [];
  const trunc = (v, n) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
  const pushNet = (e) => { net.push(e); if (net.length > NET_MAX) net.splice(0, net.length - NET_MAX); };
  const pushLog = (e) => { logs.push(e); if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX); };
  /** 插件自身与构建工具的流量不入快照（会污染尾部把业务请求挤出去） */
  const skipUrl = (u) => /__zw-web-annotations|\/\.zwa\/|\/@vite\/|\/@fs\/|\/node_modules\/|sockjs|vite\/client|__webpack_hmr/.test(u);
  const argText = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.message}${a.stack ? ' | ' + (a.stack.split('\n')[1] || '').trim() : ''}`;
    try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
  };

  const install = () => {
    if (typeof window === 'undefined' || window.__zwaTailInstalled) return;
    window.__zwaTailInstalled = true;

    if (typeof window.fetch === 'function') {
      const of = window.fetch;
      window.fetch = function (...args) {
        const t0 = performance.now();
        const url = trunc(typeof args[0] === 'string' ? args[0] : args[0]?.url, 240);
        const method = trunc(args[1]?.method || args[0]?.method || 'GET', 10);
        return Promise.resolve(of.apply(this, args)).then((res) => {
          if (!skipUrl(url)) pushNet({ t: new Date().toISOString(), m: method, u: url, s: res.status, ms: Math.round(performance.now() - t0) });
          return res;
        }).catch((err) => {
          if (!skipUrl(url)) pushNet({ t: new Date().toISOString(), m: method, u: url, s: 0, ms: Math.round(performance.now() - t0), err: trunc(err?.message || err, 160) });
          throw err;
        });
      };
    }

    const X = window.XMLHttpRequest?.prototype;
    if (X?.open && X?.send) {
      const origOpen = X.open;
      const origSend = X.send;
      X.open = function (m, u, ...rest) { this.__zwaM = trunc(m, 10); this.__zwaU = trunc(u, 240); return origOpen.call(this, m, u, ...rest); };
      X.send = function (...args) {
        const t0 = performance.now();
        const rec = (s, err) => {
          if (this.__zwaU && !skipUrl(this.__zwaU)) {
            pushNet({ t: new Date().toISOString(), m: this.__zwaM || 'GET', u: this.__zwaU, s, ms: Math.round(performance.now() - t0), ...(err ? { err } : {}) });
          }
        };
        this.addEventListener('loadend', () => rec(this.status));
        this.addEventListener('error', () => rec(0, 'network error'));
        this.addEventListener('timeout', () => rec(0, 'timeout'));
        this.addEventListener('abort', () => rec(0, 'aborted'));
        return origSend.apply(this, args);
      };
    }

    for (const lv of ['error', 'warn']) {
      const orig = console[lv];
      if (typeof orig !== 'function') continue;
      console[lv] = function (...args) {
        try { pushLog({ t: new Date().toISOString(), lv, text: trunc(args.map(argText).join(' '), 400) }); } catch { /* 快照失败不影响原输出 */ }
        return orig.apply(this, args);
      };
    }

    // capture 阶段才能拿到资源加载错误（img/script/link 的 error 事件不冒泡）
    window.addEventListener('error', (e) => {
      const el = e.target;
      if (el && el !== window && (el.src || el.href)) {
        pushLog({ t: new Date().toISOString(), lv: 'error', text: `resource ${String(el.tagName || '').toLowerCase()}: ${trunc(el.src || el.href, 200)}` });
      } else if (e.message) {
        pushLog({ t: new Date().toISOString(), lv: 'error', text: trunc(`${e.message} @${e.filename || ''}:${e.lineno || ''}`, 400) });
      }
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
      pushLog({ t: new Date().toISOString(), lv: 'error', text: `unhandledrejection: ${trunc(e.reason?.message || e.reason, 300)}` });
    });
  };

  install();

  return {
    /** 任务创建时刻的尾部快照（拷贝数组，后续流量不回溯污染已落盘任务） */
    snapshot() {
      return {
        capturedAt: new Date().toISOString(),
        network: net.slice(),
        console: logs.slice(),
      };
    },
  };
})();

/**
 * 项目总体进度。
 *
 * 三段按「已达成该阶段的任务数 / 有效任务数」计分：
 * - 分派：任一任务离开 todo 即得满分 10%（它是关卡，不是斜坡）；
 * - 开发：到达 review 或 done 即算开发完成，每项贡献 70/total；
 * - 验收：只有 done 才算验收通过，每项贡献 20/total。
 * cancelled 不计入分母——用户主动取消的任务不该把进度永远压住。
 */
export function computeProgress(tasks = []) {
  const active = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.status !== 'cancelled');
  const total = active.length;
  const counts = {};
  for (const t of active) counts[t.status] = (counts[t.status] || 0) + 1;
  if (!total) return { percent: 0, total: 0, counts, started: 0, devDone: 0, verified: 0 };
  const started = total - (counts.todo || 0);
  // archived 是 done 的人工归档终态，进度权重与 done 同档计入
  const devDone = (counts.review || 0) + (counts.done || 0) + (counts.archived || 0);
  const verified = (counts.done || 0) + (counts.archived || 0);
  const percent = Math.round(
    (started > 0 ? PROGRESS_WEIGHTS.dispatch : 0)
      + PROGRESS_WEIGHTS.dev * (devDone / total)
      + PROGRESS_WEIGHTS.verify * (verified / total),
  );
  return { percent, total, counts, started, devDone, verified };
}

/**
 * 本地降级推断：当前轮（活动任务中最大的轮次号）与排队数。
 *
 * 只在服务端没有返回轮次摘要（旧版运行时）时使用。已交付但还没归档的
 * 旧轮次任务（round 更小）不算——它们不属于任何在途工作，混进分母会让
 * 进度倒退；尚未定稿的排队任务以 queued 单独返回，显示「下一轮 N 条」。
 * 服务端摘要可用时一律以 `resolveRoundScope` 的权威口径为准。
 */
export function selectProgressTasks(tasks = []) {
  const all = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.id);
  const withRound = all.filter(t => t.round != null);
  const currentRound = withRound.reduce((m, t) => Math.max(m, t.round), 0) || null;
  return {
    dispatched: withRound.filter(t => t.round === currentRound),
    queued: all.filter(t => t.round == null && (t.status === 'todo' || t.status === 'doing')).length,
    currentRound,
  };
}

/**
 * 解析进度统计范围：分母统一为「本轮定稿集合」，服务端摘要优先。
 *
 * 两种执行模式（round/queue）共用同一个分母口径——本轮定稿时冻结的任务
 * 集合，含定稿后并入的标注；归档轮次的存量不进任何进度条。模式的区别
 * 只在边界行为：round 停下等显式归档，queue 自动归档并续轮。
 *
 * 服务端 `roundSummary` 以 `execution.activeRound` 为唯一权威：本轮成员在
 * 第一个任务进入 doing 时就被原子冻结，之后新增的标注要么并入本轮、要么
 * 排队，分母随之如实增减。客户端若自行用「活动任务最大轮次号」推断，会在
 * 旧轮任务尚未归档时把它误当成当前轮——因此只要服务端给了摘要就一律采用；
 * 只有旧版运行时没有 `round` 字段（serverRound 为 null）才回落到本地推断。
 *
 * `serverRound` 存在时必定带 `activeRound` 键（可能为 null）。null 表示本轮
 * 已交付、当前没有在途轮次，此时不能再从任务里把旧轮翻出来。
 */
export function resolveRoundScope(tasks = [], execution = {}, serverRound = null) {
  const all = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.id);
  const mode = execution?.mode || 'round';
  const fallback = selectProgressTasks(all);
  const runner = serverRound?.runner || execution?.runner || { status: 'idle' };
  const authority = serverRound && Object.prototype.hasOwnProperty.call(serverRound, 'activeRound')
    ? serverRound
    : null;
  const activeRound = authority ? authority.activeRound : fallback.currentRound;
  const dispatched = activeRound == null ? [] : all.filter(t => t.round === activeRound);
  return {
    all,
    mode,
    dispatched,
    // 排队数用服务端口径（round 为空的 todo/doing）；摘要缺失时才本地数
    queued: Number.isFinite(authority?.queued) ? authority.queued : fallback.queued,
    currentRound: activeRound,
    complete: authority ? !!authority.complete : null,
    // blocked 要显式可见：它会让本轮无法交付、队列无法续轮，静默停住会
    // 被误读成卡死。
    blocked: runner.status === 'blocked'
      || dispatched.some(t => t && t.status === 'blocked')
      || (authority?.counts?.blocked || 0) > 0,
    runner,
  };
}

export function pathIsAbsolute(value) {
  const text = String(value || '');
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text);
}

export function buildAddressPrompt(tasksPath, protocolPath) {
  if (!pathIsAbsolute(tasksPath) || !pathIsAbsolute(protocolPath)) return null;
  return [
    '请按执行要求处理以下网页标注任务：',
    `任务目录：${tasksPath}`,
    `执行要求：${protocolPath}`,
    '以上地址必须都能读取；任一无法读取时停下来告知用户，不要凭猜测执行。',
  ].join('\n');
}

export function mergeRemoteTasks(remoteTasks = [], localTasks = [], outbox = []) {
  if (!outbox.length) return (remoteTasks || []).filter(t => t?.id);
  const localById = new Map((localTasks || []).filter(t => t?.id).map(t => [t.id, t]));
  const deleted = new Set(outbox.flatMap(op => op?.ids || []));
  const merged = [];
  const seen = new Set();
  for (const remote of remoteTasks || []) {
    if (!remote?.id || deleted.has(remote.id)) continue;
    const local = localById.get(remote.id);
    merged.push(local
      ? { ...remote, instruction: local.instruction, element: local.element, images: local.images, confirmedAt: local.confirmedAt }
      : remote);
    seen.add(remote.id);
  }
  for (const local of localTasks || []) {
    if (local?.id && !seen.has(local.id) && !deleted.has(local.id)) merged.push(local);
  }
  return merged;
}

const HOST_ID = 'zw-annotation-host';
const SOURCE = 'zw-web-annotations';
const DRAFT_DELAY_MS = 900;

/* ------------------------------------------------------------------ *
 * 元素定位与描述
 * ------------------------------------------------------------------ */

export function buildSelector(el) {
  if (el.id) return '#' + cssEscape(el.id);
  // 逐级上溯时，只在「同级同标签有多个」时才补 :nth-of-type。
  // 无脑给每一级都编号会得到 div > div.page:nth-of-type(1) > aside.brand >
  // div.brand-body:nth-of-type(2) 这种渲染期位置路径：它在 Vue/React 源码里
  // 根本搜不到（模板里不存在渲染后的兄弟序），模型据此无法定位文件。
  // 类名组合通常已足够唯一，保留最少的位置限定更利于在源码里按类名检索。
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length) {
      // 取全部类名而非前两个：Vue 组件的语义类名常排在后面（如 .page .brand-body），
      // 只取前两个会丢掉最有辨识度的那个。
      part += '.' + Array.from(node.classList).map(cssEscape).join('.');
    }
    const siblings = Array.from((node.parentElement && node.parentElement.children) || []).filter(s => s.tagName === node.tagName);
    // 若本级有类名，兄弟序通常不再必要；只有当同级存在完全相同的标签+类名组合时才补
    const sameSignature = siblings.filter(s => {
      if (s === node) return false;
      const a = s.className || '', b = node.className || '';
      return a === b;
    }).length;
    if (siblings.length > 1 && (sameSignature > 0 || !node.classList?.length)) {
      part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
    // 已经足够定位到唯一元素时提前停止，避免没必要的长链
    if (parts.length >= 2) {
      try {
        if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      } catch { /* 组合非法时继续上溯，最终由整链兜底 */ }
    }
  }
  return parts.join(' > ') || 'body';
}

/**
 * 找出元素所属的框架组件源文件（Vue 3 实测可用）。
 *
 * Vue 把组件定义挂在 DOM 节点上（`__vueParentComponent.type.__file`），
 * 值就是 SFC 的绝对路径。这是给模型的最强定位线索：有了它不必根据
 * 类名在 src/ 里猜文件，直接打开对应 .vue。React/Vue2 没有这个属性，
 * 拿不到就返回空，不影响其它字段。
 */
function componentTrail(el) {
  const files = [];
  const names = [];
  // 文件名与组件名必须来自同一个组件实例。分开收集会让匿名的子组件
  // （CampusBrand.vue 没有 name）配上父组件的名字（CampusLogin），
  // 模型拿到「文件是 A、名字是 B」这组自相矛盾的线索。
  let ownFile = '';
  let ownName = '';
  let ownInst = null;
  try {
    let cur = el && el.__vueParentComponent;
    let depth = 0;
    while (cur && depth < 8) {
      const file = cur.type && cur.type.__file;
      const name = (cur.type && (cur.type.name || cur.type.__name)) || '';
      if (depth === 0) {
        ownFile = file || '';
        ownName = name;
        ownInst = cur;
      }
      if (file && !files.includes(file)) files.push(file);
      if (name && !names.includes(name)) names.push(name);
      cur = cur.parent;
      depth++;
    }
  } catch {
    // 生产构建或非 Vue 环境不暴露该属性，属正常情况
  }
  // props 浅快照：只收原始值（对象/数组记类型或长度），限前 8 键——
  // 「这个列宽不对」类标注带着组件当时的入参，模型不必猜调用方传了什么。
  let props = null;
  try {
    const p = ownInst && ownInst.props;
    if (p) {
      props = {};
      for (const [k, v] of Object.entries(p).slice(0, 8)) {
        if (v == null) props[k] = String(v);
        else if (['string', 'number', 'boolean'].includes(typeof v)) props[k] = v;
        else props[k] = Array.isArray(v) ? `[${v.length}]` : typeof v;
      }
      if (!Object.keys(props).length) props = null;
    }
  } catch { /* 快照失败不阻断标注 */ }
  // 路由信息：组件实例经 appContext 拿到 $route，取不到降级 null
  let route = null;
  try {
    const r = ownInst && ownInst.appContext && ownInst.appContext.config.globalProperties.$route;
    if (r) route = { name: r.name || null, path: r.path || '' };
  } catch { /* 同上 */ }
  return {
    // 元素真正所属的组件放最前（如 CampusBrand.vue），其后是逐级父组件
    componentFile: files[0] || '',
    componentFiles: files,
    // 只报告与 componentFile 同属一个组件的名字；匿名组件留空，
    // 而不是拿父组件的名字顶上
    componentName: ownFile ? ownName : '',
    componentChain: names,
    componentProps: props,
    route,
  };
}

/**
 * 取元素自身声明的 CSS 属性名集合（不包含继承值）。
 *
 * computedStyle 返回的是**继承后**的最终值：.brand-body 并未写 color，
 * 但计算值仍是祖先 body 的 var(--text-1)。若直接记录计算值，模型会以为
 * 该元素自己声明了这个颜色，改「这个区域文字」时去改祖先变量，一次影响全站。
 * 这里遍历 CSSOM 找到真正命中该元素的规则，从而区分「自身声明」与「继承」。
 */
/**
 * CSSOM 规则扁平缓存：整张样式表树的遍历结果只算一次。
 * 每次标注都全量 walk + matches 会卡 ~1s（EP+项目 SCSS 数千条规则）。
 * 失效条件保守取 styleSheets 数量变化——开发态 Vite 注入新表时自然重建。
 */
let flatRuleCache = null;
function flatRules() {
  const sheets = Array.from(document.styleSheets || []);
  if (flatRuleCache && flatRuleCache.count === sheets.length) return flatRuleCache.rules;
  const rules = [];
  const visit = list => {
    for (const rule of list || []) {
      if (rule.selectorText && rule.style) rules.push(rule);
      if (rule.cssRules && rule.cssRules.length) visit(rule.cssRules);
    }
  };
  for (const sheet of sheets) {
    try { visit(sheet.cssRules); } catch { /* 跨域样式表跳过 */ }
  }
  flatRuleCache = { count: sheets.length, rules };
  return rules;
}

/**
 * 选择器类名令牌预筛：selector 中（:not() 之外）出现的 .cls 若元素并不具备，
 * matches() 必然 false，直接跳过——几千条规则里真正需要 matches 的只剩个位数。
 * 注意 :not(.x) 里的类名不能用于前置排除（缺 .x 反而可能命中），先剥离。
 */
const NOT_BLOCK = /:not\([^)]*\)/g;
const CLASS_TOKEN = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
function couldMatch(el, selectorText) {
  const positive = selectorText.replace(NOT_BLOCK, '');
  const tokens = positive.match(CLASS_TOKEN);
  if (!tokens || !tokens.length) return true; // 无类名令牌：无法预筛，交给 matches
  for (const t of tokens) {
    if (!el.classList || !el.classList.contains(t.slice(1))) return false;
  }
  return true;
}

function declaredProps(el) {
  const props = new Set();
  let warned = 0;
  for (const rule of flatRules()) {
    if (!rule.selectorText || !rule.style) continue;
    if (!couldMatch(el, rule.selectorText)) continue;
    try {
      if (el.matches(rule.selectorText)) for (const p of rule.style) props.add(p);
    } catch {
      warned++;
    }
  }
  return { props, warned };
}

export function buildXPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1) {
    let index = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === node.tagName) index++;
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
    node = node.parentElement;
  }
  return '/' + parts.join('/');
}

/**
 * 序列化 DOM 片段，并按**标签边界**截断。
 *
 * 直接 slice 会切在属性中间，得到 `<polygon points="118,238 156,206 fill="#2E7C`
 * 这种残缺 HTML：模型读到不闭合的片段会误判结构，也看不出是被截断的。
 * 这里截到最后一个完整标签为止，并显式标注剩余长度。
 */
export function snippetOf(el, max = 800) {
  const html = String(el.outerHTML || '');
  if (html.length <= max) return html;
  // 在 max 之前找最后一个 '>'，保证不切在标签内部
  const cut = html.lastIndexOf('>', max);
  if (cut <= 0) return html.slice(0, max) + '…[已截断]';
  return `${html.slice(0, cut + 1)}…[已截断，完整长度 ${html.length} 字符]`;
}

/** 记录的样式属性 → CSS 属性名。font-family 故意不记：它总是从 body 继承的
 *  同一串系统字体栈（实测占单条任务 143 字节），对「改这个元素」没有指导意义。 */
const STYLE_PROPS = {
  color: 'color',
  backgroundColor: 'background-color',
  backgroundImage: 'background-image',
  border: 'border',
  opacity: 'opacity',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  lineHeight: 'line-height',
  padding: 'padding',
  margin: 'margin',
  borderRadius: 'border-radius',
  display: 'display',
};

/** 可继承的 CSS 属性。未自行声明的这些属性，值来自祖先。 */
const INHERITABLE_STYLES = new Set(['color', 'fontSize', 'fontWeight', 'lineHeight']);

/** 不写进 JSON 的属性：value 可能含用户正在输入的密码/账号。 */
const SKIP_ATTRS = new Set(['value']);

/** 采集元素的原始属性。标签名与计算样式都给不出 type/name/href 这类语义，
 *  而它们恰恰是判断「这个 input 是账号框还是密码框」的关键。 */
function attributesOf(el) {
  const out = {};
  try {
    for (const attr of Array.from(el.attributes || [])) {
      if (SKIP_ATTRS.has(attr.name)) continue;
      // Vue scoped 样式的 data-v-* 哈希无定位价值
      if (attr.name.startsWith('data-v-')) continue;
      const value = String(attr.value ?? '');
      if (value.length > 120) continue;
      out[attr.name] = value;
    }
  } catch {
    // 非元素节点，忽略
  }
  return out;
}

export function describeElement(el) {
  const rect = el.getBoundingClientRect();
  const selector = buildSelector(el);
  let matchCount = 0;
  try {
    matchCount = document.querySelectorAll(selector).length;
  } catch {
    matchCount = 0;
  }

  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : null;
  const declared = declaredProps(el);
  const styles = {};
  // ownStyles / inheritedStyles 是给模型的关键判别依据：若 color 出现在
  // inheritedStyles 里，说明该元素没有自己的颜色声明，改「这块区域的文字颜色」
  // 应当去改祖先规则或主题变量，而不是这个选择器。
  const ownStyles = [];
  const inheritedStyles = [];
  if (style) {
    for (const [key, cssName] of Object.entries(STYLE_PROPS)) {
      const value = style[key];
      if (value == null || value === '') continue;
      styles[key] = value;
      if (declared.props.has(cssName)) ownStyles.push(key);
      else if (INHERITABLE_STYLES.has(key)) inheritedStyles.push(key);
    }
  }

  const compat = componentTrail(el);
  const srcEl = el.closest && el.closest('[data-zwa-src]');

  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || '',
    classList: el.classList ? Array.from(el.classList).slice(0, 8) : [],
    attributes: attributesOf(el),
    accessibleName:
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'))) || '',
    text: trim(el.innerText || el.textContent, 300),
    selector,
    xpath: buildXPath(el),
    // 有组件来源就直接给文件，这是 Vue 项目里最有效的定位线索
    componentFile: compat.componentFile,
    componentName: compat.componentName,
    componentProps: compat.componentProps,
    route: compat.route,
    // 编译期埋点（dev）：data-zwa-src="文件:行"——本元素或最近祖先的模板行
    source: srcEl ? srcEl.getAttribute('data-zwa-src') : '',
    parentSummary: trim(el.parentElement && el.parentElement.innerText, 200),
    parentSelector: el.parentElement ? buildSelector(el.parentElement) : '',
    domSnippet: snippetOf(el, 800),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    // 仅当内容区与渲染尺寸不同（存在边框/滚动条）时才记录：其余 offset/scroll
    // 值与 rect 完全重复，同一条任务里白占 100+ 字节且不带来新信息。
    metrics:
      el.clientWidth !== Math.round(rect.width) || el.clientHeight !== Math.round(rect.height)
        ? { clientWidth: el.clientWidth, clientHeight: el.clientHeight }
        : null,
    styles,
    ownStyles,
    inheritedStyles,
    frame: typeof window !== 'undefined' && window.top === window ? 'top' : 'nested',
    uniqueMatch: matchCount === 1,
    locator: buildLocator(el, selector),
  };
}

/** 生成的/易漂移的 id 特征：Element Plus 的 el-id-*、el-table_<实例号>_*、Vue scoped data-v-*、构建期哈希 id。 */
const VOLATILE_ID = /^(el-id-|van-|v-|uid-|radix-|headlessui-)|^data-v-|__[a-z0-9]{4,}|^el-table_\d+_/i;

/**
 * 稳定定位链兜底：selector 里的 el-id-* 是会话级生成 id，换个会话必失效。
 * 这里产出两级降级定位——
 *   stableSelector：跳过易漂移 id、只走标签+类名的选择器；
 *   semantic：label/placeholder/name/role/就近文本等语义签名，
 *   供模型在 selector 失效后仍能在源码/DOM 里精确找回元素。
 */
export function buildLocator(el, primarySelector) {
  // 稳定选择器：逐级上溯，跳过易漂移 id，保留标签+稳定类名
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && !VOLATILE_ID.test(node.id)) {
      part = '#' + cssEscape(node.id);
      parts.unshift(part);
      node = node.parentElement;
      break; // 稳定 id 本身就是锚点，不必再上溯
    }
    const cls = node.classList ? Array.from(node.classList).filter(c => !VOLATILE_ID.test(c)).slice(0, 4) : [];
    if (cls.length) part += '.' + cls.map(cssEscape).join('.');
    const siblings = Array.from((node.parentElement && node.parentElement.children) || []).filter(s => s.tagName === node.tagName);
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    node = node.parentElement;
    if (parts.length >= 5) break;
  }
  const stableSelector = parts.join(' > ');

  // 语义签名：表单控件取关联 label 文本；按钮/链接取可访问名
  const semantic = {};
  const attr = (n) => el.getAttribute && el.getAttribute(n);
  if (attr('placeholder')) semantic.placeholder = attr('placeholder');
  if (attr('name')) semantic.name = attr('name');
  if (attr('type')) semantic.type = attr('type');
  if (attr('role')) semantic.role = attr('role');
  if (attr('aria-label')) semantic.ariaLabel = attr('aria-label');
  // 就近表单标签：Element Plus .el-form-item__label / 通用 label[for] / 前一个 label 兄弟
  const formItem = el.closest && el.closest('.el-form-item, .filter-cell, .search-item, .form-item, label');
  if (formItem) {
    const lbl = formItem.querySelector('.el-form-item__label, .cell-label, .item-label, label');
    if (lbl) semantic.fieldLabel = trim(lbl.innerText, 60);
    else if (formItem.tagName === 'LABEL') semantic.fieldLabel = trim(formItem.innerText, 60);
  }
  if (!semantic.fieldLabel && el.id && !VOLATILE_ID.test(el.id)) {
    const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (lab) semantic.fieldLabel = trim(lab.innerText, 60);
  }
  const txt = trim(el.innerText || el.textContent, 60);
  // 文本签名白名单放宽到表格单元格/标签/标题——th.el-table_<实例>_column_*
  // 选择器跨重挂载必失效，文本是表头唯一可靠的锚。
  if (txt && ['button', 'a', 'span', 'div', 'th', 'td', 'label', 'li', 'p', 'h1', 'h2', 'h3', 'h4'].includes(el.tagName.toLowerCase())) semantic.text = txt;
  const headers = { placeholder: semantic.placeholder, fieldLabel: semantic.fieldLabel, text: semantic.text, name: semantic.name, type: semantic.type, role: semantic.role, ariaLabel: semantic.ariaLabel };
  for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k];

  return { stableSelector: stableSelector !== primarySelector ? stableSelector : null, semantic: Object.keys(headers).length ? headers : null };
}

/* ------------------------------------------------------------------ *
 * 全视口上下文截图（dom→canvas，modern-screenshot 随运行时 vendored）
 * ------------------------------------------------------------------ */

let domshotModule = null;
/** 懒加载 vendored 截图库：只在首次标注时才下载，不占页面首屏。 */
async function loadDomshot(endpoint) {
  if (domshotModule !== null) return domshotModule || null;
  try {
    domshotModule = await import(`${endpoint}/client/domshot.mjs`);
  } catch {
    domshotModule = false; // 加载失败记住失败，不为每次标注重复打 404
  }
  return domshotModule || null;
}

/**
 * 全视口截图 + 目标元素高亮框。
 * 只截元素本身看不出它在页面哪里——整页底图上画出红框位置才是
 * 处理者要的上下文。失败（跨域资源污染画布等）静默返回 null，
 * 截图是增强证据不是阻断点。
 */
/**
 * 页面快照缓存：domToCanvas 全页序列化 ~1s 是截图唯一瓶颈。
 * 2s 内连续标注复用同一快照（页面几乎没变），二次标注近 0 延迟；
 * 进入标注模式时预热，多数情况下用户点选时快照已就绪。
 */
const SHOT_CACHE_MS = 5000;
/**
 * 只内联这 ~90 个视觉关键 CSS 属性而非全量 ~350 个计算样式——
 * domToCanvas 的瓶颈是 clone node 阶段逐节点内联样式（实测重页面 ~2.9s），
 * 裁剪后整次序列化 ~0.6s（≈7×），证据图视觉保真度足够。
 */
const SHOT_STYLE_PROPS = ('display,position,inset,top,right,bottom,left,z-index,float,clear,' +
  'width,height,min-width,min-height,max-width,max-height,' +
  'margin,margin-top,margin-right,margin-bottom,margin-left,' +
  'padding,padding-top,padding-right,padding-bottom,padding-left,box-sizing,' +
  'border,border-width,border-style,border-color,border-radius,' +
  'overflow,overflow-x,overflow-y,transform,transform-origin,visibility,opacity,' +
  'color,background,background-color,background-image,background-position,background-size,background-repeat,' +
  'font,font-family,font-size,font-weight,font-style,line-height,text-align,text-decoration,text-transform,' +
  'letter-spacing,white-space,word-break,text-overflow,vertical-align,' +
  'flex,flex-direction,flex-wrap,flex-grow,flex-shrink,flex-basis,' +
  'grid-template-columns,grid-template-rows,grid-column,grid-row,' +
  'gap,row-gap,column-gap,align-items,align-content,align-self,justify-content,justify-items,justify-self,order,' +
  'box-shadow,outline,filter,clip-path,object-fit,object-position,aspect-ratio,' +
  'zoom,scale,rotate,translate,' +
  'cursor,pointer-events,user-select,list-style,content,fill,stroke,stroke-width').split(',');
let _pageSnap = null; // { t, promise, domVer }
// DOM 变更版本：弹窗挂载/表格渲染等任何子树增删都会使旧快照失效，
// 否则 5s 缓存窗口内标注新开的 el-dialog 会截到弹窗底下的旧页面。
let _domVer = 0;
let _domWatchBound = false;
function bindDomWatch() {
  if (_domWatchBound || typeof MutationObserver === 'undefined') return;
  _domWatchBound = true;
  // childList 之外还必须盯 class/style 属性变更：侧栏收展、:class 绑定切换
  // （如 .raised）、el-popup-parent--hidden 滚动锁定等都不增删节点，却改变布局；
  // 否则旧快照在缓存窗口内被复用，红框按新 rect 画到旧版面上必然偏移。
  // shadow DOM 不穿透，标注 UI 自身的 hover/描边变动不会误触发。
  new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'attributes' || r.addedNodes.length || r.removedNodes.length) { _domVer++; break; }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style'],
  });
  // resize/缩放会触发断点切换与重排但不增删 DOM，MutationObserver 捕不到；
  // 图片/字体等资源加载完成撑开布局同理（捕获阶段的资源 load 事件）。
  // 这两类都会让旧快照里的元素位置过期——一并使缓存失效
  window.addEventListener('resize', () => { _domVer++; });
  document.addEventListener('load', () => { _domVer++; }, true);
}
/** 等仍在跑的有限时长 CSS 动画/过渡收敛再序列化：
 *  动画中途克隆会把 transform/位移的中间态冻结进图（如卡片 bottom 0.25s 过渡），
 *  而红框按点击瞬间 rect 画——两者错位。无限循环动画（spinner 等）不等待。
 *  只等主文档动画：本组件 UI 在 shadow DOM 里，不纳入。 */
async function settleAnimations() {
  try {
    if (typeof document.getAnimations !== 'function') return;
    const running = document.getAnimations({ subtree: false }).filter(a => {
      if (a.playState !== 'running') return false;
      const t = a.effect?.getTiming?.();
      return t && t.iterations !== Infinity;
    });
    if (!running.length) return;
    await Promise.race([
      Promise.allSettled(running.map(a => a.finished)),
      new Promise(r => setTimeout(r, 600)),
    ]);
  } catch {}
}

/**
 * foreignObject 内嵌文档继承宿主 devicePixelRatio：非整数 dpr（浏览器缩放
 * 125%/150% 等）下 Chrome 对 flex item 的子像素收缩与活页不一致——恰满的
 * flex 行会被多压出 1~2px，表现为顶栏文字折行、定宽卡片被收窄容器裁短等
 * 「页面被挤压」。禁止 flex 收缩让克隆体按原始尺寸排版宁可溢出也不收缩。
 *
 * 必须注入到【克隆体】而非活页：活页注入会引起真实重排（如 el-input 的
 * inner width:100%+flex:1 被禁收缩后溢出、justify-content:center 把 prefix
 * 图标顶出框外），且坏掉的活页 computed 值会被内联冻结进克隆体——既让
 * 用户看到「标注时样式跳动」，成图也跟着错。克隆侧渲染规则效果相同、活页零扰动。
 */
const SHOT_ANTIDRIFT_CSS = '*{flex-shrink:0 !important}';
/**
 * 目标打标色：页面内容不可能出现的品红。序列化前给活元素挂属性标记，
 * 克隆体侧注入一个贴边内框标记子元素，光栅化后从位图扫回标记环——
 * 元素在成图里的真实绘制位置，红框随之精确贴合（防克隆体布局漂移导致偏移）。
 *
 * 不用 outline/外凸环：目标边缘与 overflow:hidden 祖先裁剪边界重合时
 * （如 .track-top-bar 恰好贴住 .sleek-track-container 顶缘），外凸的环
 * 会整圈落在裁剪区外被裁光，位图 0 像素。内凹标记画在元素自身边界内、
 * 永不超出 → 任何祖先裁剪都伤不到它。
 */
const SHOT_MARK_COLOR = '#FF00FF';
const SHOT_MARK_W = 4; // 标记环厚度（CSS px）
const SHOT_INJECT_CSS = SHOT_ANTIDRIFT_CSS;
// 无法容纳渲染子节点的元素（void/替换/外部文档容器）退化为 inset box-shadow
const SHOT_NO_CHILD_TAGS = new Set(('area,base,br,col,embed,hr,img,input,link,meta,param,' +
  'source,track,wbr,canvas,svg,iframe,video,audio,object,textarea,select').split(','));

/**
 * 克隆体打标：给 [data-zwa-shot-target] 克隆节点追加 position:absolute +
 * inset:0 + border 的标记子元素——脱离文档流、DOM 序最后、z-index 封顶 →
 * 画在元素全部内容之上。环外缘 = 目标 padding-box（位图扫回后外扩元素
 * border 宽度即得 border-box）。
 * 必须 createElementNS(XHTML)：foreignObject 内嵌文档是 XML 语境，
 * createElement('div') 产出的无命名空间节点是未知元素、根本不渲染。
 * 元素克隆本身是 static 时补 position:relative（不动布局）让它成为定位祖先。
 */
function markCloneTarget(svg) {
  try {
    const t = svg.querySelector('[data-zwa-shot-target]');
    if (!t) return;
    if (SHOT_NO_CHILD_TAGS.has(t.tagName.toLowerCase())) {
      t.setAttribute('style', (t.getAttribute('style') || '') +
        `;box-shadow:inset 0 0 0 ${SHOT_MARK_W}px ${SHOT_MARK_COLOR} !important`);
      return;
    }
    const st = t.getAttribute('style') || '';
    if (!/position\s*:\s*(relative|absolute|fixed|sticky)/.test(st))
      t.setAttribute('style', st + ';position:relative !important');
    const m = svg.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    m.setAttribute('style',
      `position:absolute !important;inset:0 !important;` +
      `border:${SHOT_MARK_W}px solid ${SHOT_MARK_COLOR} !important;` +
      `box-sizing:border-box !important;border-radius:0 !important;` +
      `margin:0 !important;padding:0 !important;width:auto !important;height:auto !important;` +
      `background:none !important;pointer-events:none !important;z-index:2147483647 !important;`);
    t.appendChild(m);
  } catch {}
}

/**
 * 把抗漂移规则注入克隆体：domshot 的 svgStyleElement（svg 顶层 <style>，
 * 样式跨 foreignObject 作用于整个内嵌文档）是现成注入点；无样式收集时
 * （极小页）兜底新建 svg 命名空间 style 节点。注意不能走克隆 head——
 * filter 的 checkVisibility 剪枝会把不可见的 head 整棵移除。
 */
function injectShotCss(svg) {
  try {
    const styleEl = svg.querySelector('style');
    if (styleEl) { styleEl.textContent += SHOT_INJECT_CSS; return; }
    const st = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = SHOT_INJECT_CSS;
    svg.insertBefore(st, svg.firstChild);
  } catch {}
}

function serializePage(endpoint, hostId = HOST_ID) {
  return Promise.resolve()
    .then(() => settleAnimations())
    .then(() => loadDomshot(endpoint))
    .then(mod => (mod
      ? mod.domToCanvas(document.documentElement, {
        scale: 0.75,
        // 布局尺寸必须显式给：domToCanvas 默认取 html.getBoundingClientRect()——
        // 页面位于 transform:scale 容器（如 IDE 内嵌预览缩放）时拿到的是缩放后
        // 的视觉宽度，克隆体会按更窄宽度重排（顶栏换行、内容挤压）。
        // clientWidth/scrollHeight 是布局坐标，与元素排版口径一致。
        width: document.documentElement.clientWidth,
        height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
        includeStyleProperties: SHOT_STYLE_PROPS,
        // 标注组件本体不进截图（shadow DOM 本就不序列化，这里兜底外层 host）。
        // display:none/visibility:hidden 子树必然不可见——整棵剪枝（filter 返回 false
        // 的节点连同后代都不被遍历）。重 DOM 页（轨迹回放弹窗 ~20K 节点，大头是隐藏
        // Tab 面板的数千行明细表）实测序列化 28s→~2s，消除「点标注整页卡死」。
        filter: node => {
          if (node && node.id === hostId) return false;
          if (node && node.nodeType === 1 && typeof node.checkVisibility === 'function'
              && !node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
          return true;
        },
        onCreateForeignObjectSvg: svg => { injectShotCss(svg); markCloneTarget(svg); },
      })
      : null))
    .catch(() => null);
}

export function pageSnapshot(endpoint, hostId = HOST_ID) {
  const now = performance.now();
  if (_pageSnap && now - _pageSnap.t < SHOT_CACHE_MS && _pageSnap.domVer === _domVer) return _pageSnap.promise;
  const promise = serializePage(endpoint, hostId);
  _pageSnap = { t: now, promise, domVer: _domVer };
  return promise;
}

/** 在快照位图里扫描打标色像素，返回标记环外缘包围盒（位图坐标），无标记返回 null */
function scanMarkBounds(canvas) {
  try {
    const ctx2 = canvas.getContext('2d');
    if (!ctx2) return null;
    const { width, height } = canvas;
    const data = ctx2.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // #FF00FF 容差匹配（抗锯齿边缘允许分量偏差）
        if (data[i + 3] > 160 && data[i] > 190 && data[i + 1] < 110 && data[i + 2] > 190) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } catch { return null; }
}

/** 空闲期预热快照：rIC 调度到浏览器空闲帧执行，避免点击「标注」瞬间同步阻塞；
 *  超时 3s 兜底保证首次点选前快照已就绪（配合 SHOT_CACHE_MS 复用）。 */
function scheduleSnapshot(endpoint) {
  const ric = window.requestIdleCallback || (fn => window.setTimeout(fn, 0));
  ric(() => { pageSnapshot(endpoint); }, { timeout: 3000 });
}

export async function captureContextShot(endpoint, rect, hostId = HOST_ID, liveEl = null) {
  try {
    if (!rect) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 点选元素：序列化前给活元素挂属性标记并走新鲜快照（标记随元素
    // 而变不进缓存）。克隆体在分数 dpr 下有亚像素布局漂移，红框按 live rect
    // 画必然偏——标记环随元素在克隆体里一起排版，位图扫回即得真实绘制位置。
    // 只设属性、不动活页样式：outline 由克隆体内 SHOT_MARK_CSS 画，活页零闪烁。
    let unmark = null;
    if (liveEl && liveEl.isConnected && typeof liveEl.getBoundingClientRect === 'function') {
      const r = liveEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      liveEl.setAttribute('data-zwa-shot-target', '1');
      unmark = () => { liveEl.removeAttribute('data-zwa-shot-target'); };
    }
    const full = await (unmark ? serializePage(endpoint, hostId) : pageSnapshot(endpoint, hostId));
    if (unmark) unmark();
    if (!full) return null;
    // 采样比按布局坐标算：scrollX/scrollY/innerWidth 是布局坐标系，
    // 而 rect/getBoundingClientRect 是视觉坐标（transform:scale 容器内被缩放）——
    // 但克隆体继承同样的 transform，元素在图里就画在视觉位置，
    // 因此 rect 直接用视觉坐标，只有 scroll/视口切片走布局→图像换算
    const layoutW = document.documentElement.clientWidth || vw;
    const layoutH = Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight) || vh;
    const sx = full.width / layoutW || 1;
    const sy = full.height / layoutH || 1;
    // 红框基准（视口 CSS 坐标）：优先位图扫回的标记环——内凹标记环外缘
    // 即目标 padding-box，外扩元素四边 border 宽度回到 border-box；
    // 扫不到回退 live rect
    let mark = null;
    let bx = rect.x, by = rect.y, bw = rect.width, bh = rect.height;
    let ringX = 0, ringY = 0, ringW = 0, ringH = 0;
    if (unmark) {
      mark = scanMarkBounds(full);
      if (mark) {
        // 位图坐标 → 布局坐标（÷sx）→ 视口坐标（−scrollX）
        ringX = mark.x / sx - window.scrollX;
        ringY = mark.y / sy - window.scrollY;
        ringW = mark.w / sx;
        ringH = mark.h / sy;
        const cs = getComputedStyle(liveEl);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        const bb = parseFloat(cs.borderBottomWidth) || 0;
        bx = ringX - bl; by = ringY - bt;
        bw = ringW + bl + br; bh = ringH + bt + bb;
      }
    }
    const out = document.createElement('canvas');
    out.width = vw;
    out.height = vh;
    const ctx = out.getContext('2d');
    // 当前视口在采样图里的切片（文档坐标×采样比），铺满整个输出画布：
    // 内容与视口严格 1:1，高亮红框按视口坐标描即精确命中；
    // 旧写法按原尺寸画 0.75 图只占 75% 画布，红框会偏右下 1/3。
    const srcX = Math.round(window.scrollX * sx);
    const srcY = Math.round(window.scrollY * sy);
    const srcW = Math.min(Math.round(vw * sx), full.width - srcX);
    const srcH = Math.min(Math.round(vh * sy), full.height - srcY);
    ctx.drawImage(full, srcX, srcY, srcW, srcH, 0, 0, vw, vh);
    const rx = Math.round(bx), ry = Math.round(by), rw = Math.round(bw), rh = Math.round(bh);
    // 遮罩压暗四周、亮区只重绘红框那一小条（不整幅二次绘制）
    ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.fillRect(0, 0, vw, vh);
    ctx.drawImage(
      full,
      srcX + (rx - 4) * sx, srcY + (ry - 4) * sy,
      (rw + 8) * sx, (rh + 8) * sy,
      rx - 4, ry - 4, rw + 8, rh + 8,
    );
    // 红框压在标记环中心：内凹环在元素盒内 [0, MARK_W] 区间，环中心内缩
    // MARK_W/2，线宽 MARK_W+1 完全盖住品红环（成图零残留）；
    // 无标记时沿用旧样式（元素盒外 4px、3px 线宽）
    ctx.strokeStyle = '#FF584D';
    if (mark) {
      ctx.lineWidth = SHOT_MARK_W + 1;
      const i = SHOT_MARK_W / 2;
      ctx.strokeRect(Math.round(ringX) + i, Math.round(ringY) + i,
        Math.round(ringW) - SHOT_MARK_W, Math.round(ringH) - SHOT_MARK_W);
    } else {
      ctx.lineWidth = 3;
      ctx.strokeRect(rx - 4, ry - 4, rw + 8, rh + 8);
    }
    // 双图策略（读图才耗 token）：
    //   ctx  = 目标 + 周边 ~480px 语境的裁剪图，挂 images[] 做默认证据
    //          （~300 token/次，全视口 ~1300 的零头）；
    //   full = 全视口，走 meta.fullShot 独立通道落盘备查——不占 images，
    //          处理者需要页面全局语境时按路径取，不读零成本。
    const PAD = 240;
    const cx = Math.max(0, rx - PAD), cy = Math.max(0, ry - PAD);
    const cw = Math.min(vw - cx, rw + PAD * 2), ch = Math.min(vh - cy, rh + PAD * 2);
    const crop = document.createElement('canvas');
    crop.width = cw;
    crop.height = ch;
    crop.getContext('2d').drawImage(out, cx, cy, cw, ch, 0, 0, cw, ch);
    // 环境诊断随任务落盘：页面处于 transform:scale/zoom 容器（如 IDE 内嵌预览）
    // 时坐标系分裂，截图偏移类问题凭这几项指标可直接定位是哪种缩放机制
    let diag = null;
    try {
      const de = document.documentElement;
      const hr = de.getBoundingClientRect();
      const dcs = getComputedStyle(de), bcs = getComputedStyle(document.body);
      diag = {
        iw: window.innerWidth, ih: window.innerHeight,
        clientW: de.clientWidth, clientH: de.clientHeight,
        scrollW: de.scrollWidth, scrollH: de.scrollHeight,
        htmlRectW: +hr.width.toFixed(2), htmlRectH: +hr.height.toFixed(2),
        dpr: window.devicePixelRatio,
        vsScale: window.visualViewport ? +window.visualViewport.scale.toFixed(3) : 1,
        htmlZoom: dcs.zoom, htmlTransform: String(dcs.transform).slice(0, 60),
        bodyZoom: bcs.zoom, bodyTransform: String(bcs.transform).slice(0, 60),
        fullW: full.width, fullH: full.height,
        markHit: !!mark,   // 位图是否扫回目标标记环（false=回退 live rect）
      };
    } catch {}
    return { ctx: crop.toDataURL('image/png'), full: out.toDataURL('image/png'), diag };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

export function mountAnnotator(options = {}) {
  const config = {
    endpoint: options.endpoint || detectEndpoint(),
    autoSync: options.autoSync !== false,
    collapsed: options.collapsed !== false,
    ...options,
  };

  // 已挂载且 API 可用时直接复用；若宿主存在但 API 缺失（上次挂载中途失败），
  // 先清掉残留宿主再重新挂载，避免留下看得见却无法使用的面板。
  const existingHost = document.getElementById(HOST_ID);
  if (existingHost) {
    if (window.__zwAnnotator) return window.__zwAnnotator;
    existingHost.remove();
  }

  // 旧键名一次性迁移（0.11.x 及更早的前缀是 zcode-web-annotations:*）：
  // 折叠/分组偏好与未同步草稿搬到新前缀；服务端任务组始终是权威来源，
  // 这里只增不减，搬完即删旧键。
  try {
    const legacyPrefix = 'zcode-web-annotations:';
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(legacyPrefix)) continue;
      const nextKey = `zw-web-annotations:${key.slice(legacyPrefix.length)}`;
      if (localStorage.getItem(nextKey) == null) localStorage.setItem(nextKey, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch {
    /* 存储被禁用时忽略 */
  }

  // 归组、任务 id 与缓冲键统一用去 hash 的规范地址：页内锚点变化
  // 不改变"这是哪个页面"，pathname/query 只会随真正的页面切换变化。
  const pageUrl = canonicalPageUrl(location.href);
  const storageKey = `${SOURCE}:${pageUrl}`;
  const collapseKey = `${SOURCE}:collapsed`;
  // 页面分组的展开/折叠状态必须跨页面持久：项目里同一份标注数据会被
  // 多个页面轮流查看，「当前页」随导航变化，而这个偏好属于整个项目。
  const groupOpenKey = `${SOURCE}:open-groups`;
  // 注意：此 const 必须在 state 初始化（loadDockLayout() 调用）之前声明，
  // 放后面会触发 TDZ ReferenceError 被 try/catch 静默吞掉 → 布局永远恢复不出来
  const DOCK_LAYOUT_KEY = 'zwa-dock-layout';
  // 同上 TDZ 约束：state 初始化即调 loadPanelLayout()，键名必须先声明
  const PANEL_LAYOUT_KEY = 'zwa-panel-layout';
  const state = {
    /** @type {Array<any>} 按添加时间排序，元素顺序即编号顺序 */
    tasks: [],
    /**
     * 其它页面的任务组：/tasks 返回的全部组中除当前页外的部分。
     * 同一个项目里会跨页面标注，列表按页面分组展示，数据不被清空；
     * 这些组的任务仍以各自页面归组同步，绝不混入当前页的 payload。
     * @type {Array<{id: string, page: {url: string, title: string}, tasks: Array<any>, absolutePath?: string}>}
     */
    groups: [],
    /** 用户显式切换过的分组展开状态；未设置时默认当前页展开、其它页折叠 */
    groupOpenState: {},
    /** 当前页所属任务组 id（归档抽屉 PATCH 要用 groupId） */
    currentGroupId: null,
    /** 手风琴互斥：两区始终只有一个展开。默认任务区展开（主功能），
        归档区收起态头部仍实时显示计数；点开归档区自动收起任务区。 */
    archiveDrawerOpen: false,
    /** 待执行任务区展开态 */
    tasksRegionOpen: true,
    /** 归档视图内页面组的展开态（默认仅当前页展开，其余折叠） */
    archOpenState: {},
    active: false,
    hovered: null,
    collapsed: config.collapsed,
    /** 面板自定义布局：null=跟随胶囊锚定；{x,y}=自由悬浮；{side,y,pinned}=左右吸边 */
    panelLayout: loadPanelLayout(),
    /** 悬浮模式（吸边未固定）下当前已收成边耳——随布局持久化，跳页/刷新保持 */
    panelRetracted: !!(loadPanelLayout() && loadPanelLayout().retracted),
    /** 当前就地编辑的任务 id；null 表示无弹窗 */
    editingId: null,
    /** 是否为尚未确认的新建任务 */
    editingIsNew: false,
    /** 新建标注待确认的元素上下文 */
    pendingElement: null,
    /** 点选瞬间发起、确认时可能仍在途的全视口截图（Promise<dataUrl|null>） */
    pendingShot: null,
    /** 是否正在编辑一个手动添加的任务（无关联元素） */
    manualMode: false,
    /** 当前编辑任务的待提交图片（确认时才写入任务） */
    pendingImages: [],
    /** 待定拖拽：mousedown 即记录起点，位移超阈值升格为框选（点按不移动=点选） */
    marquee: null,
    /** 框选松手后吞掉紧随的 click（避免同一动作又触发一次元素点选） */
    suppressClick: false,
    /** 胶囊拖拽松手后吞掉紧随的 click（避免拖动又触发按钮动作） */
    suppressUiClick: false,
    /** 胶囊最后一次实测矩形（面板展开、胶囊隐藏时锚定面板用） */
    lastDockRect: null,
    /** 胶囊布局：{x,y,side:'left'|'right'|null,pinned}，localStorage 持久化 */
    dockLayout: loadDockLayout(),
    /** Shift+点击累积的多选元素上下文（合并进下一任务的 meta.extraElements） */
    multiPick: [],
    /** 与 multiPick 对齐的真实元素引用（DOM 引用不能塞进要持久化的 descriptor） */
    multiPickEls: [],
    /** 本次拾取的真实元素引用（主元素+附带元素），编辑器高亮标记用——
        不经 selector 重新解析，防止解析回退到大容器把标记画成整卡 */
    pendingMarkEls: [],
    /** taskId → 真实元素引用（内存态）：重开编辑器时标记画当时选中的元素原样；
        DOM 引用不能挂任务对象上——会随 JSON.stringify 污染 localStorage/服务端载荷 */
    taskEls: new Map(),
    /** 待合并进新任务 meta 的附加上下文（region/extraElements） */
    pendingMeta: null,
    /** 动画/视频冻结状态（捕捉动画瞬态标注） */
    frozen: false,
    _frozenVideos: [],
    _freezeStyle: null,
    /** 详情区当前展示的元素信息 */
    detailsElement: null,
    syncState: 'idle',
    syncMessage: '',
    /** 连续录入时的合并同步定时器 */
    syncTimer: null,
    /** 当前 flush 请求；saving 期间的新变更会进入 outbox，随后继续 flush */
    syncPromise: null,
    /** 同步请求 AbortController，销毁时取消 */
    syncAbort: null,
    /** 已确认但尚未得到服务端确认的操作队列（localStorage 持久化） */
    outbox: [],
    nextOutboxSeq: 1,
    /** 本页面是否至少成功读取过一次服务端；未读取前空任务不能触发 all 删除 */
    hasLoadedRemote: false,
    /** 已确认但未成功同步的标记（由 outbox 派生） */
    dirty: false,
    /** 最近一次从工作区 JSON 读取到的任务版本，用来检测服务端状态变化。 */
    remoteRevision: '',
    /** 定时从工作区刷新任务的句柄；只在有任务且面板挂载期间保持。 */
    refreshTimer: null,
    refreshPending: false,
    /** SSE 长连接（/events），实时接收任务变更通知。 */
    eventSource: null,
    /** 收起状态下提示的自动隐藏句柄 */
    toastTimer: null,
    /**
     * 用户主动操作的「回执」（如点复制）。与后台同步消息是两条通道：
     * 点复制时会先写文件，写入又触发 SSE 刷新并产生「已同步到 …」，
     * 若共用一条通道，刚弹出的「提示词已复制」会被这条后台噪声顶掉。
     * 因此回执在有效期内优先显示，过期后回落到后台消息。
     */
    receipt: null,
    receiptTimer: null,
    /**
     * 项目执行模式（round/queue）与落盘位置，来自 /tasks 响应。
     * null 表示服务端尚未告知：按默认 round 处理，等首次刷新覆盖。
     */
    execution: null,
    /**
     * 服务端权威轮次摘要（/tasks 的 round 字段）：activeRound、complete、queued、
     * counts、runner 都来自这里。客户端不再自行推断当前轮——本地推断在旧轮
     * 未归档时会把旧轮当成当前轮，导致分母漂移。null = 旧版运行时，回落本地推断。
     */
    serverRound: null,
    executionPath: '',
    /** 执行要求文件（execution-protocol.md）的绝对路径；null = 服务端未告知或文件缺失 */
    protocolPath: null,
    /** 任务目录绝对路径，提示词只引用目录而不是文件快照 */
    tasksPath: null,
    /** endpoint.json 的真实绝对路径；缺失时复制提示词必须 fail-closed */
    endpointManifestPath: null,
  };

  try {
    const cached = JSON.parse(localStorage.getItem(storageKey) || '[]');
    // 兼容旧版「纯任务数组」缓存，同时升级为持久 outbox；旧缓存视为一条
    // append 待同步操作，不能因为服务端首次返回空组而被覆盖。
    if (Array.isArray(cached)) {
      state.tasks = cached.filter(t => t && t.id);
      if (state.tasks.length) state.outbox = [{ seq: 1, op: 'append', queuedAt: new Date().toISOString() }];
    } else if (cached && typeof cached === 'object') {
      state.tasks = Array.isArray(cached.tasks) ? cached.tasks.filter(t => t && t.id) : [];
      state.outbox = Array.isArray(cached.outbox) ? cached.outbox : [];
      state.nextOutboxSeq = Math.max(0, ...state.outbox.map(op => Number(op.seq) || 0)) + 1;
    }
    state.dirty = state.outbox.length > 0;
  } catch {
    state.tasks = [];
    state.outbox = [];
  }
  try {
    const cachedCollapsed = localStorage.getItem(collapseKey);
    if (cachedCollapsed != null) state.collapsed = cachedCollapsed === 'true';
  } catch {
    /* 忽略 */
  }
  try {
    const cachedOpen = JSON.parse(localStorage.getItem(groupOpenKey) || '{}');
    if (cachedOpen && typeof cachedOpen === 'object' && !Array.isArray(cachedOpen)) {
      state.groupOpenState = cachedOpen;
    }
  } catch {
    /* 忽略 */
  }

  /* ---------------- DOM 骨架（Shadow DOM 隔离样式） ---------------- */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-zw-annotations-ui', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  shadow.append(style);

  // 元素高亮框
  const outline = document.createElement('div');
  outline.className = 'outline';

  // 悬停尺寸标签：跟随鼠标显示元素宽高
  const sizeBadge = document.createElement('div');
  sizeBadge.className = 'size-badge hidden';

  // 就地编辑器：胶囊形输入框，左侧滑块图标展开详情，右侧圆形箭头确认
  const editor = document.createElement('div');
  editor.className = 'editor hidden';
  editor.innerHTML = `
    <div class="editor-pill">
      <button type="button" class="pill-icon" data-act="toggle-details" data-el="detailToggle" title="元素详情">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <line x1="4" y1="9" x2="20" y2="9"></line>
          <line x1="4" y1="15" x2="20" y2="15"></line>
          <circle cx="9.5" cy="9" r="2.3" fill="currentColor" stroke="none"></circle>
          <circle cx="14.5" cy="15" r="2.3" fill="currentColor" stroke="none"></circle>
        </svg>
      </button>
      <textarea data-el="editorInput" rows="1" placeholder="添加注释…"></textarea>
      <button type="button" class="pill-submit" data-act="editor-confirm" data-el="submitBtn" title="确认 (Enter)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="19" x2="12" y2="6"></line>
          <polyline points="6 12 12 6 18 12"></polyline>
        </svg>
      </button>
    </div>
    <div class="editor-caption">
      <span class="editor-seq" data-el="editorSeq"></span>
      <span class="editor-target" data-el="editorTarget"></span>
      <span class="editor-hint" data-el="editorHint"></span>
    </div>
    <div class="editor-details hidden" data-el="editorDetails"></div>
    <div class="editor-images hidden" data-el="editorImages"></div>
  `;

  // 框选取样框与多选标记层（Shift+点击累积的元素高亮）
  const marqueeEl = document.createElement('div');
  marqueeEl.className = 'marquee hidden';
  const marqueeLabel = document.createElement('div');
  marqueeLabel.className = 'marquee-label';
  marqueeEl.append(marqueeLabel);
  const pickmarks = document.createElement('div');
  pickmarks.className = 'pickmarks';
  // 框选拖拽预览层：实时描边「将命中的最高层包容元素」供用户确认选区；
  // 松手即隐藏——纯预览，不进上下文截图
  const regionMarks = document.createElement('div');
  regionMarks.className = 'regionmarks hidden';

  // 图片预览灯箱：列表/编辑器/归档抽屉里的缩略图点击后整屏查看。
  // 多图任务支持左右切换（箭头按钮 + ←/→ 键），底部显示「当前/总数」。
  const viewer = document.createElement('div');
  viewer.className = 'viewer hidden';
  viewer.innerHTML = `
    <button type="button" class="viewer-nav prev" data-vnav="-1" title="上一张 (←)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"/></svg>
    </button>
    <img alt="预览">
    <button type="button" class="viewer-nav next" data-vnav="1" title="下一张 (→)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>
    </button>
    <div class="viewer-caption"></div>
    <span class="viewer-count"></span>`;
  let viewerList = [];
  let viewerIdx = 0;
  let viewerCaption = '';
  let viewerZoom = 1;
  /** 滚轮缩放：以光标为变换原点，1x~6x；换图/关闭复位。 */
  const viewerImg = () => viewer.querySelector('img');
  viewer.addEventListener('wheel', event => {
    event.preventDefault();
    const img = viewerImg();
    if (!img || !viewerList.length) return;
    const rect = img.getBoundingClientRect();
    // 光标相对图中心的偏移比例 → 缩放的 transform-origin，缩放时画面不跑偏
    const ox = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) * 100;
    const oy = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1) * 100;
    viewerZoom = Math.min(Math.max(viewerZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 1), 6);
    img.style.transformOrigin = `${ox}% ${oy}%`;
    img.style.transform = `scale(${viewerZoom})`;
    img.style.cursor = viewerZoom > 1 ? 'grab' : 'zoom-in';
  }, { passive: false });
  const renderViewer = () => {
    if (!viewerList.length) return;
    const img = viewerImg();
    viewerZoom = 1;
    img.style.transform = '';
    img.style.transformOrigin = '';
    img.src = viewerList[viewerIdx];
    viewer.querySelector('.viewer-caption').textContent = viewerCaption;
    const multi = viewerList.length > 1;
    viewer.querySelector('.viewer-count').textContent = multi ? `${viewerIdx + 1}/${viewerList.length}` : '';
    viewer.querySelectorAll('.viewer-nav').forEach(b => { b.style.display = multi ? '' : 'none'; });
  };
  const stepViewer = dir => {
    if (viewerList.length < 2) return;
    viewerIdx = (viewerIdx + dir + viewerList.length) % viewerList.length;
    renderViewer();
  };
  viewer.addEventListener('click', event => {
    const nav = event.target.closest && event.target.closest('.viewer-nav');
    if (nav) {
      event.stopPropagation();
      stepViewer(Number(nav.getAttribute('data-vnav')) || 0);
      return;
    }
    viewer.classList.add('hidden');
  });
  const showViewer = (srcs, index = 0, caption = '') => {
    const list = Array.isArray(srcs) ? srcs.filter(Boolean) : [srcs].filter(Boolean);
    if (!list.length) return;
    viewerList = list;
    viewerIdx = Math.min(Math.max(index, 0), list.length - 1);
    viewerCaption = caption;
    renderViewer();
    viewer.classList.remove('hidden');
  };

  // 图钉层
  const pins = document.createElement('div');
  pins.className = 'pins';

  // 编辑弹窗的聚焦层：veil 把整页轻轻压暗（手动任务用它），
  // spotlight 在目标元素处「挖孔」——元素保持全亮，四周发圈、其余压暗。
  const veil = document.createElement('div');
  veil.className = 'veil';
  const spotlight = document.createElement('div');
  spotlight.className = 'spotlight';

  // 侧栏：悬浮收缩胶囊 / 展开面板
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML = `
    <div class="dock" data-el="dock">
      <span class="dock-edge-tab" data-el="edgeTab" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 6 9 12 15 18"></polyline>
        </svg>
      </span>
      <button type="button" class="dock-btn" data-act="toggle" data-el="dockToggle" title="开启/关闭标注模式 (Esc)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20h4L20 8a2.8 2.8 0 1 0-4-4L4 16v4z"></path>
        </svg>
        <span data-el="dockToggleText">标注</span>
      </button>
      <span class="dock-sep"></span>
      <button type="button" class="dock-count" data-act="expand" title="展开标注列表">
        <span class="dock-dot" data-el="dockDot"></span>
        <span data-el="capsuleCount">0</span>
      </button>
      <span class="dock-sep"></span>
      <button type="button" class="dock-btn icon" data-act="expand" title="展开标注列表">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <line x1="4" y1="7" x2="20" y2="7"></line>
          <line x1="4" y1="12" x2="20" y2="12"></line>
          <line x1="4" y1="17" x2="20" y2="17"></line>
        </svg>
      </button>
      <!-- 悬浮快捷操作：手动添加与复制提示词原先必须展开面板才能点到，
           这里做成悬停浮出，收起状态下也能一步完成。面板里的同名按钮保留，
           键盘用户与需要看清文字的场景仍走面板。 -->
      <div class="dock-float" data-el="dockFloat">
        <div class="dock-float-row">
          <button type="button" class="dock-float-btn" data-act="manual" title="手动添加任务">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>手动</span>
          </button>
          <button type="button" class="dock-float-btn" data-act="copy" title="复制提示词">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2.5"></rect>
              <path d="M6.5 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5v1"></path>
            </svg>
            <span>复制</span>
          </button>
        </div>
      </div>
      <!-- 收起态的进度条：展开面板时刻意不显示（面板顶部已有完整的一根，
           两处同时出现是重复信息）。全部任务验收完成后自动消失。 -->
      <div class="dock-progress" data-el="dockProgress">
        <div class="dock-progress-fill" data-el="dockProgressFill"></div>
      </div>
    </div>
    <section class="panel hidden" data-el="panel">
      <header data-el="panelHead" title="拖拽移动面板；拖到屏幕左右边缘松手即吸边（双击复位跟随胶囊）">
        <div class="panel-title">
          <div class="panel-title-row">
            <strong>标注列表</strong>
            <button type="button" class="panel-board" data-act="board" title="在新标签打开任务看板（按状态总览全部任务）">看板</button>
          </div>

        </div>
        <button type="button" class="panel-theme" data-el="themeBtn" data-act="theme" title="切换明亮/暗色主题">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        </button>
        <button type="button" class="panel-pin" data-el="panelPinBtn" data-act="panel-pin" title="固定模式：吸边后保持展开；关为悬浮模式（指针移开收成边耳，悬停滑出）">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3v4l3 3v2h-6v7l-1 1-1-1v-7H5v-2l3-3V3z"/></svg>
        </button>
        <button type="button" class="panel-collapse" data-el="panelEarBtn" data-act="panel-ear" title="收成边耳（贴右缘细条，悬停滑出悬浮列表）">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 6 15 12 9 18"></polyline>
          </svg>
        </button>
        <button type="button" class="panel-collapse" data-act="collapse" title="收起为悬浮药丸">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </header>
      <div class="panel-tools">
        <button type="button" data-act="toggle" data-el="toggleBtn" title="进入/退出标注模式">标注</button>
        <button type="button" data-act="manual" title="手动添加任务">手动</button>
        <button type="button" data-act="freeze" title="冻结页面动画与视频（捕捉动画/闪烁瞬态），再点恢复">冻结</button>
        <button type="button" class="primary" data-act="copy" title="复制处理提示词">复制提示词</button>
      </div>
      <!-- 总体进度：分派 10% + 开发 70% + 验收 20%，跨越所有页面统计。
           放在操作区下方、列表上方——用户点开面板第一眼就想知道"改到哪了"。
           左侧是执行模式切换：决定进度分母（本轮/全部）与轮次边界行为。 -->
      <div class="panel-progress" data-el="progress">
        <div class="progress-head">
          <div class="mode-switch" data-el="modeSwitch" role="group" aria-label="执行模式">
            <button type="button" data-act="mode" data-mode="round" title="按轮次：本轮复核完毕即收尾，等显式归档（本轮处理期间不可切换）">轮次</button>
            <button type="button" data-act="mode" data-mode="queue" title="按队列：本轮复核归档后自动继续下一轮（本轮处理期间不可切换）">队列</button>
          </div>
          <span class="progress-label" data-el="progressLabel"></span>
          <button type="button" class="accept-btn hidden" data-act="accept-round" data-el="acceptBtn" title="把本轮待验收的改动一次确认通过（已完成的不受影响）">验收本轮</button>
          <button type="button" class="archive-btn hidden" data-act="archive-round" data-el="archiveBtn" title="把本轮已完成的任务移入归档（交付）">归档本轮</button>
          <span class="progress-pct" data-el="progressPct"></span>
          <button type="button" class="ghost-danger progress-clear" data-act="clear" title="清空全部标注">清空</button>
        </div>
        <div class="progress-track" title="">
          <div class="progress-fill" data-el="progressFill"></div>
        </div>
        <!-- 次要状态单独占一行：排队数与「为什么停住」的提示合起来经常超过
             首行剩余宽度，挤在首行会被省略号吃掉——而那恰恰是用户最需要
             看到的信息（进度停在某个百分比时的原因）。 -->
        <div class="progress-note" data-el="progressNote"></div>
      </div>
      <!-- 双折叠区布局：上「待执行任务」下「待归档检验」，各占一半可独立折叠 -->
      <div class="region region-tasks open" data-el="tasksRegion">
        <div class="arch-drawer-head region-head">
          <button type="button" class="arch-region-toggle open" data-act="tasks-region-toggle" data-el="tasksRegionToggle" title="展开/收起待执行任务区">
            <svg class="arch-region-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            <strong>待执行任务</strong><span class="region-count" data-el="tasksRegionCount"></span>
          </button>
        </div>
        <div class="panel-list region-body" data-el="list"></div>
      </div>
      <!-- 检验归档区：常驻第二块折叠区（无任务时为空态），
           按页面分组列出全部已完成待归档任务，支持单任务/按页/全部三级归档。
           数据随任务刷新实时推送，不是点开才加载。 -->
      <div class="region panel-arch open" data-el="archInline">
        <div class="arch-drawer-head region-head" data-el="archDrawerHead">
          <button type="button" class="arch-region-toggle" data-act="archive-view-toggle" data-el="archRegionToggle" title="展开/收起待归档检验区">
            <svg class="arch-region-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            <strong>待归档检验</strong><span class="region-count" data-el="archDrawerCount"></span>
          </button>
          <button type="button" class="arch-all" data-act="archive-all-done" title="把全部已完成任务一次性归档">全部归档</button>
        </div>
        <div class="arch-drawer-body region-body" data-el="archDrawerBody"></div>
        <div class="arch-pop hidden" data-el="archPop">
          <p data-el="archPopText"></p>
          <div class="arch-pop-actions">
            <button type="button" data-el="archPopCancel">取消</button>
            <button type="button" class="primary" data-el="archPopOk">确认归档</button>
          </div>
        </div>
      </div>
      <footer><span class="panel-msg" data-el="msg"></span><span class="panel-version" data-el="panelVersion" title="标注组件运行时版本"></span></footer>
    </section>
    <!-- 悬耳态：面板收成屏幕边缘细条，悬停滑出悬浮面板预览，
         点击固定展开。数字=全站未归档任务数；竖条=本轮进度。 -->
    <button type="button" class="panel-edge-tab hidden" data-el="panelEdgeTab" data-act="panel-tab-expand" title="展开标注面板（悬停=预览悬浮列表，点击=固定展开）">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
      <span class="pet-count" data-el="panelEdgeCount"></span>
      <span class="pet-progress" data-el="petProgress" title="">
        <span class="pet-progress-fill" data-el="petProgressFill"></span>
      </span>
    </button>
  `;

  // 收起状态下面板底栏不可见，操作反馈（复制成功/失败等）改由这个浮条兜底，
  // 否则点了「复制」没有任何可见回执。展开面板时不显示，避免两处重复。
  const toast = document.createElement('div');
  toast.className = 'toast hidden';
  toast.setAttribute('data-el', 'toast');

  // 编辑器打开期间的「事件拦截层」。
  //
  // 为什么必须是真实元素而不是靠 JS preventDefault：hover 由浏览器的命中测试
  // 决定，它发生在脚本之前，preventDefault 对它完全无效。所以只要指针还在
  // 页面元素上，:hover 样式、CSS 动画、title 提示照旧触发——遮罩看起来盖住了
  // 页面，鼠标划过却仍会高亮。只有让一个真实层挡住命中测试才能根治。
  //
  // 它透明、不显示任何视觉（压暗仍交给 veil/spotlight），只负责吃掉指针事件；
  // z-index 高于页面但低于组件自己的 UI，因此面板/编辑器/图钉照常可交互。
  const clickShield = document.createElement('div');
  clickShield.className = 'click-shield hidden';
  clickShield.setAttribute('data-el', 'clickShield');

  // 二次确认对话框
  const confirmBox = document.createElement('div');
  confirmBox.className = 'confirm-layer hidden';
  confirmBox.setAttribute('data-el', 'confirm');
  confirmBox.innerHTML = `
    <div class="confirm-card">
      <h3 data-el="confirmTitle"></h3>
      <p data-el="confirmDetail"></p>
      <div class="confirm-actions">
        <button type="button" data-act="confirm-cancel">取消</button>
        <button type="button" data-act="confirm-ok">确认删除</button>
      </div>
    </div>
  `;

  // 手动复制兜底层：宿主禁用剪贴板写入时弹出，文本可直接选中。
  // 挂在 shadow DOM 内既保持样式隔离，也避免污染页面。
  const manualCopy = document.createElement('div');
  manualCopy.className = 'manual-copy-layer hidden';
  manualCopy.setAttribute('data-el', 'manualCopy');
  manualCopy.innerHTML = `
    <div class="manual-copy-card">
      <h3>当前浏览器不允许自动写入剪贴板</h3>
      <p>请点击下方文本框全选后，用 ${'⌘C / Ctrl+C'} 手动复制。</p>
      <textarea data-el="manualCopyText" readonly rows="6"></textarea>
      <div class="manual-copy-actions">
        <button type="button" data-act="manual-copy-close">关闭</button>
      </div>
    </div>
  `;

  shadow.append(outline, sizeBadge, veil, spotlight, marqueeEl, pickmarks, regionMarks, pins, clickShield, editor, confirmBox, manualCopy, bar, toast, viewer);

  const $ = sel => shadow.querySelector(sel);
  const $$ = sel => Array.from(shadow.querySelectorAll(sel));

  /* ---------------- 持久化 ---------------- */

  function persistLocal() {
    const payload = { tasks: state.tasks, outbox: state.outbox };
    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      // dataUrl 图片只是可重建缓存，配额不足时先剥离它们，保住文字任务。
      const reduced = state.tasks.map(task => ({
        ...task,
        images: Array.isArray(task.images) ? task.images.map(({ dataUrl, ...image }) => image) : task.images,
        // meta.fullShot 同款剥离：磁盘副本不带二进制，内存原样保留待同步
        meta: task.meta?.fullShot?.dataUrl ? { ...task.meta, fullShot: { file: task.meta.fullShot.file } } : task.meta,
      }));
      try {
        localStorage.setItem(storageKey, JSON.stringify({ tasks: reduced, outbox: state.outbox }));
        // 剥离只作用于 localStorage 磁盘副本，绝不能回写 state.tasks——
        // 内存里的 dataUrl 一旦丢掉，后续同步推给服务端的就是
        // 既无 dataUrl 也无 file 的空壳，ctx 截图永久丢失（已踩过）。
        // 服务端存图成功后会以 file 路径回写，重启后从远端恢复。
        state.syncMessage = '本地空间不足，标注保留在内存中，同步后自动恢复。';
      } catch {
        // 内存仍保留任务；outbox 不清空，后续服务恢复/用户重试时仍可同步。
        state.syncMessage = '本地空间不足，标注保留在当前页面，请尽快同步。';
      }
    }
    state.dirty = state.outbox.length > 0;
  }

  function queueOutbox(op = 'append', details = {}) {
    state.outbox.push({
      seq: state.nextOutboxSeq++,
      op,
      ...details,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    });
    // 防止极端连续输入把 localStorage 无界撑大：操作是可合并的，保留最近 64 个
    // marker 足以区分当前请求与在途期间的新编辑；任务快照仍在 state.tasks。
    if (state.outbox.length > 64) state.outbox.splice(0, state.outbox.length - 64);
    persistLocal();
  }

  function ackOutbox(maxSeq) {
    state.outbox = state.outbox.filter(op => Number(op.seq) > maxSeq);
    state.dirty = state.outbox.length > 0;
    persistLocal();
  }

  function persistCollapsed() {
    try {
      localStorage.setItem(collapseKey, String(state.collapsed));
    } catch {
      /* 忽略 */
    }
  }

  function pagePayload() {
    return {
      page: { url: pageUrl, title: document.title },
      tasks: state.tasks,
      meta: Object.fromEntries(Object.entries(config.meta || {}).filter(([, v]) => v != null)),
      savedAt: new Date().toISOString(),
    };
  }

  /** 拉取工作区全部页面任务组（服务端是唯一权威来源）。 */
  async function fetchRemoteGroups() {
    return (await fetchTasksData()).groups;
  }

  /** 任务组 + 执行模式一次取回：模式与分母必须同源，避免两处请求读到不同时刻的状态。 */
  async function fetchTasksData() {
    // 8s 超时：挂起的请求会把 refreshPending 永久卡死（后续刷新全被跳过），
    // 超时抛错走 catch 释放锁，下轮轮询自愈。
    const response = await fetch(`${config.endpoint}/tasks`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return {
      groups: Array.isArray(data.groups) ? data.groups : [],
      // 旧版运行时的 /tasks 没有 execution 字段：保持 null，按默认 round 走
      execution: data.execution && typeof data.execution === 'object' ? data.execution : null,
      // 服务端轮次摘要（activeRound/complete/queued/runner）；旧版运行时没有则为 null，
      // 此时客户端回落到本地推断，行为与升级前一致。
      round: data.round && typeof data.round === 'object' ? data.round : null,
      executionPath: typeof data.executionPath === 'string' ? data.executionPath : '',
      tasksPath: typeof data.tasksPath === 'string' && data.tasksPath ? data.tasksPath : null,
      protocolPath: typeof data.protocolPath === 'string' && data.protocolPath ? data.protocolPath : null,
      endpointManifestPath: typeof data.endpointManifestPath === 'string' && data.endpointManifestPath
        ? data.endpointManifestPath
        : null,
    };
  }

  /**
   * 用服务端数据重排本地视图：当前页任务进 state.tasks（localStorage 只兜
   * 未同步成功的草稿），其余页面进 state.groups 供分组列表展示。
   */
  function applyRemoteGroups(groups) {
    const group = groups.find(g => g?.page?.url === pageUrl) || null;
    const remoteTasks = (Array.isArray(group?.tasks) ? group.tasks : []).filter(t => t && t.id);
    // 未确认的本地 outbox 是用户输入的优先事实：服务端只覆盖模型字段，
    // 不得用旧快照抹掉本地 instruction/element/images。
    if (state.outbox.length) {
      state.tasks = mergeRemoteTasks(remoteTasks, state.tasks, state.outbox);
    } else {
      state.tasks = remoteTasks;
    }
    state.remoteRevision = group?.updatedAt || '';
    state.currentGroupId = group?.id || null;
    state.groups = groups.filter(g => g && g.page?.url !== pageUrl);
    state.hasLoadedRemote = true;
    persistLocal();
    renderPins();
    renderList();
    renderVerifyArchive();
    return group;
  }

  /**
   * 从工作区读取任务，作为列表与图钉的权威来源。
   *
   * localStorage 只负责保存「尚未同步成功的草稿」；一旦服务端已经归档/删除/修改
   * 任务，页面刷新不能继续把旧缓存当成事实展示。刷新时以服务端为准，服务端不可用
   * 才保留本地草稿，避免网络短暂中断造成页面上的内容突然消失。
   */
  async function loadRemoteTasks({ quiet = false } = {}) {
    if (!config.autoSync) return null;
    if (state.refreshPending) {
      // 在途拉取可能取到「本次 PATCH 之前」的旧快照：排队补一轮，
      // 否则归档/打回后 UI 停留旧状态直到下个 10s 轮询。
      state.refreshQueued = true;
      return null;
    }
    state.refreshPending = true;
    try {
      const data = await fetchTasksData();
      // 模式与轮次摘要要在任务渲染前就位：进度分母由它们决定，反过来会闪一下旧分母
      if (data.execution) {
        state.execution = data.execution;
        state.executionPath = data.executionPath;
      }
      state.serverRound = data.round;
      state.endpointManifestPath = data.endpointManifestPath;
      const group = applyRemoteGroups(data.groups);
      if (!quiet) {
        const otherCount = state.groups.reduce((sum, g) => sum + ((g.tasks || []).length), 0);
        state.syncState = 'saved';
        state.syncMessage = group
          ? (otherCount ? `已从工作区刷新任务；其它页面还有 ${otherCount} 项。` : '已从工作区刷新任务。')
          : (otherCount ? `当前页面暂无任务；其它页面共 ${otherCount} 项。` : '工作区中暂无当前页面的待处理任务。');
        renderMessage();
      }
      return group;
    } catch (error) {
      // 网络断开时不覆盖本地草稿；自动刷新保持静默，避免每 8 秒打扰用户。
      if (!quiet) {
        state.syncState = 'error';
        state.syncMessage = `工作区刷新失败，本地数据仍保留：${error.message}`;
        renderMessage();
      }
      return null;
    } finally {
      state.refreshPending = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        loadRemoteTasks({ quiet: true });
      }
    }
  }

  function startRemoteRefresh() {
    if (!config.autoSync || state.refreshTimer) return;
    // 10 秒兜底轮询：正常情况下任务变化由 SSE 实时推送（events 长连接），
    // 轮询只兜住推送缺席的场景（如 SSE 被代理拦截、事件竞态遗漏）。
    state.refreshTimer = setInterval(() => loadRemoteTasks({ quiet: true }), 10000);
  }

  function stopRemoteRefresh() {
    if (!state.refreshTimer) return;
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  /**
   * SSE 实时推送：模型回写状态/归档时，服务端经 /events 广播 tasks-changed，
   * 页面立即拉取最新任务，列表与图钉几乎零延迟。EventSource 断线由浏览器
   * 自动重连；连接常开即可，开销只有一条空闲 socket + 25s 一次的心跳注释。
   */
  function startEventStream() {
    if (!config.autoSync || state.eventSource || typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource(`${config.endpoint}/events`);
      es.addEventListener('tasks-changed', () => loadRemoteTasks({ quiet: true }));
      es.onerror = () => {
        /* 断线由 EventSource 自动重连，轮询兜底；不打扰用户 */
      };
      state.eventSource = es;
    } catch {
      /* 环境不支持 EventSource 时仅用轮询兜底 */
    }
  }

  function stopEventStream() {
    if (!state.eventSource) return;
    state.eventSource.close();
    state.eventSource = null;
  }

  /** 合并连续确认，避免每条标注都打一次接口。 */
  function scheduleSync() {
    if (!config.autoSync) return;
    queueOutbox('append');
    state.dirty = true;
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => {
      state.syncTimer = null;
      syncNow();
    }, DRAFT_DELAY_MS);
  }

  async function syncNow() {
    if (!config.autoSync) return null;
    if (state.syncPromise) return state.syncPromise;
    if (!state.hasLoadedRemote && !state.tasks.length) {
      state.syncMessage = '尚未确认工作区状态，暂不执行空任务清理。';
      renderMessage();
      return null;
    }
    // 没有任务时仍保留原有「清空即删除」语义，但必须先成功拉取过远端。
    if (!state.tasks.length) {
      if (!state.hasLoadedRemote) {
        state.syncMessage = '尚未确认工作区状态，暂不执行空任务清理。';
        renderMessage();
        return null;
      }
      queueOutbox('delete', { ids: [...new Set(state.outbox.flatMap(op => op.ids || []))] });
      const op = state.outbox[state.outbox.length - 1];
      const request = deleteRemote({ all: true });
      state.syncPromise = request.then(result => {
        if (result) ackOutbox(op.seq);
        return result;
      }).finally(() => { state.syncPromise = null; });
      return state.syncPromise;
    }
    state.syncState = 'saving';
    renderPanelMeta();
    const capturedSeq = Math.max(0, ...state.outbox.map(op => Number(op.seq) || 0));
    const payload = pagePayload();
    const controller = new AbortController();
    state.syncAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    const request = (async () => {
      try {
        const response = await fetch(`${config.endpoint}/append`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        state.syncState = 'saved';
        // 只确认请求开始时已存在的 outbox；saving 期间的新编辑仍待发送。
        ackOutbox(capturedSeq);
        state.syncMessage = data.skipped
          ? '这些标注已归档，工作区无需再写入。'
          : `已同步到 ${data.absolutePath || data.relativePath || data.file || '工作区'}`;
        return data;
      } catch (error) {
        state.syncState = 'error';
        state.syncMessage = `本地已保存，工作区同步失败：${error.name === 'AbortError' ? '请求超时' : error.message}`;
        // 失败不清理 outbox；下一次编辑、可见性变化或重试会继续投递。
        return null;
      } finally {
        clearTimeout(timeout);
        if (state.syncAbort === controller) state.syncAbort = null;
      }
    })();
    state.syncPromise = request.finally(() => {
      state.syncPromise = null;
      renderPanelMeta();
      renderMessage();
      // 请求期间如果有新 outbox，安排下一次 flush，不让 saving 碰撞吞掉编辑。
      if (state.outbox.length && !state.syncTimer && !state.editingId && !state.editingIsNew) {
        state.syncTimer = setTimeout(() => { state.syncTimer = null; syncNow(); }, DRAFT_DELAY_MS);
      }
    });
    return state.syncPromise;
  }

  /** 记录当前页面已同步的任务 ID，供删除时精确同步。 */
  const syncedIds = new Set();

  function rememberSynced() {
    syncedIds.clear();
    for (const task of state.tasks) syncedIds.add(task.id);
  }

  /**
   * 把删除同步到工作区：按页面归组，传要删的 id / 选择器，
   * 或 all=true 表示该页面任务已清空，直接删掉 JSON 与附件。
   */
  async function deleteRemote({ ids = [], selectors = [], all = false, allGroups = false } = {}) {
    if (!config.autoSync) return null;
    try {
      const body = allGroups
        ? { allGroups: true, all: true }
        : all
          ? { groupId: null, page: pagePayload().page, ids: [], selectors: [], all: true }
          : { groupId: null, page: pagePayload().page, ids, selectors };
      const response = await fetch(`${config.endpoint}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
        body: JSON.stringify({ ...body, ...(allGroups ? {} : { pageUrl }) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      state.syncState = 'saved';
      // 服务端会保留处理中的任务并回报 skipped；这里把实际结果如实说出来，
      // 不谎报「已全部删除」——否则用户以为清干净了，其实文件里还有。
      const kept = Array.isArray(data.skipped) ? data.skipped.length : 0;
      if (kept) {
        state.syncMessage = `工作区已删除 ${data.removed ?? 0} 项；${kept} 项正在处理中，已保留。`;
      } else {
        state.syncMessage = allGroups
          ? '已清空工作区中全部页面的任务数据。'
          : all
            ? '已清空工作区中该页面的任务数据。'
            : `已同步删除 ${data.removed ?? ids.length} 项。`;
      }
      if (!kept && state.outbox.length) {
        ackOutbox(Math.max(0, ...state.outbox.map(op => Number(op.seq) || 0)));
      }
      return data;
    } catch (error) {
      // 不写「本地已删除」：删除可能根本没执行（如处理中的任务被拒），
      // 那句话会让用户误以为本地状态已经变了。
      state.syncMessage = `工作区同步失败：${error.message}`;
      return null;
    } finally {
      renderMessage();
    }
  }

  /* ---------------- 其它页面分组的任务操作 ---------------- */

  /** 其它页面任务的防抖同步定时器，按任务 id 各自合并连续输入。 */
  const remoteSyncTimers = new Map();

  /** 在全部其它页面组里找任务，返回其所属组与任务本身。 */
  function findRemoteTask(id) {
    for (const group of state.groups) {
      const task = (group.tasks || []).find(t => t.id === id);
      if (task) return { group, task };
    }
    return null;
  }

  /**
   * 其它页面任务的指令编辑：以该任务所属页面归组同步。
   * 绝不能走 scheduleSync/syncNow——那会把任务混进当前页的 payload，
   * appendTasks 按页面 URL 归组，任务就会被错误写进当前页面的组文件。
   */
  function scheduleRemoteInstruction(group, task, value) {
    task.instruction = value;
    task.updatedAt = new Date().toISOString();
    clearTimeout(remoteSyncTimers.get(task.id));
    remoteSyncTimers.set(
      task.id,
      setTimeout(() => {
        remoteSyncTimers.delete(task.id);
        syncRemoteTask(group, task);
      }, DRAFT_DELAY_MS),
    );
  }

  async function syncRemoteTask(group, task) {
    try {
      const response = await fetch(`${config.endpoint}/append`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
        body: JSON.stringify({
          page: { url: group.page.url, title: group.page.title || group.page.url },
          tasks: [task],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.skipped) {
        // 任务已归档：服务端没有写出任何文件，本地分组视图也如实移除，
        // 否则下一次 8 秒刷新前它还挂在列表里，让人以为仍在待处理。
        group.tasks = group.tasks.filter(t => t.id !== task.id);
        if (!group.tasks.length) state.groups = state.groups.filter(g => g !== group);
        renderList();
        state.syncMessage = '该标注已归档，已从列表移除。';
      } else {
        state.syncMessage = `已同步到 ${data.absolutePath || data.relativePath || '工作区'}。`;
      }
    } catch (error) {
      state.syncMessage = `其它页面任务同步失败：${error.message}`;
    }
    renderMessage();
  }

  /** 删除其它页面的任务：按 groupId 直达该页面的组文件，服务端同样保护处理中的任务。 */
  async function removeRemoteTask(group, task) {
    try {
      const response = await fetch(`${config.endpoint}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
        body: JSON.stringify({
          groupId: group.id,
          ids: [task.id],
          selectors: task.element?.selector ? [task.element.selector] : [],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const kept = Array.isArray(data.skipped) ? data.skipped.length : 0;
      if (kept) {
        state.syncMessage = '该标注正在处理中，工作区已保留，未删除。';
      } else {
        group.tasks = group.tasks.filter(t => t.id !== task.id);
        if (!group.tasks.length) state.groups = state.groups.filter(g => g !== group);
        renderList();
        state.syncMessage = `已删除「${truncate(task.instruction || '未填写', 20)}」并同步工作区。`;
      }
    } catch (error) {
      state.syncMessage = `工作区同步失败：${error.message}`;
    }
    renderMessage();
  }

  /**
   * 人工验收：把待验收的任务确认通过（review→done）。
   *
   * 这是「done 由主线程浏览器验收后回写」的落地按钮。回写不带
   * x-zwa-client: task-agent —— 带那个声明会被服务端当成子 agent 自查而拒绝，
   * 那样又把用户推回「没有可点入口」的死路。
   *
   * 全部验收完成后才提示可归档：轮次里还有别的状态时，归档本轮会被服务端
   * 以 obstacles 拒绝，提前说「可以归档了」是假回执。
   */
  async function acceptTasks({ ids = null, round = null } = {}) {
    try {
      const response = await fetch(`${config.endpoint}/accept-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
        body: JSON.stringify({ ids, round }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadRemoteTasks({ quiet: true });
      const accepted = data.accepted || 0;
      const pending = Array.isArray(data.pending) ? data.pending : [];
      if (!accepted) {
        setReceipt('没有待验收的任务。', 4000);
      } else if (pending.length) {
        // 只报通过的数目，并说清还剩什么没通过 —— 验收不顺带标记未完成的任务
        const detail = pending.map(p => STATUS_LABELS[p.status] || p.status).join('、');
        setReceipt(`已验收 ${accepted} 项；还有 ${pending.length} 项未收尾（${detail}），不能归档本轮。`, 7000);
      } else {
        setReceipt(`已验收 ${accepted} 项，本轮可归档。`, 5000);
      }
      return data;
    } catch (error) {
      setReceipt(`验收失败：${error.message}`, 6000);
      return null;
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderCapsule() {
    // 收起胶囊显示「本页/总数」：跨页面标注时用户同时关心
    // 当前页进度与整个项目的标注总量（如首页上是 0/3）。
    // 收起胶囊显示「本页未归档/全部未归档」：已归档任务是交付完的沉没态，
    // 用户关心的是还没走完闭环的活——archived 不计入分子分母。
    const live = t => t && t.status !== 'archived';
    const curLive = state.tasks.filter(live).length;
    const otherLive = state.groups.reduce((sum, g) => sum + ((g.tasks || []).filter(live).length), 0);
    $('[data-el="capsuleCount"]').textContent = `${curLive}/${curLive + otherLive}`;
    const dock = $('[data-el="dock"]');
    const toggle = $('[data-el="dockToggle"]');
    dock.dataset.active = state.active ? 'on' : 'off';
    dock.dataset.dirty = state.dirty ? 'on' : 'off';
    $('[data-el="dockToggleText"]').textContent = state.active ? '结束' : '标注';
    toggle.dataset.active = state.active ? 'on' : 'off';
    $('[data-el="dockDot"]').dataset.active = state.active ? 'on' : 'off';
  }

  /**
   * 总体进度条。统计范围是**整个项目**（当前页 + 其它页面的全部任务），
   * 因为用户关心的是「这批活干完多少」，而不是当前页那几项。
   */
  /** 项目全部任务（当前页 + 其它页面），进度统计的输入。 */
  function allProjectTasks() {
    return [
      ...state.tasks,
      ...state.groups.flatMap(g => (Array.isArray(g?.tasks) ? g.tasks : [])),
    ].filter(t => t && t.id);
  }

  /**
   * 进度统计的范围与排队情况。
   *
   * 分母统一为「本轮定稿集合」，权威来源是服务端 `roundSummary`：本轮成员在
   * 第一个任务被置为 doing 时就原子冻结；执行中新增的标注若被处理者接手会
   * 并入本轮（分母 +1），未接手的排队下一轮（显示「下一轮 N 条」）。归档
   * 轮次的存量不进分母——那是对已完成历史的记账，不是当前工作的进度。
   * 两种执行模式（round/queue）共用这套分母，区别只在边界行为。
   * 服务端没有返回摘要（旧版运行时）时才回落到本地推断。
   */
  function roundScope() {
    return resolveRoundScope(allProjectTasks(), state.execution || {}, state.serverRound);
  }

  /**
   * 执行模式是否处于锁定态：本轮在途（activeRound 非空）期间不允许切换。
   * 模式决定「本轮怎么收尾」，处理开始后再切换会让收尾预期漂移，所以从
   * 首个 doing（定稿）到交付之间锁死，交付后自动恢复。以服务端摘要为准；
   * 摘要缺失（旧版运行时）时不锁——宁可宽松也不误锁。
   */
  /* ---- 明亮/暗色主题：偏好记 localStorage，属性挂在宿主上随 CSS 生效 ---- */
  const PANEL_THEME_KEY = 'zwa-panel-theme';

  function applyPanelTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    const host = document.getElementById(HOST_ID);
    if (host) host.setAttribute('data-zwa-theme', value);
    const btn = $('[data-el="themeBtn"]');
    if (btn) {
      // SVG 图标替代 Emoji：部分平台 Emoji 字形自带色块底，且违反「封杀原生 Emoji」规范
      btn.innerHTML = value === 'light'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
      btn.title = value === 'light' ? '当前明亮主题，点击切换为暗色' : '当前暗色主题，点击切换为明亮';
    }
  }

  function togglePanelTheme() {
    const host = document.getElementById(HOST_ID);
    const next = host && host.getAttribute('data-zwa-theme') === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(PANEL_THEME_KEY, next); } catch { /* 隐私模式等场景忽略 */ }
    applyPanelTheme(next);
  }

  function restorePanelTheme() {
    let saved = null;
    try { saved = localStorage.getItem(PANEL_THEME_KEY); } catch { /* 忽略 */ }
    applyPanelTheme(saved);
  }

  function executionLocked() {
    return !!(state.serverRound
      && Object.prototype.hasOwnProperty.call(state.serverRound, 'activeRound')
      && state.serverRound.activeRound != null);
  }

  /**
   * 进度标签尾部的状态提示：把「为什么进度停住」说清楚。
   *
   * 服务端不会凭空启动模型——queue 模式在轮次边界只负责归档并返回
   * continue/stop/blocked，真正的下一轮派发由主线程完成。所以这里把
   * 「等处理者」「有阻塞」「处理者已断开」显式写出来，而不是让进度条
   * 静默停在某个百分比，让人以为卡死。
   */
  function runnerHint(scope) {
    if (scope.blocked) return ' · 本轮有阻塞，需先解除';
    const status = scope.runner?.status;
    if (status === 'blocked') return ' · 本轮有阻塞，需先解除';
    if (status === 'paused') return ' · 等待处理者接续';
    if (status === 'disconnected') return ' · 处理者已断开';
    return '';
  }

  /**
   * 进度条。面板展开时是顶部那根，收起时是胶囊上方的细条——两处同一份数据，
   * 但不同时显示（展开时刻意隐藏细条，避免同一信息出现两次）。
   */
  function renderProgress() {
    const scope = roundScope();
    const p = computeProgress(scope.dispatched);
    renderDockProgress(p, scope);
    renderModeSwitch();
    const fill = $('[data-el="progressFill"]');
    fill.style.width = `${p.percent}%`;
    $('[data-el="progressPct"]').textContent = p.total ? `${p.percent}%` : '';
    // 分母两种模式同口径（本轮定稿集合），前缀只标明当前模式便于对账
    const scopeName = scope.mode === 'queue' ? '队列·本轮' : '本轮';
    $('[data-el="progressLabel"]').textContent = p.total
      ? `${scopeName} 待验收 ${p.counts.review || 0} · 已完成 ${p.counts.done || 0}`
        + `${p.counts.archived ? ` · 已归档 ${p.counts.archived}` : ''} / 共 ${p.total}`
      : (scope.queued ? `下一轮 ${scope.queued} 条 · 复制提示词开始` : '还没有任务');
    // 排队数与状态提示走独立一行：两者都可能很长，放在首行会被 ellipsis
    // 截掉，而「为什么停在某个百分比」正是这条进度最重要的补充信息。
    const note = $('[data-el="progressNote"]');
    if (note) {
      // 没有在途轮次时首行已经写了「下一轮 N 条」，再补一行就是重复
      const noteText = p.total
        ? [
            scope.queued ? `下一轮排队 ${scope.queued} 条` : '',
            runnerHint(scope).replace(/^ · /, ''),
          ].filter(Boolean).join(' · ')
        : '';
      note.textContent = noteText;
      note.classList.toggle('hidden', !noteText);
    }
    fill.parentElement.title = p.total
      ? `分派 ${p.started}/${p.total} · 开发完成 ${p.devDone}/${p.total} · 验收通过 ${p.verified}/${p.total}\n`
        + `权重：分派 10% / 开发 70% / 验收 20%（cancelled 不计入，archived 按已完成计）\n`
        + `统计范围：第 ${scope.currentRound} 轮定稿集合（含执行中并入，归档轮次不计）`
      : '';
    // 全部完成时换成绿色并常驻，直到归档（交付）——这是「本轮收工」的信号
    fill.dataset.done = p.total && p.percent >= 100 ? 'on' : 'off';
    // 有等待验收的任务就露出「验收本轮」：这是 done 的正式入口，
    // 与 100% 后的「归档本轮」分工不同（先验收、后归档），两者可同时在场。
    $('[data-el="acceptBtn"]').classList.toggle('hidden', !(p.counts.review > 0));
    $('[data-el="archiveBtn"]').classList.toggle('hidden', !(p.total && p.percent >= 100));
  }

  /**
   * 模式切换控件的选中态与锁定态同源刷新：本轮在途期间按钮置灰禁点，
   * SSE 拉取后（定稿/交付）也会即时锁定或恢复。
   */
  function renderModeSwitch() {
    const mode = state.execution?.mode || 'round';
    const locked = executionLocked();
    const group = $('[data-el="modeSwitch"]');
    for (const btn of $$('[data-act="mode"]')) {
      btn.dataset.active = btn.dataset.mode === mode ? 'on' : 'off';
      btn.disabled = locked;
    }
    if (group) {
      group.title = locked
        ? `第 ${state.serverRound.activeRound} 轮处理中，交付后可切换执行模式`
        : '';
    }
  }

  /**
   * 收起态胶囊上方的细进度条。
   *
   * 显示规则：
   * - 本轮无任务（尚未开轮，或已交付归档）→ 不显示；
   * - 100% 时**不隐藏**、绿色常驻——这是显式的「本轮完成」状态，
   *   直到归档才消失（交付时机由用户掌控）；
   * - 面板展开 → 不显示，改由面板顶部那根完整进度条承担。
   */
  function renderDockProgress(p, scope) {
    const box = $('[data-el="dockProgress"]');
    const fill = $('[data-el="dockProgressFill"]');
    const stat = p || computeProgress((scope || roundScope()).dispatched);
    const show = stat.total > 0 && state.collapsed;
    box.classList.toggle('hidden', !show);
    if (show) {
      fill.style.width = `${stat.percent}%`;
      fill.dataset.done = stat.percent >= 100 ? 'on' : 'off';
      box.title = `进度 ${stat.percent}%（待验收 ${stat.counts.review || 0} · 已完成 ${stat.counts.done || 0} / 共 ${stat.total}）`;
    }
    // 悬耳态的竖向进度条：与药丸同口径，自下而上生长；本轮无任务时隐藏
    const petBox = $('[data-el="petProgress"]');
    const petFill = $('[data-el="petProgressFill"]');
    if (petBox && petFill) {
      const petShow = stat.total > 0;
      petBox.classList.toggle('hidden', !petShow);
      if (petShow) {
        petFill.style.height = `${stat.percent}%`;
        petFill.dataset.done = stat.percent >= 100 ? 'on' : 'off';
        petBox.title = `进度 ${stat.percent}%（待验收 ${stat.counts.review || 0} · 已完成 ${stat.counts.done || 0} / 共 ${stat.total}）`;
      }
    }
  }

  function renderPanelMeta() {
    // 「N 项·已填 N」元信息行已移除：两个折叠区头部各自带实时计数，
    // 顶栏再摆一份是重复信息；这里只保留标注模式钮与进度的联动刷新。
    const toggle = $('[data-el="toggleBtn"]');
    toggle.textContent = state.active ? '结束' : '标注';
    toggle.dataset.active = state.active ? 'on' : 'off';
    // 进度与元信息同源（都依赖任务列表），一并刷新，避免两处各自漏调
    renderProgress();
  }

  /**
   * 记录一条用户主动操作的「回执」，在有效期内压过后台同步消息。
   * 用于复制提示词这类「必须让用户看到结果」的动作。
   */
  function setReceipt(message, ms = 3200) {
    if (state.receiptTimer) clearTimeout(state.receiptTimer);
    // 记住创建回执时被压住的后台消息。点复制会先写文件，写入又触发
    // 「已同步到 …」这类与本次操作无关的噪声；若不做记录，回执一到期
    // 就会把这条噪声显示出来。所以到期时只在它未被新消息替换的情况下清掉。
    const background = state.syncMessage;
    state.receipt = { message, until: Date.now() + ms };
    renderMessage();
    state.receiptTimer = setTimeout(() => {
      state.receipt = null;
      state.receiptTimer = null;
      if (state.syncMessage === background) state.syncMessage = '';
      renderMessage();
    }, ms);
  }

  /**
   * 剪贴板被宿主禁用时的兜底：把文本摊在可选中的文本框里，让用户手动复制。
   *
   * 这不是「失败提示」而是完成路径的一部分：嵌入式浏览器（Devin 内置浏览器等）
   * 常以权限策略拒绝 clipboard.writeText，用户仍然需要拿到那段提示词。所以这里
   * 自动全选文本并在回执里说清该按什么键，而不是把用户丢在「复制失败」上。
   */
  function showManualCopy(text, successHint) {
    const box = $('[data-el="manualCopy"]');
    const ta = $('[data-el="manualCopyText"]');
    if (!box || !ta) return;
    ta.value = text;
    box.classList.remove('hidden');
    // 自动聚焦并全选：用户只需按一次 ⌘C/Ctrl+C
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
    state.syncMessage = `${successHint || ''}浏览器不允许自动复制，已展开文本供手动复制。`.trim();
    renderMessage();
  }

  function hideManualCopy() {
    const box = $('[data-el="manualCopy"]');
    if (box) box.classList.add('hidden');
  }

  /** 当前应当显示的文案：回执在有效期内优先，否则用最近的后台消息。 */
  function activeMessage() {
    if (state.receipt && Date.now() < state.receipt.until) return state.receipt.message;
    return state.syncMessage;
  }

  function renderMessage() {
    const text = activeMessage() || (state.active
      ? '点按选元素、拖拽框选、Shift+点击多选（Enter 收尾）。'
      : '点击“标注”后，在页面上点选元素或拖拽框选。');
    const msgEl = $('[data-el="msg"]');
    msgEl.textContent = text;
    // 提示行单行省略显示，完整文案靠悬停 title 兜底
    msgEl.title = text;
    renderToast(activeMessage());
  }

  /**
   * 收起状态下的浅色提示条：面板底栏此时不可见，用户点「复制」/「手动」后
   * 需要看到回执。只在「面板收起 + 有真实消息」时出现，展开时由底栏承担，
   * 避免同一句话在两处重复。
   */
  function renderToast(message) {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    // 编辑器打开时不弹：收起态下编辑器和浮条都停在胶囊上方，会互相压住；
    // 而且「手动任务：可直接写要求，也可粘贴图片」这类提示，编辑器自己的
    // 提示行（Enter 确认 · Esc 取消 · 可粘贴图片）已经写了一遍，属重复。
    const editorOpen = !editor.classList.contains('hidden');
    const show = !!message && state.collapsed && !editorOpen;
    toast.classList.toggle('hidden', !show);
    if (!show) return;
    toast.textContent = message;
    // 失败与「未复制」这类需要用户处理的消息停留久一点
    const sticky = /失败|未复制|不能|无法/.test(message);
    state.toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
      state.toastTimer = null;
    }, sticky ? 6000 : 3200);
  }
  /* ---------------- 列表：按页面分组 ---------------- */

  function persistGroupOpenState() {
    try {
      localStorage.setItem(groupOpenKey, JSON.stringify(state.groupOpenState));
    } catch {
      /* 存储被禁用时忽略 */
    }
  }

  /** 分组展开规则：用户显式切换过的以记录为准；否则当前页展开、其它页折叠。 */
  function isGroupOpen(groupId, current) {
    const explicit = state.groupOpenState[groupId];
    if (typeof explicit === 'boolean') return explicit;
    return current;
  }

  function toggleGroup(groupId, current) {
    state.groupOpenState[groupId] = !isGroupOpen(groupId, current);
    persistGroupOpenState();
    renderList();
  }

  function safePathname(url) {
    try {
      return new URL(url).pathname || '/';
    } catch {
      return String(url || '');
    }
  }

  /**
   * 单条任务卡片。current=true 为当前页任务，保留详情入口；
   * 其它页面的任务只支持改指令与删除——元素不在本页，没有图钉与实时详情可联动。
   */
  function taskCardHtml(task, index, current) {
    const seq = task.seq || index + 1;
    const empty = !String(task.instruction || '').trim() && !(task.images || []).length;
    const manual = !task.element;
    const title = manual
      ? '手动任务'
      : task.element.accessibleName || task.element.text || task.element.tagName;
    const sub = manual
      ? (task.images || []).length
        ? `${task.images.length} 张图片`
        : '无关联元素'
      : (() => {
          // 源码定位优先：File.vue:行 比生成的 el-table_15_column_* 更可读
          const src = task.element.source ? ` ${task.element.source.split(/[/\\]/).slice(-2).join('/')}` : '';
          return `${src}${src ? ' · ' : ''}${truncate(task.element.selector, 40)} · ${task.element.rect.width}×${task.element.rect.height}`;
        })();
    // 面板编辑规则（收敛为一条）：**只有 todo 可直接改当前指令**。
    // 非 todo（doing/review/done/blocked）的列表输入框一律只读——它们的当前
    // 指令对应着在途工作或已验收的结论，随手一改会作废它。要提交新要求，
    // 点图钉/详情打开编辑器：新指令存为 pendingInstruction，批次交付时
    // **另建一条新任务**排队下一轮，本条保持终态正常归档（服务端语义，
    // 见 store.mjs completeRound）。
    const locked = task.status === 'doing';
    // 轮次冻结后，同批 todo 已随首个 doing 整批读取进当前处理批次：
    // 与未入批的普通待处理不同——不可删、不可就地改（新要求走编辑器 → 下一轮），
    // 避免面板把它们显示成随时可动的普通待处理。
    const activeRound = (state.serverRound && Object.prototype.hasOwnProperty.call(state.serverRound, 'activeRound'))
      ? state.serverRound.activeRound
      : null;
    const batchQueued = !locked
      && activeRound != null
      && task.round != null
      && task.round === activeRound
      && task.status === 'todo';
    const readonly = task.status !== 'todo' || batchQueued;
    // 处理开始后新增的批注没有轮次号 → 排队下一轮（有轮次在身时才显示徽标）
    const queued = state.roundQueued && task.round == null;
    const pending = typeof task.pendingInstruction === 'string' && task.pendingInstruction.trim();
    // 与待归档检验行同款横排：只露首图 + 张数角标，多图存 data-srcs 供灯箱切换
    const srcs = (Array.isArray(task.images) ? task.images : [])
      .map(img => imageSrc(img, config.endpoint))
      .filter(Boolean);
    const thumbs = srcs.length
      ? `<span class="item-thumbs"><span class="arch-thumb-wrap" data-srcs="${escapeHtml(JSON.stringify(srcs))}"><img class="arch-thumb" loading="lazy" src="${escapeHtml(srcs[0])}" alt="">${srcs.length > 1 ? `<i class="arch-thumb-n">${srcs.length}</i>` : ''}</span></span>`
      : '';
    const readonlyAttr = readonly ? ' readonly' : '';
    const readonlyHint = readonly
      ? (batchQueued
        ? ' title="本批已整批锁定读取，暂不可就地修改；要提交新要求，点图钉或「详情」打开编辑器，将另建一条任务在下一轮处理"'
        : ' title="只有待处理的任务可直接修改；要提交新要求，点图钉或「详情」打开编辑器，将另建一条任务在下一轮处理"')
      : '';
    // review = 子 agent 已交活、等人看过页面确认。这是唯一面向人的验收入口：
    // 以前 done 只能靠裸 PATCH 回写，主线程没有可点的东西，于是反复让用户
    // 「去浏览器点验收」——面板上根本没有那个按钮。验收必须是显式人工动作。
    const reviewable = task.status === 'review';
    return `
    <article class="item${task.id === state.editingId ? ' editing' : ''}${locked || batchQueued ? ' locked' : ''}" data-item="${task.id}">
      <div class="item-head">
        <span class="item-seq${manual ? ' manual' : ''}">${seq}</span>
        <span class="item-title">${escapeHtml(title)}</span>
        ${locked ? '<span class="lock-note" title="正在处理中，暂不可修改或删除">🔒 处理中</span>' : ''}
        ${batchQueued ? '<span class="lock-note" title="已锁定进当前处理批次：整批读取后按顺序完成，暂不可修改或删除；新要求可通过详情提交，另建任务下一轮处理">🔒 本批待处理</span>' : ''}
        ${reviewable ? `<button type="button" class="link accept" data-accept="${escapeHtml(task.id)}" title="验收通过：确认这处改动符合要求，标记为已完成">✓ 验收</button>` : ''}
        ${current ? `<button type="button" class="link" data-details="${escapeHtml(task.id)}" title="查看元素详情">详情</button>` : ''}
        ${locked || batchQueued
          ? ''
          : `<button type="button" class="link danger" data-del="${escapeHtml(task.id)}" title="删除">✕</button>`}
      </div>
      <div class="item-body">
        ${thumbs}
        <label class="item-instruction">
          <textarea data-edit="${escapeHtml(task.id)}" rows="2" placeholder="输入调整要求"${readonlyAttr}${readonlyHint}>${escapeHtml(task.instruction)}</textarea>
        </label>
      </div>
      <div class="item-foot">
        <code>${escapeHtml(sub)}</code>
        <span class="tag${empty ? ' warn' : ` status-${task.status}`}" title="状态：${STATUS_LABELS[task.status] || task.status}">${empty ? '未填写' : STATUS_LABELS[task.status] || task.status}</span>${pending ? `<span class="tag pending" title="已提交新要求（交付后另建一条任务进入下一轮）：${escapeHtml(task.pendingInstruction)}">新要求</span>` : ''}${queued ? '<span class="tag queued" title="处理开始后新增，自动排队下一轮">下一轮</span>' : ''}
      </div>
    </article>`;
  }

  /** 一个页面分组的可折叠区块。 */
  function renderGroupSection({ id, current, title, path, url, tasks }) {
    const open = isGroupOpen(id, current);
    const doing = tasks.filter(t => t.status === 'doing').length;
    // 待验收单独标出：它是「子 agent 交活了、等人看」的状态，
    // 混在总数里用户看不出这页有没有东西等着自己确认。
    const review = tasks.filter(t => t.status === 'review').length;
    const body = tasks.length
      ? tasks.map((task, index) => taskCardHtml(task, index, current)).join('')
      : '<p class="empty">当前页面暂无标注。</p>';
    return `
      <section class="page-group${current ? ' current' : ''}" data-page-group="${escapeHtml(id)}">
        <header class="group-head" data-group-toggle="${escapeHtml(id)}" data-current="${current ? 'on' : 'off'}" title="${open ? '折叠' : '展开'}该页面的标注">
          <span class="group-chevron" data-open="${open ? 'on' : 'off'}">▶</span>
          <span class="group-name">${escapeHtml(truncate(title || '未命名页面', 16))}</span>
          ${current ? '<span class="group-badge">当前</span>' : ''}
          ${review ? `<span class="group-badge review" title="${review} 项待验收">待验${review}</span>` : ''}
          <span class="group-sub">${escapeHtml(truncate(path, 24))}</span>
          <span class="group-count">${tasks.length}${doing ? ` · 🔒${doing}` : ''}</span>
          ${!current ? `<button type="button" class="group-goto" data-act="group-goto" data-url="${escapeHtml(url || '')}" title="跳转到 ${escapeHtml(title || path)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></button>` : ''}
        </header>
        <div class="group-body${open ? '' : ' hidden'}">${body}</div>
      </section>`;
  }

  /**
   * 列表按页面分组：当前页组始终在最前（用户正在这页上工作），其余页面
   * 按服务端返回的最近活动排序。组内顺序仍是添加顺序，编号不重排。
   * 跨页面标注不会因切换页面而丢失：每个页面的任务都常驻列表，可折叠。
   */
  /** 列表可见任务：已完成待归档（done）与已归档任务只出现在「检验归档」抽屉，
      标注列表不再展示——否则验收完的任务永远占着列表挤掉真正待办的。 */
  function isPanelTask(t) {
    return t && t.status !== 'done' && t.status !== 'archived';
  }

  function renderList() {
    const list = $('[data-el="list"]');
    // 卡片上的「下一轮」徽标需要知道当前是否有轮次在身（含排队数）
    state.roundQueued = roundScope().queued;
    const curTasks = state.tasks.filter(isPanelTask);
    const otherGroups = state.groups
      .map(g => ({ group: g, tasks: (g && Array.isArray(g.tasks) ? g.tasks : []).filter(isPanelTask) }))
      .filter(x => x.tasks.length);
    if (!curTasks.length && !otherGroups.length) {
      list.innerHTML = '<p class="empty">还没有标注。点击“标注”后点选元素，或用“手动”添加任务。</p>';
      renderCapsule();
      renderPanelMeta();
      return;
    }
    const sections = [
      renderGroupSection({
        id: '__current__',
        current: true,
        title: document.title || '当前页面',
        path: safePathname(location.href),
        tasks: curTasks,
      }),
    ];
    for (const { group, tasks } of otherGroups) {
      sections.push(
        renderGroupSection({
          id: group.id,
          current: false,
          title: group.page?.title || group.page?.url || '其它页面',
          path: safePathname(group.page?.url || ''),
          url: group.page?.url || '',
          tasks,
        }),
      );
    }
    list.innerHTML = sections.join('');
    bindListEvents();
    renderCapsule();
    renderPanelMeta();
  }

  function bindListEvents() {
    const list = $('[data-el="list"]');
    list.querySelectorAll('[data-item]').forEach(el => {
      el.addEventListener('mouseenter', () => flashPin(el.dataset.item, true));
      el.addEventListener('mouseleave', () => flashPin(el.dataset.item, false));
    });
    list.querySelectorAll('[data-group-toggle]').forEach(el => {
      el.onclick = e => {
        // 组头内的动作钮（如跳页）不触发折叠
        if (e.target.closest('[data-act]')) return;
        toggleGroup(el.dataset.groupToggle, el.dataset.current === 'on');
      };
    });
    list.querySelectorAll('[data-edit]').forEach(el => {
      el.oninput = () => {
        const localTask = findTask(el.dataset.edit);
        if (localTask) {
          // 只读输入框理论上不会再触发 input，这里仍兜一层，
          // 防止通过脚本或浏览器自动填充绕过 readonly 改掉非 todo 的指令：
          // 当前指令对应在途工作或已验收结论，改它必须走编辑器的
          // 「提交新要求」路径（下一轮生效）。
          if (localTask.status !== 'todo') {
            el.value = localTask.instruction || '';
            state.syncMessage = '只有待处理的任务可直接修改；要提交新要求，点图钉或「详情」打开编辑器，将另建一条任务在下一轮处理。';
            renderMessage();
            return;
          }
          localTask.instruction = el.value;
          localTask.updatedAt = new Date().toISOString();
          persistLocal();
          scheduleSync();
          renderCapsule();
          renderPanelMeta();
          return;
        }
        // 其它页面的任务：以所属页面归组直连同步，绝不混入当前页的 payload
        const remote = findRemoteTask(el.dataset.edit);
        if (!remote) return;
        if (remote.task.status !== 'todo') {
          el.value = remote.task.instruction || '';
          state.syncMessage = '只有待处理的任务可直接修改；要提交新要求，点图钉或「详情」打开编辑器，将另建一条任务在下一轮处理。';
          renderMessage();
          return;
        }
        scheduleRemoteInstruction(remote.group, remote.task, el.value);
      };
      // 侧栏里 Enter 也确认，方便快速连续填写
      el.onkeydown = event => {
        if (event.key === 'Enter' && !event.shiftKey && !isComposing(event)) {
          event.preventDefault();
          el.blur();
          renderList();
        }
      };
    });
    list.querySelectorAll('[data-del]').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.del;
        const localTask = findTask(id);
        const remote = localTask ? null : findRemoteTask(id);
        const task = localTask || remote?.task;
        if (!task) return;
        if (task.status === 'doing') {
          // 列表上已不渲染删除按钮，这里兜住脚本触发的路径
          state.syncMessage = '该标注正在处理中，不能删除。';
          renderMessage();
          return;
        }
        askConfirm({
          title: '删除这条标注？',
          detail: `「${truncate(task.instruction || '未填写', 30)}」将被删除，工作区中对应数据与图片附件一并移除。此操作不可撤销。`,
          onConfirm: () => {
            if (localTask) removeTask(id);
            else if (remote) removeRemoteTask(remote.group, remote.task);
          },
        });
      };
    });
    list.querySelectorAll('[data-accept]').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.accept;
        const task = findTask(id) || findRemoteTask(id)?.task;
        if (!task) return;
        askConfirm({
          title: '验收通过这条标注？',
          detail: `「${truncate(task.instruction || '未填写', 30)}」将标记为已完成并计入验收进度。`
            // detail 走 textContent，换行不会渲染，用整句拼接
            + (task.result ? ` 处理者回写：${truncate(task.result, 160)}` : ''),
          confirmText: '确认验收',
          danger: false,
          onConfirm: () => acceptTasks({ ids: [id] }),
        });
      };
    });
    list.querySelectorAll('[data-details]').forEach(el => {
      el.onclick = () => {
        const task = findTask(el.dataset.details);
        if (!task) return;
        if (!task.element) {
          // 手动任务没有元素信息，直接打开编辑器
          openEditorFor(task.id);
          return;
        }
        const target = resolveElement(task.element);
        if (!target) {
          state.syncMessage = '该元素已不在当前页面，无法显示详情。';
          renderMessage();
          return;
        }
        // 打开编辑器并把详情收起：详情默认收缩，要看时用胶囊左侧图标展开
        openEditorFor(task.id);
      };
    });
  }

  /* ---------------- 图钉 ---------------- */

  function renderPins() {
    pins.innerHTML = '';
    // archived 是终态：图钉不应再渲染（done 仍显示，待归档检验要对页面核对）
    state.tasks.filter(t => t && t.status !== 'archived').forEach((task, index) => {
      const seq = task.seq || index + 1;
      const empty = !String(task.instruction || '').trim();
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'pin';
      pin.dataset.pin = task.id;
      pin.dataset.empty = empty ? 'on' : 'off';
      pin.title = `${seq}. ${task.instruction || '未填写'}`;
      pin.textContent = String(seq);
      pin.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        // 图钉的 z-index 高于事件拦截层，所以编辑器开着时它仍可点到。
        // 此时直接切走会把未确认的草稿丢掉，必须先让用户确认或取消——
        // 与「编辑器开着时点页面」保持同一套语义。
        if (isEditing() && state.editingId !== task.id) {
          state.syncMessage = '请先按 Enter 确认或 Esc 取消当前输入。';
          renderMessage();
          return;
        }
        openEditorFor(task.id);
      });
      pins.append(pin);
      positionPin(pin, task);
    });
  }

  /**
   * 元素解析：主 selector 优先；DOM 重建（内嵌视图切换/重渲染）后会话级
   * el-id-* 选择器必然失效，按 0.30.0 采集的 locator 兜底链依次降级：
   * stableSelector（无易漂移 id 的链）→ 语义签名（placeholder/fieldLabel/text）。
   */
  function resolveElement(selectorOrEl) {
    const desc = typeof selectorOrEl === 'string' ? { selector: selectorOrEl } : (selectorOrEl || {});
    const tryQ = (sel) => {
      try { return sel ? document.querySelector(sel) : null; } catch { return null; }
    };
    let el = tryQ(desc.selector);
    if (el) return el;
    el = tryQ(desc.locator?.stableSelector);
    if (el) return el;
    const sem = desc.locator?.semantic;
    if (sem) {
      // 语义兜底：placeholder 精确匹配 > 表单标签就近 > 可见文本
      if (sem.placeholder) {
        el = tryQ(`[placeholder="${CSS.escape(sem.placeholder)}"]`);
        if (el) return el;
      }
      if (sem.fieldLabel) {
        const item = [...document.querySelectorAll('.el-form-item, .filter-cell, .search-item, .form-item')]
          .find(i => (i.querySelector('.el-form-item__label, .cell-label, .item-label, label')?.innerText || '').trim().startsWith(sem.fieldLabel));
        el = item?.querySelector('input, select, textarea, .el-select, button');
        if (el) return el;
      }
      if (sem.text) {
        el = [...document.querySelectorAll('button, a, span, div, th, td, label, li, p, h1, h2, h3, h4')].find(e => (e.innerText || '').trim() === sem.text);
        if (el) return el;
      }
    }
    // 末级兜底（不依赖 locator.semantic——老任务该字段为 null 也能走）：
    // ① tagName + 顶层 text 精确匹配；② xpath 结构路径 + tagName 校验
    // （防结构偏移后钉到错误元素——钉错比不钉更误导）。
    const tag = desc.tagName;
    const txt = trim(desc.text, 60);
    if (tag && txt) {
      el = [...document.querySelectorAll(tag)].find(e => (e.innerText || '').trim().slice(0, 60) === txt);
      if (el) return el;
    }
    if (desc.xpath && tag) {
      try {
        el = document.evaluate(desc.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (el && el.tagName && el.tagName.toLowerCase() === tag) return el;
      } catch { /* xpath 求值失败按未命中处理 */ }
    }
    return null;
  }

  /**
   * 遮挡判定：标注 host 的 z-index 永远是页面最高，弹窗/抽屉打开后底层
   * 页面的图钉仍然浮在弹窗之上，视觉上很乱。用 elementFromPoint 实测
   * 元素中心点的最顶元素——纯几何事实，不区分弹窗类型，天然支持多级
   * 弹窗/下拉浮层嵌套：元素在哪一层不重要，只认它当前是否被盖住。
   * 命中自家 host（图钉/拦截层恰在采样点）或元素本身 pointer-events:none
   * （不参与命中）时不判定，宁可见不可误隐。
   */
  function isCoveredByOverlay(el, rect) {
    try {
      // 采样点必须取元素【可见部分】的中心而非整体中心：超高元素（大表格）
      // 整体中心在视口外，钳回视口边采样会落到元素外 → 误判被遮。
      const vx0 = Math.max(rect.left, 0), vy0 = Math.max(rect.top, 0);
      const vx1 = Math.min(rect.right, window.innerWidth), vy1 = Math.min(rect.bottom, window.innerHeight);
      if (vx1 - vx0 < 2 || vy1 - vy0 < 2) return true; // 可见部分不足 2px，视为被遮
      const cx = Math.min(Math.max((vx0 + vx1) / 2, 1), window.innerWidth - 1);
      const cy = Math.min(Math.max((vy0 + vy1) / 2, 1), window.innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === el || el.contains(top) || top.contains(el)) return false;
      if (top.id === HOST_ID) return false;
      if (getComputedStyle(el).pointerEvents === 'none') return false;
      return true;
    } catch { return false; }
  }

  function positionPin(pin, task) {
    // 手动任务没有关联元素，不显示页面图钉
    if (!task.element?.selector) {
      pin.style.display = 'none';
      return;
    }
    const el = resolveElement(task.element);
    if (!el) {
      pin.dataset.orphan = 'on';
      pin.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    // 零尺寸（选择器命中未渲染的兄弟节点，如折叠面板里的同名 el-table）
    // 不是「被遮」而是「没渲染」——直接隐藏，别走进遮挡判定误报。
    const offscreen =
      rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth
      || rect.width < 2 || rect.height < 2;
    if (offscreen) {
      pin.style.display = 'none';
      return;
    }
    pin.style.display = 'flex';
    // 被更高层覆盖物（弹窗/抽屉/浮层）遮住的元素降级为幽影：
    // 仍保留「这里有标注」的空间提示但不再喧宾夺主，且不吃点击——
    // 避免浮在弹窗上的残影拦截对弹窗的操作；弹窗关闭自动恢复。
    pin.dataset.covered = isCoveredByOverlay(el, rect) ? 'on' : 'off';
    // 贴在元素左上角，略微向外偏移，避免压住内容本身
    pin.style.left = `${Math.max(2, rect.left - 9)}px`;
    pin.style.top = `${Math.max(2, rect.top - 9)}px`;
  }

  function repositionPins() {
    $$('.pin').forEach(pin => {
      const task = findTask(pin.dataset.pin);
      if (task) positionPin(pin, task);
    });
    renderPickmarks(); // 多选高亮随图钉一起重排
    // 编辑器开着时补定位：打开瞬间目标元素可能尚未重建（视图切换竞态），
    // 弹窗落到了「未命中回退位（贴胶囊）」；元素就绪后搬回元素旁。
    // 已对齐（left≈rect.left）则不动，且 focus:false——不抢光标打断输入。
    if (isEditing()) {
      const elDesc = (state.editingId ? findTask(state.editingId)?.element : state.pendingElement) || null;
      const target = elDesc ? resolveElement(elDesc) : null;
      if (target && Math.abs(editor.getBoundingClientRect().left - target.getBoundingClientRect().left) > 24) {
        placeEditor(elDesc, $('[data-el="editorInput"]'), { focus: false });
      }
    }
  }

  function flashPin(taskId, on) {
    const pin = shadow.querySelector(`[data-pin="${cssEscape(taskId)}"]`);
    if (pin) pin.dataset.flash = on ? 'on' : 'off';
  }

  /* ---------------- 悬停尺寸标签 ---------------- */

  function showSizeBadge(target) {
    const rect = target.getBoundingClientRect();
    sizeBadge.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    sizeBadge.classList.remove('hidden');
    // 默认贴元素右上角，空间不够时移到内部，避免超出视口
    const badgeWidth = 86;
    let left = rect.right - badgeWidth;
    let top = rect.top - 22;
    if (top < 4) top = rect.top + 4;
    if (left < 4) left = 4;
    if (left + badgeWidth > window.innerWidth - 4) left = window.innerWidth - badgeWidth - 4;
    sizeBadge.style.left = `${left}px`;
    sizeBadge.style.top = `${top}px`;
  }

  function hideSizeBadge() {
    sizeBadge.classList.add('hidden');
  }

  /* ---------------- 元素详情（内嵌在编辑面板内） ---------------- */

  function mediaQueryLabel() {
    const w = window.innerWidth;
    if (w < 600) return '手机';
    if (w < 900) return '平板';
    if (w < 1280) return '笔记本';
    return '桌面';
  }

  function detailRows(element) {
    const rows = [];
    const s = element.styles;
    rows.push(['标签', `<code>${escapeHtml(element.tagName)}</code>`]);
    if (element.id) rows.push(['ID', `<code>#${escapeHtml(element.id)}</code>`]);
    if (element.classList?.length) rows.push(['Class', element.classList.map(c => `<code>.${escapeHtml(c)}</code>`).join(' ')]);
    // 组件来源放显眼位置：这是最省事的定位线索（可直接打开该文件）
    if (element.componentFile) {
      const short = String(element.componentFile).split(/[/\\]/).slice(-2).join('/');
      rows.push([
        '组件',
        `<code title="${escapeHtml(element.componentFile)}">${escapeHtml(short)}</code>` +
          (element.componentName ? ` <span class="dim">${escapeHtml(element.componentName)}</span>` : ''),
      ]);
    }
    // 源码行级定位（dev 埋点）：File.vue:行号 + 一键在编辑器中打开
    if (element.source) {
      const [file, line] = String(element.source).split(/:(\d+)$/).filter(Boolean);
      const shortFile = String(file || element.source).split(/[/\\]/).slice(-2).join('/');
      rows.push([
        '源码',
        `<code title="${escapeHtml(element.source)}">${escapeHtml(shortFile)}${line ? `:${line}` : ''}</code>` +
          ` <a class="src-open" href="${config.endpoint}/open?file=${encodeURIComponent(element.source)}" target="_blank" rel="noopener">打开源码</a>`,
      ]);
    }
    if (element.componentProps && Object.keys(element.componentProps).length) {
      rows.push([
        'Props',
        Object.entries(element.componentProps).map(([k, v]) => `<code>${escapeHtml(k)}</code><span class="dim">=${escapeHtml(truncate(String(v), 24))}</span>`).join(' '),
      ]);
    }
    const attrs = element.attributes && typeof element.attributes === 'object' ? Object.entries(element.attributes) : [];
    if (attrs.length) {
      rows.push([
        '属性',
        attrs.map(([k, v]) => `<code>${escapeHtml(k)}</code>${v === '' ? '' : `<span class="dim">="${escapeHtml(truncate(v, 24))}"</span>`}`).join(' '),
      ]);
    }
    if (element.text) rows.push(['文本', escapeHtml(truncate(element.text, 120))]);
    rows.push([
      '尺寸',
      `${element.rect.width} × ${element.rect.height} px` +
        (element.metrics?.clientWidth ? ` <span class="dim">（内容区 ${element.metrics.clientWidth}×${element.metrics.clientHeight}）</span>` : ''),
    ]);
    rows.push(['位置', `<span class="dim">x ${element.rect.x}, y ${element.rect.y}</span>`]);
    if (s) {
      // 标出「继承」：否则用户和模型都会以为改这个选择器就能改这块文字颜色
      const inherited = new Set(element.inheritedStyles || []);
      const mark = key => (inherited.has(key) ? ' <span class="warn">继承</span>' : '');
      rows.push([
        '颜色',
        `<span class="swatch" style="background:${escapeHtml(s.color)}"></span><code>${escapeHtml(s.color)}</code>${mark('color')}`,
      ]);
      const hasGradient = s.backgroundImage && s.backgroundImage !== 'none';
      rows.push([
        '背景',
        hasGradient
          ? `<span class="dim">渐变</span> <code class="wrap">${escapeHtml(truncate(s.backgroundImage, 60))}</code>`
          : `<span class="swatch" style="background:${escapeHtml(s.backgroundColor)}"></span><code>${escapeHtml(s.backgroundColor)}</code>`,
      ]);
      if (s.opacity && s.opacity !== '1') rows.push(['不透明度', escapeHtml(s.opacity)]);
      rows.push([
        '字号',
        `<code>${escapeHtml(s.fontSize)}</code> <span class="dim">/ ${escapeHtml(s.fontWeight)}</span>${mark('fontSize')}`,
      ]);
      rows.push(['行高', `<span class="dim">${escapeHtml(s.lineHeight)}</span>${mark('lineHeight')}`]);
      if (s.border && s.border !== '0px none rgb(0, 0, 0)' && !/^0px none/.test(s.border)) {
        rows.push(['边框', `<span class="dim">${escapeHtml(s.border)}</span>`]);
      }
      if (s.padding && s.padding !== '0px') rows.push(['内边距', `<span class="dim">${escapeHtml(s.padding)}</span>`]);
      if (s.borderRadius && s.borderRadius !== '0px') rows.push(['圆角', `<span class="dim">${escapeHtml(s.borderRadius)}</span>`]);
    }
    rows.push(['选择器', `<code class="wrap">${escapeHtml(element.selector)}</code>`]);
    rows.push(['视口', `<span class="dim">${mediaQueryLabel()} · ${window.innerWidth}×${window.innerHeight}</span>`]);
    rows.push([
      '定位',
      element.uniqueMatch
        ? '<span class="ok">唯一匹配</span>'
        : '<span class="warn">匹配不唯一，建议补充说明</span>',
    ]);
    const existing = findTaskBySelector(element.selector);
    if (existing) rows.push(['已有标注', escapeHtml(truncate(existing.instruction || '（未填写）', 80))]);
    return rows;
  }

  function renderDetailRows(element) {
    return detailRows(element)
      .map(([label, value]) => `<div class="detail-row"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${value}</span></div>`)
      .join('');
  }

  /** 用元素信息填充编辑面板内的详情区（不改变展开/收缩状态）。 */
  function fillDetails(element) {
    const box = $('[data-el="editorDetails"]');
    if (!box) return;
    state.detailsElement = element;
    if (!element) {
      box.innerHTML = '<p class="detail-empty">手动任务没有关联的页面元素。</p>';
      return;
    }
    box.innerHTML = renderDetailRows(element);
    // 附带元素：框选/Shift 多选并入的 meta.extraElements（新任务读 pendingMeta，已有任务读 meta）
    const extras = state.pendingMeta?.extraElements?.length
      ? state.pendingMeta.extraElements
      : (state.editingId ? findTask(state.editingId)?.meta?.extraElements : null) || [];
    if (extras.length) {
      const items = extras.map(e =>
        `<div class="detail-row"><span class="detail-label">附带元素</span><span class="detail-value"><code class="wrap">${escapeHtml(
          `${e.tagName || ''}${e.text ? `「${truncate(e.text, 24)}」` : ''} ${e.selector || ''}`.trim()
        )}</code></span></div>`
      ).join('');
      box.innerHTML += `<div class="detail-row"><span class="detail-label">附带元素</span><span class="detail-value">共 ${extras.length} 个（随主元素存入 meta.extraElements）</span></div>` + items;
    }
  }

  /** 切换详情区的展开与收缩。 */
  function toggleDetails(force) {
    const box = $('[data-el="editorDetails"]');
    const toggle = $('[data-el="detailToggle"]');
    if (!box) return false;
    const next = typeof force === 'boolean' ? force : box.classList.contains('hidden');
    box.classList.toggle('hidden', !next);
    toggle?.setAttribute('data-open', next ? 'on' : 'off');
    if (next) {
      // 展开详情时按内容重新测量弹窗位置，避免遮挡目标元素
      const elDesc = (state.editingId ? findTask(state.editingId)?.element : state.pendingElement) || null;
      placeEditor(elDesc, $('[data-el="editorInput"]'));
    } else if (state.manualMode) {
      // 手动任务贴着面板上方定位，位置由弹窗高度算出；收起详情后若不安置一次，
      // 弹窗会停用展开时的高度，与面板之间空出一块。元素任务锚定在元素旁，
      // 高度变化不影响锚点，无需重算。
      placeEditor(null, $('[data-el="editorInput"]'));
    }
    return next;
  }

  function isDetailsOpen() {
    const box = $('[data-el="editorDetails"]');
    return !!box && !box.classList.contains('hidden');
  }

  function detailsText() {
    const box = $('[data-el="editorDetails"]');
    if (!box || box.classList.contains('hidden')) return null;
    return box.textContent.replace(/\s+/g, ' ').trim();
  }

  async function copyDetails() {
    const element = state.detailsElement;
    if (!element) return;
    const text = [
      `标签：${element.tagName}${element.id ? ` #${element.id}` : ''}`,
      element.text ? `文本：${element.text}` : '',
      `尺寸：${element.rect.width} × ${element.rect.height}`,
      `位置：x ${element.rect.x}, y ${element.rect.y}`,
      element.styles ? `颜色：${element.styles.color} / 背景：${element.styles.backgroundColor}` : '',
      element.styles ? `字体：${element.styles.fontSize} ${element.styles.fontWeight} ${element.styles.fontFamily}` : '',
      `Selector：${element.selector}`,
      `XPath：${element.xpath}`,
      `DOM：${element.domSnippet}`,
    ]
      .filter(Boolean)
      .join('\n');
    const ok = await copyTextRobust(text);
    if (ok) {
      state.syncMessage = '已复制元素信息。';
    } else {
      // 宿主禁用了剪贴板写入：不谎报成功，把文本摊开让用户自己复制
      showManualCopy(text, '已复制元素信息。');
    }
    renderMessage();
  }

  /* ---------------- 图片：仅支持粘贴 ---------------- */

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files, source) {
    const list = Array.from(files || []).filter(f => f.type.startsWith('image/'));
    if (!list.length) return 0;
    for (const file of list) {
      const dataUrl = await readImageFile(file);
      const dims = await imageSize(dataUrl);
      state.pendingImages.push({
        id: `img_${Math.random().toString(36).slice(2, 10)}`,
        name: file.name || `${source}-${state.pendingImages.length + 1}`,
        source,
        mimeType: file.type,
        bytes: file.size,
        width: dims.width,
        height: dims.height,
        dataUrl,
      });
    }
    renderEditorImages();
    syncEditorInput();
    state.syncMessage = `已添加 ${list.length} 张图片。`;
    renderMessage();
    return list.length;
  }

  function imageSize(dataUrl) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: null, height: null });
      img.src = dataUrl;
    });
  }

  function renderEditorImages() {
    const wrap = $('[data-el="editorImages"]');
    if (!state.pendingImages.length) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = state.pendingImages
      .map(
        image => `
      <div class="thumb" data-thumb="${image.id}">
        <img src="${escapeHtml(imageSrc(image, config.endpoint))}" alt="${escapeHtml(image.name)}">
        <span class="thumb-size">${image.width ? `${image.width}×${image.height}` : ''}</span>
        <button type="button" class="link danger" data-drop-image="${image.id}" title="移除">✕</button>
      </div>`,
      )
      .join('');
  }

  /** 输入框随内容增高，并把提交按钮切到可提交状态。 */
  function syncEditorInput() {
    const input = $('[data-el="editorInput"]');
    const submit = $('[data-el="submitBtn"]');
    if (!input || !submit) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.3)}px`;
    const ready = !!input.value.trim() || state.pendingImages.length > 0;
    submit.dataset.ready = ready ? 'on' : 'off';
  }

  function onPaste(event) {
    if (editor.classList.contains('hidden')) return;
    const items = event.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    addImageFiles(files, 'paste');
  }

  /* ---------------- 就地编辑器 ---------------- */

  function openEditorFor(taskId, options = {}) {
    const task = findTask(taskId);
    if (!task) return;
    state.editingId = taskId;
    state.editingIsNew = false;
    // 必须按被编辑的任务重算：否则上次点了「手动」留下的 true 会让
    // 元素任务的弹窗也按面板定位，丢掉贴住目标元素的默认行为。
    state.manualMode = !task.element;
    state.pendingElement = null;
    state.pendingImages = (task.images || []).map(img => ({ ...img }));
    const input = $('[data-el="editorInput"]');
    $('[data-el="editorSeq"]').textContent = `#${task.seq || state.tasks.indexOf(task) + 1}`;
    $('[data-el="editorTarget"]').textContent = task.element
      ? task.element.accessibleName || task.element.text || task.element.tagName
      : '手动任务';
    // 非 todo（doing/review/done/blocked）：编辑器是「提交新要求」模式——
    // 当前指令对应在途工作或已验收结论，这里写下的文字不会改动它，
    // 而是存为 pendingInstruction，批次交付时**另建一条新任务**排队下一轮。
    // todo：普通编辑，Enter 即改当前指令。
    const nonTodo = task.status !== 'todo';
    input.readOnly = false;
    $('[data-el="editorHint"]').textContent = nonTodo
      ? '另建新任务 · 本条保持已交付 · Esc 取消'
      : 'Enter 确认 · Esc 取消';
    input.value = task.instruction || '';
    renderEditorImages();
    syncEditorInput();
    fillDetails(task.element || null);
    toggleDetails(!!options.expandDetails);
    placeEditor(task.element, input);
    // 选中元素虚线高亮：优先用确认时存下的真实元素引用（与当时选中完全一致），
    // 没有才按 selector 解析——解析可能回退到大容器把标记画成整卡
    const markEls = (() => {
      const cached = state.taskEls.get(task.id);
      if (cached?.length) return cached;
      const main = task.element?.selector ? resolveElement(task.element.selector) : null;
      const region = task.meta?.region;
      return [
        main,
        // 过滤：①祖先容器（把虚线框画成整卡）②主元素的子孙零件（input 壳/
        // 后缀图标等，主元素框已覆盖，重画会成嵌套小框）③蹭到选区边缘的大
        // 元素（如顶栏），要求矩形过半落在所画选区内才保留
        ...(task.meta?.extraElements || []).map(e => (e && e.selector ? resolveElement(e.selector) : null))
          .filter(n => {
            if (!n) return true;
            if (main && (n.contains(main) || main.contains(n))) return false;
            if (region) {
              const r = n.getBoundingClientRect();
              const iw = Math.min(region.x + region.width, r.right) - Math.max(region.x, r.left);
              const ih = Math.min(region.y + region.height, r.bottom) - Math.max(region.y, r.top);
              if (iw <= 0 || ih <= 0 || (iw * ih) < r.width * r.height * 0.5) return false;
            }
            return true;
          }),
      ];
    })();
    showSelectionMarks(markEls);
    renderList();
  }

  /** 为新建标注打开编辑器（内容尚未写进 state.tasks）。 */
  function openEditorForNew(element) {
    state.editingId = null;
    state.editingIsNew = true;
    state.manualMode = false;
    state.pendingImages = [];
    const input = $('[data-el="editorInput"]');
    $('[data-el="editorSeq"]').textContent = `#${nextSeq()}`;
    $('[data-el="editorTarget"]').textContent = element.accessibleName || element.text || element.tagName;
    $('[data-el="editorHint"]').textContent = 'Enter 确认 · Esc 取消 · 可粘贴图片';
    input.readOnly = false;
    input.value = '';
    renderEditorImages();
    syncEditorInput();
    fillDetails(element);
    toggleDetails(false);
    placeEditor(element, input);
    showSelectionMarks(state.pendingMarkEls.length
      ? state.pendingMarkEls
      : [element.selector ? resolveElement(element.selector) : null]);
  }

  /** 打开手动任务编辑器：不关联页面元素，可粘贴图片。 */
  function openEditorForManual() {
    state.editingId = null;
    state.editingIsNew = true;
    state.pendingElement = null;
    state.manualMode = true;
    state.pendingImages = [];
    const input = $('[data-el="editorInput"]');
    $('[data-el="editorSeq"]').textContent = `#${nextSeq()}`;
    $('[data-el="editorTarget"]').textContent = '手动添加的任务';
    $('[data-el="editorHint"]').textContent = 'Enter 确认 · Esc 取消 · 可粘贴图片';
    input.readOnly = false;
    input.value = '';
    renderEditorImages();
    syncEditorInput();
    fillDetails(null);
    toggleDetails(false);
    placeEditor(null, input);
    showSelectionMarks([]); // 手动任务无关联元素，清掉可能残留的选中标记
    renderList();
  }

  /**
   * 当前编辑会话应聚焦的元素选择器；null 表示没有可聚焦的元素
   * （手动任务、或正在编辑的目标已从页面消失），此时只保留轻遮罩。
   */
  function focusSelectorForEditor() {
    if (editor.classList.contains('hidden')) return null;
    if (state.editingId) return findTask(state.editingId)?.element?.selector || null;
    if (state.editingIsNew) return state.pendingElement?.selector || null;
    return null;
  }

  /**
   * 编辑弹窗的聚焦效果：
   * - 有目标元素 → spotlight 在元素处挖孔高亮（box-shadow 的 9999px 大阴影
   *   同时充当背景遮罩，元素本身保持在「孔」里全亮），veil 不显示；
   * - 无目标元素 → 只有 veil 轻遮罩，把注意力交给弹窗本身。
   * 两层都用 opacity/visibility 过渡而不是 display 切换，出现与消失带淡入淡出。
   */
  function updateFocusFx() {
    if (editor.classList.contains('hidden')) {
      clickShield.classList.add('hidden');
      if (!spotlight.classList.contains('on') && !veil.classList.contains('on')) return;
      spotlight.classList.remove('on');
      veil.classList.remove('on');
      return;
    }
    // 编辑器打开期间挡住整个页面。只有这个时机才拦：**标注模式下不拦**，
    // 因为「点选元素」正是靠页面自己接到点击来完成的，拦住就没法标注了。
    clickShield.classList.remove('hidden');
    // 手动任务不加任何视觉遮罩：这个弹窗的典型用法是「截个图粘进来」，
    // 遮罩会把要截的页面压暗，截出来的图自带一层灰。而且手动任务本来
    // 就没有可聚焦的目标元素，挖孔高亮无从谈起。
    // （拦截层是透明的，不影响截图，所以照常启用。）
    if (state.manualMode || (!state.editingId && !state.pendingElement)) {
      spotlight.classList.remove('on');
      veil.classList.remove('on');
      return;
    }
    const el = (() => {
      const selector = focusSelectorForEditor();
      return selector ? resolveElement(selector) : null;
    })();
    // 框选任务的高亮按用户实际画出的区域（meta.region），不只亮主元素：
    // 框住一组控件时聚光孔要罩住整组，而不是其中一个零件
    const metaRegion = state.editingId
      ? findTask(state.editingId)?.meta?.region
      : state.pendingMeta?.region;
    if (el || metaRegion) {
      // 聚光孔 = 主元素+附带元素的实时矩形并集：框选（region）与 Shift 多选
      // （extraElements）都要罩住整组。优先用拾取时存下的真实元素引用
      // （taskEls/pendingMarkEls），旧任务才按 selector 解析；meta.region
      // 冻结视口坐标只在元素全解析不到时兜底
      const markEls = state.editingId ? state.taskEls.get(state.editingId) : state.pendingMarkEls;
      const live = [];
      if (markEls && markEls.length) {
        for (const n of markEls) if (n && n.isConnected) live.push(n.getBoundingClientRect());
      } else {
        if (el) live.push(el.getBoundingClientRect());
        const extras = state.editingId
          ? findTask(state.editingId)?.meta?.extraElements
          : state.pendingMeta?.extraElements;
        for (const e of extras || []) {
          const n = e && e.selector ? resolveElement(e.selector) : null;
          // 祖先容器/子孙零件不参与聚光并集（存量任务的 extras 里可能混入
          // 容器链与控件内零件，前者把高亮孔撑成整卡，后者纯冗余）
          if (n && el && (n.contains(el) || el.contains(n))) continue;
          // 相交候选兜底可能收进「只蹭到选区边缘的大元素」（如顶栏/整卡容器），
          // 有 region 时要求元素矩形过半落在选区内，否则不参与并集
          if (n && metaRegion) {
            const r = n.getBoundingClientRect();
            const iw = Math.min(metaRegion.x + metaRegion.width, r.right) - Math.max(metaRegion.x, r.left);
            const ih = Math.min(metaRegion.y + metaRegion.height, r.bottom) - Math.max(metaRegion.y, r.top);
            if (iw <= 0 || ih <= 0 || (iw * ih) < r.width * r.height * 0.5) continue;
          }
          if (n) live.push(n.getBoundingClientRect());
        }
      }
      const rect = live.length
        ? {
            left: Math.min(...live.map(r => r.left)),
            top: Math.min(...live.map(r => r.top)),
            width: Math.max(...live.map(r => r.right)) - Math.min(...live.map(r => r.left)),
            height: Math.max(...live.map(r => r.bottom)) - Math.min(...live.map(r => r.top)),
          }
        : metaRegion
          ? { left: metaRegion.x, top: metaRegion.y, width: metaRegion.width, height: metaRegion.height }
          : null;
      const pad = 5;
      // 0 尺寸（元素被隐藏/移除）没有可高亮的区域，退回纯遮罩
      if (rect && rect.width > 0 && rect.height > 0) {
        // 不做视口夹取：孔必须与元素严格对齐，偏移的挖孔比出界更难看
        spotlight.style.left = `${rect.left - pad}px`;
        spotlight.style.top = `${rect.top - pad}px`;
        spotlight.style.width = `${rect.width + pad * 2}px`;
        spotlight.style.height = `${rect.height + pad * 2}px`;
        spotlight.classList.add('on');
        veil.classList.remove('on');
        return;
      }
    }
    spotlight.classList.remove('on');
    veil.classList.add('on');
  }

  /**
   * 弹窗定位。
   * - 有目标元素：贴元素下方，空间不足翻到上方，并夹在视口内；
   * - 无目标元素（手动任务、元素已从页面消失）：贴住右下角面板的上方。
   */
  /**
   * 收起态下编辑器可用的底边：胶囊与悬浮按钮这一簇的最上沿。
   * 悬浮按钮层即使处于隐藏（opacity/visibility）状态也有布局几何，
   * 因此可以直接测量，不用管此刻指针是否停在上面。
   */
  function editorClusterTop() {
    const dock = $('[data-el="dock"]');
    if (!dock || dock.classList.contains('hidden')) return null;
    const dockTop = dock.getBoundingClientRect().top;
    const float = $('[data-el="dockFloat"]');
    const floatTop = float ? float.getBoundingClientRect().top : dockTop;
    const top = Math.min(dockTop, floatTop);
    return Number.isFinite(top) && top > 0 ? top : null;
  }

  function placeEditor(selector, input, opts = {}) {
    editor.classList.remove('hidden');
    // 弹窗隐藏时 scrollHeight 恒为 0，openEditor* 在取消隐藏前调用的
    // syncEditorInput 会把输入条高度算成 0（首开 16px、二开 37px，
    // 看起来像弹窗"跳了一下"）。取消隐藏后必须重新量一次。
    syncEditorInput();
    // 弹窗打开期间悬停高亮与尺寸标签会跟聚光圈叠在一起，全部让位
    outline.style.display = 'none';
    hideSizeBadge();
    const el = selector ? resolveElement(selector) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(380, Math.max(260, vw - 24));
    editor.style.width = `${width}px`;
    // 先清掉上一轮的限高，否则量到的不是弹窗的自然高度
    editor.style.maxHeight = '';

    const GAP = 8;
    let top = 16;
    let left = 16;
    if (el) {
      const rect = el.getBoundingClientRect();
      const natural = editor.offsetHeight || 190;
      const spaceBelow = vh - rect.bottom - GAP * 2;
      const spaceAbove = rect.top - GAP * 2;
      // 优先选放得下自然高度的一侧；两侧都放不下时选空间大的那侧。
      // 不能只在「下方放不下就翻到上方」之间二选一：展开元素详情后弹窗可达
      // 400px 以上，两侧都放不下，旧逻辑会把 top 夹到最小值 8，
      // 弹窗直接跳到视口顶端盖住页面标题。
      let placeBelow;
      if (spaceBelow >= natural) placeBelow = true;
      else if (spaceAbove >= natural) placeBelow = false;
      else placeBelow = spaceBelow >= spaceAbove;
      const avail = Math.max(120, placeBelow ? spaceBelow : spaceAbove);
      // 用可用空间限高，让详情区自己滚动，而不是把弹窗挤出视口。
      editor.style.maxHeight = `${avail}px`;
      const height = Math.min(natural, avail);
      top = placeBelow ? rect.bottom + GAP : Math.max(GAP, rect.top - height - GAP);
      left = rect.left;
    } else {
      // 手动任务没有可锚定的元素。弹窗出现在页面中部会与右下角面板断开，
      // 用户点「手动」后视线要跑到别处找输入框，所以贴住面板上方、右边缘对齐。
      const height = editor.offsetHeight || 190;
      const panel = $('[data-el="panel"]');
      const panelRect = panel && !panel.classList.contains('hidden') ? panel.getBoundingClientRect() : null;
      if (panelRect) {
        left = panelRect.right - width;
        top = panelRect.top - height - GAP;
      } else {
        // 面板已收起：编辑器要落在胶囊与悬浮按钮之上，否则会压住刚点的
        // 「手动/复制」按钮（收起态下这两个按钮正在悬停显示，被盖住会显得点不动）。
        // 悬浮层隐藏时仍有布局几何，可直接测量，无需关心当前是否悬停。
        // 胶囊可拖拽换位：编辑器右缘对齐胶囊右缘，不再写死右下角。
        left = clampNum(bar.getBoundingClientRect().right - width, GAP, vw - width - GAP);
        const clusterTop = editorClusterTop();
        top = (clusterTop ?? vh - 72) - height - GAP;
      }
      // 与元素锚定同样的限高逻辑，避免面板上方空间不足时弹窗顶到视口顶端
      editor.style.maxHeight = `${Math.max(120, Math.min(height, top))}px`;
    }
    left = Math.min(Math.max(8, left), Math.max(8, vw - width - 8));
    top = Math.min(Math.max(8, top), Math.max(8, vh - 60));
    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
    updateFocusFx();
    setTimeout(() => {
      // focus:false 用于 DOM 稳定后的补定位——不打断正在进行的输入
      if (opts.focus === false) return;
      input.focus();
      // 光标放到末尾，便于继续编辑已有内容
      const len = input.value.length;
      try {
        input.setSelectionRange(len, len);
      } catch {
        /* 忽略 */
      }
    }, 0);
  }

  function closeEditor() {
    editor.classList.add('hidden');
    // 框选命中预览随编辑器关闭（确认/取消/Esc 统一走这里）
    regionMarks.classList.add('hidden');
    regionMarks.innerHTML = '';
    state.editingId = null;
    state.editingIsNew = false;
    state.manualMode = false;
    state.pendingElement = null;
    state.pendingImages = [];
    state.pendingMeta = null;
    state.pendingMarkEls = [];
    $('[data-el="editorInput"]').value = '';
    updateFocusFx();
    renderEditorImages();
    renderList();
  }

  /**
   * 确认录入：写入内容、落盘、生成图钉、关闭弹窗，并保持标注模式开启，
   * 以便直接点选下一个元素连续标注。
   */
  function confirmEditor() {
    const input = $('[data-el="editorInput"]');
    const text = input.value.trim();

    if (state.editingIsNew) {
      const element = state.pendingElement;
      const isManual = state.manualMode || !element;
      // 手动任务允许只有图片没有文字；元素标注仍要求有要求文本
      if (!text && !state.pendingImages.length) {
        closeEditor();
        return null;
      }
      const images = state.pendingImages.map(img => ({ ...img }));

      if (!isManual) {
        const existing = findTaskBySelector(element.selector);
        if (existing) {
          existing.instruction = text || existing.instruction;
          existing.images = mergeImages(existing.images, images);
          existing.updatedAt = new Date().toISOString();
          existing.history = [
            ...(existing.history || []),
            { at: new Date().toISOString(), event: 'instruction_updated', detail: text },
          ];
          state.editingId = null;
          finishConfirm(existing);
          return existing;
        }
      }

      const task = isManual ? createManualTask(text, images) : createTask(element, text, images);
      // 真实元素引用进内存 Map：重开编辑器时标记画「当时选中的元素」原样
      if (state.pendingMarkEls.length) state.taskEls.set(task.id, [...state.pendingMarkEls]);
      state.tasks.push(task);
      state.editingId = null;
      finishConfirm(task);
      return task;
    }

    if (state.editingId) {
      const task = findTask(state.editingId);
      if (task) {
        // 非 todo：编辑器是「提交新要求」模式——写入 pendingInstruction，
        // 当前指令/状态/结果一律不动（处理者按原指令收尾不受干扰），
        // 批次交付时另建一条新任务排队下一轮，本条保持终态归档。
        if (task.status !== 'todo') {
          if (!text || text === task.instruction || text === task.pendingInstruction) {
            // 没有提出新要求（含仅粘贴图片）：视为取消
            closeEditor();
            return null;
          }
          task.pendingInstruction = text;
          task.history = [...(task.history || []), { at: new Date().toISOString(), event: 'pending_instruction_updated', detail: text }];
          task.updatedAt = new Date().toISOString();
          finishConfirm(task);
          setReceipt('新要求已提交，交付后将另建一条待处理任务。', 6000);
          return task;
        }
        const hasImages = state.pendingImages.length > 0;
        if (!text && !hasImages && !String(task.instruction || '').trim()) {
          // 原本就是空的又确认空内容：视为取消，不留下空条目
          closeEditor();
          return null;
        }
        if (text !== task.instruction) {
          task.instruction = text;
          task.history = [...(task.history || []), { at: new Date().toISOString(), event: 'instruction_updated', detail: text }];
        }
        task.images = state.pendingImages.map(img => ({ ...img }));
        task.updatedAt = new Date().toISOString();
        finishConfirm(task);
        return task;
      }
    }
    closeEditor();
    return null;
  }

  /** 追加图片时按 id 去重，避免重复确认产生重复附件。 */
  function mergeImages(current, incoming) {
    const map = new Map((current || []).map(img => [img.id, img]));
    for (const img of incoming) map.set(img.id, img);
    return Array.from(map.values());
  }

  function finishConfirm(task) {
    // 点选瞬间发起的全视口截图：已 resolve 就地挂入，在途则落地后补挂并
    // 二次同步——截图是定位证据，不应阻塞用户连续标注。
    const shot = state.pendingShot;
    state.pendingShot = null;
    if (shot && task && task.element) {
      shot.then(pair => {
        if (!pair || !pair.ctx) return;
        // images[] 只挂裁剪图（默认证据，~300 token）；全视口走
        // meta.fullShot 独立通道落盘备查，不占默认读图负载。
        task.images = [
          { id: `ctx_${Date.now().toString(36)}`, name: 'context.png', source: 'auto-context', mimeType: 'image/png', dataUrl: pair.ctx },
          ...(task.images || []),
        ].slice(0, 8); // 与服务端 MAX_IMAGES_PER_TASK 对齐，自动图不挤掉用户贴图
        if (pair.full || pair.diag) task.meta = {
          ...(task.meta || {}),
          ...(pair.full ? { fullShot: { dataUrl: pair.full } } : {}),
          ...(pair.diag ? { snapDiag: pair.diag } : {}),
        };
        persistLocal();
        scheduleSync();
      });
    }
    persistLocal();
    scheduleSync();
    renderPins();
    renderList();
    renderMessage();
    // 暖下一张快照：连续标注时 2s 内复用，二次截图近 0 延迟（空闲调度防阻塞）
    scheduleSnapshot(config.endpoint);
    // 关闭弹窗但保持标注模式，方便连续点选
    editor.classList.add('hidden');
    state.editingId = null;
    state.editingIsNew = false;
    state.manualMode = false;
    state.pendingElement = null;
    state.pendingImages = [];
    const input = $('[data-el="editorInput"]');
    input.value = '';
    renderEditorImages();
    if (state.active) outline.style.display = 'none';
    updateFocusFx();
    return task;
  }

  /* ---------------- 任务操作 ---------------- */

  function nextSeq() {
    return state.tasks.reduce((max, t) => Math.max(max, Number(t.seq) || 0), 0) + 1;
  }

  function findTask(id) {
    return state.tasks.find(t => t.id === id) || null;
  }

  function findTaskBySelector(selector) {
    return state.tasks.find(t => t.element?.selector === selector) || null;
  }

  /** 手动任务：不关联页面元素，id 由时间戳与序号生成。 */
  function createManualTask(instruction, images) {
    const at = new Date().toISOString();
    const seq = nextSeq();
    return {
      id: `manual_${Date.now().toString(36)}_${seq}`,
      seq,
      kind: 'manual',
      instruction: instruction || '',
      status: 'todo',
      createdAt: at,
      updatedAt: at,
      confirmedAt: at,
      startedAt: null,
      completedAt: null,
      element: null,
      images: images || [],
      // 创建时刻的运行时尾部快照：最近的网络请求与控制台错误，随任务落盘
      meta: { ctx: runtimeTail.snapshot(), ...consumePendingMeta() },
      history: [{ at, event: 'created', detail: 'manual task' }],
      result: null,
    };
  }

  function createTask(element, instruction, images) {
    const at = new Date().toISOString();
    return {
      id: stableTaskId(pageUrl, element.selector),
      seq: nextSeq(),
      kind: 'element',
      instruction: instruction || '',
      status: 'todo',
      createdAt: at,
      updatedAt: at,
      confirmedAt: instruction ? at : null,
      startedAt: null,
      completedAt: null,
      element,
      images: images || [],
      // 创建时刻的运行时尾部快照：最近的网络请求与控制台错误，随任务落盘
      meta: { ctx: runtimeTail.snapshot(), ...consumePendingMeta() },
      history: [{ at, event: 'created', detail: 'picked in page' }],
      result: null,
    };
  }

  /** 删除单条：本地移除后立刻把删除同步到工作区 JSON。 */
  function removeTask(id) {
    const task = findTask(id);
    if (!task) return;
    if (task.status === 'doing') {
      // 处理中的任务不允许删除：删除会让处理者回写的 done 与结果失去对应记录
      state.syncMessage = `「${truncate(task.instruction || '未填写', 20)}」正在处理中，不能删除。可等处理完成，或让处理者标记为阻塞/取消。`;
      renderMessage();
      return;
    }
    state.tasks = state.tasks.filter(t => t.id !== id);
    state.taskEls.delete(id);
    queueOutbox('delete', { ids: [id] });
    if (state.editingId === id) closeEditor();
    persistLocal();
    renderPins();
    renderList();
    if (!state.tasks.length) {
      // 最后一条被删掉：整个页面的 JSON 与附件一并移除
      deleteRemote({ all: true });
    } else {
      deleteRemote({
        ids: [task.id],
        selectors: task.element?.selector ? [task.element.selector] : [],
      });
    }
    state.syncMessage = `已删除「${truncate(task.instruction || '未填写', 20)}」并同步工作区。`;
    renderMessage();
  }

  /**
   * 清空**全部页面**的标注，并删除工作区中对应数据。
   *
   * 面板展示的是跨页面队列，用户看到的「全部标注」就是全部分组——
   * 只清当前页会让其他页面残留，且当前页为空时报「还没有标注」明显答非所问。
   *
   * 处理中的任务不在清空范围内：它们正被某个处理者改代码，清掉会让其回写的
   * 结果无处可归。当前页与其他页面分组同样按 doing 保留并如实告知。
   */
  function clearAll() {
    const locked = state.tasks.filter(t => t.status === 'doing');
    const ids = state.tasks.map(task => task.id);
    state.tasks = locked;
    // 其它页面分组按同一规则本地收敛：只保留各组里处理中的任务，
    // 全空分组整组移除——与服务端 removeAllTasks 的保护语义一致。
    const remoteLocked = state.groups.reduce((n, g) => n + (g.tasks || []).filter(t => t.status === 'doing').length, 0);
    state.groups = state.groups
      .map(g => ({ ...g, tasks: (g.tasks || []).filter(t => t.status === 'doing') }))
      .filter(g => g.tasks.length);
    queueOutbox('delete', { ids });
    persistLocal();
    closeEditor();
    renderPins();
    renderList();
    // 一律发 allGroups: true，由服务端逐组按状态自行保留处理中的任务。
    deleteRemote({ all: true, allGroups: true });
    const kept = locked.length + remoteLocked;
    state.syncMessage = kept
      ? `已清空其余标注；${kept} 项处理中的标注已保留，不能被清空。`
      : '已清空全部页面的标注，并删除工作区数据。';
    renderMessage();
  }

  /**
   * 当前轮是否在途——直接读服务端轮次摘要，不再本地推断。
   *
   * 本地推断（取活动任务最大轮次号）在旧轮尚未归档时会把它当成当前轮，
   * 于是「按轮次」会被描述成本轮在途，实际服务端早已交付。服务端摘要里的
   * activeRound 才是权威：第一个任务进入 doing 时冻结，completeRound 后置空。
   * 摘要缺失（旧版运行时）才回落到本地推断，保证降级不崩。
   */
  function currentRoundInFlight() {
    if (state.serverRound && Object.prototype.hasOwnProperty.call(state.serverRound, 'activeRound')) {
      const currentRound = state.serverRound.activeRound;
      return { currentRound, inFlight: currentRound != null && !state.serverRound.complete };
    }
    const all = allProjectTasks();
    const withRound = all.filter(t => t.round != null);
    const currentRound = withRound.reduce((m, t) => Math.max(m, t.round), 0) || null;
    const scoped = currentRound ? withRound.filter(t => t.round === currentRound) : [];
    const complete = scoped.length > 0 && scoped.every(t => t.status === 'done' || t.status === 'cancelled');
    return { currentRound, inFlight: currentRound != null && !complete };
  }

  /**
   * 切换执行模式（round/queue）。模式决定本轮怎么收尾：立即写盘、SSE 广播
   * 到所有页面。本轮在途期间（首个 doing 到交付）锁定——收尾预期不能在
   * 处理中途漂移；按钮此时已置灰，这里再守一道防绕过。
   */
  async function setExecutionMode(mode) {
    if (!mode || mode === (state.execution?.mode || 'round')) return;
    if (executionLocked()) {
      setReceipt(`第 ${state.serverRound.activeRound} 轮处理中，交付后可切换执行模式。`, 6000);
      return;
    }
    try {
      const res = await fetch(`${config.endpoint}/execution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.execution = data.execution;
      // 切换响应带回权威轮次摘要；没有（旧版运行时）就保持原摘要不动，
      // 由 currentRoundInFlight 的降级分支兜底。
      if (data.round && typeof data.round === 'object') state.serverRound = data.round;
      renderModeSwitch();
      renderProgress();
      // 回执必须说清生效时机；分母两模式同口径，无需解释跳变
      const { inFlight } = currentRoundInFlight();
      setReceipt(mode === 'queue'
        ? (inFlight
          ? '已切换为按队列：本轮复核完毕后将自动归档并继续下一轮。'
          : '已切换为按队列：下一轮完成后将自动继续。')
        : (inFlight
          ? '已切换为按轮次：本轮复核完毕后停下，等你显式归档。'
          : '已切换为按轮次：下一轮完成后停在本轮。'));
    } catch (error) {
      setReceipt(`模式切换失败：${error.message}`, 6000);
    }
  }

  /**
   * 验收本轮：把当前轮所有待验收（review）的改动一次确认通过。
   *
   * 这是给「一次看完整批改动」准备的快捷入口——逐条点验收在七八条时要
   * 点七八次。仍走同一个 confirm 二次确认，且服务端只挑 review 置 done，
   * blocked/doing/todo 一个都不会被顺带标成完成。
   */
  function acceptRound() {
    const scope = roundScope();
    const review = scope.dispatched.filter(t => t.status === 'review');
    if (!review.length) {
      setReceipt('本轮没有待验收的任务。', 4000);
      return;
    }
    const round = state.serverRound && Object.prototype.hasOwnProperty.call(state.serverRound, 'activeRound')
      ? state.serverRound.activeRound
      : (Number.isInteger(state.execution?.activeRound) ? state.execution.activeRound : scope.currentRound);
    askConfirm({
      title: `验收本轮 ${review.length} 项改动？`,
      detail: `第 ${round ?? '当前'} 轮里 ${review.length} 项待验收标注将标记为已完成；未收尾的任务不受影响。`,
      confirmText: `验收 ${review.length} 项`,
      danger: false,
      onConfirm: () => acceptTasks({ round: round ?? null }),
    });
  }

  /**
   * 归档本轮：把全部任务组里已完成（done/cancelled）的任务移入归档。
   * 这是轮次的「交付」动作——验收通过后 100% 绿条常驻，由用户点此按钮
   * （或下一轮复制提示词时自动）完成交付。只动已完成任务，
   * 排队中的下一轮任务不受影响。
   */
  async function archiveRound() {
    // 归档目标轮次以服务端摘要为准：本地推断可能把未归档的旧轮当成当前轮，
    // 发出去的 round 会与服务端 activeRound 不匹配而被拒（active round mismatch）。
    const round = state.serverRound && Object.prototype.hasOwnProperty.call(state.serverRound, 'activeRound')
      ? state.serverRound.activeRound
      : (Number.isInteger(state.execution?.activeRound) ? state.execution.activeRound : roundScope().currentRound);
    if (!round) {
      setReceipt('当前没有可归档的活动轮次。');
      return;
    }
    try {
      const res = await fetch(`${config.endpoint}/complete-round`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zwa-client': 'annotator' },
        body: JSON.stringify({ round }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.action === 'blocked') {
        const obstacles = Array.isArray(data.obstacles) ? data.obstacles : (data.summary?.obstacles || []);
        const detail = obstacles.length
          ? obstacles.map(item => `${item.id}（${STATUS_LABELS[item.status] || item.status}）`).join('、')
          : '仍有未收尾任务';
        setReceipt(`第 ${round} 轮尚未收尾：${detail}`, 7000);
        await loadRemoteTasks({ quiet: true });
        return data;
      }
      const total = (data.archived || []).reduce((sum, item) => sum + (item.archived || 0), 0);
      setReceipt(data.action === 'continue'
        ? `第 ${round} 轮已交付：${total} 项已归档，队列将继续下一轮。`
        : `第 ${round} 轮已交付：${total} 项已归档。`);
      await loadRemoteTasks({ quiet: true });
    } catch (error) {
      setReceipt(`归档失败：${error.message}`, 6000);
    }
  }

  /**
   * 复制处理提示词：只给任务目录与执行要求两个绝对路径。
   * 复制本身除同步本地 outbox 外没有归档/定稿等副作用。
   */
  async function copyPrompt() {
    // 当前页有草稿要先同步；没有任务时绝不能调 syncNow——它把「空」当
    // 删除信号，会发出整组删除请求。其它页面是否有待处理由后面的组列表判断。
    // 没有本地未同步变更时，复制必须是纯只读动作；无条件 syncNow 会改写
    // 任务 updatedAt，导致用户只是复制提示词却改变任务数据。
    const saved = state.tasks.length && (state.outbox.length || state.dirty) ? await syncNow() : null;
    if (state.tasks.length && !saved && state.outbox.length) {
      setReceipt('任务尚未成功同步到工作区，无法确定文件地址。', 6000);
      return null;
    }
    const fallbackPath = saved?.absolutePath || saved?.relativePath || saved?.file || '';

    /**
     * 复制是只读的地址索引，不负责归档、不冻结轮次，也不输出页面文件快照。
     * 归档只能由显式「归档本轮」或 queue 边界动作完成；复制后新增页面任务
     * 仍能被模型从任务目录扫描到。
     */
    let taskDirectory = null;
    let groups = null;
    try {
      const data = await fetchTasksData();
      groups = data.groups;
      if (data.execution) {
        state.execution = data.execution;
        state.executionPath = data.executionPath;
        state.tasksPath = data.tasksPath;
      }
      state.serverRound = data.round;
      state.endpointManifestPath = data.endpointManifestPath;
      state.protocolPath = data.protocolPath;
      taskDirectory = data.tasksPath;
    } catch {
      // 任务地址读取失败时走下面的 fail-closed
    }

    const pendingGroups = (groups || [])
      .map(group => ({ ...group, pending: (group.tasks || []).filter(t => t.status === 'todo' || t.status === 'doing' || t.status === 'review' || t.status === 'blocked') }))
      .filter(group => group.pending.length);
    if (!taskDirectory || !state.protocolPath || !state.endpointManifestPath
      || !pathIsAbsolute(taskDirectory) || !pathIsAbsolute(state.protocolPath)
      || !pathIsAbsolute(state.endpointManifestPath)) {
      setReceipt('任务目录、执行要求文件或接口清单缺失，请升级标注运行时后重试。', 6000);
      return null;
    }
    if (!pendingGroups.length) {
      setReceipt(saved?.skipped
        ? '当前标注均已归档，工作区中没有待处理文件。重新标注后即可复制。'
        : '工作区里没有待处理的标注任务（可能均已完成或归档）。', 6000);
      return null;
    }

    const prompt = buildAddressPrompt(taskDirectory, state.protocolPath);
    if (!prompt) {
      setReceipt('任务目录或执行要求地址无效，请升级标注运行时后重试。', 6000);
      return null;
    }
    const summary = '任务目录与执行要求 2 个地址';
    const copied = await copyTextRobust(prompt);
    if (copied) {
      setReceipt(`提示词已复制，${summary}。`);
    } else {
      // 嵌入式宿主拒绝剪贴板时不把流程断在这里：展开文本让用户手动复制，
      // 否则「复制提示词」这个主入口在某些浏览器里直接不可用。
      showManualCopy(prompt, '');
    }
    return prompt;
  }

  /* ---------------- 页面事件 ---------------- */

  function isOwnUi(target) {
    return target === host || host.contains(target);
  }

  /* ---------------- 框选 / 多选 / 动画冻结 ---------------- */

  /** 点按→框选的位移阈值：超过才算拖拽，之下保持点选语义 */
  const DRAG_THRESHOLD = 8;
  /** 框选最小有效尺寸：拖出又拖回、选区过小 → 回退为点选 */
  const MIN_REGION = 10;

  function setFrozen(next) {
    state.frozen = next;
    if (next) {
      if (!state._freezeStyle) {
        const s = document.createElement('style');
        s.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}';
        state._freezeStyle = s;
      }
      if (!state._freezeStyle.isConnected) document.head.append(state._freezeStyle);
      state._frozenVideos = [...document.querySelectorAll('video')].filter(v => !v.paused && !v.ended);
      state._frozenVideos.forEach(v => { try { v.pause(); } catch { /* 忽略 */ } });
    } else {
      state._freezeStyle?.remove();
      (state._frozenVideos || []).forEach(v => { try { v.play().catch(() => {}); } catch { /* 忽略 */ } });
      state._frozenVideos = [];
    }
    const btn = shadow.querySelector('[data-act="freeze"]');
    if (btn) btn.dataset.active = next ? 'on' : 'off';
    state.syncMessage = next
      ? '已冻结页面动画与视频（用于捕捉动画/闪烁瞬态），再点恢复。'
      : '已恢复动画播放。';
    renderMessage();
  }

  /** 多选标记高亮：跟随 repositionPins 刷新（滚动/重排时贴住元素） */
  function renderPickmarks() {
    pickmarks.innerHTML = '';
    // 从元素引用渲染而非 selector 解析：同类控件 selector 相同会解析到同一节点，标记塌缩
    for (const node of state.multiPickEls) {
      if (!node || !node.isConnected) continue;
      const r = node.getBoundingClientRect();
      const mark = document.createElement('div');
      mark.className = 'pickmark';
      Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      pickmarks.append(mark);
    }
  }

  function clearMultiPick() {
    state.multiPick = [];
    state.multiPickEls = [];
    renderPickmarks();
  }

  /** 取走待合并 meta（region/extraElements），同时清空——消费语义，不污染下一任务 */
  function consumePendingMeta() {
    const m = state.pendingMeta;
    state.pendingMeta = null;
    return m && Object.keys(m).length ? m : {};
  }

  /**
   * 元素在该点是否「用户实际可见」：该点栈顶（首个非自身 UI 的元素）
   * 必须等于它或落在它内部——被弹层/遮罩盖住时栈顶是无关元素，判不可见。
   */
  function isTopmostVisible(el, x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    const top = stack.find(s => s.nodeType === 1 && !isOwnUi(s));
    return !!top && (top === el || el.contains(top));
  }

  /**
   * 全量矩形相交扫描：一次性遍历 DOM，收集与选区相交且有可见部分的元素。
   * 相比网格点采样——零漏网，且对被部分遮住的元素按「可见比例」如实裁剪；
   * 只在 mouseup 跑一次（约 30~60ms / 万级节点），不在拖拽路径上。
   * 可见性按 2×2 采样验证：任一采样点栈顶落在候选内部即算可见。
   */
  function collectRegionCandidates(rect) {
    const regionArea = rect.width * rect.height;
    const candidates = [];
    const walk = parent => {
      for (const el of parent.children) {
        if (el.nodeType !== 1 || isOwnUi(el) || el === document.documentElement || el === document.body) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const interW = Math.min(rect.x + rect.width, r.right) - Math.max(rect.x, r.left);
          const interH = Math.min(rect.y + rect.height, r.bottom) - Math.max(rect.y, r.top);
          if (interW > 0 && interH > 0) {
            const inter = interW * interH;
            const union = regionArea + r.width * r.height - inter;
            // 可见性验证：取相交区中心 + 三分点，任一点栈顶落在元素内即可见
            const ix = Math.max(rect.x, r.left);
            const iy = Math.max(rect.y, r.top);
            const pts = [
              [ix + interW / 2, iy + interH / 2],
              [ix + interW / 4, iy + interH / 4],
              [ix + (interW * 3) / 4, iy + (interH * 3) / 4],
            ];
            if (pts.some(([px, py]) => isTopmostVisible(el, px, py))) {
              candidates.push({ el, inter, iou: union > 0 ? inter / union : 0, area: r.width * r.height });
            }
          }
        }
        walk(el); // 不可剪枝：overflow/absolute 子元素可能越出父矩形
      }
    };
    walk(document.body);
    return candidates;
  }

  /**
   * 包容扫描：只收「完全落在选区内」的元素（2px 容差 + 可见性过滤），
   * 并折算出「最高层级」集合——任一祖先也在 contained 里的元素剔除，
   * 留各自分支最外层（祖先在框内优先祖先，深度零件让位整组容器）。
   * pickRegion 与拖拽实时预览共用，保证预览=实际命中。
   */
  function collectContainedElements(rect) {
    const TOL = 2;
    const contained = [];
    const walk = parent => {
      for (const el of parent.children) {
        if (el.nodeType !== 1 || isOwnUi(el) || el === document.documentElement || el === document.body) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 &&
            r.left >= rect.x - TOL && r.top >= rect.y - TOL &&
            r.right <= rect.x + rect.width + TOL && r.bottom <= rect.y + rect.height + TOL) {
          const pts = [
            [r.left + r.width / 2, r.top + r.height / 2],
            [r.left + 1, r.top + 1],
            [r.right - 1, r.bottom - 1],
          ];
          if (pts.some(([px, py]) => isTopmostVisible(el, px, py))) contained.push(el);
        }
        walk(el); // 不可剪枝：absolute/overflow 子元素可能越出父矩形
      }
    };
    walk(document.body);
    const set = new Set(contained);
    const topLevel = contained
      .filter(el => {
        let p = el.parentElement;
        while (p && p !== document.body) {
          if (set.has(p)) return false;
          p = p.parentElement;
        }
        return true;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
    return { set, topLevel };
  }

  /** 拖拽中的轻量估计：粗网格采样去重计数（不跑 describeElement），150ms 节流刷新徽标。 */
  function estimateRegionCount(rect) {
    const cols = Math.min(6, Math.max(2, Math.floor(rect.width / 60)));
    const rows = Math.min(6, Math.max(2, Math.floor(rect.height / 60)));
    const seen = new Set();
    for (let i = 0; i <= cols; i++) {
      for (let j = 0; j <= rows; j++) {
        const stack = document.elementsFromPoint(rect.x + (rect.width * i) / cols, rect.y + (rect.height * j) / rows) || [];
        const top = stack.find(s => s.nodeType === 1 && !isOwnUi(s) && s !== document.documentElement && s !== document.body);
        if (top) seen.add(top);
      }
    }
    return seen.size;
  }

  /**
   * 框选收尾。
   * 候选：包容模式——只收「完全落在选区内」的元素（2px 容差 + 可见性过滤）。
   * 主元素：嵌套层级中取「在框内的最高层级」（祖先也在框内时优先祖先）；
   * 多个最高层元素时，其 LCA 仍在框内则取 LCA，否则取面积最大者。
   * 零包容命中退回相交扫描兜底（IoU 最佳 / 选区中心点）。
   * 其余最高层元素按面积降序进 meta.extraElements（上限 12，selector 去重）。
   */
  function pickRegion(rect) {
    const region = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
    const { set: containedSet, topLevel } = collectContainedElements(rect);
    // 松手瞬间按最终选区精确重渲命中高亮（拖拽期是 150ms 节流的近似值），
    // 编辑器打开期间保留供用户确认标记是否正确——截图 filter 排除宿主不进图
    regionMarks.innerHTML = '';
    for (const el of topLevel.slice(0, 24)) {
      const r = el.getBoundingClientRect();
      const mark = document.createElement('div');
      mark.className = 'regionmark';
      mark._el = el; // 存引用供滚动/布局变化时跟随重排
      Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      regionMarks.append(mark);
    }
    regionMarks.classList.toggle('hidden', topLevel.length === 0);
    let primaryEl = null;
    if (topLevel.length === 1) {
      primaryEl = topLevel[0];
    } else if (topLevel.length >= 2) {
      // 多个最高层元素：其 LCA 若也完全在框内 → LCA 为主元素（框住一组控件要公共容器）；
      // LCA 超出框 → 取面积最大的最高层元素，其余进 extras
      let lca = topLevel[0];
      while (lca && lca !== document.body && !topLevel.every(e => lca === e || lca.contains(e))) {
        lca = lca.parentElement;
      }
      primaryEl = (lca && lca !== document.body && lca !== document.documentElement && !isOwnUi(lca) && containedSet.has(lca))
        ? lca
        : topLevel[0];
    }
    // 零包容命中（框太小/全在元素边缘）→ 退回相交扫描兜底：IoU 最佳或选区中心点
    const candidates = collectRegionCandidates(rect);
    candidates.sort((a, b) => b.iou - a.iou || b.inter - a.inter);
    if (!primaryEl && candidates.length && candidates[0].iou >= 0.05) primaryEl = candidates[0].el;
    if (!primaryEl) {
      const centerEl = document.elementFromPoint(
        Math.round(rect.x + rect.width / 2),
        Math.round(rect.y + rect.height / 2),
      );
      if (centerEl && centerEl.nodeType === 1 && !isOwnUi(centerEl)) primaryEl = centerEl;
    }
    const element = primaryEl ? describeElement(primaryEl) : null;
    // 真实元素引用进 pendingMarkEls：编辑器标记画「当时框中的最高层元素」原样，
    // 不经 selector 重新解析（解析回退会把标记扩成大容器/整卡）
    state.pendingMarkEls = primaryEl
      ? [primaryEl, ...topLevel.filter(e => e !== primaryEl)]
      : [];
    if (element) element.rect = { ...region };
    const seenSel = new Set(element ? [element.selector] : []);
    const extras = [];
    // extras 同为包容语义：其余最高层元素优先，不足时由相交候选补齐上下文；
    // 过滤两类污染源：①主元素的祖先容器 ②只蹭到选区边缘的大元素
    // （元素矩形过半须在选区内）——二者重解析后会把聚光并集撑成整卡
    for (const el of [...topLevel, ...candidates.map(c => c.el)]) {
      if (el === primaryEl) continue;
      // 主元素的祖先容器与子孙零件都不进 extras（input 壳/后缀图标这类
      // 内零件重解析后会画出嵌套小框；容器链则把高亮撑成整卡）
      if (primaryEl && (el.contains(primaryEl) || primaryEl.contains(el))) continue;
      const er = el.getBoundingClientRect();
      const iw = Math.min(rect.x + rect.width, er.right) - Math.max(rect.x, er.left);
      const ih = Math.min(rect.y + rect.height, er.bottom) - Math.max(rect.y, er.top);
      if (iw <= 0 || ih <= 0 || (iw * ih) < er.width * er.height * 0.5) continue;
      const d = describeElement(el);
      if (seenSel.has(d.selector)) continue;
      seenSel.add(d.selector);
      extras.push(d);
      if (extras.length >= 12) break;
    }
    state.pendingMeta = { region, extraElements: extras };
    // 与点选一致：松手即发起全视口上下文截图，按框选区域高亮
    state.pendingShot = new Promise(res =>
      setTimeout(() => captureContextShot(config.endpoint, region).then(res), 0)
    );
    if (element) {
      const existing = findTaskBySelector(element.selector);
      if (existing) {
        existing.element = element;
        existing.meta = { ...(existing.meta || {}), ...consumePendingMeta() };
        persistLocal();
        openEditorFor(existing.id);
        return;
      }
      state.pendingElement = element;
      openEditorForNew(element);
    } else {
      // 选区中心是空白：退化为手动任务，区域与采样仍在 meta 里
      openEditorForManual();
    }
  }

  function onMove(event) {
    // 待定拖拽：位移未超阈值时仍按点选处理（继续 hover 高亮，不显示选框）；
    // 超过阈值升格为框选——只更新选框与计数徽标，不再弹悬停高亮
    const m = state.marquee;
    if (m) {
      const dx = event.clientX - m.x0;
      const dy = event.clientY - m.y0;
      if (!m.moved && Math.max(Math.abs(dx), Math.abs(dy)) > DRAG_THRESHOLD) {
        m.moved = true;
        // 升格为框选的瞬间隐掉悬停描边——否则拖拽前最后悬停的大容器
        // （moved 分支提前 return，outline 不再更新）会一直框着外层大框
        outline.style.display = 'none';
        hideSizeBadge();
      }
      if (m.moved) {
        const x = Math.min(m.x0, event.clientX);
        const y = Math.min(m.y0, event.clientY);
        const w = Math.abs(dx);
        const h = Math.abs(dy);
        marqueeEl.classList.remove('hidden');
        Object.assign(marqueeEl.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
        // 拖拽中节流显示框内元素数 + 命中元素聚焦描边（预览=实际命中，松手即隐不进截图）
        if (!m._t || performance.now() - m._t > 150) {
          m._t = performance.now();
          marqueeLabel.textContent = `≈${estimateRegionCount({ x, y, width: w, height: h })} 个元素`;
          const { topLevel } = collectContainedElements({ x, y, width: w, height: h });
          regionMarks.innerHTML = '';
          for (const el of topLevel.slice(0, 24)) {
            const r = el.getBoundingClientRect();
            const mark = document.createElement('div');
            mark.className = 'regionmark';
            Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
            regionMarks.append(mark);
          }
          regionMarks.classList.toggle('hidden', topLevel.length === 0);
        }
        return;
      }
    }
    if (!state.active || state.editingId || state.editingIsNew) return;
    // 悬停高亮与点选走同一归一化：圈出的就是点下去会选中的控件
    const target = normalizePickTarget(event.target);
    if (isOwnUi(target)) return;
    state.hovered = target;
    if (!target || target.nodeType !== 1) {
      outline.style.display = 'none';
      hideSizeBadge();
      return;
    }
    const rect = target.getBoundingClientRect();
    outline.style.display = 'block';
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;

    // 悬停时显示元素宽高
    showSizeBadge(target);
  }

  /** 编辑器是否开着（编辑已有任务、点选新元素、手动任务都算）。 */
  function isEditing() {
    return !!(state.editingId || state.editingIsNew);
  }

  /**
   * mousedown 的默认行为是「激活控件 + 聚焦 + 起拖选择」，且发生在 click 之前。
   *
   * 只拦 click 是不够的：点页面输入框时它已经在 mousedown 阶段拿到焦点了，
   * click 才被拦下——用户此时已经开始往页面里打字。所以这里也要拦。
   *
   * 拦截范围是「编辑器开着」或「标注模式开着」这两种情况，而不只是标注模式：
   * 点图钉、点「手动」都会在非标注模式下打开编辑器，那时光标下仍有遮罩
   * （手动任务除外），若只按 state.active 判断，那条路径依旧完全穿透。
   */
  function onMouseDown(event) {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (!shouldBlockPageEvent({ ownUi: isOwnUi(target), editing: isEditing(), active: state.active })) return;
    event.preventDefault();
    if (isEditing()) { event.stopPropagation(); return; }
    // 合并手势：按下即进入「待定拖拽」——位移超阈值升格为框选（onMove），
    // 原地松手=点选（click 流程照常）。不 stopPropagation：页面照旧收到
    // mousedown，与点选时的透传行为一致。
    if (state.active && !isOwnUi(target)) {
      state.marquee = { x0: event.clientX, y0: event.clientY, moved: false };
      // 快照在 mousedown 就启动：菜单类点击会在 click 阶段触发导航/重渲染，
      // 若等 click 后才序列化 DOM，截到的是跳转后的版面，红框按旧 rect 画上去
      // 必然错位（历史 bug：截图像素与 element 元数据不一致）。预热进缓存后
      // captureContextShot 命中同一份 mousedown 时刻的 DOM。
      pageSnapshot(config.endpoint);
    }
  }

  /**
   * 框选松手：拖出过面积 → 建区域任务；原地点击（未移动）→ 让 click 照常走点选。
   * moved 时吞掉紧随的 click——mousedown/mouseup 已构成一次完整框选，
   * 再放行 click 会对落点元素重复开一次编辑。
   */
  function onMouseUp(event) {
    if (!state.marquee) return;
    const m = state.marquee;
    state.marquee = null;
    marqueeEl.classList.add('hidden');
    // regionMarks 不清：编辑器打开期间保留命中高亮供用户确认（截图 filter 排除宿主，不进图）
    const w = Math.abs(event.clientX - m.x0);
    const h = Math.abs(event.clientY - m.y0);
    // 未移动，或拖出又拖回导致选区过小 → 视为点选，放行 click 走正常点选流程
    if (!m.moved || w < MIN_REGION || h < MIN_REGION) {
      regionMarks.classList.add('hidden');
      regionMarks.innerHTML = '';
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    armClickSuppress('suppressClick');
    pickRegion({
      x: Math.min(m.x0, event.clientX),
      y: Math.min(m.y0, event.clientY),
      width: Math.abs(event.clientX - m.x0),
      height: Math.abs(event.clientY - m.y0),
    });
  }

  /**
   * 编辑器打开期间锁住焦点：应用里的弹窗（如 Naive UI 的 n-modal）自带
   * 焦点陷阱，会把刚聚焦到注释输入框的焦点立刻拉回弹窗——胶囊输入框
   * 看得见却打不了字。这里在 focusout 捕获阶段同步把焦点拉回输入框：
   * 同步 focus 会取消这次焦点转移，陷阱的 focusin 根本不会发生，也就
   * 不存在来回抢的抖动。编辑器自己的关闭路径（Esc/确认）会先改状态，
   * 此时 isEditing() 已为 false，不会拦截。
   */
  function onEditorFocusLeak(event) {
    if (!isEditing()) return;
    const input = $('[data-el="editorInput"]');
    if (!input) return;
    const fromOwnUi = event.target === host || host.contains(event.target);
    if (!fromOwnUi) return;
    const next = event.relatedTarget;
    if (next && (next === host || host.contains(next))) return;
    input.focus({ preventScroll: true });
  }

  function onClick(event) {
    // 控件归一化：点在控件内部零件时提升到控件根（el-select/el-input 等），
    // 点选、Shift 多选、悬停高亮三处口径一致——悬停圈什么就选中什么
    const target = normalizePickTarget(event.target);
    if (!target || target.nodeType !== 1) return;
    // 框选松手后的残余 click：吞掉，不进入点选流程
    if (state.suppressClick) {
      state.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      return;
    }
    if (!shouldBlockPageEvent({ ownUi: isOwnUi(target), editing: isEditing(), active: state.active })) return;

    // Shift+点击 = 多选累积：不建任务、不开编辑，只收进 multiPick 打高亮
    if (event.shiftKey && state.active && !isEditing()) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      const d = describeElement(target);
      // 取消判定按元素引用而非 selector：两个同类控件（如下拉框）可能生成
      // 相同 selector，按串判重会把「点第二个」误当「取消第一个」→ 越点越少
      const idx = state.multiPickEls.indexOf(target);
      if (idx >= 0) { state.multiPick.splice(idx, 1); state.multiPickEls.splice(idx, 1); }
      else if (state.multiPick.length < 12) { state.multiPick.push(d); state.multiPickEls.push(target); }
      renderPickmarks();
      state.syncMessage = `已选 ${state.multiPick.length} 个元素；普通点击主元素或按 Enter 以最后选中项为主元素填写说明，多选集合随任务存入 meta.extraElements（Shift+点击增减，Esc 清空）。`;
      renderMessage();
      return;
    }

    // 编辑器已打开时忽略页面点击，避免未确认的输入被静默丢弃。
    if (isEditing()) {
      // 必须真的把事件拦下，而不只是弹一句提示。此前这里只写消息就 return，
      // 没调 preventDefault，于是页面默认行为照常发生——实测遮罩可见时点
      // 页面复选框，勾选状态真的被切换了（遮罩只是视觉层，本身不拦事件）。
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      state.syncMessage = '请先按 Enter 确认或 Esc 取消当前输入。';
      renderMessage();
      return;
    }

    if (!state.active) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const element = describeElement(target);
    // 真实元素引用进 pendingMarkEls：标记画「当时点中的元素」原样，不经 selector 重解析
    state.pendingMarkEls = [target];
    // 多选收尾：普通点击把累积的 multiPick 并入本次任务的 meta.extraElements
    if (state.multiPick.length) {
      // 过滤按元素引用：同 selector 的不同元素（同类控件）不能被误剔出 extras
      const extras = state.multiPick.filter((_, i) => state.multiPickEls[i] !== target);
      if (extras.length) state.pendingMeta = { extraElements: extras };
      for (const n of state.multiPickEls) {
        if (n && n !== target) state.pendingMarkEls.push(n);
      }
      clearMultiPick();
    }
    const existing = findTaskBySelector(element.selector);
    // 截图推迟一拍启动：让编辑器/弹窗先渲染，DOM 序列化不占 pick 帧；
    // 传入活元素供成图前复测 rect（点击到出图之间元素位移时红框跟最终位置）
    state.pendingShot = new Promise(res =>
      setTimeout(() => captureContextShot(config.endpoint, element.rect, HOST_ID, target).then(res), 0)
    );
    if (existing) {
      existing.element = element;
      if (state.pendingMeta) existing.meta = { ...(existing.meta || {}), ...consumePendingMeta() };
      persistLocal();
      openEditorFor(existing.id);
      return;
    }
    state.pendingElement = element;
    openEditorForNew(element);
  }

  /**
   * Esc 分级释放：
   * 1) 确认框打开时，Esc 关闭确认框；
   * 2) 编辑器打开时，Esc 关闭编辑器；
   * 3) 编辑器已关闭时，Esc 只退出标注模式——不再收起面板（收起仅走面板头部收起钮）。
   */
  function onKeydown(event) {
    if (!viewer.classList.contains('hidden') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      event.stopPropagation();
      stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key === 'Escape') {
      if (!viewer.classList.contains('hidden')) {
        event.preventDefault();
        event.stopPropagation();
        viewer.classList.add('hidden');
        return;
      }
      if (!$('[data-el="manualCopy"]').classList.contains('hidden')) {
        event.preventDefault();
        event.stopPropagation();
        hideManualCopy();
        return;
      }
      if (!$('[data-el="confirm"]').classList.contains('hidden')) {
        event.preventDefault();
        event.stopPropagation();
        closeConfirm();
        return;
      }
      if (!editor.classList.contains('hidden')) {
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
        return;
      }
      // 拖拽中的框选可 Esc 取消；残余 click 要吞掉避免松手后误点选
      if (state.marquee) {
        event.preventDefault();
        event.stopPropagation();
        state.marquee = null;
        marqueeEl.classList.add('hidden');
        regionMarks.classList.add('hidden');
        regionMarks.innerHTML = '';
        armClickSuppress('suppressClick');
        return;
      }
      // 多选集合是标注模式的子状态，先清它再退标注模式
      if (state.multiPick.length) {
        event.preventDefault();
        event.stopPropagation();
        clearMultiPick();
        return;
      }
      if (state.active) {
        event.preventDefault();
        event.stopPropagation();
        // 只负责切换，退出文案由 setActive 统一写。之前在这里再赋一次
        // （带「再按 Esc 收起面板」后缀），会覆盖掉 setActive 里的消息。
        setActive(false);
        return;
      }
      // Esc 只取消标注拾取，不再兜底收面板（收起只能走面板头部的收起钮）
      return;
    }

    if (event.key !== 'Enter') return;
    // 多选收尾的键盘路径：Enter 以最后选中元素为主元素直接弹输入框，
    // 其余多选并入 meta.extraElements（与普通点击主元素同义，省一次手眼切换）
    if (state.active && !isEditing() && state.multiPick.length) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      const element = state.multiPick[state.multiPick.length - 1];
      const extras = state.multiPick.slice(0, -1);
      if (extras.length) state.pendingMeta = { extraElements: extras };
      const primaryEl = state.multiPickEls[state.multiPickEls.length - 1];
      state.pendingMarkEls = [primaryEl, ...state.multiPickEls.slice(0, -1)].filter(Boolean);
      clearMultiPick();
      state.pendingShot = new Promise(res =>
        setTimeout(() => captureContextShot(config.endpoint, element.rect, HOST_ID, primaryEl).then(res), 0)
      );
      const existing = findTaskBySelector(element.selector);
      if (existing) {
        existing.element = element;
        if (state.pendingMeta) existing.meta = { ...(existing.meta || {}), ...consumePendingMeta() };
        persistLocal();
        openEditorFor(existing.id);
        return;
      }
      state.pendingElement = element;
      openEditorForNew(element);
      return;
    }
    if (editor.classList.contains('hidden')) return;
    // Shadow DOM 外部的监听器拿到的 target 会被重定向为宿主元素，
    // 必须用 composedPath() 才能判断事件是否真的来自编辑框。
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!(path.includes(editor) || event.target === editor)) return;
    if (event.shiftKey) return; // Shift+Enter 换行
    if (isComposing(event)) return; // 输入法组合中不提交
    event.preventDefault();
    event.stopPropagation();
    confirmEditor();
  }

  function isComposing(event) {
    return event.isComposing || event.keyCode === 229;
  }

  /**
   * 控件归一化：点在表单控件内部零件（.el-select__wrapper、内部 input 等）
   * 时提升到控件根元素——同一控件不同位置点出的元素不一致、选择器还不稳定。
   * 取「最外层」匹配祖先：el-select 套内部 input 时归到 select 而不是内层零件。
   */
  const PICK_CONTROL_SEL = '.el-select, .el-input, .el-textarea, .el-date-editor, .el-input-number, .el-radio-group, .el-checkbox-group, .el-switch, .el-cascader, .el-autocomplete, .el-slider, select, button';
  function normalizePickTarget(el) {
    if (!el || el.nodeType !== 1 || isOwnUi(el)) return el;
    let best = null;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (p.matches && p.matches(PICK_CONTROL_SEL)) best = p;
    }
    return best || el;
  }

  function setActive(next) {
    state.active = next;
    document.documentElement.style.cursor = next ? 'crosshair' : '';
    if (!next) {
      outline.style.display = 'none';
      hideSizeBadge();
      closeEditor();
      // 退出标注模式顺带复位子状态：拖拽中、多选集合
      state.marquee = null;
      marqueeEl.classList.add('hidden');
      regionMarks.classList.add('hidden');
      regionMarks.innerHTML = '';
      clearMultiPick();
    }
    // 进/出标注模式各自给一条提示。之前只在 Esc 退出分支里写消息，
    // 点「标注」进入时消息不变，于是上一条（比如上一轮的「已退出…」）
    // 会一直挂着，看起来像操作没生效。放在这里可保证两条路径一致，
    // 也覆盖 API 调用的 start/stop。
    if (next) { bindDomWatch(); scheduleSnapshot(config.endpoint); } // 进入即空闲预热页面快照：首次点选截图近 0 延迟（rIC 防进入瞬间主线程阻塞）；DOM 监听保证弹窗等动态内容不命中陈旧缓存
    state.syncMessage = next
      ? '已进入标注模式：点按选元素、拖拽框选、Shift+点击多选（Enter 收尾，Esc 退出）。'
      : '已退出标注模式。';
    renderCapsule();
    renderPanelMeta();
    renderMessage();
  }

  /* ---------------- 胶囊拖拽 / 贴边吸附 / 布局持久化 ---------------- */

  function loadDockLayout() {
    try {
      const v = JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY) || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch { return null; }
  }
  function saveDockLayout() {
    try { localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(state.dockLayout ?? null)); } catch { /* 忽略 */ }
  }
  const clampNum = (v, lo, hi) => Math.min(Math.max(lo, v), Math.max(lo, hi));

  /** 把布局落到 .bar：free=left/top 定位；edge=贴边吸附耳片；null=回默认右下角 */
  function applyDockLayout() {
    const l = state.dockLayout;
    bar.classList.remove('edge-left', 'edge-right', 'edge-bottom');
    // pinned 字段已废弃（钉住按钮移除）：旧 localStorage 残留直接忽略，
    // 贴边态一律为悬浮模式（悬停展开、移开缩回）
    bar.classList.remove('pinned');
    if (!l) {
      // 回默认右下角：清掉全部内联定位，样式表 right:18/bottom:18 生效
      ['left', 'top', 'right', 'bottom'].forEach(p => bar.style.removeProperty(p));
      avoidAppChrome();
      syncBarAnchored();
      return;
    }
    // 定位时必须四边显式赋值：只设 left/top 而不盖 right/bottom，
    // 样式表默认 right:18/bottom:18 会同时生效 → 双锚定把胶囊拉成几百 px 的空白条。
    if (l.side === 'left' || l.side === 'right') {
      bar.classList.add(`edge-${l.side}`);
      bar.style.left = l.side === 'left' ? '0px' : 'auto';
      bar.style.right = l.side === 'right' ? '0px' : 'auto';
      // 钳制下限 vh-40：允许耳片沉到屏底角（snapY 也会给到这个值），
      // 原先 vh-90 把沉底落点又顶回半腰——「拖不下去」就是它。
      bar.style.top = `${clampNum(l.y ?? 140, 40, window.innerHeight - 40)}px`;
      bar.style.bottom = 'auto';
      avoidEdgeChrome(l.side);
    } else if (Number.isFinite(l.x) && Number.isFinite(l.y)) {
      bar.style.left = `${clampNum(l.x, 0, window.innerWidth - 90)}px`;
      bar.style.right = 'auto';
      // 与拖拽钳制一致：允许底部伸出屏外，保底 20px 抓手
      bar.style.top = `${clampNum(l.y, 0, window.innerHeight - 20)}px`;
      bar.style.bottom = 'auto';
    }
    syncBarAnchored();
  }

  /**
   * 默认落点避障：右下角常被应用自己的底栏/悬浮控件占着（如 Master Dock
   * 标签条），胶囊直接压上去会盖住它的图标。取胶囊中心点命中栈里最上层
   * 的非标注元素——贴屏底的窄条（≤200px）视为应用 chrome，把胶囊抬到
   * 它上方 10px；大面积背景内容（地图/表格）照常覆盖不避让。
   */
  function avoidAppChrome() {
    try {
      const dockEl = $('[data-el="dock"]');
      const r = (dockEl || bar).getBoundingClientRect();
      if (r.width < 10) return;
      // 采样点打在胶囊底缘内 2px——胶囊与应用底栏的重叠发生在底部条带，
      // 取中心点会落到底栏上方的内容里而漏判
      const stack = document.elementsFromPoint(
        r.left + r.width / 2, r.bottom - 2) || [];
      let need = 0;
      for (const el of stack) {
        if (el === host || host.contains(el)) continue;
        if (el === document.documentElement || el === document.body) continue;
        const er = el.getBoundingClientRect();
        if (er.height > 200) break; // 命中大背景内容：底下的被它盖住，不避让
        if (er.bottom < window.innerHeight - 4) continue; // 不贴屏底的小元素：底栏里的按钮等，继续向下找
        // 贴屏底的窄条 = 应用底栏/悬浮 chrome；嵌套多层时抬到最外层上方 10px
        need = Math.max(need, window.innerHeight - er.top + 10);
      }
      if (need > 18 && need < window.innerHeight * 0.5) {
        bar.style.bottom = `${need}px`;
        bar._avoidChrome = true;
        return;
      }
      // 底栏消失（切页/收起）：把之前抬过的胶囊放回默认位
      if (bar._avoidChrome) {
        bar._avoidChrome = false;
        bar.style.removeProperty('bottom');
      }
    } catch {}
  }

  /**
   * 贴边耳片避障：应用右缘常有自带的悬浮控件列（地图工具、收展钮），
   * 耳片贴边会压住它们。在耳片中心采样命中栈，命中交互控件时上溯到
   * 贴缘的定位祖先（整列按钮视为一个阻挡体），把耳片挪到它下方；
   * 下方放不下则抬到上方。阻挡消失后恢复拖拽落点原位。
   */
  function avoidEdgeChrome(side) {
    try {
      const l = state.dockLayout;
      if (!l || l.side !== side) return;
      const ear = $('[data-el="edgeTab"]') || bar;
      const vw = window.innerWidth, vh = window.innerHeight;
      for (let attempt = 0; attempt < 6; attempt++) {
        const er0 = ear.getBoundingClientRect();
        // 采样点取耳片自身中心：应用的悬浮工具条不一定贴屏缘（如地图
        // 工具列 absolute 在画布内缘），采样屏缘会漏掉它
        const cy = Math.min(vh - 4, Math.max(4, er0.top + er0.height / 2));
        const stack = document.elementsFromPoint(er0.left + er0.width / 2, cy) || [];
        let hit = null;
        for (const el of stack) {
          if (el === host || host.contains(el)) continue;
          if (el === document.documentElement || el === document.body) continue;
          const er = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          // 大面积蒙层/背景不是控件：半透明的（loading mask 等）穿透继续找
          // 下层控件；不透明的才算真背景，停止
          if (er.width * er.height > vw * vh * 0.25) {
            const m = cs.backgroundColor.match(/[\d.]+/g);
            const translucent = parseFloat(cs.opacity) < 0.95
              || (m && m.length >= 4 && parseFloat(m[3]) < 0.9);
            if (translucent) continue;
            break;
          }
          // 普通静态内容被耳片压住是悬浮件的常态，不避让；
          // 只有交互控件或浮层容器才算阻挡
          const interactive = el.closest &&
            el.closest('button,a,input,select,textarea,[role="button"],[class*="btn"],[class*="tool"]');
          const floating = cs.position === 'fixed' || cs.position === 'absolute';
          if (!interactive && !floating) break;
          hit = el;
          break;
        }
        if (!hit) {
          // 无阻挡：恢复被自动挪开前的落点
          if (l._origY != null) {
            l.y = l._origY;
            delete l._origY;
            bar.style.top = `${clampNum(l.y, 40, vh - 40)}px`;
          }
          return;
        }
        // 上溯到浮层祖先：整列按钮容器当一个阻挡体（如 map-floating-toolbar）
        let blk = hit;
        for (let p = hit.parentElement; p && p !== document.body; p = p.parentElement) {
          const ps = getComputedStyle(p), pr = p.getBoundingClientRect();
          if ((ps.position === 'fixed' || ps.position === 'absolute')
              && pr.height < vh * 0.8 && pr.width < vw * 0.5) blk = p;
          else break;
        }
        const br = blk.getBoundingClientRect();
        const down = br.bottom + 10;
        const up = br.top - er0.height - 10;
        const ny = down + er0.height + 8 < vh ? down : Math.max(8, up);
        if (Math.abs(ny - er0.top) < 4) return; // 已在避让位，不再振荡
        if (l._origY == null) l._origY = l.y;
        l.y = ny;
        bar.style.top = `${ny}px`;
      }
    } catch {}
  }

  /** 面板跟随胶囊：贴胶囊上方、水平按胶囊所在半屏对齐；胶囊近顶时翻到下方（toast 已改顶部居中，不再锚定） */
  function syncBarAnchored() {
    // 面板展开时胶囊隐藏、bar 塌成零点，直接量 bar 会锚错
    // （右缘贴到胶囊左缘、高度取 0）——改用胶囊最后一次实测矩形。
    const dockEl = $('[data-el="dock"]');
    const live = dockEl ? dockEl.getBoundingClientRect() : null;
    if (live && live.width > 10) {
      state.lastDockRect = { left: live.left, right: live.right, top: live.top, bottom: live.bottom, width: live.width };
    }
    const r = (!state.collapsed && state.lastDockRect) ? state.lastDockRect : bar.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const panel = $('[data-el="panel"]');
    bar.classList.toggle('flip-top', r.top < 80 && !(state.dockLayout && state.dockLayout.side));
    // 面板有自定义布局（拖拽自由悬浮/左右吸边）时不再跟随胶囊锚定
    if (state.panelLayout) { applyPanelLayout(); return; }
    // 无布局=固定态：补一次显隐同步（固定钮/右箭头互斥在这里也要生效）
    applyPanelLayout();
    const alignLeft = r.left + r.width / 2 < vw / 2;
    if (alignLeft) {
      panel.style.left = `${Math.max(8, r.left)}px`; panel.style.right = 'auto';
    } else {
      panel.style.right = `${Math.max(8, vw - r.right)}px`; panel.style.left = 'auto';
    }
    if (r.top > 110) {
      panel.style.bottom = `${vh - r.top + 8}px`; panel.style.top = 'auto';
    } else {
      panel.style.top = `${Math.min(vh - 8, r.bottom + 8)}px`; panel.style.bottom = 'auto';
    }
  }

  /**
   * 胶囊拖拽：按下位移 >5px 进入拖动（left/top 直写），松手按落点判定——
   * 距左/右缘 <90px 吸附成耳片（悬浮模式，悬停滑出），否则自由悬浮；
   * 结果持久化 localStorage。从贴边耳片拖出时先摘 edge 类，
   * 胶囊在指针下完整展开再跟手。
   */
  function onBarPointerDown(event) {
    if (event.button !== 0) return;
    // 归档抽屉有自己的拖拽/交互，不能连带拖走整条 bar（药丸会一起动）
    if (event.target.closest('.panel')) return;
    const rect = bar.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    const offX = startX - rect.left, offY = startY - rect.top;
    let dragging = false;
    const move = ev => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        dragging = true;
        bar.classList.add('dragging');
        // 从贴边耳片拖出：无条件摘 edge 类——不能只靠 dockLayout.side 判断，
        // 布局状态丢失/不一致时耳片仍在但 side 为 null，胶囊会滑着移出屏幕。
        bar.classList.remove('edge-left', 'edge-right', 'edge-bottom');
        if (state.dockLayout && state.dockLayout.side) state.dockLayout.side = null;
      }
      if (!dragging) return;
      // 底边不吸附，但允许拖出屏外：留 20px 抓手防整条丢进屏外拿不回来。
      const nx = clampNum(ev.clientX - offX, 0, window.innerWidth - rect.width);
      const ny = clampNum(ev.clientY - offY, 0, window.innerHeight - 20);
      bar.style.left = `${nx}px`;
      bar.style.top = `${ny}px`;
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      ev.preventDefault();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('mouseup', up);
      bar.classList.remove('dragging');
      if (!dragging) return;
      dragging = false; // 双监听（pointerup+mouseup）谁先触发谁生效，防止二次进入
      armClickSuppress('suppressUiClick'); // 吞掉松手后的 click，防误触胶囊按钮
      const r2 = bar.getBoundingClientRect();
      // 吸附判定看胶囊最近「边缘」距屏缘：贴到屏缘松手即吸附。
      // 不能用中心点——胶囊本身 ~190px 宽，贴缘时中心距缘近百像素，
      // 中心阈值会永远差一点点吸不上（实测踩过）。
      // 阈值 20px：只有真的贴到屏缘才吸附，离边一段距离松手保持自由悬浮
      // （用户反馈 40px 太贪，拖在右下区域被误吸走）。
      const EDGE_SNAP = 20;
      // 只吸附左右贴边；底边/顶边一律当自由悬浮（用户明确不要上下吸附）
      const side = r2.left < EDGE_SNAP ? 'left'
        : window.innerWidth - r2.right < EDGE_SNAP ? 'right'
        : null;
      // 贴边后的耳片高度：默认跟随松手位置；落点已近底（距底 <90px）时
      // 沉到屏底附近（耳片底留 ~26px），不在半腰留大空档也不死贴底缘。
      const snapY = window.innerHeight - r2.bottom < 90
        ? window.innerHeight - 60
        : r2.top;
      state.dockLayout = side
        ? { side, y: snapY, pinned: false }
        : { x: r2.left, y: r2.top, side: null, pinned: false };
      saveDockLayout();
      applyDockLayout();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, { once: true });
    // 兜底：部分嵌入/合成事件流 pointerup 可能缺失，mouseup 一定到
    window.addEventListener('mouseup', up, { once: true });
  }

  /** 面板布局持久化：拖拽/吸边/固定模式跨刷新保留。 */
  function loadPanelLayout() {
    try {
      const v = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch { return null; }
  }
  function savePanelLayout() {
    try {
      const l = state.panelLayout;
      // retracted 并入布局持久化：悬浮收成边耳跨页/刷新后仍是边耳
      localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(l ? { ...l, retracted: !!state.panelRetracted } : null));
    } catch { /* 忽略 */ }
  }

  /** 把面板布局落到 DOM：null 时交还 syncBarAnchored 跟随胶囊；
      吸边态顺带处理悬浮模式的边耳显隐与固定钮可见性。 */
  function applyPanelLayout() {
    const panel = $('[data-el="panel"]');
    const tab = $('[data-el="panelEdgeTab"]');
    if (!panel || !tab) return;
    const l = state.panelLayout;
    panel.classList.remove('edge-left', 'edge-right');
    if (!l) {
      panel.classList.remove('retracted');
      tab.classList.add('hidden');
      $('[data-el="panelPinBtn"]')?.classList.add('hidden');
      $('[data-el="panelPinBtn"]')?.classList.remove('on');
      $('[data-el="panelEarBtn"]')?.classList.remove('hidden');
      return;
    }
    const vh = window.innerHeight;
    if (l.side === 'left' || l.side === 'right') {
      panel.classList.add(`edge-${l.side}`);
      // 吸边留 5px 缝：面板与屏幕边缘不死贴（药丸吸边仍贴死，两态不同口径）
      panel.style.left = l.side === 'left' ? '5px' : 'auto';
      panel.style.right = l.side === 'right' ? '5px' : 'auto';
      // 底边距屏幕下缘 ≥5px：面板不许沉出可视区
      panel.style.top = `${clampNum(l.y ?? 80, 0, Math.max(0, vh - panel.offsetHeight - 5))}px`;
      panel.style.bottom = 'auto';
    } else if (Number.isFinite(l.x) && Number.isFinite(l.y)) {
      panel.style.left = `${clampNum(l.x, 0, window.innerWidth - 120)}px`;
      panel.style.right = 'auto';
      panel.style.top = `${clampNum(l.y, 0, Math.max(0, vh - panel.offsetHeight - 5))}px`;
      panel.style.bottom = 'auto';
    }
    // 悬浮模式（吸边且未固定）：收成边耳只露一条，悬停边耳滑出；
    // 面板收起为胶囊时胶囊本身就是收起态，边耳不再出现（双收起态打架）
    const retracted = !!(l.side && !l.pinned && state.panelRetracted && !state.collapsed);
    panel.classList.toggle('retracted', retracted);
    tab.classList.toggle('hidden', !retracted);
    if (retracted) {
      tab.classList.toggle('edge-left', l.side === 'left');
      tab.classList.toggle('edge-right', l.side === 'right');
      tab.style.top = `${clampNum(l.y ?? 80, 40, vh - 80)}px`;
      tab.style.transform = 'none'; // 盖掉默认 translateY(-50%)，顶边=面板顶边
      // 边耳数字=全站未归档任务总数（本页+其它页），与药丸口径一致；0 也显示
      const live = state.tasks.filter(t => t && t.status !== 'archived').length
        + state.groups.reduce((sum, g) => sum + ((g.tasks || []).filter(t => t && t.status !== 'archived').length), 0);
      const cnt = $('[data-el="panelEdgeCount"]');
      if (cnt) cnt.textContent = String(live);
    }
    // 固定钮与右箭头互斥：悬浮态（吸边未固定）只显示固定钮，固定态只显示右箭头
    const floating = !!(l.side && !l.pinned);
    const pin = $('[data-el="panelPinBtn"]');
    pin?.classList.toggle('on', !!(l.side && l.pinned));
    pin?.classList.toggle('hidden', !floating);
    $('[data-el="panelEarBtn"]')?.classList.toggle('hidden', floating);
    pin?.setAttribute('title', l.pinned
      ? '固定模式：吸边保持展开（点击切悬浮模式，移开收成边耳）'
      : '固定：点击锁定为固定面板');
  }

  /**
   * 面板头拖拽：位移 >5px 进入拖动（直写 left/top），松手按落点判定——
   * 距左/右缘 <20px 吸边（与胶囊同一阈值口径），否则自由悬浮。
   * 吸边默认固定模式（pinned），点头上的钉钮切悬浮模式。
   */
  function onPanelHeadPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return; // 头部按钮不吃拖拽
    const panel = $('[data-el="panel"]');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    const offX = startX - rect.left, offY = startY - rect.top;
    let dragging = false;
    const move = ev => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        dragging = true;
        panel.classList.add('dragging');
        // 从吸边态拖出：先摘 edge 类，面板在指针下完整展开再跟手
        panel.classList.remove('edge-left', 'edge-right', 'retracted');
      }
      if (!dragging) return;
      const nx = clampNum(ev.clientX - offX, 0, window.innerWidth - 120);
      // 底边夹紧：面板下缘不许拖出屏幕，至少留 5px
      const ny = clampNum(ev.clientY - offY, 0, Math.max(0, window.innerHeight - rect.height - 5));
      panel.style.left = `${nx}px`;
      panel.style.top = `${ny}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      ev.preventDefault();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('mouseup', up);
      panel.classList.remove('dragging');
      if (!dragging) return;
      dragging = false;
      armClickSuppress('suppressUiClick');
      const r2 = panel.getBoundingClientRect();
      // 松手必吸边：不允许面板停在页面中间——按面板中线距左右缘的
      // 远近决定吸左还是吸右，纵向保留松手位置。
      const side = r2.left <= window.innerWidth - r2.right ? 'left' : 'right';
      // 吸边默认固定模式；保留同侧已存 pinned 选择
      const keepPinned = state.panelLayout && state.panelLayout.side === side ? !!state.panelLayout.pinned : true;
      state.panelLayout = { side, y: r2.top, pinned: keepPinned };
      state.panelRetracted = false;
      savePanelLayout();
      applyPanelLayout();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('mouseup', up, { once: true });
  }

  /** 悬浮模式：指针移出面板收成边耳；边耳悬停滑出（点击=固定展开）。 */
  function bindPanelDocking() {
    const panel = $('[data-el="panel"]');
    const head = $('[data-el="panelHead"]');
    const tab = $('[data-el="panelEdgeTab"]');
    head?.addEventListener('pointerdown', onPanelHeadPointerDown);
    // 双击面板头复位：清除自定义布局，回到跟随胶囊的默认锚定
    head?.addEventListener('dblclick', event => {
      if (event.target.closest('button')) return;
      state.panelLayout = null;
      state.panelRetracted = false;
      savePanelLayout();
      syncBarAnchored();
    });
    panel?.addEventListener('mouseleave', () => {
      const l = state.panelLayout;
      if (l && l.side && !l.pinned && !state.panelRetracted
          && viewer.classList.contains('hidden') && !archPopOpen()) {
        state.panelRetracted = true;
        savePanelLayout(); // 收成边耳跨页保持
        applyPanelLayout();
      }
    });
    tab?.addEventListener('mouseenter', () => {
      // 悬停只是预览：内存态滑出，不写持久化——否则悬停一下跳页，
      // 新页面会莫名弹开面板。真正定住靠点击边耳（pinned=true）。
      if (state.panelRetracted) {
        state.panelRetracted = false;
        applyPanelLayout();
      }
    });
  }

  /** 武装「吞下一次 click」标志，350ms 后自愈。
      松手点在胶囊/页面外时残余 click 到不了对应监听器，布尔标志不设过期
      会挂住误吞下一次真实点击（悬浮展开后首次点按钮无效就是它）。 */
  function armClickSuppress(key) {
    state[key] = true;
    setTimeout(() => { state[key] = false; }, 350);
  }

  /** 三态边缘守恒：面板下边 = 收起药丸下边。
      吸边面板收起时把胶囊搬到「同侧边、底缘=面板底缘」的位置，
      再展开面板回到 panelLayout 原位——收缩前后视觉锚点不动。 */
  function syncCollapseAnchor() {
    const panel = $('[data-el="panel"]');
    const l = state.panelLayout;
    if (!panel || !l || !panel.offsetHeight) return;
    const r = panel.getBoundingClientRect();
    const dockH = (state.lastDockRect && state.lastDockRect.bottom - state.lastDockRect.top) || 40;
    state.dockLayout = l.side
      ? { side: l.side, y: r.bottom - dockH }
      : { x: r.left, y: r.bottom - dockH, side: null };
    saveDockLayout();
    applyDockLayout();
  }

  function setCollapsed(next) {
    if (next) syncCollapseAnchor();
    state.collapsed = next;
    persistCollapsed();
    // 收起是「面板自己消失」这种自明的动作，不该再复用上一条消息。
    // 不清的话，Esc 两级操作（先退出标注模式、再收起面板）会在收起时
    // 把「已退出标注模式。」当成收起动作的回执再弹一次，看起来像重复执行。
    if (next) state.syncMessage = '';
    renderBar();
  }

  function renderBar() {
    $('[data-el="dock"]').classList.toggle('hidden', !state.collapsed);
    $('[data-el="panel"]').classList.toggle('hidden', state.collapsed);
    bar.classList.toggle('panel-open', !state.collapsed);
    syncBarAnchored();
    if (!state.collapsed) renderList();
    renderCapsule();
    // 收起态不跑 renderList（不做列表渲染），收起条必须在这里单独刷新，
    // 否则「展开→收起」后细条不会出现，或收起时仍残留上次的宽度。
    renderProgress();
    // 展开/收起只切换承载位置，文案与回执优先级仍交给 renderMessage 统一决定，
    // 否则展开面板时会把压在回执下面的后台消息提前显示出来。
    renderMessage();
  }

  function expandBar() {
    setCollapsed(false);
    // 药丸展开默认进「固定面板」：若曾吸边悬浮，强制锁定，不回落成悬耳
    if (state.panelLayout && state.panelLayout.side) {
      state.panelLayout.pinned = true;
      state.panelRetracted = false;
      savePanelLayout();
      applyPanelLayout();
    }
  }

  /* ---------------- 检验归档（已完成 → 已归档 人工核对入口） ---------------- */

  /** 归档视图状态跨页面持久化：点页面跳转后新页面要能回到同样的核对现场。 */
  const archDrawerKey = `${SOURCE}:arch-drawer`;
  function persistArchDrawer() {
    try {
      localStorage.setItem(archDrawerKey, JSON.stringify({
        open: state.archiveDrawerOpen,
        tasksOpen: state.tasksRegionOpen,
        openState: state.archOpenState,
      }));
    } catch { /* 存储不可用时归档视图仅在当前页有效 */ }
  }

  /** 跳转后恢复：归档区展开态与页组开合跨页保留（含用户已折叠的 false 态）。 */
  function restoreArchDrawer() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(archDrawerKey) || 'null'); } catch { /* ignore */ }
    if (saved && typeof saved === 'object') {
      state.archiveDrawerOpen = saved.open !== false;
      // 手风琴互斥不变量：归档区开则任务区关，反之亦然
      state.tasksRegionOpen = !state.archiveDrawerOpen;
      state.archOpenState = saved.openState && typeof saved.openState === 'object' ? saved.openState : {};
    }
    if (!doneCount()) {
      applyArchDrawerLayout();
      return;
    }
    // 不强开面板：用户收起成胶囊是显式选择，展开后归档区状态仍在
    // 跳页核对语义：恢复后强制展开当前页组（手风琴互斥，其余收起），
    // 否则当前页组恰处于已存收起态时跳转后看不到内容。
    if (state.currentGroupId && doneGroups().some(d => d.group.id === state.currentGroupId)) {
      state.archOpenState = {};
      for (const d of doneGroups()) state.archOpenState[d.group.id] = d.group.id === state.currentGroupId;
    }
    renderArchiveDrawer();
    applyArchDrawerLayout();
  }

  /** 全量任务组：当前页组 + 其它页组（currentGroupId 由 applyRemoteGroups 维护）。 */
  function allGroupsWithCurrent() {
    const list = [];
    if (state.currentGroupId) {
      list.push({ id: state.currentGroupId, page: { url: pageUrl, title: document.title || pageUrl }, tasks: state.tasks });
    }
    return list.concat(state.groups);
  }

  /** 已完成待归档 = status:'done' 且尚未归档的任务（archived 与文件级归档不在 /tasks 里）。 */
  function doneGroups() {
    return allGroupsWithCurrent()
      .map(g => ({ group: g, tasks: (g.tasks || []).filter(t => t && t.status === 'done') }))
      .filter(x => x.tasks.length);
  }

  function doneCount() {
    return doneGroups().reduce((n, x) => n + x.tasks.length, 0);
  }

  /** 页面组短名：路径末段+查询串（区分同标题的 rpt=xxx 报表页）。 */
  function archPageLabel(group) {
    try {
      const u = new URL(group.page?.url || '', window.location.origin);
      return (u.pathname.split('/').filter(Boolean).pop() || '/') + u.search;
    } catch { return group.page?.title || group.page?.url || '未命名页面'; }
  }

  /** 归档区随任务数据实时刷新：SSE/轮询每次重拉任务后走到这里，
      开着的区域重渲列表，折叠态头部计数也要同步——不是点开才加载。 */
  function renderVerifyArchive() {
    if (state.archiveDrawerOpen) renderArchiveDrawer();
    applyArchDrawerLayout(); // done 数变化可能令区域出现/消失 + 头部计数刷新
  }

  /** 归档区主体：一级页面（点击跳转核对），二级任务（单击归档）。 */
  function renderArchiveDrawer() {
    const body = $('[data-el="archDrawerBody"]');
    if (!body) return;
    closeArchPop(); // 数据刷新后旧确认 popover 已失效
    const groups = doneGroups();
    if (!groups.length) {
      body.innerHTML = '<p class="arch-empty">没有已完成待归档任务</p>';
      return;
    }
    body.innerHTML = groups.map(({ group, tasks }, gi) => {
      // 页面名要能区分同标题页面（如 reports/driving?rpt=xxx 系列报表），
      // 显示路径末段+查询串，完整标题与 URL 放悬浮提示。
      const fullName = group.page?.title || group.page?.url || '未命名页面';
      const pageName = archPageLabel(group);
      const isCurrent = group.id === state.currentGroupId;
      const open = state.archOpenState[group.id] != null
        ? state.archOpenState[group.id]
        : (isCurrent || gi === 0);
      const taskRows = tasks.map(t => {
        const el = t.element || {};
        // 核对归档看的是「我输入的要求」：指令全文优先；el.text 是元素抓取的
        // 整段文本（表格会带几百字），只能作为无指令时的兜底。
        const tip = (t.instruction || '').trim();
        const name = tip || el.accessibleName || el.text || '手动任务';
        // 懒加载：只有展开组的任务才渲 <img>（折叠组的行连标签都不进 DOM）；
        // 单行只露一张首图 + 张数角标，多图列表存 data-srcs 供灯箱切换，
        // 不再渲 display:none 的隐藏 img（有 src 浏览器照样会发请求）。
        const srcs = open
          ? (Array.isArray(t.images) ? t.images : [])
              .map(img => imageSrc(img, config.endpoint))
              .filter(Boolean)
          : [];
        const thumbs = srcs.length
          ? `<span class="arch-thumb-wrap" data-srcs="${escapeHtml(JSON.stringify(srcs))}"><img class="arch-thumb" loading="lazy" src="${escapeHtml(srcs[0])}" alt="">${srcs.length > 1 ? `<i class="arch-thumb-n">${srcs.length}</i>` : ''}</span>`
          : '';
        return `<div class="arch-task">
          ${thumbs ? `<span class="arch-thumbs item-thumbs">${thumbs}</span>` : ''}
          <span class="arch-task-name">${escapeHtml(name)}</span>
          <span class="arch-task-acts">
            <button type="button" data-act="archive-task" data-group="${escapeHtml(group.id)}" data-task="${escapeHtml(t.id)}" title="归档此任务">归档</button>
            <button type="button" class="arch-reject" data-act="reject-task" data-group="${escapeHtml(group.id)}" data-task="${escapeHtml(t.id)}" data-url="${escapeHtml(group.page?.url || '')}" title="打回重做：任务回到待执行并跳转页面打开标注编辑">打回</button>
          </span>
        </div>`;
      }).join('');
      return `<div class="arch-page${open ? ' open' : ''}${isCurrent ? ' current' : ''}">
        <div class="arch-page-row">
          <button type="button" class="arch-page-head" data-act="arch-toggle" data-group="${escapeHtml(group.id)}" title="${open ? '收起任务列表' : '展开任务列表'}">
            <svg class="arch-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
            <span class="arch-page-name">${escapeHtml(pageName)}</span>
            ${isCurrent ? '<span class="arch-cur">当前</span>' : ''}
            <span class="arch-page-count">${tasks.length}</span>
          </button>
          <button type="button" class="arch-goto" data-act="arch-goto" data-url="${escapeHtml(group.page?.url || '')}" title="跳转到 ${escapeHtml(fullName)} 核对">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4L11 13"/><path d="M19 14v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V6.5A1.5 1.5 0 0 1 5.5 5H11"/></svg>
          </button>
          <button type="button" class="arch-page-arch" data-act="archive-page" data-group="${escapeHtml(group.id)}" title="归档此页面全部 ${tasks.length} 项已完成任务">归档本页</button>
        </div>
        <div class="arch-tasks${open ? '' : ' hidden'}">${taskRows}</div>
      </div>`;
    }).join('');
  }

  /** 两个折叠区统一应用显隐：区域常驻（无任务为空态），open 控制主体展开；
      计数在此更新——折叠态下头部数字也随推送实时刷新。 */
  function applyArchDrawerLayout() {
    const inline = $('[data-el="archInline"]');
    const tasksRegion = $('[data-el="tasksRegion"]');
    // 兜底归一化：无论状态怎么进来，双开/双关都不允许出现
    if (state.archiveDrawerOpen && state.tasksRegionOpen) state.tasksRegionOpen = false;
    if (!state.archiveDrawerOpen && !state.tasksRegionOpen) state.tasksRegionOpen = true;
    if (inline) {
      inline.classList.toggle('open', state.archiveDrawerOpen);
      $('[data-el="archRegionToggle"]')?.classList.toggle('open', state.archiveDrawerOpen);
      const n = doneCount();
      const countEl = $('[data-el="archDrawerCount"]');
      if (countEl) countEl.textContent = `（${n}）`;
    }
    if (tasksRegion) {
      tasksRegion.classList.toggle('open', state.tasksRegionOpen);
      $('[data-el="tasksRegionToggle"]')?.classList.toggle('open', state.tasksRegionOpen);
      // 与列表口径一致：isPanelTask 排除 done/archived（done 归待归档区，
      // 两边都计会重复），且含跨页任务——区域体渲染的就是全站待执行
      const live = state.tasks.filter(isPanelTask).length
        + state.groups.reduce((sum, g) => sum + ((g.tasks || []).filter(isPanelTask).length), 0);
      const tc = $('[data-el="tasksRegionCount"]');
      if (tc) tc.textContent = `（${live}）`;
    }
  }

  /** 待执行任务区折叠切换。手风琴互斥：展开这个就收起另一个，
      收起这个就展开另一个——两个区始终只有一个展开。 */
  function toggleTasksRegion() {
    state.tasksRegionOpen = !state.tasksRegionOpen;
    state.archiveDrawerOpen = !state.tasksRegionOpen;
    applyArchDrawerLayout();
    persistArchDrawer();
  }

  /** 区域头折叠切换：与待执行任务区互斥（同上）。 */
  function toggleArchiveRegion() {
    state.archiveDrawerOpen = !state.archiveDrawerOpen;
    state.tasksRegionOpen = !state.archiveDrawerOpen;
    if (state.archiveDrawerOpen && state.collapsed) setCollapsed(false);
    closeArchPop();
    // 展开即渲：body 不是常驻渲染（折叠态跳过），展开时若等下一次
    // SSE/轮询才补内容，用户会看到长时间空白
    if (state.archiveDrawerOpen) renderArchiveDrawer();
    applyArchDrawerLayout();
    persistArchDrawer();
  }

  /** 区域内贴按钮的小型确认 popover（批量归档用，非模态不打断布局）。 */
  let archPopPending = null;
  function closeArchPop() {
    archPopPending = null;
    $('[data-el="archPop"]')?.classList.add('hidden');
  }
  function archPopOpen() {
    return !$('[data-el="archPop"]')?.classList.contains('hidden');
  }
  function askArchPop(anchorBtn, text, onConfirm) {
    const box = $('[data-el="archInline"]');
    const pop = $('[data-el="archPop"]');
    if (!box || !pop) { onConfirm(); return; }
    archPopPending = onConfirm;
    $('[data-el="archPopText"]').textContent = text;
    pop.classList.remove('hidden');
    const dr = box.getBoundingClientRect();
    const br = anchorBtn.getBoundingClientRect();
    pop.style.right = `${Math.max(8, dr.right - br.right)}px`;
    pop.style.left = 'auto';
    const ph = pop.offsetHeight || 92;
    // 固定弹在按钮上方；钳在归档区内部（贴顶时覆盖头部，保证文字完整可见）。
    const top = Math.max(br.top - dr.top - ph - 6, 4);
    pop.style.top = `${top}px`;
  }

  /** popover 确认/取消 + 点归档区其他位置收起 popover。 */
  function bindArchivePop() {
    $('[data-el="archPopOk"]')?.addEventListener('click', () => {
      const fn = archPopPending;
      closeArchPop();
      if (fn) fn();
    });
    $('[data-el="archPopCancel"]')?.addEventListener('click', closeArchPop);
    $('[data-el="archInline"]')?.addEventListener('pointerdown', event => {
      if (archPopOpen() && !event.target.closest('.arch-pop')) closeArchPop();
    });
  }

  /** 打回重做：done → todo（reopen 清验收结论），并跳回任务所在页打开
      标注编辑器——改的要求不对不用重新标注，直接在原批注上改。 */
  const PENDING_EDIT_KEY = `${SOURCE}:pending-edit`;
  async function rejectTask(groupId, taskId, url) {
    try {
      await fetch(`${config.endpoint}/${encodeURIComponent(groupId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'todo', reopen: true }),
        signal: AbortSignal.timeout(8000),
      }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); });
    } catch (error) {
      state.syncMessage = `打回失败：${error.message}`;
      renderMessage();
      return;
    }
    if (url && url !== pageUrl) {
      // 跨页：存下待编辑任务，目标页加载完成后恢复编辑器现场
      try { localStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({ groupId, taskId })); } catch { /* ignore */ }
      window.location.href = url;
      return;
    }
    // 同页：重拉任务（done→todo 已回到待执行区）后直接开编辑器
    await loadRemoteTasks({ quiet: true });
    if (state.collapsed) setCollapsed(false);
    if (findTask(taskId)) openEditorFor(taskId);
  }

  /** 跨页打回落地：新页任务加载完成后自动弹出该任务的标注编辑器。 */
  function restorePendingEdit() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(PENDING_EDIT_KEY) || 'null'); } catch { /* ignore */ }
    if (!p || !p.taskId) return;
    try { localStorage.removeItem(PENDING_EDIT_KEY); } catch { /* ignore */ }
    if (findTask(p.taskId)) {
      if (state.collapsed) setCollapsed(false);
      openEditorFor(p.taskId);
    }
  }

  /** 归档写回：PATCH status:archived，成功后静默重拉任务刷新列表与角标。 */
  async function archiveTasksRemote(pairs) {
    if (!pairs.length) return;
    const results = await Promise.allSettled(pairs.map(({ groupId, taskId }) =>
      fetch(`${config.endpoint}/${encodeURIComponent(groupId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
        signal: AbortSignal.timeout(8000),
      }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }),
    ));
    const failed = results.filter(r => r.status === 'rejected').length;
    const ok = pairs.length - failed;
    // 乐观下屏：成功的对先在本地标 archived 并立即重渲，
    // 不等服务端回拉——用户点确认后界面即刻响应。
    const okIds = new Set(pairs.filter((_, i) => results[i].status === 'fulfilled').map(p => p.taskId));
    const markArchived = list => list.forEach(t => { if (t && okIds.has(t.id)) t.status = 'archived'; });
    markArchived(state.tasks);
    state.groups.forEach(g => markArchived(g.tasks || []));
    renderList();
    renderPins(); // 归档任务的页面图钉同步摘除
    renderVerifyArchive();
    state.syncMessage = failed
      ? `已归档 ${ok} 项，${failed} 项失败（可能已被处理）。`
      : `已归档 ${ok} 项任务。`;
    renderMessage();
    await loadRemoteTasks({ quiet: true });
    renderVerifyArchive();
  }

  /* ---------------- 二次确认 ---------------- */

  let confirmState = null;

  /**
   * 二次确认对话框。删除是不可逆操作，必须显式确认。
   * onConfirm 由调用方提供，确认后执行真正的删除。
   */
  function askConfirm({ title, detail, confirmText = '确认删除', danger = true, onConfirm }) {
    confirmState = { onConfirm };
    const box = $('[data-el="confirm"]');
    $('[data-el="confirmTitle"]').textContent = title;
    $('[data-el="confirmDetail"]').textContent = detail || '';
    const okBtn = $('[data-act="confirm-ok"]');
    okBtn.textContent = confirmText;
    okBtn.dataset.danger = danger ? 'on' : 'off';
    box.classList.remove('hidden');
    // 焦点给取消按钮，避免误按 Enter 直接删除
    setTimeout(() => $('[data-act="confirm-cancel"]')?.focus(), 0);
  }

  function closeConfirm() {
    confirmState = null;
    $('[data-el="confirm"]').classList.add('hidden');
  }

  function resolveConfirm(ok) {
    const pending = confirmState;
    closeConfirm();
    if (ok && pending?.onConfirm) pending.onConfirm();
  }

  /* ---------------- 事件绑定 ---------------- */

  // 点击确认框外部关闭，等同取消，避免误触删除
  confirmBox.addEventListener(
    'mousedown',
    event => {
      if (event.target === confirmBox) resolveConfirm(false);
    },
    true,
  );

  shadow.addEventListener(
    'click',
    async event => {
      const target = event.target;
      if (!target || !target.closest) return;
      // 胶囊拖拽松手后的残余 click：吞掉，不触发任何按钮动作
      if (state.suppressUiClick) {
        state.suppressUiClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // 缩略图点击 → 灯箱预览（列表 item-thumbs 与编辑器 thumb 两处都支持）
      const thumbImg = target.closest && target.closest('.item-thumbs img, .thumb img');
      if (thumbImg && thumbImg.src) {
        event.preventDefault();
        // 同任务多图：把缩略图容器里的整组 src 交给灯箱，支持左右切换
        const box = thumbImg.closest('.item-thumbs, .thumb, .arch-thumbs');
        // 归档抽屉的多图清单存在 wrap 的 data-srcs 上（不渲隐藏 img 省请求）；
        // 列表/看板卡片仍从同级 img 收集。
        let srcs = null;
        const wrap = thumbImg.closest('.arch-thumb-wrap');
        if (wrap?.dataset.srcs) {
          try { srcs = JSON.parse(wrap.dataset.srcs); } catch { srcs = null; }
        }
        if (!srcs) srcs = box ? Array.from(box.querySelectorAll('img')).map(i => i.src) : [thumbImg.src];
        // 预览时带上任务文案：归档抽屉行取指令名，列条目取指令输入框内容
        const taskEl = thumbImg.closest('.arch-task, .item');
        const caption = taskEl
          ? (taskEl.querySelector('.arch-task-name')?.textContent
             || taskEl.querySelector('.item-instruction textarea')?.value || '').trim()
          : '';
        showViewer(srcs, Math.max(0, srcs.indexOf(thumbImg.src)), caption);
        return;
      }
      // 按钮内部还有文字与 svg 图标，真实点击常落在子元素上，
      // 因此必须用 closest() 向上查找带 data-act 的祖先元素。
      const dropBtn = target.closest('[data-drop-image]');
      if (dropBtn) {
        event.preventDefault();
        state.pendingImages = state.pendingImages.filter(img => img.id !== dropBtn.getAttribute('data-drop-image'));
        renderEditorImages();
        syncEditorInput();
        return;
      }
      const actBtn = target.closest('[data-act]');
      if (!actBtn) return;
      const act = actBtn.getAttribute('data-act');
      if (!act) return;
      event.preventDefault();
      if (act === 'expand') expandBar();
      else if (act === 'collapse') setCollapsed(true);
      else if (act === 'theme') togglePanelTheme();
      else if (act === 'board') window.open(`${config.endpoint}/board`, '_blank');
      else if (act === 'toggle') setActive(!state.active);
      else if (act === 'freeze') setFrozen(!state.frozen);
      else if (act === 'clear') {
        // 清空范围是全项目（面板队列本来就跨页面展示）——只数当前页
        // 会让「本页无标注、别页有 4 条」时报「还没有标注」
        const all = allProjectTasks();
        if (!all.length) {
          state.syncMessage = '还没有标注。';
          renderMessage();
        } else {
          const locked = all.filter(t => t.status === 'doing').length;
          const removable = all.length - locked;
          if (!removable) {
            // 全部都在处理中：没有可清空的内容，如实说明而不是弹一个清不掉确认框
            state.syncMessage = `${locked} 项标注正在处理中，均不能清空。可等处理完成，或让处理者标记为阻塞/取消。`;
            renderMessage();
          } else {
            // 状态分解：archived/done 等不出现在待执行列表，只说总数会让人以为
            // 数字对不上——把每一类都点名
            const LABELS = { todo: '待执行', done: '待验收', archived: '待文件归档', cancelled: '已取消', blocked: '阻塞' };
            const parts = Object.entries(LABELS)
              .map(([k, label]) => {
                const n = all.filter(t => t.status === k).length;
                return n ? `${label} ${n}` : null;
              })
              .filter(Boolean);
            const breakdown = parts.length > 1 ? `（${parts.join(' · ')}）` : '';
            const otherPages = state.groups.filter(g => (g.tasks || []).length).length;
            const scope = otherPages ? `，跨 ${otherPages + 1} 个页面分组` : '';
            askConfirm({
              title: '清空全部标注？',
              detail: `将删除共 ${removable} 项标注${breakdown}${scope}及其图片附件${locked ? `；另有 ${locked} 项正在处理中，会被保留` : ''}。此操作不可撤销。`,
              confirmText: `清空 ${removable} 项`,
              onConfirm: clearAll,
            });
          }
        }
      } else if (act === 'copy') copyPrompt();
      else if (act === 'accept-round') acceptRound();
      else if (act === 'archive-round') archiveRound();
      else if (act === 'archive-view-toggle') toggleArchiveRegion();
      else if (act === 'tasks-region-toggle') toggleTasksRegion();
      else if (act === 'panel-pin') {
        if (state.panelLayout && state.panelLayout.side) {
          state.panelLayout.pinned = !state.panelLayout.pinned;
          if (state.panelLayout.pinned) state.panelRetracted = false;
          savePanelLayout();
          applyPanelLayout();
        }
      }
      else if (act === 'panel-ear') {
        // 右箭头 = 收成边耳：面板贴当前（或默认右）侧缘收成细条，可再固定/收药丸
        const panel = $('[data-el="panel"]');
        const r = panel?.getBoundingClientRect();
        const cur = state.panelLayout;
        const side = cur?.side === 'left' || cur?.side === 'right' ? cur.side : 'right';
        const y = cur && Number.isFinite(cur.y) ? cur.y : (r ? r.top : 80);
        state.panelLayout = { side, y, pinned: false };
        state.panelRetracted = true;
        savePanelLayout();
        applyPanelLayout();
      }
      else if (act === 'panel-tab-expand') {
        // 边耳固定钮 = 展开为固定面板（锁定态）
        if (state.panelLayout && state.panelLayout.side) state.panelLayout.pinned = true;
        state.panelRetracted = false;
        savePanelLayout();
        applyPanelLayout();
      }
      else if (act === 'arch-toggle') {
        const gid = actBtn.getAttribute('data-group');
        // 与 renderArchiveDrawer 默认态保持一致：当前页组或首组默认展开
        const isFirst = doneGroups()[0]?.group.id === gid;
        const cur = state.archOpenState[gid] != null
          ? state.archOpenState[gid]
          : (gid === state.currentGroupId || isFirst);
        // 手风琴：同一时刻只展开一个页面组，展开这组就收起其它全部
        if (cur) {
          state.archOpenState[gid] = false;
        } else {
          state.archOpenState = {};
          for (const d of doneGroups()) state.archOpenState[d.group.id] = d.group.id === gid;
        }
        renderArchiveDrawer();
        persistArchDrawer();
      }
      else if (act === 'arch-goto' || act === 'group-goto') {
        const url = actBtn.getAttribute('data-url');
        if (url && url !== pageUrl) {
          // 跳转前落盘抽屉状态：新页面加载后自动还原抽屉与展开态
          persistArchDrawer();
          window.location.href = url;
        }
      } else if (act === 'reject-task') {
        const gid = actBtn.getAttribute('data-group');
        const tid = actBtn.getAttribute('data-task');
        const url = actBtn.getAttribute('data-url');
        // 打回会撤销已验收结论并回到待执行——显式二次确认防误触
        askConfirm({
          title: '打回此任务？',
          detail: '任务将回到「待执行任务」重新处理，已验收结论作废。',
          confirmText: '打回',
          onConfirm: () => rejectTask(gid, tid, url),
        });
      } else if (act === 'archive-task') {
        archiveTasksRemote([{ groupId: actBtn.getAttribute('data-group'), taskId: actBtn.getAttribute('data-task') }]);
      } else if (act === 'archive-page' || act === 'archive-all-done') {
        const gid = act === 'archive-page' ? actBtn.getAttribute('data-group') : null;
        const pairs = [];
        let pageLabel = '';
        doneGroups().forEach(({ group, tasks }) => {
          if (gid && group.id !== gid) return;
          if (gid) pageLabel = archPageLabel(group);
          tasks.forEach(t => pairs.push({ groupId: group.id, taskId: t.id }));
        });
        if (!pairs.length) return;
        // 批量归档用贴按钮的 popover 确认（非模态），抽屉布局不被打断
        askArchPop(
          actBtn,
          gid ? `归档「${pageLabel}」的 ${pairs.length} 项任务？` : `归档全部 ${pairs.length} 项已完成任务？`,
          () => archiveTasksRemote(pairs),
        );
      }
      else if (act === 'mode') setExecutionMode(event.target?.dataset?.mode);
      else if (act === 'manual') {
        openEditorForManual();
        state.syncMessage = '手动任务：可直接写要求，也可粘贴图片。';
        renderMessage();
      } else if (act === 'editor-confirm') confirmEditor();
      else if (act === 'editor-close') closeEditor();
      else if (act === 'toggle-details') toggleDetails();
      else if (act === 'manual-copy-close') hideManualCopy();
      else if (act === 'confirm-ok') resolveConfirm(true);
      else if (act === 'confirm-cancel') resolveConfirm(false);
    },
    true,
  );

  // 输入或粘贴后同步提交按钮状态与输入框高度
  $('[data-el="editorInput"]').addEventListener('input', syncEditorInput);

  /** 编辑器随锚点元素重排：滚动/缩放/侧栏开合都会移动元素，
      编辑器锚定在元素旁，不跟着走就会与聚光圈错位 */
  function repositionEditor() {
    if (editor.classList.contains('hidden')) return;
    const elDesc = (state.editingId ? findTask(state.editingId)?.element : state.pendingElement) || null;
    placeEditor(elDesc, $('[data-el="editorInput"]'), { focus: false });
  }

  /** 选中元素标虚线高亮（多选同款 regionmark），编辑器打开期间持续显示供确认 */
  function showSelectionMarks(elements) {
    regionMarks.innerHTML = '';
    let n = 0;
    for (const el of elements) {
      if (!el || typeof el.getBoundingClientRect !== 'function') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const mark = document.createElement('div');
      mark.className = 'regionmark';
      mark._el = el;
      Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      regionMarks.append(mark);
      n++;
    }
    regionMarks.classList.toggle('hidden', n === 0);
  }

  /** 框选命中标记随元素重排（标记存了元素引用，滚动/布局变化时按实时 rect 重画） */
  function repositionRegionMarks() {
    if (regionMarks.classList.contains('hidden')) return;
    let alive = 0;
    for (const mark of regionMarks.children) {
      const el = mark._el;
      if (!el || !el.isConnected) { mark.style.display = 'none'; continue; }
      const r = el.getBoundingClientRect();
      mark.style.display = '';
      Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      alive++;
    }
    if (!alive) regionMarks.classList.add('hidden');
  }

  function onScroll() {
    repositionPins();
    // 编辑期间页面仍可滚动（滚轮不被拦截），聚光孔/编辑器/命中标记都必须跟着元素走
    updateFocusFx();
    repositionEditor();
    repositionRegionMarks();
  }

  function onResize() {
    repositionPins();
    hideSizeBadge();
    if (!bar.classList.contains('dragging')) {
      if (!state.dockLayout) avoidAppChrome();
      else if (state.dockLayout.side) avoidEdgeChrome(state.dockLayout.side);
    }
    syncBarAnchored();
    repositionEditor();
    updateFocusFx();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && state.outbox.length) syncNow();
  }

  function onPageHide() {
    // 不能在卸载阶段假装同步成功；只触发一次 best-effort flush，outbox 仍留在本地。
    if (state.outbox.length) syncNow();
  }

  document.addEventListener('paste', onPaste, true);
    document.addEventListener('mousemove', onMove, true);
    // mousedown 必须早于 click 拦下：页面控件的聚焦发生在 mousedown 阶段，
    // 只拦 click 的话输入框已经拿到焦点了。
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('focusout', onEditorFocusLeak, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize, true);
    bar.addEventListener('pointerdown', onBarPointerDown);
    // DOM 变化重排：SPA 内嵌视图切换/局部重渲染既不触发 scroll 也不触发
    // resize，pin 与打开中的编辑器都会钉死在旧坐标。MutationObserver 兜底，
    // 节流而非防抖——防抖会被弹窗内的持续渲染（地图瓦片/表格数据流）反复
    // 重置饿死，层级调整拖上好几秒：
    // - body 直属子节点增删（teleport 弹窗/浮层开合的特征）立即重排；
    // - 其余变化持续发生时每 250ms 保底必刷一次（throttle），变化停止后
    //   尾随一次收尾——最长延迟封顶 250ms 而非等变化静默；
    // - attributes 监听 class/style：v-show 型弹窗只切 display 不增删节点。
    const REPOSITION_INTERVAL = 250;
    // 应用底栏可能比标注器晚渲染/随路由出现消失：默认落点下每次重排都重评
    // 避障（用户拖过的自由/贴边布局不打扰，拖拽中途也不回写）
    const reevalDockAvoid = () => {
      if (bar.classList.contains('dragging')) return;
      if (!state.dockLayout) {
        avoidAppChrome();
        syncBarAnchored();
      } else if (state.dockLayout.side) {
        avoidEdgeChrome(state.dockLayout.side);
        syncBarAnchored();
      }
    };
    const repositionAll = () => { reevalDockAvoid(); repositionPins(); repositionEditor(); repositionRegionMarks(); updateFocusFx(); };
    let lastRepositionAt = 0;
    let repositionTimer = null;
    const domObserver = new MutationObserver(recs => {
      const overlayToggle = recs.some(r =>
        r.type === 'childList' && r.target === document.body
        && (r.addedNodes.length || r.removedNodes.length));
      const now = performance.now();
      if (overlayToggle || now - lastRepositionAt >= REPOSITION_INTERVAL) {
        clearTimeout(repositionTimer);
        repositionTimer = null;
        lastRepositionAt = now;
        repositionAll();
        return;
      }
      if (!repositionTimer) repositionTimer = setTimeout(() => {
        repositionTimer = null;
        lastRepositionAt = performance.now();
        repositionAll();
      }, REPOSITION_INTERVAL - (now - lastRepositionAt));
    });
    domObserver.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'style'],
    });
    document.addEventListener('visibilitychange', onVisibilityChange, true);
    window.addEventListener('pagehide', onPageHide, true);

  document.documentElement.append(host);
  // 版本由宿主（Vite 插件 / http 适配器）随 bootstrap 注入，与技能版本同源
  $('[data-el="panelVersion"]').textContent = config.version ? `v${config.version}` : '';
  restorePanelTheme();
  applyDockLayout();
  // 挂载时机缝隙：应用底栏/工具列可能比标注器晚渲染且其后再无 DOM
  // mutation（observer 不触发）——延迟兜底各重评一次避障
  setTimeout(() => { reevalDockAvoid(); }, 600);
  setTimeout(() => { reevalDockAvoid(); }, 2500);
  renderBar();
  renderPins();
  renderMessage();
  // localStorage 先用于首屏占位，随后以工作区 JSON 为权威刷新；
  // 定时器会继续处理模型在其它终端的状态回写、删除与归档。
  startRemoteRefresh();
  startEventStream();
  bindArchivePop();
  bindPanelDocking();
  loadRemoteTasks({ quiet: true }).then(() => { restoreArchDrawer(); restorePendingEdit(); });

  const api = {
    // 版本由宿主（Vite 插件 / http 适配器）随 bootstrap 注入，与技能版本同源。
    // 这里曾经硬编码版本号，与 scripts/index.mjs 的 SKILL_VERSION 各写一份，
    // 升级时必然漏改其中一处——那正是 doctor 的版本检查要防的静默不一致。
    version: config.version || 'unknown',
    endpoint: config.endpoint,
    list: () => state.tasks,
    count: () => state.tasks.length,
    filledCount: () => state.tasks.filter(t => String(t.instruction || '').trim()).length,
    isActive: () => state.active,
    isCollapsed: () => state.collapsed,
    page: () => ({ url: location.href, title: document.title }),
    start: () => setActive(true),
    stop: () => setActive(false),
    expand: expandBar,
    collapse: () => setCollapsed(true),
    openEditor: (id, options) => (findTask(id) ? openEditorFor(id, options) : null),
    closeEditor,
    confirm: () => confirmEditor(),
    /** 详情内嵌在编辑面板中，由标题栏图标展开/收缩 */
    toggleDetails: force => toggleDetails(force),
    isDetailsOpen: () => isDetailsOpen(),
    detailsText: () => detailsText(),
    copyDetails,
    /** 悬停尺寸标签 */
    isSizeBadgeVisible: () => !sizeBadge.classList.contains('hidden'),
    sizeBadgeText: () => (sizeBadge.classList.contains('hidden') ? null : sizeBadge.textContent),
    hoverAt: selector => {
      const el = resolveElement(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      state.hovered = el;
      const rect = el.getBoundingClientRect();
      outline.style.display = 'block';
      outline.style.left = `${rect.left}px`;
      outline.style.top = `${rect.top}px`;
      outline.style.width = `${rect.width}px`;
      outline.style.height = `${rect.height}px`;
      showSizeBadge(el);
      return { text: sizeBadge.textContent, width: rect.width, height: rect.height };
    },
    /** 手动任务 */
    openManual: () => {
      openEditorForManual();
      return { seq: $('[data-el="editorSeq"]').textContent, target: $('[data-el="editorTarget"]').textContent };
    },
    /** 图片：以 data URL 直接注入，供自动化验证粘贴/选择路径 */
    addImageDataUrl(dataUrl, name) {
      const match = /^data:([^;,]+)/.exec(String(dataUrl || ''));
      state.pendingImages.push({
        id: `img_${Math.random().toString(36).slice(2, 10)}`,
        name: name || 'image',
        source: 'api',
        mimeType: match ? match[1] : 'image/png',
        dataUrl,
      });
      renderEditorImages();
      return state.pendingImages.length;
    },
    pendingImageCount: () => state.pendingImages.length,
    setInstruction(id, instruction) {
      const task = findTask(id);
      if (!task) return null;
      task.instruction = instruction;
      task.confirmedAt = task.confirmedAt || new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      persistLocal();
      scheduleSync();
      renderPins();
      renderList();
      return task;
    },
    remove(id) {
      removeTask(id);
      return state.tasks.length;
    },
    clear() {
      clearAll();
      return 0;
    },
    sync: syncNow,
    refresh: () => loadRemoteTasks({ quiet: false }),
    copyPrompt,
    /** SSE 连接状态（0 连接中 / 1 已打开 / 2 已关闭），用于排查实时推送。 */
    eventStreamReady: () => (state.eventSource ? state.eventSource.readyState : null),
    deleteRemote,
    askConfirm,
    resolveConfirm,
    isConfirmOpen: () => !$('[data-el="confirm"]').classList.contains('hidden'),
    confirmText: () => ($('[data-el="confirm"]').classList.contains('hidden') ? null : $('[data-el="confirmTitle"]').textContent),
    /** 自动化友好：直接以选择器添加并确认标注 */
    add(selector, instruction) {
      const el = resolveElement(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      const element = describeElement(el);
      // 手动任务的 element 为 null，直接取 .selector 会抛 TypeError，
      // 导致页面上只要有一条手动任务，api.add 就再也标不了元素。
      const existing = state.tasks.find(t => t.element?.selector === element.selector);
      if (existing) {
        if (instruction != null) {
          existing.instruction = instruction;
          existing.confirmedAt = existing.confirmedAt || new Date().toISOString();
          existing.updatedAt = new Date().toISOString();
        }
        persistLocal();
        scheduleSync();
        renderPins();
        renderList();
        return existing;
      }
      const task = createTask(element, instruction || '');
      state.tasks.push(task);
      persistLocal();
      scheduleSync();
      renderPins();
      renderList();
      return task;
    },
    /** 自动化友好：模拟点选元素（走真实交互路径） */
    pick(selector) {
      const el = resolveElement(selector);
      if (!el) throw new Error(`element not found: ${selector}`);
      const element = describeElement(el);
      // 手动任务的 element 为 null，直接取 .selector 会抛 TypeError，
      // 导致页面上只要有一条手动任务，api.add 就再也标不了元素。
      const existing = state.tasks.find(t => t.element?.selector === element.selector);
      state.pendingShot = new Promise(res =>
        setTimeout(() => captureContextShot(config.endpoint, element.rect, HOST_ID, el).then(res), 0)
      );
      if (existing) {
        openEditorFor(existing.id);
        return { mode: 'edit', id: existing.id };
      }
      state.pendingElement = element;
      openEditorForNew(element);
      return { mode: 'new', selector: element.selector };
    },
    setEditorText(text) {
      const input = $('[data-el="editorInput"]');
      input.value = text;
      return input.value;
    },
    isEditorOpen: () => !editor.classList.contains('hidden'),
    editorValue: () => $('[data-el="editorInput"]').value,
    /** 手动复制兜底层状态：宿主禁用剪贴板时用它验证降级路径确实可达。 */
    isManualCopyOpen: () => !$('[data-el="manualCopy"]').classList.contains('hidden'),
    manualCopyText: () => $('[data-el="manualCopyText"]').value,
    hideManualCopy,
    pinCount: () => $$('.pin').length,
    pinTexts: () => $$('.pin').map(p => p.textContent),
    pinTitle: id => shadow.querySelector(`[data-pin="${cssEscape(id)}"]`)?.title || null,
    destroy() {
      stopRemoteRefresh();
      stopEventStream();
      if (state.syncTimer) clearTimeout(state.syncTimer);
      if (state.toastTimer) clearTimeout(state.toastTimer);
      if (state.receiptTimer) clearTimeout(state.receiptTimer);
      state.syncTimer = null;
      state.toastTimer = null;
      state.receiptTimer = null;
      state.syncAbort?.abort();
      state.syncAbort = null;
      for (const timer of remoteSyncTimers.values()) clearTimeout(timer);
      remoteSyncTimers.clear();
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize, true);
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
      window.removeEventListener('pagehide', onPageHide, true);
      domObserver.disconnect();
      clearTimeout(repositionTimer);
      document.documentElement.style.cursor = '';
      host.remove();
      delete window.__zwAnnotator;
      return true;
    },
  };

  // SPA 路由兼容：单路由内嵌多工作台的页面靠 query/path 切换子页面，
  // URL 变化时必须整体重挂载，任务才能按新 page.url 重新归组，
  // 否则上一「页面」的图钉会继续残留在切换后的工作台里。
  installUrlWatcher();

  window.__zwAnnotator = api;
  return api;
}

let urlWatcherInstalled = false;
function installUrlWatcher() {
  if (urlWatcherInstalled || typeof window === 'undefined' || typeof history === 'undefined') return;
  urlWatcherInstalled = true;
  let lastUrl = canonicalPageUrl(location.href);
  const remount = () => {
    const next = canonicalPageUrl(location.href);
    if (next === lastUrl) return;
    lastUrl = next;
    const cfg = window.__zwAnnotationsConfig || {};
    try { window.__zwAnnotator?.destroy(); } catch { /* 销毁失败仍尝试重挂 */ }
    mountAnnotator({ ...cfg });
  };
  for (const key of ['pushState', 'replaceState']) {
    const orig = history[key];
    if (typeof orig !== 'function') continue;
    history[key] = function (...args) {
      const ret = orig.apply(this, args);
      remount();
      return ret;
    };
  }
  window.addEventListener('popstate', remount);
}

/** 同源接口优先；可通过 options.endpoint 覆盖。 */
export function detectEndpoint() {
  const script = typeof document !== 'undefined' ? document.currentScript : null;
  const fromScript = script && script.getAttribute && script.getAttribute('data-endpoint');
  if (fromScript) return fromScript;
  const global = typeof window !== 'undefined' && window.__zwAnnotationsConfig && window.__zwAnnotationsConfig.endpoint;
  if (global) return global;
  return '/__zw-web-annotations';
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/** 附件取址：内存 dataUrl 优先；已落盘的走同源 /files/ 接口回源 */
function imageSrc(image, endpoint) {
  if (image && image.dataUrl) return image.dataUrl;
  const file = image && image.file;
  if (file) return `${endpoint}/files/${encodeURIComponent(String(file).split(/[\\/]/).pop())}`;
  return '';
}

function trim(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function truncate(value, max) {
  const str = String(value || '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hash(value) {
  let h = 5381;
  const str = String(value);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 任务 ID 由页面与选择器派生，保证同一元素重复标注是幂等更新。 */
export function stableTaskId(pageUrl, selector) {
  return `task_${hash(`${pageUrl}|${selector}`)}`;
}

/**
 * 归组用的规范页面地址：去掉 hash（页内锚点），保留 path 与 query。
 *
 * 页内锚点变化不改变"这是哪个页面"：带着 hash 归组会让面板在 URL 出现
 * 锚点后匹配不上自己的任务组（列表显示成"当前页 0"、任务组被当成其它
 * 页面），锚点状态下标注还会生成重复的组文件。
 */
export function canonicalPageUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  } catch {
    return String(url || '');
  }
}

/**
 * 复制文本，逐级降级直到成功；全失败返回 false。
 *
 * 嵌入式宿主（Devin / Codex 等内置浏览器、iframe 预览、被 Permissions-Policy
 * 限制的页面）里 `navigator.clipboard.writeText` 会被直接拒绝——它要求安全上下文
 * + 用户激活 + 未被策略禁用，任一不满足就抛 "Write permission denied"。而这类
 * 环境恰恰是看标注面板的主场景，所以不能只依赖 Clipboard API：
 *   1. navigator.clipboard.writeText（标准路径，权限正常时最好用）；
 *   2. document.execCommand('copy')（老接口，很多嵌入宿主仍放行）；
 *   3. 都失败返回 false，由调用方弹出可选中的文本框让用户手动复制。
 * 绝不谎报成功。
 *
 * `env` 可注入，便于单测覆盖「宿主拒绝剪贴板」这条否则只能靠人肉复现的分支。
 */
export async function copyTextRobust(text, env = {}) {
  const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : null);
  const doc = env.document ?? (typeof document !== 'undefined' ? document : null);
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 宿主拒绝：落到下一个方案，这不是错误路径
  }
  try {
    if (!doc?.createElement) return false;
    // execCommand 要求真实选中：临时 textarea 必须在文档里且可聚焦，
    // 否则部分宿主会静默失败。
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    doc.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = doc.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch {
    // 两条路都不通，交给调用方走手动兜底
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

const CSS_TEXT = `
:host {
  all: initial;
  /* 组件 UI 统一字体：微软雅黑优先，缺失时退回平台中文黑体 */
  --zc-font: "Microsoft YaHei", "微软雅黑", "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
.hidden { display: none !important; }

.outline {
  position: fixed; display: none; pointer-events: none; z-index: 2147483640;
  border: 2px solid #7c6cff; background: rgba(124,108,255,.12); border-radius: 3px;
}

/* ---- 框选取样框与多选标记 ---- */
.marquee {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 1.5px dashed #3b6ef0; background: rgba(59,110,240,.10); border-radius: 3px;
}
.marquee-label {
  position: absolute; right: 4px; bottom: 4px;
  padding: 2px 7px; border-radius: 4px;
  background: #3b6ef0; color: #fff;
  font: 600 11px/1.4 var(--zc-font); white-space: nowrap;
}
/* 多选/框选标记层须在悬停 .outline（640）之上——已选标记是「确认态」，
   悬停高亮盖在上面会把虚线框整体遮住，看起来像标记消失 */
.pickmarks { position: fixed; inset: 0; z-index: 2147483641; pointer-events: none; }
.pickmark {
  position: fixed; pointer-events: none;
  border: 1.5px dashed #f59e0b; background: rgba(245,158,11,.10); border-radius: 3px;
}
/* 框选命中预览：与 Shift 多选同款的琥珀虚线+浅填充，编辑器打开期间保留供确认（截图排除不进图） */
.regionmarks { position: fixed; inset: 0; z-index: 2147483641; pointer-events: none; }
.regionmarks.hidden { display: none; }
.regionmark {
  position: fixed; pointer-events: none;
  border: 1.5px dashed #f59e0b; background: rgba(245,158,11,.10); border-radius: 3px;
}
.dock-float-btn[data-on="on"] { background: #3b6ef0 !important; color: #fff !important; }

/* ---- 图片预览灯箱 ---- */
.viewer {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(10, 14, 28, .82); cursor: zoom-out;
}
.viewer { overflow: hidden; }
.viewer img {
  max-width: 82vw; max-height: 92vh; border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0,0,0,.5); background: #fff;
  transition: transform .12s ease-out;
}
/* 多图切换：左右箭头悬浮于视口两侧，底部居中计数徽标 */
.viewer-nav {
  position: fixed; top: 50%; transform: translateY(-50%);
  width: 44px; height: 64px; border: 0; border-radius: 10px; cursor: pointer;
  background: rgba(30,30,40,.7); color: #d5d5dc;
  display: flex; align-items: center; justify-content: center;
}
.viewer-nav:hover { background: rgba(60,60,80,.9); color: #fff; }
.viewer-nav svg { width: 22px; height: 22px; }
.viewer-nav.prev { left: 18px; }
.viewer-nav.next { right: 18px; }
.viewer-count {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: rgba(30,30,40,.8); color: #d5d5dc;
}
.viewer-count:empty { display: none; }
/* 预览时底部展示任务文案（我输入的指令），核对不用退回列表看 */
.viewer-caption {
  position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%);
  max-width: 76vw; padding: 9px 20px; border-radius: 10px;
  background: rgba(20,20,28,.88); color: #f2f2f8; font-size: 17px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  box-shadow: 0 4px 20px rgba(0,0,0,.4);
}
.viewer-caption:empty { display: none; }
.item-thumbs img, .thumb img { cursor: zoom-in; }

/* ---- 悬停尺寸标签 ---- */
.size-badge {
  position: fixed; z-index: 2147483646; pointer-events: none;
  padding: 3px 7px; border-radius: 5px;
  background: #7c6cff; color: #fff;
  font: 600 11px/1.4 var(--zc-font);
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
  white-space: nowrap;
}

/* ---- 编辑弹窗的聚焦效果：轻遮罩 + 目标元素聚光 ---- */
.veil {
  position: fixed; inset: 0; z-index: 2147483643;
  pointer-events: none;
  background: rgba(13, 18, 35, .26);
  opacity: 0; visibility: hidden;
  transition: opacity .18s ease, visibility .18s ease;
}
.veil.on { opacity: 1; visibility: visible; }
/* 事件拦截层：完全透明，只参与命中测试，不产生任何视觉。
   z-index 取 2147483643（与 veil 同级）——必须低于组件自己的 UI：
   图钉 645、面板 646、编辑器/确认框 647。高于它们就会把自己人一起挡住，
   面板按钮和图钉全都点不动。 */
.click-shield {
  position: fixed; inset: 0; z-index: 2147483643;
  background: transparent;
  cursor: default;
}
.click-shield.hidden { display: none; }
.spotlight {
  position: fixed; z-index: 2147483644;
  pointer-events: none;
  border: 1.5px solid rgba(124, 108, 255, .95);
  border-radius: 10px;
  /* 前两层是贴着元素的柔光与投影，最后一层 9999px 的大阴影把元素以外的
     整页轻轻压暗——元素本身处在「孔」里保持全亮，这是聚光灯的核心。 */
  box-shadow:
    0 0 0 3px rgba(124, 108, 255, .22),
    0 10px 34px rgba(64, 52, 220, .38),
    0 0 0 9999px rgba(13, 18, 35, .26);
  opacity: 0; visibility: hidden;
  transition: opacity .18s ease, visibility .18s ease;
}
.spotlight.on { opacity: 1; visibility: visible; }
/* 呼吸光圈：只动 opacity（合成器动画），不引发大面积重排重绘 */
.spotlight::after {
  content: '';
  position: absolute; inset: -7px;
  border: 1px solid rgba(124, 108, 255, .55);
  border-radius: 14px;
  animation: spotlight-breathe 2.2s ease-in-out infinite;
}
@keyframes spotlight-breathe {
  0%, 100% { opacity: .15; }
  50% { opacity: .85; }
}

/* ---- 内嵌元素详情 ---- */
.editor-details {
  max-height: 44vh; overflow: auto;
  margin-bottom: 6px; padding: 7px 9px;
  background: #151515; border: 1px solid #383838; border-radius: 7px;
}
.detail-empty { margin: 0; padding: 6px 2px; color: #8a8a8a; font-size: 11px; }
.detail-row { display: flex; gap: 9px; padding: 3px 0; }
.detail-row + .detail-row { border-top: 1px dashed #2c2c2c; }
.detail-label { flex: none; width: 56px; color: #8a8a8a; font-size: 11px; }
.detail-value { flex: 1; min-width: 0; word-break: break-all; font-size: 11px; }
.detail-value code {
  padding: 1px 4px; border-radius: 4px; background: #262626; color: #c9c9c9;
  font: 10px var(--zc-font);
}
.detail-value code.wrap { word-break: break-all; }
.detail-value .dim { color: #8a8a8a; }
.detail-value a.src-open {
  color: #7c6cff; text-decoration: none; font-size: 11px; white-space: nowrap;
}
.detail-value a.src-open:hover { text-decoration: underline; }
.detail-value .ok { color: #7fbf8f; }
.detail-value .warn { color: #d8a45a; }
.swatch {
  display: inline-block; width: 10px; height: 10px; margin-right: 4px;
  border: 1px solid #555; border-radius: 3px; vertical-align: -1px;
}

/* ---- 编辑器内的图片区 ---- */
.editor-images {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 2px 0 4px; max-height: 128px; overflow: auto;
}
.thumb {
  position: relative; width: 64px; height: 64px;
  border: 1px solid #4a4a4a; border-radius: 7px; overflow: hidden; background: #111;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-size {
  position: absolute; left: 0; bottom: 0; right: 0;
  background: rgba(0,0,0,.65); color: #ddd;
  font: 9px/1.4 var(--zc-font); text-align: center;
}
.thumb button {
  position: absolute; top: 1px; right: 1px;
  width: 16px; height: 16px; padding: 0; border-radius: 50%;
  background: rgba(0,0,0,.72); color: #f0a0a0; border: 0; cursor: pointer;
  font-family: inherit; font-size: 10px; line-height: 16px; font-weight: 400; text-align: center;
}

/* ---- 编号图钉 ---- */
.pins { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; }
.pin {
  position: fixed; display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0;
  border: 1px solid rgba(255,255,255,.85); border-radius: 50%;
  background: #7c6cff; color: #fff; cursor: pointer;
  font: 700 11px/1 var(--zc-font);
  box-shadow: 0 2px 6px rgba(0,0,0,.35);
  pointer-events: auto; transition: transform .12s ease;
}
.pin[data-empty="on"] { background: #d8a45a; }
.pin[data-flash="on"], .pin:hover { transform: scale(1.25); }
.pin[data-orphan="on"] { background: #8a8a8a; }
/* 元素被弹窗等更高层覆盖时的幽影态：弱化存在感、不拦截点击 */
.pin[data-covered="on"] { opacity: .18; pointer-events: none; transition: opacity .18s ease; }

/* ---- 就地编辑器（胶囊式，参考 Codex 注释输入） ---- */
.editor {
  position: fixed; z-index: 2147483647;
  display: flex; flex-direction: column; gap: 6px;
  font: 13px/1.5 var(--zc-font);
}

/* 胶囊输入条：左侧详情按钮 + 输入框 + 右侧圆形提交按钮 */
.editor-pill {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 4px 4px 6px;
  background: #fff; border-radius: 999px;
  box-shadow: 0 6px 22px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.06);
}
.editor-pill textarea {
  flex: 1; min-width: 0;
  border: 0; outline: none; resize: none; background: transparent;
  padding: 8px 6px; max-height: 30vh;
  color: #22303f; font-family: inherit; font-size: 14px; line-height: 1.5;
}
.editor-pill textarea::placeholder { color: #a8b0bb; }
.pill-icon {
  flex: none; width: 32px; height: 32px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%; cursor: pointer;
  background: transparent; color: #6b7684;
}
.pill-icon svg { width: 19px; height: 19px; }
.pill-icon:hover { background: #f0f2f6; color: #3b4652; }
.pill-icon[data-open="on"] { background: #e8ecff; color: #3b6ef0; }
.pill-submit {
  flex: none; width: 32px; height: 32px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%; cursor: pointer;
  background: #b6bcc5; color: #fff; transition: background .15s ease;
}
.pill-submit svg { width: 17px; height: 17px; }
.pill-submit[data-ready="on"] { background: #3b6ef0; }
.pill-submit:hover { background: #93a0b0; }
.pill-submit[data-ready="on"]:hover { background: #2f5fd0; }

/* 输入条下方的辅助信息：编号、目标元素、按键提示 */
.editor-caption {
  display: flex; align-items: center; gap: 6px;
  padding: 0 10px; font-size: 11px;
  text-shadow: 0 1px 2px rgba(255,255,255,.7);
}
.editor-seq {
  flex: none; padding: 1px 6px; border-radius: 999px;
  background: #7c6cff; color: #fff; font-weight: 700; font-size: 10px;
}
.editor-target {
  flex: 1; min-width: 0; color: #4b5563;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.editor-hint { flex: none; color: #8b95a3; font-size: 10px; }

.editor-details {
  /* 弹窗在空间不足时会被行内 max-height 限高，详情区必须能跟着收缩。
     没有 min-height:0 的话 flex 子项不会缩到内容高度以下，内容会被裁掉。 */
  flex: 1 1 auto; min-height: 0;
  max-height: 46vh; overflow: auto;
  padding: 9px 11px;
  background: #1b1b1b; color: #eee;
  border: 1px solid #3f3f3f; border-radius: 10px;
  box-shadow: 0 12px 30px rgba(0,0,0,.35);
}

/* ---- 二次确认对话框 ---- */
.confirm-layer {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(12,12,18,.42);
  font: 13px/1.5 var(--zc-font);
}
.confirm-card {
  width: min(340px, calc(100vw - 32px));
  padding: 16px 17px 14px;
  background: #1b1b1b; color: #eee;
  border: 1px solid #4a4a4a; border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0,0,0,.55);
}
.confirm-card h3 { margin: 0 0 8px; font-size: 14px; }
.confirm-card p { margin: 0 0 14px; color: #9a9a9a; font-size: 12px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
.confirm-actions button {
  border: 0; border-radius: 7px; padding: 7px 14px; cursor: pointer;
  background: #2b2b2b; color: #c9c9c9; font-family: inherit; font-weight: 500; font-size: 12px; line-height: normal;
}
.confirm-actions button:hover { background: #383838; color: #fff; }
.confirm-actions button[data-act="confirm-ok"][data-danger="on"] {
  background: #c14b4b; color: #fff; font-weight: 700;
}
.confirm-actions button[data-act="confirm-ok"][data-danger="on"]:hover { background: #d45757; }
.confirm-actions button[data-act="confirm-ok"][data-danger="off"] {
  background: #dedaff; color: #29215e; font-weight: 700;
}

/* ---- 手动复制兜底层（宿主禁用剪贴板写入时） ---- */
.manual-copy-layer {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(12,12,18,.42);
  font: 13px/1.5 var(--zc-font);
}
.manual-copy-card {
  width: min(560px, calc(100vw - 32px));
  padding: 16px 17px 14px;
  background: #1b1b1b; color: #eee;
  border: 1px solid #4a4a4a; border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0,0,0,.55);
}
.manual-copy-card h3 { margin: 0 0 8px; font-size: 14px; }
.manual-copy-card p { margin: 0 0 10px; color: #9a9a9a; font-size: 12px; }
/* 文本框必须可选中可聚焦：它存在的唯一目的就是让用户按 ⌘C/Ctrl+C */
.manual-copy-card textarea {
  width: 100%; box-sizing: border-box; resize: vertical;
  padding: 9px 10px; border-radius: 8px;
  background: #111; color: #e6e6e6; border: 1px solid #4a4a4a;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all; white-space: pre-wrap;
}
.manual-copy-card textarea:focus { outline: none; border-color: #6b7bff; }
.manual-copy-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.manual-copy-actions button {
  border: 0; border-radius: 7px; padding: 7px 14px; cursor: pointer;
  background: #2b2b2b; color: #c9c9c9; font-family: inherit; font-weight: 500; font-size: 12px; line-height: normal;
}
.manual-copy-actions button:hover { background: #383838; color: #fff; }

/* ---- 右下角控制条 ---- */
/* z-index 比 .editor 低一号：两者同为最大值时按 DOM 顺序后者在上，
   会让展开详情的弹窗被标注列表盖住。面板必须在遮罩之上、弹窗之下。 */
.bar {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; font: 13px/1.5 var(--zc-font);
  transition: left .18s ease, top .18s ease, right .18s ease;
}
.bar.dragging { transition: none; }
.dock {
  position: relative;
  display: flex; align-items: center; gap: 2px;
  padding: 4px; border: 1px solid #3f3f3f; border-radius: 999px;
  background: #1c1c1c; box-shadow: 0 8px 22px rgba(0,0,0,.4);
  cursor: grab; touch-action: none;
}
.dock button, .dock-edge-tab { cursor: pointer; }
.bar.dragging .dock { cursor: grabbing; }
/* ---- 贴边吸附：胶囊大部滑出屏幕，仅留 34px 耳片 ----
   悬浮模式：悬停耳片/胶囊滑出完整条，移开自动缩回。
   .bar 容器仍占着胶囊原位的整条隐形区域——贴边态必须给 .bar 也关掉
   指针事件，否则鼠标扫过那片空白（未悬停耳片）也会触发 :hover 弹出。 */
.bar.edge-right, .bar.edge-left { pointer-events: none; }
.bar.edge-right .dock,
.bar.edge-left .dock {
  pointer-events: none;
  transition: transform .18s ease;
}
/* 面板在 .bar 内：继承 none 会不可点，展开面板时单独恢复 */
.bar.edge-right .panel, .bar.edge-left .panel { pointer-events: auto; }
/* 面板悬浮模式的边耳同理：胶囊吸边态下也要可点 */
.bar.edge-right .panel-edge-tab, .bar.edge-left .panel-edge-tab { pointer-events: auto; }
.bar.edge-right .dock { transform: translateX(calc(100% - 34px)); border-radius: 999px 0 0 999px; }
.bar.edge-left .dock { transform: translateX(calc(-100% + 34px)); border-radius: 0 999px 999px 0; }
.bar.edge-right:hover .dock, .bar.edge-left:hover .dock,
.bar.panel-open .dock { transform: none; pointer-events: auto; }
/* 耳片：收缩态下唯一可交互区，承接拖拽与悬停展开 */
.dock-edge-tab {
  display: none; position: absolute; top: 0; bottom: 0; width: 34px; z-index: 3;
  align-items: center; justify-content: center;
  color: #9a9a9a; pointer-events: auto; cursor: grab;
  /* 不透明底：遮住耳片下层的钉住按钮等胶囊内容，
     收缩态只能看到箭头，不会出现两图标叠影。 */
  background: #1c1c1c;
}
.dock-edge-tab svg { width: 15px; height: 15px; flex: none; }
.bar.edge-right .dock-edge-tab { display: flex; left: 0; border-radius: 999px 0 0 999px; }
.bar.edge-left .dock-edge-tab { display: flex; right: 0; border-radius: 0 999px 999px 0; }
.bar.edge-left .dock-edge-tab svg { transform: rotate(180deg); }
.bar.edge-right:hover .dock-edge-tab, .bar.edge-left:hover .dock-edge-tab,
.bar.panel-open .dock-edge-tab { display: none; }
/* 近顶翻转：胶囊拖近视口顶部时，悬浮按钮与进度条改到下方 */
.bar.flip-top .dock-float { bottom: auto; top: 100%; padding-top: 16px; padding-bottom: 0; }
.bar.flip-top .dock-progress { bottom: auto; top: calc(100% + 6px); }
.dock-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 11px; border: 0; border-radius: 999px; cursor: pointer;
  background: transparent; color: #c9c9c9; font-family: inherit; font-weight: 600; font-size: 12px; line-height: normal;
}
.dock-btn svg { width: 15px; height: 15px; flex: none; }
.dock-btn:hover { background: #2f2f2f; color: #fff; }
.dock-btn[data-active="on"] { background: #dedaff; color: #29215e; }
.dock-btn.icon { padding: 6px 9px; }
.dock-count {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 10px; border: 0; border-radius: 999px; cursor: pointer;
  background: transparent; color: #eee; font-family: inherit; font-weight: 700; font-size: 12px; line-height: normal;
}
.dock-count:hover { background: #2f2f2f; }
.dock-dot { width: 7px; height: 7px; border-radius: 50%; background: #6b6b6b; }
.dock-dot[data-active="on"] { background: #5dcc81; }
.dock[data-dirty="on"] .dock-dot { background: #d8a45a; }
.dock-sep { width: 1px; height: 18px; background: #3a3a3a; flex: none; }

/* ---- 收起胶囊的悬浮快捷操作 ---- */
/* 左边缘与胶囊内的「标注」按钮对齐：.dock 有 1px 边框 + 4px 内边距，
   绝对定位的包含块是内边距盒，所以 left:4px 恰好落在按钮左边缘上；
   若用 right:0 会整体右对齐到胶囊右端，视觉上像是两个不相干的浮块。 */
.dock-float {
  /* 与胶囊同宽：按钮均分整行，左右缘与药丸齐平。 */
  position: absolute; left: 4px; right: 4px; bottom: 100%;
  display: flex; flex-direction: column; gap: 6px;
  /* 边框盒底边贴住胶囊顶边，下内边距 16px 把「胶囊顶 → 按钮底」整段
     （其中 4~9px 处会叠着进度条）都纳入浮层盒子，指针上移途中始终在浮层内，
     不会丢 hover 导致闪烁。16px 是常量：进度条全部完成后会隐藏，
     这段桥仍在，hover 不会因为进度条消失而断路。 */
  padding-bottom: 16px;
  opacity: 0; visibility: hidden; transform: translateY(6px);
  transition: opacity .16s ease, transform .16s ease, visibility .16s;
  pointer-events: none;
}
/* 用 :has(:focus-visible) 而不是 :focus-within：鼠标点「标注」后焦点留在该按钮上，
   :focus-within 会让浮层一直显示、鼠标移开也不收起（用户实测反馈）。
   :focus-visible 只在键盘聚焦时命中，鼠标点击不会触发，两种输入方式各得其所。
   .dock-float:focus-within 保留——Tab 进入浮层按钮时它必须保持可见，否则焦点会落在看不见的按钮上。 */
.dock:hover .dock-float,
.dock-float:hover,
.dock-float:focus-within,
.dock:has(:focus-visible) .dock-float {
  opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto;
}
.dock-float-row { display: flex; gap: 6px; }
.dock-float-row > * { flex: 1; }
.dock-float-btn {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 6px 11px; border: 1px solid #3f3f3f; border-radius: 999px; cursor: pointer;
  background: #1c1c1c; color: #d8d8d8; font-family: inherit; font-weight: 600; font-size: 12px; line-height: normal;
  box-shadow: 0 6px 18px rgba(0,0,0,.42);
}
.dock-float-btn svg { width: 14px; height: 14px; flex: none; }
.dock-float-btn:hover { background: #2f2f2f; color: #fff; border-color: #5a5a5a; }
.dock-float-btn:focus-visible { outline: 2px solid #8d7bff; outline-offset: 1px; }

/* ---- 收起态进度条 ---- */
/* 贴在胶囊正上方，与胶囊同宽（用绝对定位 + left/right 0 跟随 .dock 宽度），
   细条不抢视觉。全部任务验收完成时整条淡出（见 renderDockProgress）。 */
.dock-progress {
  position: absolute; left: 4px; right: 4px; bottom: calc(100% + 6px);
  height: 4px; border-radius: 999px;
  background: #2b2b2b; overflow: hidden;
  opacity: 1; transition: opacity .3s ease;
}
.dock-progress.hidden { display: none; }
.dock-progress-idle { opacity: 0; pointer-events: none; }
.dock-progress-fill {
  height: 100%; width: 0; border-radius: 999px;
  background: linear-gradient(90deg, #6f7cf0, #9a7cf0);
  transition: width .28s ease, background .28s ease;
}
.dock-progress-fill[data-done="on"] { background: linear-gradient(90deg, #4fbf7a, #6fd39a); }

/* ---- 收起状态的操作反馈浮条 ---- */
/* 回执固定顶部居中：不再跟随胶囊/dock（原贴胶囊上方会压住右下快捷按钮区）；
   且加 pointer-events:none——它只是回执，不需要交互，不会吞点击。 */
.toast {
  /* 顶部居中回执：不再跟随 dock（原贴胶囊上方会压住右下快捷按钮区） */
  position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 2147483646;
  max-width: min(340px, calc(100vw - 36px));
  padding: 9px 13px; border: 1px solid #3f3f3f; border-radius: 10px;
  background: #1c1c1c; color: #ececec;
  font: 600 12px/1.5 var(--zc-font);
  box-shadow: 0 10px 26px rgba(0,0,0,.45);
  pointer-events: none;
  /* 单行回执：长文案省略号截断，不因折行增高盖到悬浮按钮（pointer-events:none
     虽不吞点击，但视觉上压住按钮同样干扰）。 */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 1; transition: opacity .16s ease;
}
.toast.hidden { display: none; }

/* ---- 侧栏：展开面板 ---- */
.panel {
  position: fixed; right: 18px; bottom: 18px;
  display: flex; flex-direction: column;
  /* 固定 500px：双折叠区布局需要确定高度才能等分；小屏兜底不溢出 */
  width: 340px; height: 500px; max-height: calc(100vh - 24px);
  background: #17181d; color: #eee;
  border: 1px solid #3f3f3f; border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0,0,0,.5); overflow: hidden;
}
/* 面板头可拖拽（按钮区除外）；吸边后贴缘侧去圆角 */
.panel header { cursor: grab; }
.panel header:active { cursor: grabbing; }
.panel header button { cursor: pointer; }
/* 吸边留 5px 缝后不再贴缘，保留完整圆角 */
/* 悬浮模式收成边耳：面板整体隐藏 */
.panel.retracted { display: none; }
/* 固定模式钮：吸边才出现；on=已固定 */
.panel-pin {
  flex: none; width: 24px; height: 24px; border: 0; border-radius: 6px;
  background: none; color: #9a9aa6; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.panel-pin:hover { background: #333; color: #fff; }
.panel-pin.on { color: #b7ade8; background: #2b2840; }
.panel-pin svg { width: 16px; height: 16px; }
/* 悬浮模式边耳：屏幕边缘细条，悬停滑出面板 */
.panel-edge-tab {
  position: fixed; top: 50%; transform: translateY(-50%);
  right: 0; width: 26px; height: 200px; padding: 8px 0;
  border: 1px solid #3a3a46; border-right: 0; border-radius: 8px 0 0 8px;
  background: #1e1e24; color: #9a9aa5; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  box-shadow: -4px 0 18px rgba(0,0,0,.35); pointer-events: auto; z-index: 41;
}
.panel-edge-tab.edge-left {
  left: 0; right: auto; border-right: 1px solid #3a3a46; border-left: 0;
  border-radius: 0 8px 8px 0; box-shadow: 4px 0 18px rgba(0,0,0,.35);
}
.panel-edge-tab.edge-left svg { transform: rotate(180deg); }
.panel-edge-tab:hover { color: #fff; background: #2a2a33; }
.panel-edge-tab svg { width: 14px; height: 14px; }
.panel-edge-tab .pet-count {
  font-size: 9px; font-weight: 700; color: #9a8fd0;
  writing-mode: vertical-rl; letter-spacing: 1px;
}
/* 悬耳竖向进度条：细轨道贴边，填充自下而上，100% 转绿 */
.panel-edge-tab .pet-progress {
  flex: 1; width: 4px; min-height: 30px; border-radius: 2px;
  background: #33333d; overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-end;
}
.panel-edge-tab .pet-progress.hidden { display: none; }
.panel-edge-tab .pet-progress-fill {
  width: 100%; background: linear-gradient(180deg, #7a63c9, #5b4aa8);
  transition: height .3s ease;
}
.panel-edge-tab .pet-progress-fill[data-done="on"] { background: #2f9e63; }
.panel-edge-tab .pet-count:empty { display: none; }
.panel header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 11px 8px;
}
.panel-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.panel-title-row { display: flex; align-items: center; gap: 8px; }
.panel-title strong { font-size: 13px; }
/* 主题与收起按钮贴身排列在最右，不被 space-between 拉散 */
.panel-theme { margin-left: auto; }
/* 版本徽标：一眼看到页面里跑的是哪一版运行时，升级后刷新即可确认 */
.panel-version {
  flex: none; margin-left: auto;
  padding: 1px 7px; border-radius: 999px;
  background: #262626; color: #8f8f8f; font-size: 10px;
}
.panel footer { display: flex; align-items: center; gap: 8px; }
.panel footer .panel-version { margin-left: auto; }
/* 收缩按钮固定在最右上角 */
.panel-collapse {
  flex: none; width: 24px; height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; cursor: pointer;
  background: #2b2b2b; color: #c9c9c9;
}
.panel-collapse svg { width: 17px; height: 17px; }
.panel-collapse:hover { background: #383838; color: #fff; }
/* 主题切换钮：无底裸图标，与钉钮同风格 */
.panel-theme {
  flex: none; width: 24px; height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; cursor: pointer;
  background: none; color: #c9c9c9; font-size: 13px;
}
.panel-theme:hover { background: #333; color: #fff; }
.panel-theme svg { width: 15px; height: 15px; }
/* 看板入口：与版本徽标并排的小链接，新标签打开只读看板 */
.panel-board {
  flex: none; border: 0; cursor: pointer; padding: 0;
  background: none; color: #9a9aa6; font-family: inherit; font-size: 11px;
}
.panel-board:hover { color: #dedaff; }
/* 操作区在标题下方，靠左排列 */
.panel-tools {
  display: flex; flex-wrap: wrap; gap: 5px;
  padding: 0 11px 9px; border-bottom: 1px solid #333;
}
.panel-tools button {
  border: 0; border-radius: 6px; padding: 4px 9px; cursor: pointer;
  background: #2b2b2b; color: #c9c9c9; font-family: inherit; font-weight: 500; font-size: 11px; line-height: normal;
}
.panel-tools button:hover { background: #383838; color: #fff; }
.panel-tools button[data-active="on"] { background: #dedaff; color: #29215e; font-weight: 700; }
/* 复制提示词是「把任务交给模型」的收尾动作，用实心主色与前面的灰底操作区分开。
   标注/手动是灰色，标注开启态是浅紫，这里用饱和靛蓝实心，三者互不混淆。 */
.panel-tools button.primary {
  background: #4f5bd5; color: #fff; font-weight: 600;
}
.panel-tools button.primary:hover { background: #5f6ae0; color: #fff; }
.panel-tools button.ghost-danger { color: #d98585; }
.panel-tools button.ghost-danger:hover { background: #4a2626; color: #ffb4b4; }
/* 清空是危险操作，推到最右侧与常用操作拉开距离 */
.panel-tools button.push-right { margin-left: auto; }
/* 检验归档按钮角标：(N) 直接跟在文字后，0 时按钮禁用 */
.panel-tools .va-count { font-variant-numeric: tabular-nums; font-weight: 700; margin-left: 1px; }
.panel-list { flex: 1; overflow: auto; padding: 6px 9px 9px; }

/* ---- 双折叠区：待执行任务 / 待归档检验，等分剩余高度、独立折叠 ---- */
.region {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  position: relative; font-family: inherit; overflow: hidden;
}
/* 折叠态：只剩头部摘要行，不参与空间分配 */
.region:not(.open) { flex: none; }
.region:not(.open) .region-body { display: none; }
.panel-arch { border-top: 1px solid #333; }
.arch-drawer-head {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  user-select: none; border-bottom: 1px solid #333; color: #e6e6ea; font-size: 12px;
}
.arch-drawer-head button { cursor: pointer; }
/* 区域折叠开关：整条头部可点，箭头方向指示展开态 */
.arch-region-toggle {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px;
  border: 0; background: none; color: inherit; font-family: inherit;
  font-size: 12px; text-align: left; cursor: pointer; padding: 0;
}
.arch-region-toggle:hover strong { color: #fff; }
.arch-region-chev {
  flex: none; width: 11px; height: 11px; color: #8b8b96;
  transition: transform .15s;
}
.arch-region-toggle.open .arch-region-chev { transform: rotate(180deg); }
/* 批量归档的贴按钮确认 popover：非模态，面板布局不收起不打断 */
.arch-pop {
  position: absolute; z-index: 50; width: 210px; padding: 10px 12px;
  background: #232329; border: 1px solid #3a3a46; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.45);
}
.arch-pop p { margin: 0 0 9px; font-size: 12px; color: #e8e8ee; line-height: 1.5; }
.arch-pop-actions { display: flex; justify-content: flex-end; gap: 6px; }
.arch-pop-actions button {
  padding: 4px 10px; border-radius: 6px; border: 1px solid #3a3a46;
  background: #2a2a33; color: #c8c8d0; font-size: 12px; cursor: pointer;
}
.arch-pop-actions button:hover { background: #33333d; color: #fff; }
.arch-pop-actions button.primary { background: #6f63c4; border-color: #6f63c4; color: #fff; }
.arch-pop-actions button.primary:hover { background: #7a6fd0; }
.region-count, .arch-drawer-count {
  color: #9a8fd0; font-size: 11px; font-weight: 600;
  font-variant-numeric: tabular-nums; margin-left: 4px;
}
.arch-drawer-head .arch-all {
  margin-left: auto; border: 1px solid #4a4670; border-radius: 6px; padding: 3px 9px;
  background: #2b2840; color: #b7ade8; font-size: 11px; cursor: pointer; font-family: inherit;
}
.arch-drawer-head .arch-all:hover { background: #38355a; color: #d5ccf5; }
.arch-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px 10px; }
.arch-empty { padding: 18px 10px; text-align: center; color: #8b8b96; font-size: 11px; }
.arch-page { margin-bottom: 4px; }
.arch-page-row { display: flex; align-items: center; gap: 6px; }
.arch-chev { flex: none; width: 11px; height: 11px; color: #8b8b96; transition: transform .15s; }
.arch-page.open .arch-chev { transform: rotate(90deg); }
.arch-tasks.hidden { display: none; }
.arch-goto {
  flex: none; width: 24px; height: 24px; border: 0; border-radius: 6px; cursor: pointer;
  background: none; color: #8b8b96; display: inline-flex; align-items: center; justify-content: center;
}
.arch-goto:hover { background: #333; color: #dedaff; }
.arch-goto svg { width: 12px; height: 12px; }
.arch-page-head {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; text-align: left;
  border: 0; border-radius: 7px; padding: 6px 8px; cursor: pointer;
  background: #26262e; color: #d5d5dc; font-family: inherit; font-size: 11px; font-weight: 600;
}
.arch-page-head:hover { background: #30303a; color: #fff; }
/* 当前所在页的组高亮：核对跳转循环里一眼定位「我现在在哪页」 */
.arch-page.current .arch-page-head { background: #2b2840; color: #d5ccf5; }
.arch-cur {
  flex: none; font-size: 9px; color: #fff; font-weight: 700;
  background: #4f5bd5; border-radius: 6px; padding: 0 6px; line-height: 16px;
}
.arch-page-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arch-page-count {
  flex: none; font-size: 10px; color: #9a8fd0; font-variant-numeric: tabular-nums;
  background: #2b2840; border-radius: 8px; padding: 1px 7px;
}
.arch-page-arch {
  flex: none; border: 1px solid #4a4670; border-radius: 6px; padding: 4px 8px;
  background: none; color: #9a8fd0; font-size: 10px; cursor: pointer; font-family: inherit;
}
.arch-page-arch:hover { background: #2b2840; color: #d5ccf5; }
.arch-tasks { padding: 2px 0 2px 10px; }
.arch-task {
  display: flex; align-items: flex-start; gap: 6px; padding: 4px 4px 4px 8px;
  border-left: 2px solid #3a3a46; margin: 3px 0;
  /* 不换行：名字列内部折行，缩略图+按钮钉右端成一组，
     否则按钮掉到第二三行把行高撑成五倍 */
  flex-wrap: nowrap;
}
.arch-task-name {
  flex: 1 1 auto; min-width: 0; font-size: 11px; color: #b9b9c2; line-height: 1.5;
  /* 完整显示不缩略：核对归档时指令全文必须一眼可见 */
  white-space: normal; word-break: break-word;
}
.arch-thumbs { display: flex; gap: 4px; flex: none; }
/* 归档行缩略图贴行顶：清掉 .panel .item-thumbs 的 margin-top（该选择器特异性更高需点名压过） */
.panel .item-thumbs.arch-thumbs { margin: 0; padding-top: 0; }
.arch-thumb {
  width: 64px; height: 44px; object-fit: cover; border-radius: 4px;
  border: 1px solid #3a3a46; cursor: zoom-in; display: block;
}
.arch-thumb:hover { border-color: #7a63c9; }
/* 单图 + 数量角标：多图任务行内只露首图，遮罩徽标提示总数 */
.arch-thumb-wrap { position: relative; display: block; flex: none; }
.arch-thumb-n {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-style: normal; font-size: 10px; font-weight: 700; color: #fff;
  background: rgba(10, 12, 20, .55); border-radius: 4px; pointer-events: none;
}
/* 操作钮纵向一列钉右端：归档上、打回下，整列垂直居中 */
.arch-task-acts {
  flex: none; margin-left: auto; align-self: center;
  display: flex; flex-direction: column; gap: 4px;
}
.arch-task button {
  flex: none;
  border: 1px solid #4a4670; border-radius: 5px; padding: 2px 8px;
  background: none; color: #9a8fd0; font-size: 10px; cursor: pointer; font-family: inherit;
  opacity: .6; transition: opacity .15s;
}
.arch-task:hover button { opacity: 1; }
.arch-task button:hover { background: #2b2840; color: #d5ccf5; }
/* 打回=返工信号色：与归档紫区分，一眼认出「这条要重做」 */
.arch-task .arch-reject { border-color: #6b4a2a; color: #d9a85f; }
.arch-task .arch-reject:hover { background: #3a2c1c; color: #f0c088; }

/* ---- 总体进度条 ---- */
/* 三段权重（分派 10 / 开发 70 / 验收 20）已折算进 fill 的宽度，条上不再分段，
   避免用户误以为每一段可单独点击或拖拽。 */
.panel-progress { padding: 8px 11px 9px; border-bottom: 1px solid #333; }
.progress-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-bottom: 6px;
}
.progress-label {
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: #9a9a9a; font-size: 11px;
}
.progress-pct { color: #dedaff; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
/* 清空挪到进度行最右：危险操作贴近统计而非主操作区 */
.progress-clear { border: 0; border-radius: 5px; padding: 2px 8px; cursor: pointer; background: none; color: #d98585; font-family: inherit; font-size: 10px; }
.progress-clear:hover { background: #4a2626; color: #ffb4b4; }
/* 次要状态行（排队数 / 阻塞原因）：可换行，不省略——这里的信息不能丢 */
.progress-note {
  margin-top: 5px;
  color: #b99a5f; font-size: 10px; line-height: 1.4;
  overflow-wrap: anywhere;
}
.progress-note.hidden { display: none; }
.progress-track {
  position: relative; height: 6px; border-radius: 999px;
  background: #2b2b2b; overflow: hidden;
}
.progress-fill {
  height: 100%; width: 0; border-radius: 999px;
  background: linear-gradient(90deg, #6f7cf0, #9a7cf0);
  transition: width .28s ease, background .28s ease;
}
/* 全部验收通过：整条转绿，作为收尾信号 */
.progress-fill[data-done="on"] { background: linear-gradient(90deg, #4fbf7a, #6fd39a); }
/* ---- 执行模式切换：轮次 / 队列 ---- */
/* 分段控件紧贴进度条左侧，与 11px 的进度文字同一行高，不挤压标签 */
.mode-switch { flex: none; display: inline-flex; border: 1px solid #3d3d46; border-radius: 6px; overflow: hidden; }
.mode-switch button {
  border: 0; background: transparent; color: #8f8f9b; cursor: pointer;
  font-family: inherit; font-size: 10px; font-weight: 600; line-height: 1;
  padding: 4px 7px;
}
.mode-switch button + button { border-left: 1px solid #3d3d46; }
.mode-switch button:hover { color: #d6d6e0; }
/* 选中态用面板主色描底：与图钉/进度条的紫保持同一视觉语言 */
.mode-switch button[data-active="on"] { background: #34315c; color: #dedaff; }
/* 本轮在途期间按钮禁用（deliver 后恢复）：置灰并压掉 hover 反馈，
   让「不能切」从视觉上就是确定的，而不是点了没反应 */
.mode-switch button:disabled { cursor: not-allowed; opacity: .45; }
.mode-switch button:disabled:hover { color: #8f8f9b; }
/* ---- 内部滚动条统一美化：默认浅色滚动条在深色面板上不搭。
   规则只作用于组件 Shadow DOM 内部，页面自身的滚动条不受影响。 ---- */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: #3d3d46; border: 2px solid transparent;
  border-radius: 999px; background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover { background-color: #565662; }
*::-webkit-scrollbar-corner { background: transparent; }
.panel-list, .editor-details, .editor-images, .editor-pill textarea, .panel .item textarea {
  scrollbar-width: thin;
  scrollbar-color: #3d3d46 transparent;
}
.panel .empty { padding: 16px 5px; margin: 0; color: #8a8a8a; font-size: 12px; }
.panel .item {
  border: 1px solid #343434; border-radius: 12px; background: #232326;
  padding: 10px 11px; margin: 8px 1px;
}
.panel .item.editing { border-color: #7c6cff; }
.panel .item-head { display: flex; align-items: center; gap: 7px; }
.panel .item-seq {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  background: #7c6cff; color: #fff; font-family: inherit; font-weight: 700; font-size: 11px; line-height: 22px; text-align: center;
}
.panel .item-seq.manual { background: #d8a45a; color: #2b1e08; }
/* 任务卡主体行：缩略图左 + 输入框右，与待归档检验行同款横排 */
.panel .item-body { display: flex; align-items: flex-start; gap: 8px; margin-top: 6px; }
.panel .item-body .item-thumbs { flex: none; padding-top: 2px; }
.panel .item-body .item-instruction { flex: 1; min-width: 0; }
.panel .item-body .item-instruction textarea { margin-top: 0; }
.panel .item-thumbs { display: flex; gap: 4px; margin: 5px 0 0; flex-wrap: wrap; }
.panel .item-thumbs img {
  width: 64px; height: 44px; object-fit: cover;
  border: 1px solid #3f3f3f; border-radius: 5px; display: block;
}
.panel .thumb-file {
  width: 36px; height: 36px; border: 1px solid #3f3f3f; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  background: #2a2a2a; color: #999; font-size: 10px;
}
.panel .item-title {
  flex: 1; min-width: 0; font-weight: 600; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.panel .item textarea {
  width: 100%; min-height: 40px; resize: vertical; margin: 6px 0 5px;
  padding: 6px; border: 1px solid #3f3f3f; border-radius: 6px;
  background: #151515; color: #eee; font-family: inherit; font-size: 12px; line-height: 1.5;
}
.panel .item textarea:focus { outline: none; border-color: #7c6cff; }
.panel .item-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.panel .item-foot code { color: #8f8f8f; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel .tag { flex: none; font-size: 10px; color: #7fa7e8; }
/* 状态分色：六种状态一眼可辨，不再共用一个绿色。
   蓝=待处理 / 橙=进行中 / 琥珀=待验收 / 绿=已完成 / 红=已阻塞 / 灰=已取消。
   都是深底上的高亮色，亮度对齐避免某个状态显得「更重要」。 */
.panel .tag.status-todo { color: #7fa7e8; }
.panel .tag.status-doing { color: #e8935a; }
.panel .tag.status-review { color: #e0b464; }
.panel .tag.status-done { color: #7fce8f; }
.panel .tag.status-archived { color: #9a8fd0; }
.panel .tag.status-blocked { color: #e07a7a; }
.panel .tag.status-cancelled { color: #85858f; }
/* 处理开始后新增的批注：琥珀描边（与待验收的状态标签区分开） */
.panel .tag.queued { color: #c9a35a; border: 1px dashed #8a6d35; padding: 0 5px; border-radius: 4px; }
/* 暂存新要求：紫描边（与面板主色同语言），悬停可看新指令全文 */
.panel .tag.pending { color: #b48ce8; border: 1px solid #6f5aa8; padding: 0 5px; border-radius: 4px; }
/* 归档本轮按钮：仅在本轮 100% 完成时出现 */
.progress-head .archive-btn {
  border: 1px solid #4fbf7a; border-radius: 5px; padding: 2px 8px; cursor: pointer;
  background: transparent; color: #6fd39a; font-family: inherit; font-size: 11px; font-weight: 600;
}
.progress-head .archive-btn:hover { background: #1f3d2b; }
/* 验收本轮按钮：有任务处于待验收时出现，是 done 的正式人工入口（先前只能裸 PATCH） */
.progress-head .accept-btn {
  border: 1px solid #c9a35a; border-radius: 5px; padding: 2px 8px; cursor: pointer;
  background: transparent; color: #e0b968; font-family: inherit; font-size: 11px; font-weight: 600;
}
.progress-head .accept-btn:hover { background: #3a3120; }
.panel .tag.warn { color: #d8a45a; }
.panel button.link { border: 0; background: none; cursor: pointer; padding: 0; color: #c9c9c9; font: inherit; }
.panel button.link[data-details] { font-size: 10px; }
.panel button.link.danger { color: #e07a7a; font-size: 12px; }
/* 待验收任务的「✓ 验收」：与删除同为行内链接，但用验收色区分语义 */
.panel button.link.accept { color: #e0b968; font-size: 12px; }
/* 处理中的任务：整条降饱和 + 输入框禁改，明确传达「已锁定，别动」 */
.panel .item.locked { border-color: #4a4a52; background: #191a1d; }
.panel .item.locked .item-title { color: #9a9aa2; }
.panel .item.locked textarea { background: #131316; color: #8f8f96; cursor: not-allowed; }
.panel .lock-note {
  flex: none; font-size: 10px; color: #d8a45a;
  border: 1px solid #5a4a2a; border-radius: 4px; padding: 0 4px;
}
/* ---- 页面分组：跨页面标注按页面分组展示，当前页置顶 ---- */
.page-group { margin: 6px 0 2px; }
.page-group.current .group-head { border-color: #45415e; }
.group-head {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 7px; margin: 0 1px 2px;
  border: 1px solid #2e2e2e; border-radius: 10px;
  background: #1e1e22; cursor: default; user-select: none;
  /* 行高钉死：徽标/跳页钮高度不同不得撑出行差 */
  min-height: 36px; box-sizing: border-box;
}
/* .panel header 的拖拽 grab 特异性更高会压掉上面这条，必须点名为分组头恢复 */
.panel .group-head, .panel .group-head:active { cursor: default; }
.group-head:hover { background: #232323; }
.group-chevron {
  flex: none; color: #8a8a8a; font-size: 9px; line-height: 1;
  transition: transform .12s ease;
}
.group-chevron[data-open="on"] { transform: rotate(90deg); }
.group-name {
  flex: none; max-width: 38%; font-weight: 600; font-size: 11px; color: #ddd;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.group-badge {
  flex: none; padding: 0 5px; border-radius: 999px;
  background: #dedaff; color: #29215e; font-size: 9px; font-weight: 700;
  /* 行高钉死在文字行高内：徽标不得把分组头撑得比无徽标行高 */
  line-height: 14px;
}
/* 「当前」用靛蓝、待验收用琥珀，避免两个徽标同色分不清含义 */
.group-badge.review { background: #4a3a1c; color: #e8c176; }
.group-sub {
  flex: 1; min-width: 0; color: #6f6f6f; font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.group-count { flex: none; color: #8f8f8f; font-size: 10px; }
/* 组内跳页钮：只挂在非当前页组头（当前页跳自己无意义） */
.group-goto {
  flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; cursor: pointer;
  background: none; color: #8b8b96; display: inline-flex; align-items: center; justify-content: center;
}
.group-goto:hover { background: #333; color: #dedaff; }
.group-goto svg { width: 13px; height: 13px; }
.panel footer { padding: 8px 11px 10px; border-top: 1px solid #333; }
/* 提示行单行显示：长回执（如模式切换）超出即省略号截断，不再折行把面板撑高。
   min-width:0 允许 flex/grid 环境下收缩；完整文案通过 title 悬停可见。 */
.panel-msg {
  display: block; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: #8fd6a0; font-size: 11px;
}

/* ------------------------------------------------------------------ *
 * 明亮主题：宿主 data-zwa-theme="light" 时覆盖暗色基底。
 * 只做加法覆盖，暗色规则保持原样；色板与看板明亮主题同一套语言。
 * ------------------------------------------------------------------ */
:host([data-zwa-theme="light"]) {
  --zwa-surface: #ffffff;
  --zwa-surface-soft: #f2f3f7;
  --zwa-surface-hover: #e9ebf2;
  --zwa-border: #e3e5ec;
  --zwa-border-strong: #d5d8e2;
  --zwa-text: #1f2430;
  --zwa-text-secondary: #5b6472;
  --zwa-text-muted: #8a92a3;
  --zwa-shadow: rgba(15, 23, 42, .14);
}
/* 药丸/悬浮钮同面板语言：半透明白玻璃 + 柔光投影 */
:host([data-zwa-theme="light"]) .dock {
  background: rgba(255,255,255,.78); border-color: rgba(213,216,226,.9);
  backdrop-filter: blur(12px) saturate(1.4);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  box-shadow: 0 8px 24px rgba(30,40,70,.16), inset 0 1px 0 rgba(255,255,255,.9);
}
:host([data-zwa-theme="light"]) .dock-btn { color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .dock-btn:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .dock-count { color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .dock-count:hover { background: var(--zwa-surface-hover); }
:host([data-zwa-theme="light"]) .dock-dot { background: #b9bfcc; }
:host([data-zwa-theme="light"]) .dock-sep { background: var(--zwa-border); }
/* 悬浮快捷按钮/进度条/边缘耳片此前只有暗色硬编码，明亮主题下显突兀黑块 */
:host([data-zwa-theme="light"]) .dock-float-btn {
  background: rgba(255,255,255,.78); color: var(--zwa-text-secondary);
  border-color: rgba(213,216,226,.9);
  backdrop-filter: blur(10px) saturate(1.4);
  -webkit-backdrop-filter: blur(10px) saturate(1.4);
  box-shadow: 0 6px 18px rgba(30,40,70,.14), inset 0 1px 0 rgba(255,255,255,.9);
}
:host([data-zwa-theme="light"]) .dock-float-btn:hover {
  background: rgba(236,234,255,.9); color: #4a3fc0; border-color: rgba(190,184,240,.9);
}
:host([data-zwa-theme="light"]) .dock-progress { background: var(--zwa-border); }
/* 耳片必须近不透明：半透明会透出下层胶囊内容（铅笔钮与箭头叠影）。
   毛玻璃保留让边缘观感与药丸一致 */
:host([data-zwa-theme="light"]) .dock-edge-tab {
  background: rgba(255,255,255,.96); color: var(--zwa-text-muted);
  backdrop-filter: blur(12px) saturate(1.4);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
}
/* 悬耳进度条浅色版：暗色轨道在白底上发灰看不清，换浅蓝灰轨道+亮紫填充 */
:host([data-zwa-theme="light"]) .panel-edge-tab .pet-progress {
  width: 5px;
  background: #dde1ee;
  box-shadow: inset 0 0 0 1px rgba(150,160,195,.25);
}
:host([data-zwa-theme="light"]) .panel-edge-tab .pet-progress-fill {
  background: linear-gradient(180deg, #8b7ae8, #6a5bd6);
}
:host([data-zwa-theme="light"]) .panel-edge-tab .pet-progress-fill[data-done="on"] { background: linear-gradient(180deg, #43c07f, #2f9e63); }
:host([data-zwa-theme="light"]) .toast {
  background: var(--zwa-surface); color: var(--zwa-text);
  border-color: var(--zwa-border-strong);
  box-shadow: 0 10px 26px var(--zwa-shadow, rgba(31,36,48,.16));
}
:host([data-zwa-theme="light"]) .panel {
  background: var(--zwa-surface); color: var(--zwa-text);
  border-color: var(--zwa-border-strong);
  /* 双层投影把面板从浅色页面上托起来：大范围弥散层 + 贴近的定向层 */
  box-shadow:
    0 24px 64px rgba(30,40,70,.18),
    0 6px 20px rgba(30,40,70,.12);
}
:host([data-zwa-theme="light"]) .panel-version { background: var(--zwa-surface-soft); color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel-collapse { background: var(--zwa-surface-soft); color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .panel-collapse:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .panel-theme {
  flex: none; width: 24px; height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--zwa-text-secondary); font-size: 13px;
}
:host([data-zwa-theme="light"]) .panel-theme:hover { background: var(--zwa-surface-hover); }
:host([data-zwa-theme="light"]) .panel-board { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel-board:hover { color: #4f5bd5; }
:host([data-zwa-theme="light"]) .panel-tools { border-bottom-color: var(--zwa-border); }
:host([data-zwa-theme="light"]) .panel-tools button { background: var(--zwa-surface-soft); color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .panel-tools button:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .panel-tools button[data-active="on"] { background: #dedaff; color: #29215e; }
:host([data-zwa-theme="light"]) .panel-tools button { border-radius: 8px; }
:host([data-zwa-theme="light"]) .panel-tools button.primary {
  background: linear-gradient(135deg, #6a5bd6, #8a6fe0); color: #fff;
  box-shadow: 0 2px 8px rgba(106,91,214,.3);
}
:host([data-zwa-theme="light"]) .panel-tools button.primary:hover { background: linear-gradient(135deg, #5c4ed0, #7c5fd8); color: #fff; }
:host([data-zwa-theme="light"]) .panel-tools button.ghost-danger { color: #c25656; }
:host([data-zwa-theme="light"]) .panel-tools button.ghost-danger:hover { background: #fdeaea; color: #a83b3b; }
:host([data-zwa-theme="light"]) .progress-clear { color: #c25656; }
:host([data-zwa-theme="light"]) .progress-clear:hover { background: #fdeaea; color: #a83b3b; }
/* 检验归档区：浅色整套 */
:host([data-zwa-theme="light"]) .panel-arch { border-top-color: var(--zwa-border); }
:host([data-zwa-theme="light"]) .panel-pin { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel-pin:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .panel-pin.on { color: #4a3fc0; background: #eceaff; }
:host([data-zwa-theme="light"]) .panel-edge-tab { background: var(--zwa-surface); border-color: var(--zwa-border); color: var(--zwa-text-muted); box-shadow: -4px 0 18px rgba(30,40,70,.15); }
:host([data-zwa-theme="light"]) .panel-edge-tab:hover { color: var(--zwa-text); background: var(--zwa-surface-hover); }
:host([data-zwa-theme="light"]) .panel-edge-tab .pet-count { color: #7a63c9; }
:host([data-zwa-theme="light"]) .arch-drawer-head { border-bottom-color: var(--zwa-border); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .arch-region-toggle strong { color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .arch-drawer-count { color: #7a63c9; }
:host([data-zwa-theme="light"]) .arch-drawer-head .arch-all { background: #eceaff; border-color: #cdc9f0; color: #5a4fd0; }
:host([data-zwa-theme="light"]) .arch-drawer-head .arch-all:hover { background: #ddd9fa; color: #4a3fc0; }
:host([data-zwa-theme="light"]) .arch-empty { color: var(--zwa-text-muted); }
/* 待归档检验区与待执行任务区同语言：玻璃白卡片 */
:host([data-zwa-theme="light"]) .arch-page-head {
  color: var(--zwa-text);
  border: 1px solid rgba(215,220,235,.8); border-radius: 9px;
  background: rgba(255,255,255,.62);
  backdrop-filter: blur(10px) saturate(1.4);
  -webkit-backdrop-filter: blur(10px) saturate(1.4);
  box-shadow: 0 1px 2px rgba(30,40,70,.05), inset 0 1px 0 rgba(255,255,255,.85);
}
:host([data-zwa-theme="light"]) .arch-page-head:hover { background: rgba(255,255,255,.82); border-color: rgba(200,206,228,.9); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .arch-page.current .arch-page-head { background: rgba(236,234,255,.72); color: #4a3fc0; border-color: rgba(190,184,240,.8); }
:host([data-zwa-theme="light"]) .arch-page-count { background: #eceaff; color: #5a4fd0; }
:host([data-zwa-theme="light"]) .arch-page-arch { border-color: #cdc9f0; color: #5a4fd0; }
:host([data-zwa-theme="light"]) .arch-page-arch:hover { background: #eceaff; color: #4a3fc0; }
:host([data-zwa-theme="light"]) .arch-goto { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .arch-goto:hover { background: var(--zwa-surface-hover); color: #4f5bd5; }
:host([data-zwa-theme="light"]) .arch-chev { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .arch-task {
  border-left: 0; border: 1px solid #e7e9f2; border-radius: 10px;
  background: #ffffff; padding: 7px 10px; margin: 6px 0;
  box-shadow: 0 1px 2px rgba(30,40,70,.05);
}
:host([data-zwa-theme="light"]) .arch-task-name { color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .arch-task button { border-color: #cdc9f0; color: #5a4fd0; }
:host([data-zwa-theme="light"]) .arch-task button:hover { background: #eceaff; color: #4a3fc0; }
:host([data-zwa-theme="light"]) .arch-task .arch-reject { border-color: #e8c48a; color: #b07a2a; }
:host([data-zwa-theme="light"]) .arch-task .arch-reject:hover { background: #fdf3e2; color: #96661d; }
:host([data-zwa-theme="light"]) .arch-thumb { border-color: var(--zwa-border-strong); }
:host([data-zwa-theme="light"]) .arch-thumb:hover { border-color: #7a63c9; }
:host([data-zwa-theme="light"]) .arch-pop { background: var(--zwa-surface); border-color: var(--zwa-border); box-shadow: 0 8px 28px rgba(30,40,70,.18); }
:host([data-zwa-theme="light"]) .arch-pop p { color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .arch-pop-actions button { background: var(--zwa-surface); border-color: var(--zwa-border); color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .arch-pop-actions button:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .arch-pop-actions button.primary { background: #5a55d6; border-color: #5a55d6; color: #fff; }
:host([data-zwa-theme="light"]) .arch-pop-actions button.primary:hover { background: #4c47c9; }
:host([data-zwa-theme="light"]) .panel-progress { border-bottom-color: var(--zwa-border); }
:host([data-zwa-theme="light"]) .progress-label { color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .progress-pct { color: #4f5bd5; }
:host([data-zwa-theme="light"]) .progress-note { color: #8a6a1f; }
:host([data-zwa-theme="light"]) .progress-track { background: #e8eaf0; }
:host([data-zwa-theme="light"]) .mode-switch { border-color: var(--zwa-border-strong); }
:host([data-zwa-theme="light"]) .mode-switch button { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .mode-switch button + button { border-left-color: var(--zwa-border-strong); }
:host([data-zwa-theme="light"]) .mode-switch button:hover { color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .mode-switch button[data-active="on"] { background: #e6e2ff; color: #3d3a8c; }
:host([data-zwa-theme="light"]) .mode-switch button:disabled:hover { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .progress-head .archive-btn { border-color: #2e9e57; color: #2e9e57; }
:host([data-zwa-theme="light"]) .progress-head .archive-btn:hover { background: #e7f6ee; }
:host([data-zwa-theme="light"]) .progress-head .accept-btn { border-color: #a8791f; color: #8a6a1f; }
:host([data-zwa-theme="light"]) .progress-head .accept-btn:hover { background: #fbf3e2; }
:host([data-zwa-theme="light"]) .panel button.link.accept { color: #8a6a1f; }
:host([data-zwa-theme="light"]) *::-webkit-scrollbar-thumb { background: #c9cdd8; border: 2px solid transparent; border-radius: 999px; background-clip: padding-box; }
:host([data-zwa-theme="light"]) *::-webkit-scrollbar-thumb:hover { background-color: #b0b6c4; }
:host([data-zwa-theme="light"]) .panel-list,
:host([data-zwa-theme="light"]) .editor-details,
:host([data-zwa-theme="light"]) .editor-images,
:host([data-zwa-theme="light"]) .editor-pill textarea,
:host([data-zwa-theme="light"]) .panel .item textarea { scrollbar-color: #c9cdd8 transparent; }
:host([data-zwa-theme="light"]) .panel .empty { color: var(--zwa-text-muted); }
/* 任务卡：纯白卡片浮在浅灰紫面板上，大圆角+轻投影——与效果图同语言 */
:host([data-zwa-theme="light"]) .panel {
  background: #f8f9fd;
}
:host([data-zwa-theme="light"]) .panel .item {
  border-color: #e7e9f2; background: #ffffff; border-radius: 14px;
  padding: 10px 12px; margin: 8px 1px;
  box-shadow: 0 1px 3px rgba(30,40,70,.06);
}
:host([data-zwa-theme="light"]) .panel .item-seq {
  width: 22px; height: 22px; line-height: 22px; font-size: 11px;
  background: #6a5bd6;
}
:host([data-zwa-theme="light"]) .panel .item-seq.manual { background: #d8a45a; }
:host([data-zwa-theme="light"]) .panel .item.editing { border-color: #7c6cff; }
:host([data-zwa-theme="light"]) .panel .item-thumbs img { border-color: var(--zwa-border); }
:host([data-zwa-theme="light"]) .panel .thumb-file { border-color: var(--zwa-border); background: var(--zwa-surface-soft); color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel .item textarea {
  border-color: #e2e5ef; background: #fff; color: var(--zwa-text);
  border-radius: 8px;
}
:host([data-zwa-theme="light"]) .panel .item textarea:focus { border-color: #7c6cff; box-shadow: 0 0 0 3px rgba(106,91,214,.12); }
:host([data-zwa-theme="light"]) .panel .item-foot code { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel .tag { color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .panel .tag.status-todo { color: #3b6ef0; }
:host([data-zwa-theme="light"]) .panel .tag.status-doing { color: #d97a2e; }
:host([data-zwa-theme="light"]) .panel .tag.status-review { color: #b07d1c; }
:host([data-zwa-theme="light"]) .panel .tag.status-done { color: #2e9e57; }
:host([data-zwa-theme="light"]) .panel .tag.status-archived { color: #7a63c9; }
:host([data-zwa-theme="light"]) .panel .tag.status-blocked { color: #d04b4b; }
:host([data-zwa-theme="light"]) .panel .tag.status-cancelled { color: #7a8291; }
:host([data-zwa-theme="light"]) .panel .tag.queued { color: #a07827; border-color: #d8c391; }
:host([data-zwa-theme="light"]) .panel .tag.pending { color: #7a5fc0; border-color: #c4b4ee; }
:host([data-zwa-theme="light"]) .panel .tag.warn { color: #b07d1c; }
:host([data-zwa-theme="light"]) .panel button.link { color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .panel button.link.danger { color: #d04b4b; }
:host([data-zwa-theme="light"]) .panel .item.locked { border-color: var(--zwa-border); background: #f1f2f6; }
:host([data-zwa-theme="light"]) .panel .item.locked .item-title { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel .item.locked textarea { background: #f6f7fa; color: var(--zwa-text-muted); cursor: not-allowed; }
:host([data-zwa-theme="light"]) .panel .lock-note { color: #b07d1c; border-color: #e2d3ac; }
/* 当前页靠紫边凸显（底色与非当前页统一淡蓝玻璃） */
:host([data-zwa-theme="light"]) .page-group.current .group-head { border-color: rgba(150,140,230,.85); }
:host([data-zwa-theme="light"]) .group-goto { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .group-goto:hover { background: var(--zwa-surface-hover); color: #4f5bd5; }
/* 页面分组头：淡蓝玻璃——浅蓝半透明 + 背景模糊 + 顶部内高光。
   当前页只靠紫边+徽标区分，底色与非当前页统一。 */
:host([data-zwa-theme="light"]) .group-head {
  border-color: rgba(200,208,238,.7); border-radius: 9px;
  padding: 7px 10px;
  background: rgba(236,240,254,.36);
  backdrop-filter: blur(10px) saturate(1.4);
  -webkit-backdrop-filter: blur(10px) saturate(1.4);
  box-shadow: 0 1px 2px rgba(30,40,70,.05), inset 0 1px 0 rgba(255,255,255,.7);
}
:host([data-zwa-theme="light"]) .group-head:hover { background: rgba(236,240,254,.55); border-color: rgba(190,198,235,.8); }
:host([data-zwa-theme="light"]) .group-chevron { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .group-name { color: #333a46; }
:host([data-zwa-theme="light"]) .group-badge { background: #dedaff; color: #29215e; }
:host([data-zwa-theme="light"]) .group-badge.review { background: #f5ecd7; color: #8a6a1e; }
:host([data-zwa-theme="light"]) .group-sub { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .group-count { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .panel footer { border-top-color: var(--zwa-border); }
:host([data-zwa-theme="light"]) .panel-msg { color: #2e9e57; }
:host([data-zwa-theme="light"]) .editor-details { background: #fff; color: var(--zwa-text); border-color: var(--zwa-border-strong); box-shadow: 0 12px 30px var(--zwa-shadow); }
:host([data-zwa-theme="light"]) .detail-row + .detail-row { border-top-color: var(--zwa-border); }
:host([data-zwa-theme="light"]) .detail-label,
:host([data-zwa-theme="light"]) .detail-empty { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .detail-value .dim { color: var(--zwa-text-muted); }
:host([data-zwa-theme="light"]) .confirm-card { background: #fff; color: var(--zwa-text); border-color: var(--zwa-border-strong); box-shadow: 0 20px 50px var(--zwa-shadow); }
:host([data-zwa-theme="light"]) .confirm-card p { color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .confirm-actions button { background: var(--zwa-surface-soft); color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .confirm-actions button:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .manual-copy-card { background: #fff; color: var(--zwa-text); border-color: var(--zwa-border-strong); box-shadow: 0 20px 50px var(--zwa-shadow); }
:host([data-zwa-theme="light"]) .manual-copy-card p { color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .manual-copy-card textarea { background: #f7f8fa; color: var(--zwa-text); border-color: var(--zwa-border-strong); }
:host([data-zwa-theme="light"]) .manual-copy-actions button { background: var(--zwa-surface-soft); color: var(--zwa-text-secondary); }
:host([data-zwa-theme="light"]) .manual-copy-actions button:hover { background: var(--zwa-surface-hover); color: var(--zwa-text); }
:host([data-zwa-theme="light"]) .thumb { border-color: var(--zwa-border-strong); background: #fff; }
:host([data-zwa-theme="light"]) .size-badge { box-shadow: 0 2px 8px var(--zwa-shadow); }
`;

/* 自动挂载在样式常量声明之后执行，避免初始化顺序导致的暂时性死区。 */
if (typeof document !== 'undefined') {
  const script = document.currentScript;
  const auto = script && script.hasAttribute && script.hasAttribute('data-zw-annotations');
  if (auto) {
    const run = () => mountAnnotator({ collapsed: script.getAttribute('data-collapsed') !== 'false' });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
  }
}
