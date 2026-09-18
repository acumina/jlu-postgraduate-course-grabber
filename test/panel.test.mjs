/* ============================================================
 * test/panel.test.mjs —— 面板渲染冒烟测试（用极简 DOM 打桩，不需要浏览器）
 * ------------------------------------------------------------
 * 目的：panel.js 有上千行 UI 代码，浏览器里出错只会表现为「面板一片空白」。
 * 这里把它挂到一个假 shadow root 上，逐个页签渲染并检查：
 *   · 渲染不抛异常
 *   · 输出里没有 undefined / NaN / [object Object] 这类脏值
 *   · 标签基本配平
 *   · 主要按钮都在（改坏了按钮名字会立刻发现）
 *   · **每个 data-act 都有对应的 case**（点了没反应这类 bug 立刻暴露）
 *   · 一部分按钮点击不抛异常
 * 用法：node test/panel.test.mjs
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- 打桩：最小 DOM ---------------- */
const listeners = {};
function makeShadow() {
  return {
    adoptedStyleSheets: [],
    activeElement: null,
    _html: '',
    _writes: 0,          // innerHTML 被赋值几次 = 面板 DOM 被重建几次（用来抓"重绘吃掉 click"这类 bug）
    set innerHTML(v) { this._html = v; this._writes++; },
    get innerHTML() { return this._html; },
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  };
}
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, value: '', textContent: '', checked: false,
    attachShadow() { this._shadow = makeShadow(); return this._shadow; },
    appendChild() {}, remove() {}, setAttribute() {}, select() {},
    addEventListener() {}, classList: { add() {}, remove() {} }
  };
}
globalThis.document = {
  readyState: 'complete',
  body: { appendChild() {} },
  documentElement: { appendChild() {} },
  createElement: makeEl,
  addEventListener() {},
  execCommand() { return true; }
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
// panel.js 会读 window（面板宽度/拖动都依赖它），测试里补一个最小桩
globalThis.window = globalThis.window || {
  innerWidth: 1280,
  innerHeight: 900,
  addEventListener() {},
  postMessage() {},
  getSelection() { return null; }
};
globalThis.alert = () => {};
globalThis.confirm = () => false;
// Node 24 已经有只读的全局 navigator，不需要也不允许再赋值
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: { getURL: (p) => 'chrome-extension://fake/' + p, sendMessage: async () => ({ ok: true }) }
};

await import('../src/lib/config.js');
await import('../src/lib/rules.js');
await import('../src/panel.js');
const KX = globalThis.KX;
const R = globalThis.KXRules;
const KXPanel = globalThis.KXPanel;

/* ---------------- 假 app（模拟 content.js 暴露的 KXApp） ---------------- */
const captureFixture = {
  id: 'c1', kind: 'fetch', method: 'POST',
  url: 'https://jwxt.example.edu.cn/xk/xkgo?op=save&jxb_id=2099000001',
  reqHeaders: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    Cookie: 'JSESSIONID=secret', 'Content-Length': '72'
  },
  reqBody: 'jxb_id=2099000001&kch_id=CS101&xnm=2024&xqm=12&op=save',
  status: 200, respType: 'application/json',
  resp: '{"code":0,"msg":"选课成功"}', ms: 62, ts: Date.now()
};
const captureFixture2 = Object.assign({}, captureFixture, {
  id: 'c2',
  reqBody: 'jxb_id=2099000002&kch_id=CS102&xnm=2024&xqm=12&op=save',
  resp: '{"code":1,"msg":"该教学班人数已满"}'
});

function makeStatus(overrides) {
  return Object.assign({
    active: true, host: 'jwxt.example.edu.cn', href: 'https://jwxt.example.edu.cn/xk',
    bridgeReady: true, tabId: 7, running: true, status: 'running', statusText: '抢课中',
    scheduleAt: '', nextRunAt: Date.now() + 1500, backoffMult: 1,
    stats: { cycles: 12, queryOk: 5, queryErr: 0, submitTry: 9, submitOk: 1, submitFull: 8, submitErr: 0, halts: 0 },
    auth: { state: 'ok', why: '', lastOkAt: Date.now(), lastProbeAt: Date.now(), loginAt: Date.now() - 60000, leftMs: 19 * 60000, loginUrl: '' },
    resumePending: false,
    targets: [
      { id: '2099000001', label: '数据结构-张三', kch: 'CS101', enabled: true, priority: 1, state: 'waiting', tryCount: 8, okCount: 0, lastMsg: '名额已满，继续监控', remain: 0, lastAt: Date.now() },
      { id: '2099000002', label: '操作系统-李四', kch: '', enabled: false, priority: 2, state: 'success', tryCount: 1, okCount: 1, lastMsg: '选课成功', remain: 3, lastAt: Date.now() },
      { id: '2099000003', label: '', kch: 'CS103', enabled: true, priority: 3, state: 'blocked', tryCount: 3, okCount: 0, lastMsg: '触发验证码', lastAt: Date.now(), needConfirm: true }
    ],
    boardAt: Date.now(), board: [{ id: '2099000001', name: '数据结构', remain: 0 }],
    captureCount: 2, logCount: 3
  }, overrides || {});
}

