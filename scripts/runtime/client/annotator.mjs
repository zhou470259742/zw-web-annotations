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
  const devDone = (counts.review || 0) + (counts.done || 0);
  const verified = counts.done || 0;
  const percent = Math.round(
    (started > 0 ? PROGRESS_WEIGHTS.dispatch : 0)
      + PROGRESS_WEIGHTS.dev * (devDone / total)
      + PROGRESS_WEIGHTS.verify * (verified / total),
  );
  return { percent, total, counts, started, devDone, verified };
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
  try {
    let cur = el && el.__vueParentComponent;
    let depth = 0;
    while (cur && depth < 8) {
      const file = cur.type && cur.type.__file;
      const name = (cur.type && (cur.type.name || cur.type.__name)) || '';
      if (depth === 0) {
        ownFile = file || '';
        ownName = name;
      }
      if (file && !files.includes(file)) files.push(file);
      if (name && !names.includes(name)) names.push(name);
      cur = cur.parent;
      depth++;
    }
  } catch {
    // 生产构建或非 Vue 环境不暴露该属性，属正常情况
  }
  return {
    // 元素真正所属的组件放最前（如 CampusBrand.vue），其后是逐级父组件
    componentFile: files[0] || '',
    componentFiles: files,
    // 只报告与 componentFile 同属一个组件的名字；匿名组件留空，
    // 而不是拿父组件的名字顶上
    componentName: ownFile ? ownName : '',
    componentChain: names,
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
function declaredProps(el) {
  const props = new Set();
  let warned = 0;
  const visit = rules => {
    for (const rule of rules || []) {
      // 先处理"有选择器的普通规则"。不能反过来用 `if (rule.cssRules) continue`
      // 判断：支持 CSS 嵌套后，普通的样式规则也带一个（通常为空的）cssRules，
      // 空列表是真值，那样会把所有规则统统跳过，ownStyles 恒为空、
      // 每个属性都被误报成"继承"，比不判断更糟。
      if (rule.selectorText && rule.style) {
        try {
          if (el.matches(rule.selectorText)) for (const p of rule.style) props.add(p);
        } catch {
          // 跨域样式表、嵌套里的 & 选择器、:has() 等无法匹配，跳过
          warned++;
        }
      }
      // 分组规则（@media/@supports/@layer）本身没有选择器，需要下钻
      if (rule.cssRules && rule.cssRules.length) visit(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets || [])) {
    try { visit(sheet.cssRules); } catch { warned++; }
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
  };
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
    active: false,
    hovered: null,
    collapsed: config.collapsed,
    /** 当前就地编辑的任务 id；null 表示无弹窗 */
    editingId: null,
    /** 是否为尚未确认的新建任务 */
    editingIsNew: false,
    /** 新建标注待确认的元素上下文 */
    pendingElement: null,
    /** 是否正在编辑一个手动添加的任务（无关联元素） */
    manualMode: false,
    /** 当前编辑任务的待提交图片（确认时才写入任务） */
    pendingImages: [],
    /** 详情区当前展示的元素信息 */
    detailsElement: null,
    syncState: 'idle',
    syncMessage: '',
    /** 连续录入时的合并同步定时器 */
    syncTimer: null,
    /** 已确认但未成功同步的标记 */
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
  };

  try {
    const cached = JSON.parse(localStorage.getItem(storageKey) || '[]');
    // manual 任务没有 element，不能再用 element 作为过滤条件
    if (Array.isArray(cached)) state.tasks = cached.filter(t => t && t.id);
  } catch {
    state.tasks = [];
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
      <!-- 收起态的进度条：展开面板时刻意不显示（面板顶部已有完整的一根，
           两处同时出现是重复信息）。全部任务验收完成后自动消失。 -->
      <div class="dock-progress" data-el="dockProgress">
        <div class="dock-progress-fill" data-el="dockProgressFill"></div>
      </div>
    </div>
    <section class="panel hidden" data-el="panel">
      <header>
        <div class="panel-title">
          <strong>标注列表</strong>
          <span class="panel-meta" data-el="panelMeta"></span>
        </div>
        <span class="panel-version" data-el="panelVersion" title="标注组件运行时版本"></span>
        <button type="button" class="panel-collapse" data-act="collapse" title="收起">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </header>
      <div class="panel-tools">
        <button type="button" data-act="toggle" data-el="toggleBtn" title="进入/退出标注模式">标注</button>
        <button type="button" data-act="manual" title="手动添加任务">手动</button>
        <button type="button" class="primary" data-act="copy" title="复制处理提示词">复制提示词</button>
        <button type="button" class="ghost-danger push-right" data-act="clear" title="清空全部标注">清空</button>
      </div>
      <!-- 总体进度：分派 10% + 开发 70% + 验收 20%，跨越所有页面统计。
           放在操作区下方、列表上方——用户点开面板第一眼就想知道"改到哪了"。 -->
      <div class="panel-progress" data-el="progress">
        <div class="progress-head">
          <span class="progress-label" data-el="progressLabel"></span>
          <span class="progress-pct" data-el="progressPct"></span>
        </div>
        <div class="progress-track" title="">
          <div class="progress-fill" data-el="progressFill"></div>
        </div>
      </div>
      <div class="panel-list" data-el="list"></div>
      <footer><span class="panel-msg" data-el="msg"></span></footer>
    </section>
  `;

  // 收起状态下面板底栏不可见，操作反馈（复制成功/失败等）改由这个浮条兜底，
  // 否则点了「复制」没有任何可见回执。展开面板时不显示，避免两处重复。
  const toast = document.createElement('div');
  toast.className = 'toast hidden';
  toast.setAttribute('data-el', 'toast');

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

  shadow.append(outline, sizeBadge, veil, spotlight, pins, editor, confirmBox, bar, toast);

  const $ = sel => shadow.querySelector(sel);
  const $$ = sel => Array.from(shadow.querySelectorAll(sel));

  /* ---------------- 持久化 ---------------- */

  function persistLocal() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state.tasks));
    } catch {
      /* 存储被禁用时忽略，内存仍在 */
    }
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
    const response = await fetch(`${config.endpoint}/tasks`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return Array.isArray(data.groups) ? data.groups : [];
  }

  /**
   * 用服务端数据重排本地视图：当前页任务进 state.tasks（localStorage 只兜
   * 未同步成功的草稿），其余页面进 state.groups 供分组列表展示。
   */
  function applyRemoteGroups(groups) {
    const group = groups.find(g => g?.page?.url === pageUrl) || null;
    // 服务端任务是权威数据：它可能已经被模型回写、归档或从工作区删除。
    state.tasks = (Array.isArray(group?.tasks) ? group.tasks : []).filter(t => t && t.id);
    state.remoteRevision = group?.updatedAt || '';
    state.groups = groups.filter(g => g && g.page?.url !== pageUrl);
    persistLocal();
    renderPins();
    renderList();
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
    if (!config.autoSync || state.refreshPending) return null;
    state.refreshPending = true;
    try {
      const group = applyRemoteGroups(await fetchRemoteGroups());
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
    state.dirty = true;
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => {
      state.syncTimer = null;
      syncNow();
    }, DRAFT_DELAY_MS);
  }

  async function syncNow() {
    if (state.syncState === 'saving') return null;
    if (!state.tasks.length) {
      // 全部删完：通知服务端移除 JSON 文件与附件
      return deleteRemote({ all: true });
    }
    state.syncState = 'saving';
    renderPanelMeta();
    try {
      const response = await fetch(`${config.endpoint}/append`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pagePayload()),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      state.syncState = 'saved';
      state.dirty = false;
      // skipped：本地这些任务都已归档、服务端没有写出任何文件。
      // 此时不能报「已同步到 xxx」，那会让人以为工作区里有这份数据。
      state.syncMessage = data.skipped
        ? '这些标注已归档，工作区无需再写入。'
        : `已同步到 ${data.absolutePath || data.relativePath || data.file || '工作区'}`;
      return data;
    } catch (error) {
      state.syncState = 'error';
      state.syncMessage = `本地已保存，工作区同步失败：${error.message}`;
      return null;
    } finally {
      renderPanelMeta();
      renderMessage();
    }
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
  async function deleteRemote({ ids = [], selectors = [], all = false } = {}) {
    if (!config.autoSync) return null;
    try {
      const body = all
        ? { groupId: null, page: pagePayload().page, ids: [], selectors: [], all: true }
        : { groupId: null, page: pagePayload().page, ids, selectors };
      const response = await fetch(`${config.endpoint}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, pageUrl }),
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
        state.syncMessage = all
          ? '已清空工作区中该页面的任务数据。'
          : `已同步删除 ${data.removed ?? ids.length} 项。`;
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
        headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
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

  /* ---------------- 渲染 ---------------- */

  function renderCapsule() {
    // 收起胶囊显示「本页/总数」：跨页面标注时用户同时关心
    // 当前页进度与整个项目的标注总量（如首页上是 0/3）。
    const otherTotal = state.groups.reduce((sum, g) => sum + ((g.tasks || []).length), 0);
    $('[data-el="capsuleCount"]').textContent = `${state.tasks.length}/${state.tasks.length + otherTotal}`;
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
   * 进度条。面板展开时是顶部那根，收起时是胶囊上方的细条——两处同一份数据，
   * 但不同时显示（展开时刻意隐藏细条，避免同一信息出现两次）。
   */
  function renderProgress() {
    const p = computeProgress(allProjectTasks());
    renderDockProgress(p);
    const fill = $('[data-el="progressFill"]');
    fill.style.width = `${p.percent}%`;
    $('[data-el="progressPct"]').textContent = p.total ? `${p.percent}%` : '';
    $('[data-el="progressLabel"]').textContent = p.total
      ? `待验收 ${p.counts.review || 0} · 已完成 ${p.counts.done || 0} / 共 ${p.total}`
      : '还没有任务';
    fill.parentElement.title = p.total
      ? `分派 ${p.started}/${p.total} · 开发完成 ${p.devDone}/${p.total} · 验收通过 ${p.verified}/${p.total}\n`
        + `权重：分派 10% / 开发 70% / 验收 20%（cancelled 不计入）`
      : '';
    // 全部完成时换成绿色，作为「这批活收工」的收尾信号
    fill.dataset.done = p.total && p.percent >= 100 ? 'on' : 'off';
  }

  /**
   * 收起态胶囊上方的细进度条。
   *
   * 三条显示规则：
   * - 没有任务 → 不显示（空条无意义，且会占住悬浮按钮的位置）；
   * - 全部完成（100%）→ 不显示。用户明确要求「全部完成之后消失」，
   *   任务都归档后这条一直在反而干扰；
   * - 面板展开 → 不显示，改由面板顶部那根完整进度条承担。
   */
  function renderDockProgress(p) {
    const box = $('[data-el="dockProgress"]');
    const fill = $('[data-el="dockProgressFill"]');
    const stat = p || computeProgress(allProjectTasks());
    const show = stat.total > 0 && stat.percent < 100 && state.collapsed;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    fill.style.width = `${stat.percent}%`;
    fill.dataset.done = 'off';
    box.title = `进度 ${stat.percent}%（待验收 ${stat.counts.review || 0} · 已完成 ${stat.counts.done || 0} / 共 ${stat.total}）`;
  }

  function renderPanelMeta() {
    const filled = state.tasks.filter(t => String(t.instruction || '').trim()).length;
    const otherTotal = state.groups.reduce((sum, g) => sum + ((g.tasks || []).length), 0);
    // 有跨页面任务时按用户的心智模型给出两个数字：项目总量与当前页数量；
    // 只有一页时退回原来的简洁显示，避免“共 3 项 · 当前页 3”的废话。
    const parts = otherTotal > 0 ? [`共 ${state.tasks.length + otherTotal} 项`, `当前页 ${state.tasks.length}`] : [`${state.tasks.length} 项`];
    parts.push(`已填 ${filled}`);
    if (state.syncState === 'saving') parts.push('同步中…');
    else if (state.dirty) parts.push('待同步');
    else if (state.syncState === 'saved') parts.push('已同步');
    $('[data-el="panelMeta"]').textContent = parts.join(' · ');
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

  /** 当前应当显示的文案：回执在有效期内优先，否则用最近的后台消息。 */
  function activeMessage() {
    if (state.receipt && Date.now() < state.receipt.until) return state.receipt.message;
    return state.syncMessage;
  }

  function renderMessage() {
    const text = activeMessage() || (state.active
      ? '点击页面元素即可就地输入要求。'
      : '点击“标注”后，在页面上点选元素。');
    $('[data-el="msg"]').textContent = text;
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
      : `${truncate(task.element.selector, 40)} · ${task.element.rect.width}×${task.element.rect.height}`;
    // doing = 已被处理者领取、正在改代码。此时锁住不可改不可删：
    // 中途换指令或删任务，会让处理者回写的 done/结果与记录对不上。
    // review（待验收）**不锁**：代码已改完等验收，用户此时看到效果想补一句
    // 或删掉它都是合理的；锁住会让改动静默失效，比放行更糟。
    const locked = task.status === 'doing';
    const review = task.status === 'review';
    const thumbs = (task.images || []).length
      ? `<div class="item-thumbs">${task.images
          .map(img => (img.dataUrl ? `<img src="${img.dataUrl}" alt="">` : `<span class="thumb-file" title="${escapeHtml(img.file || '')}">图</span>`))
          .join('')}</div>`
      : '';
    return `
    <article class="item${task.id === state.editingId ? ' editing' : ''}${locked ? ' locked' : ''}" data-item="${task.id}">
      <div class="item-head">
        <span class="item-seq${manual ? ' manual' : ''}">${seq}</span>
        <span class="item-title">${escapeHtml(title)}</span>
        ${locked ? '<span class="lock-note" title="正在处理中，暂不可修改或删除">🔒 处理中</span>' : ''}
        ${current ? `<button type="button" class="link" data-details="${task.id}" title="查看元素详情">详情</button>` : ''}
        ${locked
          ? ''
          : `<button type="button" class="link danger" data-del="${task.id}" title="删除">✕</button>`}
      </div>
      ${thumbs}
      <label class="item-instruction">
        <textarea data-edit="${task.id}" rows="2" placeholder="输入调整要求"${locked ? ' readonly' : ''}>${escapeHtml(task.instruction)}</textarea>
      </label>
      <div class="item-foot">
        <code>${escapeHtml(sub)}</code>
        <span class="tag${empty ? ' warn' : review ? ' review' : ''}">${empty ? '未填写' : STATUS_LABELS[task.status] || task.status}</span>
      </div>
    </article>`;
  }

  /** 一个页面分组的可折叠区块。 */
  function renderGroupSection({ id, current, title, path, tasks }) {
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
        </header>
        <div class="group-body${open ? '' : ' hidden'}">${body}</div>
      </section>`;
  }

  /**
   * 列表按页面分组：当前页组始终在最前（用户正在这页上工作），其余页面
   * 按服务端返回的最近活动排序。组内顺序仍是添加顺序，编号不重排。
   * 跨页面标注不会因切换页面而丢失：每个页面的任务都常驻列表，可折叠。
   */
  function renderList() {
    const list = $('[data-el="list"]');
    const otherGroups = state.groups.filter(g => g && Array.isArray(g.tasks) && g.tasks.length);
    if (!state.tasks.length && !otherGroups.length) {
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
        tasks: state.tasks,
      }),
    ];
    for (const group of otherGroups) {
      sections.push(
        renderGroupSection({
          id: group.id,
          current: false,
          title: group.page?.title || group.page?.url || '其它页面',
          path: safePathname(group.page?.url || ''),
          tasks: group.tasks,
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
      el.onclick = () => toggleGroup(el.dataset.groupToggle, el.dataset.current === 'on');
    });
    list.querySelectorAll('[data-edit]').forEach(el => {
      el.oninput = () => {
        const localTask = findTask(el.dataset.edit);
        if (localTask) {
          // 只读输入框理论上不会再触发 input，这里仍兜一层，
          // 防止通过脚本或浏览器自动填充绕过 readonly 改掉处理中的指令
          if (localTask.status === 'doing') {
            el.value = localTask.instruction || '';
            state.syncMessage = '该标注正在处理中，指令暂不可修改；如需调整请先等处理完成或让处理者标记为阻塞。';
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
        if (remote.task.status === 'doing') {
          el.value = remote.task.instruction || '';
          state.syncMessage = '该标注正在处理中，指令暂不可修改；如需调整请先等处理完成或让处理者标记为阻塞。';
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
    list.querySelectorAll('[data-details]').forEach(el => {
      el.onclick = () => {
        const task = findTask(el.dataset.details);
        if (!task) return;
        if (!task.element) {
          // 手动任务没有元素信息，直接打开编辑器
          openEditorFor(task.id);
          return;
        }
        const target = resolveElement(task.element.selector);
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
    state.tasks.forEach((task, index) => {
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
        openEditorFor(task.id);
      });
      pins.append(pin);
      positionPin(pin, task);
    });
  }

  function resolveElement(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function positionPin(pin, task) {
    // 手动任务没有关联元素，不显示页面图钉
    if (!task.element?.selector) {
      pin.style.display = 'none';
      return;
    }
    const el = resolveElement(task.element.selector);
    if (!el) {
      pin.dataset.orphan = 'on';
      pin.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    const offscreen =
      rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
    if (offscreen) {
      pin.style.display = 'none';
      return;
    }
    pin.style.display = 'flex';
    // 贴在元素左上角，略微向外偏移，避免压住内容本身
    pin.style.left = `${Math.max(2, rect.left - 9)}px`;
    pin.style.top = `${Math.max(2, rect.top - 9)}px`;
  }

  function repositionPins() {
    $$('.pin').forEach(pin => {
      const task = findTask(pin.dataset.pin);
      if (task) positionPin(pin, task);
    });
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
      const sel = state.editingId ? findTask(state.editingId)?.element?.selector : state.pendingElement?.selector;
      placeEditor(sel || null, $('[data-el="editorInput"]'));
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
    try {
      await navigator.clipboard.writeText(text);
      state.syncMessage = '已复制元素信息。';
    } catch (error) {
      state.syncMessage = `复制失败：${error.message}`;
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
        <img src="${image.dataUrl}" alt="${escapeHtml(image.name)}">
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
    $('[data-el="editorHint"]').textContent = 'Enter 确认 · Esc 取消';
    input.value = task.instruction || '';
    renderEditorImages();
    syncEditorInput();
    fillDetails(task.element || null);
    toggleDetails(!!options.expandDetails);
    placeEditor(task.element?.selector, input);
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
    input.value = '';
    renderEditorImages();
    syncEditorInput();
    fillDetails(element);
    toggleDetails(false);
    placeEditor(element.selector, input);
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
    input.value = '';
    renderEditorImages();
    syncEditorInput();
    fillDetails(null);
    toggleDetails(false);
    placeEditor(null, input);
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
      if (!spotlight.classList.contains('on') && !veil.classList.contains('on')) return;
      spotlight.classList.remove('on');
      veil.classList.remove('on');
      return;
    }
    // 手动任务不加任何遮罩：这个弹窗的典型用法是「截个图粘进来」，
    // 遮罩会把要截的页面压暗，截出来的图自带一层灰。而且手动任务本来
    // 就没有可聚焦的目标元素，挖孔高亮无从谈起。
    if (state.manualMode || (!state.editingId && !state.pendingElement)) {
      spotlight.classList.remove('on');
      veil.classList.remove('on');
      return;
    }
    const el = (() => {
      const selector = focusSelectorForEditor();
      return selector ? resolveElement(selector) : null;
    })();
    if (el) {
      const rect = el.getBoundingClientRect();
      const pad = 5;
      // 0 尺寸（元素被隐藏/移除）没有可高亮的区域，退回纯遮罩
      if (rect.width > 0 && rect.height > 0) {
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

  function placeEditor(selector, input) {
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
        left = vw - width - 18;
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
    state.editingId = null;
    state.editingIsNew = false;
    state.manualMode = false;
    state.pendingElement = null;
    state.pendingImages = [];
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
      state.tasks.push(task);
      state.editingId = null;
      finishConfirm(task);
      return task;
    }

    if (state.editingId) {
      const task = findTask(state.editingId);
      if (task) {
        // 处理中的任务不接受就地编辑的指令修改（点元素、点「详情」都会走到这里）。
        // 面板那边锁了输入框，但这条路径绕开了面板，必须单独拦。
        if (task.status === 'doing') {
          closeEditor();
          state.syncMessage = `「${truncate(task.instruction || '未填写', 20)}」正在处理中，指令暂不可修改。`;
          renderMessage();
          return null;
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
    persistLocal();
    scheduleSync();
    renderPins();
    renderList();
    renderMessage();
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
   * 清空当前页面全部标注，并删除工作区中对应数据。
   *
   * 处理中的任务不在清空范围内：它们正被某个处理者改代码，清掉会让其回写的
   * 结果无处可归。这里保留它们并如实告知，而不是假装已清空。
   */
  function clearAll() {
    const locked = state.tasks.filter(t => t.status === 'doing');
    state.tasks = locked;
    persistLocal();
    closeEditor();
    renderPins();
    renderList();
    // 一律发 all: true，由服务端按状态自行保留处理中的任务。
    // 这里若改成传 ids，就必须传「要删的」id；曾把 locked 的 id 当成删除目标
    // 发出去，等于请求删掉唯一该保留的任务，与意图完全相反。
    deleteRemote({ all: true });
    state.syncMessage = locked.length
      ? `已清空其余标注；${locked.length} 项处理中的标注已保留，不能被清空。`
      : '已清空当前页面的标注，并删除工作区数据。';
    renderMessage();
  }

  /**
   * 复制处理提示词。
   *
   * 提示词不嵌入任务明细，只给出任务清单 JSON 的文件地址，
   * 让 AI agent 自己去读取，避免提示词随任务增多而膨胀。
   * 地址必须来自同步成功后的真实文件路径，否则模型会去读一个不存在的文件。
   *
   * 存储按页面分成多个组文件，而标注是跨页面的：项目里有多个页面待处理时，
   * 提示词按页面列出每个文件地址。优先用绝对路径：relativePath 是相对
   * 「项目目录」算的，而模型的工作目录是「工作区根」，项目常在工作区的
   * 子目录里，照抄 relativePath 会读不到文件。
   */
  async function copyPrompt() {
    // 当前页有草稿要先同步；没有任务时绝不能调 syncNow——它把「空」当
    // 删除信号，会发出整组删除请求。其它页面是否有待处理由后面的组列表判断。
    const saved = state.tasks.length ? await syncNow() : null;
    if (state.tasks.length && !saved) {
      setReceipt('任务尚未成功同步到工作区，无法确定文件地址。', 6000);
      return null;
    }
    const fallbackPath = saved?.absolutePath || saved?.relativePath || saved?.file || '';

    let pendingGroups = null;
    try {
      pendingGroups = (await fetchRemoteGroups())
        // review 也算「还没收尾」：它等着主线程验收，不能从清单里漏掉，
        // 否则一旦有任务进入待验收，复制出的提示词就会把它们当作已完成而略过。
        .map(group => ({ ...group, pending: (group.tasks || []).filter(t => t.status === 'todo' || t.status === 'doing' || t.status === 'review') }))
        .filter(group => group.pending.length);
    } catch {
      // 组列表读不到时退回单文件提示词：当前页任务刚刚同步成功，地址可靠
      pendingGroups = null;
    }
    if (!pendingGroups && !fallbackPath) {
      setReceipt('无法读取工作区任务列表。', 6000);
      return null;
    }
    if (pendingGroups && !pendingGroups.length) {
      setReceipt(saved?.skipped
        ? '当前标注均已归档，工作区中没有待处理文件。重新标注后即可复制。'
        : '工作区里没有待处理的标注任务（可能均已完成或归档）。', 6000);
      return null;
    }

    const singleFilePrompt = jsonPath =>
      [
        `请参考 ${jsonPath} 中的待处理工作，进行处理。`,
        '改完把任务状态回写为 review（待验收），并注明改动的文件与验证证据；不要写 done——done 表示已验收，由主线程复核后才回写。',
        '已验收通过的任务请进行归档。',
        '同一任务文件是唯一写入目标：如需并行，请由主线程统一回写任务状态，子 agent 只负责改源码并回报结果，且不要让多个 agent 同时改同一份源码。',
      ].join('\n');

    let prompt;
    let summary;
    if (!pendingGroups) {
      prompt = singleFilePrompt(fallbackPath);
      summary = `指向 ${fallbackPath}`;
    } else if (pendingGroups.length === 1) {
      const [group] = pendingGroups;
      const jsonPath = group.absolutePath || (group.page?.url === pageUrl ? fallbackPath : '');
      if (!jsonPath) {
        setReceipt('无法确定任务文件地址。', 6000);
        return null;
      }
      prompt = singleFilePrompt(jsonPath);
      summary = `指向 ${jsonPath}`;
    } else {
      const lines = ['请处理以下网页标注任务（项目跨多个页面，任务已按页面分成多个任务文件）：'];
      pendingGroups.forEach((group, index) => {
        const isCurrent = group.page?.url === pageUrl;
        lines.push(`${index + 1}. 页面：${group.page?.title || group.page?.url || '未命名页面'}${isCurrent ? '（当前页面）' : ''}，待处理 ${group.pending.length} 项`);
        lines.push(`   任务文件：${group.absolutePath || '（地址未知）'}`);
      });
      lines.push('');
      lines.push('请依次参考这些任务文件中的待处理工作，进行处理。');
      lines.push('改完把任务状态回写为 review（待验收），并注明改动的文件与验证证据；不要写 done——done 表示已验收，由主线程复核后才回写。已验收通过的任务请进行归档。');
      lines.push('请按任务文件并行处理：每个任务文件（对应一个页面）交给一个子 agent，同一页面内的多项任务归同一个 agent，不要按任务 ID 再拆。子 agent 只修改自己页面的源码，并回报改动的文件与验证证据；浏览器验收请统一在主线程完成，避免多个 agent 抢占同一个标签页。');
      prompt = lines.join('\n');
      summary = `覆盖 ${pendingGroups.length} 个页面的待处理任务`;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      setReceipt(`提示词已复制，${summary}。`);
    } catch (error) {
      setReceipt(`复制失败：${error.message}`, 6000);
    }
    return prompt;
  }

  /* ---------------- 页面事件 ---------------- */

  function isOwnUi(target) {
    return target === host || host.contains(target);
  }

  function onMove(event) {
    if (!state.active || state.editingId || state.editingIsNew) return;
    const target = event.target;
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
    if (isEditing()) event.stopPropagation();
  }

  function onClick(event) {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (!shouldBlockPageEvent({ ownUi: isOwnUi(target), editing: isEditing(), active: state.active })) return;

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
    const existing = findTaskBySelector(element.selector);
    if (existing) {
      existing.element = element;
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
   * 3) 编辑器已关闭时，Esc 依次退出标注模式、收起侧栏面板。
   */
  function onKeydown(event) {
    if (event.key === 'Escape') {
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
      if (state.active) {
        event.preventDefault();
        event.stopPropagation();
        // 只负责切换，退出文案由 setActive 统一写。之前在这里再赋一次
        // （带「再按 Esc 收起面板」后缀），会覆盖掉 setActive 里的消息。
        setActive(false);
        return;
      }
      if (!state.collapsed) {
        event.preventDefault();
        event.stopPropagation();
        setCollapsed(true);
      }
      return;
    }

    if (event.key !== 'Enter') return;
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

  function setActive(next) {
    state.active = next;
    document.documentElement.style.cursor = next ? 'crosshair' : '';
    if (!next) {
      outline.style.display = 'none';
      hideSizeBadge();
      closeEditor();
    }
    // 进/出标注模式各自给一条提示。之前只在 Esc 退出分支里写消息，
    // 点「标注」进入时消息不变，于是上一条（比如上一轮的「已退出…」）
    // 会一直挂着，看起来像操作没生效。放在这里可保证两条路径一致，
    // 也覆盖 API 调用的 start/stop。
    state.syncMessage = next ? '已进入标注模式（按 Esc 可退出）。' : '已退出标注模式。';
    renderCapsule();
    renderPanelMeta();
    renderMessage();
  }

  function setCollapsed(next) {
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
      else if (act === 'toggle') setActive(!state.active);
      else if (act === 'clear') {
        if (!state.tasks.length) {
          state.syncMessage = '还没有标注。';
          renderMessage();
        } else {
          const locked = state.tasks.filter(t => t.status === 'doing');
          const removable = state.tasks.length - locked.length;
          if (!removable) {
            // 全部都在处理中：没有可清空的内容，如实说明而不是弹一个清不掉确认框
            state.syncMessage = `${locked.length} 项标注正在处理中，均不能清空。可等处理完成，或让处理者标记为阻塞/取消。`;
            renderMessage();
          } else {
            askConfirm({
              title: '清空全部标注？',
              detail: locked.length
                ? `将删除当前页面可清空的 ${removable} 项标注及其图片附件；另有 ${locked.length} 项正在处理中，会被保留。此操作不可撤销。`
                : `将删除当前页面的 ${state.tasks.length} 项标注，同时移除工作区中对应的 JSON 数据与图片附件。此操作不可撤销。`,
              confirmText: locked.length ? `清空 ${removable} 项` : '清空并删除',
              onConfirm: clearAll,
            });
          }
        }
      } else if (act === 'copy') copyPrompt();
      else if (act === 'manual') {
        openEditorForManual();
        state.syncMessage = '手动任务：可直接写要求，也可粘贴图片。';
        renderMessage();
      } else if (act === 'editor-confirm') confirmEditor();
      else if (act === 'editor-close') closeEditor();
      else if (act === 'toggle-details') toggleDetails();
      else if (act === 'confirm-ok') resolveConfirm(true);
      else if (act === 'confirm-cancel') resolveConfirm(false);
    },
    true,
  );

  // 输入或粘贴后同步提交按钮状态与输入框高度
  $('[data-el="editorInput"]').addEventListener('input', syncEditorInput);

  document.addEventListener('paste', onPaste, true);
  document.addEventListener('mousemove', onMove, true);
  // mousedown 必须早于 click 拦下：页面控件的聚焦发生在 mousedown 阶段，
  // 只拦 click 的话输入框已经拿到焦点了。
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('scroll', () => {
    repositionPins();
    // 编辑期间页面仍可滚动（滚轮不被拦截），聚光孔必须跟着元素走
    updateFocusFx();
  }, true);
  window.addEventListener('resize', () => {
    repositionPins();
    hideSizeBadge();
    if (state.editingId || state.editingIsNew) {
      const sel = state.editingId ? findTask(state.editingId)?.element?.selector : state.pendingElement?.selector;
      placeEditor(sel || null, $('[data-el="editorInput"]'));
    }
  });

  document.documentElement.append(host);
  // 版本由宿主（Vite 插件 / http 适配器）随 bootstrap 注入，与技能版本同源
  $('[data-el="panelVersion"]').textContent = config.version ? `v${config.version}` : '';
  renderBar();
  renderPins();
  renderMessage();
  // localStorage 先用于首屏占位，随后以工作区 JSON 为权威刷新；
  // 定时器会继续处理模型在其它终端的状态回写、删除与归档。
  startRemoteRefresh();
  startEventStream();
  loadRemoteTasks({ quiet: true });

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
    pinCount: () => $$('.pin').length,
    pinTexts: () => $$('.pin').map(p => p.textContent),
    pinTitle: id => shadow.querySelector(`[data-pin="${cssEscape(id)}"]`)?.title || null,
    destroy() {
      stopRemoteRefresh();
      stopEventStream();
      for (const timer of remoteSyncTimers.values()) clearTimeout(timer);
      remoteSyncTimers.clear();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('scroll', repositionPins, true);
      document.documentElement.style.cursor = '';
      host.remove();
      delete window.__zwAnnotator;
      return true;
    },
  };

  window.__zwAnnotator = api;
  return api;
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

/* ---- 右下角控制条 ---- */
/* z-index 比 .editor 低一号：两者同为最大值时按 DOM 顺序后者在上，
   会让展开详情的弹窗被标注列表盖住。面板必须在遮罩之上、弹窗之下。 */
.bar { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; font: 13px/1.5 var(--zc-font); }
.dock {
  position: relative;
  display: flex; align-items: center; gap: 2px;
  padding: 4px; border: 1px solid #3f3f3f; border-radius: 999px;
  background: #1c1c1c; box-shadow: 0 8px 22px rgba(0,0,0,.4);
}
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
  position: absolute; left: 4px; bottom: 100%;
  display: flex; align-items: flex-start; gap: 6px;
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
.dock-float-btn {
  display: flex; align-items: center; gap: 5px;
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
/* 位置必须让开上方的悬浮按钮层（y 708~738），否则会盖住「手动/复制」并挡住点击；
   所以整条落在浮层之上，且加 pointer-events:none——它只是回执，不需要交互，
   即使因长文案增高也不会吞掉按钮的点击。right 与胶囊同轴对齐。 */
.toast {
  position: fixed; right: 18px; bottom: 102px; z-index: 2147483646;
  max-width: min(340px, calc(100vw - 36px));
  padding: 9px 13px; border: 1px solid #3f3f3f; border-radius: 10px;
  background: #1c1c1c; color: #ececec;
  font: 600 12px/1.5 var(--zc-font);
  box-shadow: 0 10px 26px rgba(0,0,0,.45);
  pointer-events: none;
  opacity: 1; transition: opacity .16s ease;
}
.toast.hidden { display: none; }

/* ---- 侧栏：展开面板 ---- */
.panel {
  position: fixed; right: 18px; bottom: 18px;
  display: flex; flex-direction: column;
  width: 340px; max-height: 72vh;
  background: #1b1b1b; color: #eee;
  border: 1px solid #3f3f3f; border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0,0,0,.5); overflow: hidden;
}
.panel header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 11px 8px;
}
.panel-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.panel-title strong { font-size: 13px; }
.panel-meta { color: #8f8f8f; font-size: 11px; }
/* 版本徽标：一眼看到页面里跑的是哪一版运行时，升级后刷新即可确认 */
.panel-version {
  flex: none; margin-left: auto;
  padding: 1px 7px; border-radius: 999px;
  background: #262626; color: #8f8f8f; font-size: 10px;
}
/* 收缩按钮固定在最右上角 */
.panel-collapse {
  flex: none; width: 24px; height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; cursor: pointer;
  background: #2b2b2b; color: #c9c9c9;
}
.panel-collapse svg { width: 15px; height: 15px; }
.panel-collapse:hover { background: #383838; color: #fff; }
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
.panel-list { flex: 1; overflow: auto; padding: 6px 9px 9px; }

/* ---- 总体进度条 ---- */
/* 三段权重（分派 10 / 开发 70 / 验收 20）已折算进 fill 的宽度，条上不再分段，
   避免用户误以为每一段可单独点击或拖拽。 */
.panel-progress { padding: 8px 11px 9px; border-bottom: 1px solid #333; }
.progress-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-bottom: 6px;
}
.progress-label { color: #9a9a9a; font-size: 11px; }
.progress-pct { color: #dedaff; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
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
  border: 1px solid #343434; border-radius: 9px; background: #212121;
  padding: 8px 9px; margin: 7px 1px;
}
.panel .item.editing { border-color: #7c6cff; }
.panel .item-head { display: flex; align-items: center; gap: 7px; }
.panel .item-seq {
  flex: none; width: 18px; height: 18px; border-radius: 50%;
  background: #7c6cff; color: #fff; font-family: inherit; font-weight: 700; font-size: 10px; line-height: 18px; text-align: center;
}
.panel .item-seq.manual { background: #d8a45a; color: #2b1e08; }
.panel .item-thumbs { display: flex; gap: 4px; margin: 5px 0 0; flex-wrap: wrap; }
.panel .item-thumbs img {
  width: 36px; height: 36px; object-fit: cover;
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
.panel .tag { flex: none; font-size: 10px; color: #8fd6a0; }
.panel .tag.warn { color: #d8a45a; }
/* 待验收：代码已改、主线程还没验，用琥珀色与「已完成」的绿色区分开 */
.panel .tag.review { color: #e0b464; }
.panel button.link { border: 0; background: none; cursor: pointer; padding: 0; color: #c9c9c9; font: inherit; }
.panel button.link.danger { color: #e07a7a; font-size: 12px; }
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
  border: 1px solid #2e2e2e; border-radius: 7px;
  background: #191919; cursor: pointer; user-select: none;
}
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
}
/* 「当前」用靛蓝、待验收用琥珀，避免两个徽标同色分不清含义 */
.group-badge.review { background: #4a3a1c; color: #e8c176; }
.group-sub {
  flex: 1; min-width: 0; color: #6f6f6f; font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.group-count { flex: none; color: #8f8f8f; font-size: 10px; }
.panel footer { padding: 8px 11px 10px; border-top: 1px solid #333; }
.panel-msg { color: #8fd6a0; font-size: 11px; }
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