const app = {
  config: () => {
    const c = KX.defaults();
    c.sites = ['jwxt.example.edu.cn'];
    c.submit.body = 'jxb_id={{id}}&kch_id={{kch}}&xnm=2024&op=save';
    c.submit.url = 'https://jwxt.example.edu.cn/xk/xkgo';
    c.targets = makeStatus().targets;
    return c;
  },
  status: () => makeStatus(),
  captures: () => [captureFixture, captureFixture2],
  captureById: (id) => [captureFixture, captureFixture2].find((c) => c.id === id) || null,
  logs: () => [
    { i: 1, t: Date.now(), level: 'ok', msg: '引擎启动' },
    { i: 2, t: Date.now(), level: 'warn', msg: '触发限速保护，等待 300ms', extra: '{"url":"x"}' },
    { i: 3, t: Date.now(), level: 'err', msg: '✖ 请求失败' }
  ],
  save: async () => ({}), importConfig: async (o) => Object.assign({ targets: [], submit: {}, query: {} }, o),
  start: async () => ({ ok: true }), stop: () => {},
  probe: async () => ({}), markLogin: () => true, openLogin: () => ({ ok: true }),
  confirmTarget: () => {}, denyTarget: () => {}, resetTargetState: () => {},
  addTarget: async () => ({ ok: true }), removeTarget: async () => ({ ok: true }), updateTarget: async () => ({ ok: true }),
  applyCapture: async () => ({ ok: true }), testSubmit: async () => ({ ok: true, kind: 'success' }),
  testQuery: async () => ({ ok: true, list: [] }), clearLog: () => {}, clearCaptures: async () => {},
  setRecording: () => {}, clearCapturesSync: () => {},
  pushNow: async () => ({ ok: true, added: 2, total: 2 }), pingCollector: async () => ({ ok: true, body: { entries: 0, files: {} } }),
  exportCaptures: () => ({ filename: 'kx-captures.har', text: '{}' }), lastPush: () => ({ at: 0 }),
  probePageValues: async () => ({ href: 'x', cookies: 'csrfToken=abc123', globals: {}, storage: { local: {}, session: {} }, metas: {} }),
  learnedTokens: () => ({})
};

/* 在 mount 之前就包一层 createElement，好把面板真正用的那个 shadow root 记下来，
 * 之后就能读它的 innerHTML 做断言了。 */
let capturedShadow = null;
const origCreate = document.createElement;
document.createElement = (tag) => {
  const el = origCreate(tag);
  if (el.attachShadow) {
    const orig = el.attachShadow.bind(el);
    el.attachShadow = (init) => { const s = orig(init); capturedShadow = s; return s; };
  }
  return el;
};

KXPanel.mount(app, { visible: true, tab: 'captures', collapsed: false });
if (!capturedShadow) throw new Error('面板没有挂载到 shadow root 上，测试打桩失效');

/** 重新渲染一次并返回面板 HTML */
function html() {
  KXPanel.refresh();
  return capturedShadow.innerHTML;
}

function snippet(h, needle) {
  const i = h.indexOf(needle);
  return i < 0 ? '' : h.slice(Math.max(0, i - 120), i + 80);
}

test('panel: 六个页签都能渲染且没有脏值', () => {
  for (const tab of ['captures', 'targets', 'board', 'archive', 'log', 'settings']) {
    KXPanel.setTab(tab);
    const h = html();
    assert.ok(h && h.length > 100, '页签 ' + tab + ' 渲染为空');
    assert.ok(!/undefined/.test(h), '页签 ' + tab + ' 输出里有 undefined：' + snippet(h, 'undefined'));
    assert.ok(!/NaN/.test(h), '页签 ' + tab + ' 输出里有 NaN：' + snippet(h, 'NaN'));
    assert.ok(!/\[object Object\]/.test(h), '页签 ' + tab + ' 输出里有 [object Object]');
  }
});

test('panel: 档案页要能读「项目 archives/ 目录」与「临时选文件夹」', () => {
  /* 用户需求：档案放进项目单独文件夹 → 面板能列出并读取；也能临时选任意文件夹。
   * 背景：浏览器扩展**不允许枚举自己目录里的文件**，所以项目的 archives/ 靠
   * tools/make-archive-index.mjs 生成的 index.json 索引来列举。 */
  KXPanel.setTab('archive');
  let h = html();
  assert.ok(h.includes('项目 archives/ 目录里的档案'), '要有"项目 archives/ 目录"区块');
  assert.ok(h.includes('data-act="arch-refresh-bundled"'), '要能重新扫描 archives/');
  assert.ok(h.includes('data-act="arch-pick-dir"'), '要能临时选文件夹');
  assert.ok(h.includes('data-act="arch-dir"') && /webkitdirectory/.test(h), '文件夹输入框要用 webkitdirectory');
  assert.ok(/make-archive-index\.mjs/.test(h), '空的时候要告诉用户怎么把文件放进去（跑索引工具）');

  // 有一份"项目里的档案"时，要能一键读取
  KXPanel.bundled({ generatedAt: Date.now(), files: [
    { name: 'kx-courses-20260917-1540.json', rows: 148, at: Date.now(), terms: ['20261×120', '20251×28'] }
  ] });
  h = html();
  assert.ok(h.includes('kx-courses-20260917-1540.json'), '要列出文件名');
  assert.ok(h.includes('148'), '要显示门数');
  assert.ok(h.includes('data-act="arch-load-bundled"'), '要有一键「读取」按钮');
  assert.ok(/20261×120/.test(h), '要显示学期分布（判断是哪一年的档案）');
  KXPanel.setTab('board');
});

test('panel: 「已选课程」区（服务器权威判据，退课仍是手动）', () => {
  /* 真实事故：15:28:31 选上了「研究生心理成长」（响应 {"msg":"<WID>","code":1}），
   * 插件只敢说"看起来成功了，请你去学校页面确认"—— 而抓包里早就有 loadStdCourseInfo
   * 这个能权威判断的接口。这个区就是它的 UI。
   * 注意：退课**不做自动化**（用户明确要求），所以这里**不该**有退课按钮，
   * 但必须提示"退课前先把目标停掉，否则会被抢回来"。 */
  KXPanel.setTab('targets');
  KXPanel.mine([
    { id: '20261-111-A0321000003-1788793882416', name: '研究生心理成长', teacher: '张琳', wid: '7151e5f115564b95a066b580b809b990', raw: { XF: 1 } }
  ], Date.now());
  const h = html();
  assert.ok(h.includes('已选课程（服务器确认）'), '要有已选课程区');
  assert.ok(h.includes('研究生心理成长') && h.includes('张琳'), '要列出已选课程与教师');
  assert.ok(h.includes('data-act="check-mine"'), '要有「检查已选课程」按钮');
  assert.equal(/data-act="drop-course"/.test(h), false, '退课不做自动化：不该有退课按钮');
  assert.ok(/退课请去学校页面手动退/.test(h), '要说明退课是手动的');
  assert.ok(/退之前先把对应目标「停」或「删」/.test(h), '要提醒"退课前先停目标，否则会被抢回来"');
});

test('简化: 退课相关的自动化代码必须彻底移除（用户明确不需要）', async () => {
  const fs = await import('node:fs');
  const content = fs.readFileSync('src/content.js', 'utf8');
  const panel = fs.readFileSync('src/panel.js', 'utf8');
  for (const [name, s] of [['content.js', content], ['panel.js', panel]]) {
    assert.equal(/dropCourse|setDropTemplate/.test(s), false, name + ' 里还有退课自动化的函数');
    assert.equal(/use-drop|drop-course/.test(s), false, name + ' 里还有退课相关的按钮/动作');
  }
  const cfg = JSON.parse(fs.readFileSync('kx-config-吉大研究生选课.json', 'utf8'));
  assert.equal('drop' in cfg, false, '配置里不该再有 drop 段');
  assert.ok(cfg.mine && cfg.mine.url, 'mine（已选课程核对）要保留 —— 它是判断"选上没有"的权威判据');
});

test('panel: 「档案」页 —— 离线课程快照 + 跨年按课程名兜底', () => {
  /* 用户需求：① 新建页面把当前所有课程存档，用于选课未开前提前挑目标
   *           ② 下一年代码变了，用模糊搜索课程名兜底 */
  KXPanel.setTab('archive');
  // 空档案时要有引导
  let h = html();
  assert.ok(h.includes('还没有档案') && h.includes('data-act="arch-refresh"'), '空档案要有引导和刷新按钮');
  assert.ok(h.includes('data-act="arch-resolve"'), '要有「按课程名重新解析目标」按钮');
  assert.ok(h.includes('data-act="arch-download"') && h.includes('data-act="arch-pick"'),
    '要能"导出为文件 / 选择文件导入"（真正的文件操作，不是只让用户复制粘贴）');
  assert.ok(h.includes('data-act="arch-file"') && /type="file"/.test(h), '要有文件选择框');
  assert.ok(h.includes('data-act="arch-copy"'), '保留剪贴板兜底');
  assert.ok(/下载文件夹/.test(h), '要说明文件存到哪里（下载文件夹）');
  assert.ok(/重载插件、重启浏览器都不丢/.test(h), '要说明档案存在浏览器里、什么时候会丢');

  // 有档案时：能搜、能勾选加监控、显示"当前余量"
  KXPanel.archive({ at: Date.now(), site: 'yjsxk.jlu.edu.cn', rows: [
    { id: '20261-104-A1322104047-1784036812839', name: '钢琴艺术赏析', klass: '钢琴艺术赏析（线上慕课）', code: 'A1322104047', teacher: '王老师', campus: '前卫校区', time: '3-12周 星期日[3-4节]', capacity: 20, used: 20, remain: 0 },
    { id: '20261-105-A0422105011-1', name: '羽毛球', klass: '羽毛球（羽毛球01南湖）', code: 'A0422105011', teacher: '李凤丽', campus: '南湖校区', time: '3-12周 星期六[3-4节]', capacity: 20, used: 18, remain: 2 }
  ] }, []);
  h = html();
  assert.ok(h.includes('共 <b>2 门</b>') || h.includes('2 门'), '要显示档案门数');
  assert.ok(h.includes('当前余量'), '列名应为「当前余量」');
  assert.ok(h.includes('李凤丽'), '要显示教师（跨年匹配的依据）');
  assert.ok(h.includes('data-act="arch-filter"'), '要有搜索框');
  assert.ok(h.includes('data-act="arch-sel"'), '要能勾选');
  assert.ok(h.includes('data-act="arch-add-sel"'), '要能批量加入监控');
  KXPanel.setTab('board');
});

test('panel: 标签配平（防止 innerHTML 半截导致空白面板）', () => {
  KXPanel.setTab('settings');
  const h = html();
  for (const tag of ['div', 'table', 'tr', 'td', 'span', 'button', 'pre', 'textarea', 'select', 'label']) {
    const open = (h.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length;
    const close = (h.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert.equal(open, close, '<' + tag + '> 开合不配平：' + open + ' 个开、' + close + ' 个闭');
  }
});

test('panel: 抓包页有关键按钮与差分能力', () => {
  KXPanel.setTab('captures');
  const h = html();
  for (const t of ['设为提交模板', '设为余量查询模板', '复制 cURL', '详情', '清空']) {
    assert.ok(h.includes(t), '抓包页缺少按钮/文案：' + t);
  }
  assert.ok(h.includes('2099000001'), '应显示抓到的请求体相关 ID');
});

test('panel: 目标页含课程号列，且 {{kch}} 为空时会红框提示', () => {
  KXPanel.setTab('targets');
  const h = html();
  assert.ok(h.includes('课程号'), '目标页应有课程号列');
  assert.ok(h.includes('data-act="t-kch"'), '课程号应可编辑');
  assert.ok(h.includes('{{kch}}'), '模板里用了 {{kch}} 就应给出提示');
  assert.ok(h.includes('数据结构-张三') && h.includes('2099000003'), '应列出目标');
});

test('panel: 设置页覆盖全部配置分组与关键字段', () => {
  KXPanel.setTab('settings');
  const h = html();
  for (const t of ['引擎', '会话 / 20 分钟硬超时', '提交模板', '判定规则', '余量查询', '通知', '生效站点', '配置导入 / 导出']) {
    assert.ok(h.includes(t), '设置页缺少分组：' + t);
  }
  for (const p of ['engine.intervalMs', 'engine.scheduleAt', 'session.hardTimeoutMs', 'session.autoResume',
    'session.keepAlive.enabled', 'submit.url', 'submit.body', 'submit.rules.success.value',
    'query.parse.remainField', 'notify.webhook', 'sites', 'debug.collectorUrl', 'debug.autoPush', 'debug.pushLogs']) {
    assert.ok(h.includes('data-path="' + p + '"'), '设置页缺少字段：' + p);
  }
  for (const t of ['本地抓包落盘', '测试连接', '立即推送', '导出抓包 HAR', '探测页面 token']) {
    assert.ok(h.includes(t), '设置页缺少元素：' + t);
  }
});

test('panel: 收起后只剩小胶囊，展开能恢复', () => {
  KXPanel.setTab('captures');
  KXPanel.setVisible(true);
  const before = html();
  assert.ok(before.includes('kx-panel-host') === false && before.includes('class="wrap'), '展开时应有面板容器');
  KXPanel.setVisible(false);
  const collapsed = html();
  assert.ok(collapsed.includes('class="pill"'), '收起后应是小胶囊');
  assert.ok(collapsed.length < 400, '收起后不该还渲染整块面板');
  KXPanel.setVisible(true);
});

test('panel: 面板可加宽（表格列多时不再挤成竖排）', () => {
  KXPanel.setTab('targets');
  KXPanel.refresh();
  const before = capturedShadow.innerHTML;
  assert.ok(/width:\d+px/.test(before), '面板应显式设置宽度');
  assert.ok(before.includes('data-act="wider"'), '标题栏应有宽度切换按钮');
  // 点一下宽度按钮应换到下一个档位并重绘
  const click = listeners.click || [];
  const el = { dataset: { act: 'wider' }, closest: () => el };
  for (const fn of click) fn({ target: el, preventDefault() {}, stopPropagation() {} });
  const after = capturedShadow.innerHTML;
  assert.notEqual(after.match(/width:(\d+)px/)[1], before.match(/width:(\d+)px/)[1], '点宽度按钮后宽度应变化');
});

test('panel: 余量页有筛选框、校区列、可展开详情', () => {
  KXPanel.setTab('board');
  // 灌一批真实形状的余量数据进去
  const board = [
    { id: '20261-105-A0422105001-1783734434438', name: '健美操', remain: 0, kch: 'A0422105001',
      raw: { KCMC: '健美操', KCDM: 'A0422105001', BJMC: '健美操01前卫', RKJS: '胡光霞', PKSJDDMS: '3-12周 星期日[3-4节]', XQMC: '前卫校区', XF: 1, KXRS: 20, DQRS: 20, KCKKDWMC: '体育学院', XKBZ: '第一次课在前卫校区田径场主席台前集合' } },
    { id: '20261-105-A0422105013-1783731972173', name: '台球', remain: 0, raw: { KCMC: '台球', RKJS: '李洋', XQMC: '南岭校区', KXRS: 20, DQRS: 20 } }
  ];
  KXPanel.board(board, Date.now());
  const h = capturedShadow.innerHTML;
  assert.ok(h.includes('data-act="board-filter"'), '应有筛选框');
  assert.ok(h.includes('校区'), '应有校区列');
  assert.ok(h.includes('胡光霞'), '应显示教师');
  assert.ok(h.includes('data-act="board-more"'), '每行应有「详情」按钮');

  // 点详情 → 展开原始响应里的全部字段
  const click = listeners.click || [];
  const el = { dataset: { act: 'board-more', id: board[0].id }, closest: () => el };
  for (const fn of click) fn({ target: el, preventDefault() {}, stopPropagation() {} });
  const h2 = capturedShadow.innerHTML;
  assert.ok(h2.includes(board[0].id), '详情里要显示完整选课ID（表格里只显示末段）');
  assert.ok(h2.includes('第一次课在前卫校区田径场主席台前集合'), '详情里要能看到课程备注');
  assert.ok(h2.includes('体育学院'), '详情里要能看到开课单位');
  assert.ok(h2.includes('20'), '详情里要能看到容量/已选');
  assert.ok(h2.includes('复制选课ID'), '详情里应能一键复制完整的选课ID');
});

test('回归: 标题栏按钮必须能点（拖动/调宽不能吃掉 click）', () => {
  /* 真实事故：标题栏整块是拖动区（data-drag），按钮也在里面 ——
   * pointerdown 被当成开始拖动，pointerup 又 render() 重建 DOM，
   * 元素在 click 派发前就没了 → 标题栏上「启动/停止/收起/宽度」全部点不动。 */
  KXPanel.setVisible(true);
  KXPanel.setTab('captures');
  KXPanel.refresh();
  const down = listeners.pointerdown || [];
  const up = listeners.pointerup || [];
  assert.ok(down.length && up.length, 'panel 应注册了拖动指针事件');

  // 模拟：在「启动」按钮上按下 → 抬起（没有移动）
  const wrap = { getBoundingClientRect: () => ({ left: 100, right: 700, top: 0, bottom: 400 }), style: {}, setPointerCapture() {} };
  const origQuery = capturedShadow.querySelector;
  capturedShadow.querySelector = (sel) => (sel === '.wrap' ? wrap : (origQuery ? origQuery.call(capturedShadow, sel) : null));
  const beforeHtml = capturedShadow.innerHTML;
  const writesBefore = capturedShadow._writes;

  /* 真实结构：按钮在标题栏**内部**，所以 btn.closest('[data-drag]') 会返回标题栏。
   * 这个细节很关键 —— 早先的测试桩让 closest 对 [data-drag] 返回 null，
   * 于是根本没走进拖动分支，测试"通过"了却抓不到真 bug（反向验证时发现的）。 */
  const header = { closest: () => null };
  const btn = (function () {
    const el = {
      dataset: { act: 'start' },
      closest: function (s) {
        if (String(s).indexOf('data-act') !== -1) return el;   // 自己是按钮
        if (String(s).indexOf('data-drag') !== -1) return header; // 但它在可拖动标题栏里
        return null;
      },
      setPointerCapture: function () {}
    };
    return el;
  })();
  for (const fn of down) fn({ target: btn, clientX: 650, clientY: 20, preventDefault() {}, pointerId: 1 });
  for (const fn of up) fn({ target: btn, clientX: 650, clientY: 20, pointerId: 1 });

  capturedShadow.querySelector = origQuery;
  // 关键断言：没有发生移动时，pointerup 不应重绘（DOM 重建 = 元素在 click 派发前被销毁）
  assert.equal(capturedShadow._writes, writesBefore,
    '点按钮时 pointerup 不该重绘面板 —— 否则 click 事件会丢失，标题栏按钮点不动');
  assert.equal(capturedShadow.innerHTML, beforeHtml);
});

test('回归: 真的拖动面板时才重绘并保存位置', () => {
  const down = listeners.pointerdown || [];
  const move = listeners.pointermove || [];
  const up = listeners.pointerup || [];
  const wrap = { getBoundingClientRect: () => ({ left: 100, right: 700, top: 0, bottom: 400 }), style: {}, setPointerCapture() {} };
  const origQuery = capturedShadow.querySelector;
  capturedShadow.querySelector = (sel) => (sel === '.wrap' ? wrap : (origQuery ? origQuery.call(capturedShadow, sel) : null));
  const writesBefore = capturedShadow._writes;

  const handle = { closest: (s) => (s === '[data-drag]' ? handle : null), setPointerCapture() {} };
  for (const fn of down) fn({ target: handle, clientX: 300, clientY: 20, preventDefault() {}, pointerId: 1 });
  for (const fn of move) fn({ target: handle, clientX: 260, clientY: 60, pointerId: 1 });
  for (const fn of up) fn({ target: handle, clientX: 260, clientY: 60, pointerId: 1 });
  capturedShadow.querySelector = origQuery;

  assert.ok(capturedShadow._writes > writesBefore, '拖动后应该重绘一次（把新位置写进样式）');
  assert.equal(wrap.style.left, '60px', '面板应移动到拖到的位置');
});

test('回归: 重建面板时要保住滚动位置（点「详情」不该跳回顶部）', () => {
  /* 真实事故：render() 重建整个 innerHTML，只在异步刷新路径里保存了 scrollTop，
   * 按钮点击触发的直接 render() 用的是旧值 → 点「详情」列表跳回顶部。 */
  KXPanel.setTab('board');
  const body = { scrollTop: 0, style: {} };
  const origQuery = capturedShadow.querySelector;
  capturedShadow.querySelector = (sel) => (sel === '.body' ? body : (origQuery ? origQuery.call(capturedShadow, sel) : null));

  KXPanel.board([{ id: '20261-105-A0422105055-1788403399462', name: '文人雅习', remain: 0, raw: { KCMC: '文人雅习', RKJS: '刘天明', XQMC: '前卫校区' } }], Date.now(), { full: true });
  KXPanel.refresh();                    // 初次渲染
  body.scrollTop = 320;                 // 用户往下滚了
  KXPanel.refresh();                    // 再渲染一次（模拟点详情触发的重建）
  capturedShadow.querySelector = origQuery;

  assert.equal(body.scrollTop, 320, '重建面板后滚动位置必须保持（不能跳回顶部）');
});

test('回归: 目标表不能裁掉「删」按钮（且课程号列随模板自适应）', () => {
  /* 真实事故：操作列只有 96px 塞不下「停用/重置/删」三个按钮，
   * td 的 text-overflow:ellipsis 把「删」裁掉了 → 用户根本删不掉加错的目标。 */
  const origConfig = app.config;
  KXPanel.setTab('targets');

  // ① 模板**用**了 {{kch}} → 显示课程号列，删按钮仍必须完整
  const h1 = html();
  assert.ok(/<th[^>]*>课程号<\/th>/.test(h1), '模板用了 {{kch}} 就该显示课程号列');
  assert.ok(h1.includes('data-act="t-del"'), '必须有删除按钮');
  assert.ok(h1.includes('>删</button>'), '删除按钮文字要完整可见');
  assert.ok(/width:118px[^>]*>操作/.test(h1), '操作列要留足宽度（否则按钮被裁掉）');

  // ② 模板**没用** {{kch}}（吉大这套就是）→ 隐藏课程号列，把宽度让给操作列
  app.config = () => { const c = origConfig(); c.submit.body = 'bjdm={{id}}&lx=1&csrfToken={{csrfToken}}'; return c; };
  const h2 = html();
  assert.equal(/<th[^>]*>课程号<\/th>/.test(h2), false, '模板没用 {{kch}} 时不该显示课程号列');
  assert.ok(h2.includes('>删</button>'), '隐藏课程号列后删按钮更要在');
  app.config = origConfig;
});

test('panel: 设置页有速率预设，且能把「每目标多久轮一次」算给用户看', () => {
  KXPanel.setTab('settings');
  const h = html();
  assert.ok(h.includes('data-act="rate-preset"'), '应有速率预设按钮');
  for (const name of ['慢', '中', '快', '极速']) {
    assert.ok(new RegExp('>' + name + ' \\d+/分').test(h), '缺少预设：' + name);
  }
  // 必须把"每目标频率"算出来 —— 用户看不懂"400/分"但对"每 1.4 秒轮到一次"有直觉
  assert.ok(/每目标 \d+\/分 ≈ [\d.]+ 秒/.test(h), '预设里要显示每个目标的实际频率');
  assert.ok(h.includes('每个目标的频率 = 实际速率 ÷ 目标数'), '要写清速率与目标数的关系');
  assert.ok(h.includes('减少目标数'), '要提示减少目标数这条提速路径');
});

test('panel: 同名班策略 —— 一起抢，且默认**不**自动收手（成功判定不可靠）', async () => {
  /* 用户原话："应该抢到同名的继续抢，因为你的成功判定并不可靠。"
   * 这个判断是对的：多抢一个同名班只是去退一次课（可逆），
   * 而误停一个同名班是丢掉课程（不可逆）。宁可多抢。
   * （真实教训：15:28 选上了研究生心理成长，响应是 {"msg":"<已选记录WID>","code":1}，
   *   不在预设成功文案里 → 被判成"无法判定"，白抢了一小时。拿这种判断去停抢课很危险。） */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(ROOT, 'src/panel.js'), 'utf8');
  assert.ok(/data-act="arch-add-same-name"/.test(src), '档案页要有「连同同名班一起加」按钮（同名一起抢的入口）');
  assert.ok(/默认<b>不会<\/b>因为/.test(src) || /不会<\/b>因为"判定抢到了"/.test(src),
    '要明确告诉用户"不会因为判定抢到就停掉同名其它班"');
  assert.ok(/多抢一个只是多退一次课/.test(src), '要说明代价对比（多抢可逆、误停不可逆）');

  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  // 提交响应判定成功时**绝不能**去停同名班
  const succ = content.slice(content.indexOf("case 'success':"), content.indexOf("case 'success':") + 1400);
  assert.equal(/stopSameNameOthers/.test(succ), false,
    '提交响应的成功判定只是猜测，绝不能据此停掉同名班（误停=丢课）');
  // 只有在「已选课程」权威确认路径里才允许（且默认关闭）
  assert.ok(/async function stopSameNameOthers/.test(content), '保留 stopSameNameOthers 供选用');
  assert.ok(/autoStopSameName !== true\) return 0/.test(content), '默认关闭（只在显式开启时才停）');

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'kx-config-吉大研究生选课.json'), 'utf8'));
  assert.equal(cfg.engine.autoStopSameName, false, '默认必须是不自动收手');
  assert.ok(cfg.engine.autoResolveMinScore <= 0.7, '模糊门槛按用户要求放低（当前 ' + cfg.engine.autoResolveMinScore + '）');
  assert.ok(cfg.engine.autoResolveMinGap <= 0.05, '领先第二名门槛也放低（当前 ' + cfg.engine.autoResolveMinGap + '）');
});

test('panel: 每个 data-act 必须有对应的 case（否则点击静默无反应）', async () => {
  /* 真实 bug（用户报"加监控点击没反应"）：档案页每行的按钮写的是
   * data-act="arch-add"，但处理器里**只有** case 'add-target' ——
   * 点击落到 switch 的 default → 什么都不发生，也没有任何提示。
   * 之前的测试只检查"按钮存在"，没检查"按钮有人接"，于是这个漏洞活了很久。
   * 这个断言把整类问题堵住：UI 里出现的每个动作名都必须有处理分支。 */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(ROOT2, 'src/panel.js'), 'utf8');

  /* 只看真正的 <button>：input/textarea 上的 data-act 是给 querySelector 查值用的，
   * 不需要 switch 分支（arch-name / arch-dir / import / config-json 这些都是输入框）。 */
  const acts = Array.from(new Set(
    Array.from(src.matchAll(/<button\b[^>]*?data-act=[\\]?["']([a-zA-Z0-9-]+)/g)).map((m) => m[1])
  )).sort();
  const cases = new Set(
    Array.from(src.matchAll(/case '([a-zA-Z0-9-]+)':/g)).map((m) => m[1])
  );
  assert.ok(acts.length > 25, '至少应该识别出二十多个按钮（识别太少说明正则失效了）：' + acts.length);
  const missing = acts.filter((a) => !cases.has(a));
  assert.deepEqual(missing, [],
    '这些按钮没有处理逻辑（点了没反应）：' + missing.join('、'));
});

test('panel: 面板调用的每个 app 方法都必须在门面里存在（否则点击报错/无反应）', async () => {
  /* 和 data-act 那条同类：按钮有分支了，但分支里调的 app.xxx 不存在，一样是"点了没反应"
   * （只是这次会在控制台抛 TypeError，用户更看不到）。 */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const panel = fs.readFileSync(path.join(ROOT2, 'src/panel.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT2, 'src/content.js'), 'utf8');

  const used = new Set();
  for (const m of panel.matchAll(/\b(?:app|S\.app)\.([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
  const facadeAt = content.indexOf('const KXApp = {');
  assert.ok(facadeAt > 0, 'content.js 里应该有 KXApp 门面');
  const seg = content.slice(facadeAt, facadeAt + 12000);
  const provided = new Set();
  for (const m of seg.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:(]/gm)) provided.add(m[1]);

  assert.ok(used.size > 30, '应该识别出几十个调用：' + used.size);
  const missing = Array.from(used).filter((k) => !provided.has(k)).sort();
  assert.deepEqual(missing, [], '面板调用了但门面里没有的方法：' + missing.join('、'));
});

test('panel: 点击关键按钮不抛异常（打桩 app）', () => {
  KXPanel.setTab('captures');
  html();
  const click = listeners.click || [];
  assert.ok(click.length, 'panel 应该注册了 click 委托');
  const fire = (dataset) => {
    const el = { dataset, closest: () => el };
    for (const fn of click) fn({ target: el, preventDefault() {}, stopPropagation() {} });
  };
  // 这些动作都不涉及真实网络/下载，安全
  fire({ act: 'detail', cid: 'c1' });
  fire({ act: 'sel', cid: 'c1' });
  fire({ act: 'diff' });
  fire({ act: 'use-submit', cid: 'c1' });
  fire({ act: 'test-query' });
  fire({ act: 'clear-log' });
  fire({ act: 'sel-clear' });
  fire({ act: 't-reset', id: '2099000001' });
  fire({ act: 't-toggle', id: '2099000001', on: '0' });
  fire({ act: 't-del', id: '2099000001' });
  fire({ act: 'confirm', id: '2099000003' });
  fire({ act: 'probe' });
  fire({ act: 'mark-login' });
  fire({ act: 'add-target', id: '2099000001', label: 'x' });
  fire({ act: 'import-go' });
  fire({ act: 'reset-config' });
  fire({ act: 'ping-collector' });
  fire({ act: 'push-now' });
  fire({ act: 'probe-values' });
  // 页签切换也走 click 委托
  for (const tab of ['captures', 'targets', 'board', 'log', 'settings']) fire({ tab });
  assert.ok(true);
});
