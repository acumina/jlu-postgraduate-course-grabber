/* ============================================================
 * test/shipped.test.mjs —— 「随仓库发布的那套文件」能不能直接用
 * ------------------------------------------------------------
 * 为什么单独测这个：单元测试全部通过 ≠ 新用户拿到的东西能用。
 * 去敏感、清理、改名之后，最容易坏的是**发布物本身**：
 *   · 配置里的模板被清空/改坏 → 提交发不出去
 *   · 内置预设与配置不同步 → 新装用户拿到旧配置
 *   · 课表档案被清空/改字段 → 「档案」页空着、跨年找不回目标
 * 这个文件就是把"新用户第一次使用"的路径用真文件跑一遍。
 *
 * 用法：node test/shipped.test.mjs
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

globalThis.chrome = undefined;
await import('../src/lib/config.js');
await import('../src/lib/rules.js');
await import('../src/lib/presets.js');
const KX = globalThis.KX;
const R = globalThis.KXRules;

const CFG_FILE = 'kx-config-吉大研究生选课.json';
const cfg = JSON.parse(read(CFG_FILE));

test('发布物: 配置文件结构完整（提交/查询/已选接口 + 判定规则 + 会话策略）', () => {
  assert.ok(Array.isArray(cfg.sites) && cfg.sites.length, '站点白名单不能为空（否则面板不出现在学校站点）');
  assert.ok(cfg.submit && cfg.submit.url, '提交接口必须在');
  assert.ok(/\{\{id\}\}/.test(cfg.submit.body || ''), '提交体必须带 {{id}}（否则所有目标提交同一个班）');
  assert.ok(cfg.query && cfg.query.url, '查询接口必须在');
  assert.ok(cfg.mine && cfg.mine.url, '已选课程接口必须在（判断"选上没有"的权威判据）');
  assert.ok(cfg.session && cfg.session.loginUrl, '登录页地址要在（失效后自动打开用）');
  assert.ok(cfg.worker && cfg.worker.urlRe, '引擎运行页面限制要在（防止在非选课页空转）');
  assert.ok(cfg.ui && cfg.ui.mode, 'UI 点击模式配置要在（否则取不到 csrfToken）');
  for (const k of ['success', 'full', 'dup', 'captcha', 'logout', 'closed']) {
    assert.ok(cfg.submit.rules && cfg.submit.rules[k], '判定规则缺少 ' + k);
  }
  assert.equal((cfg.targets || []).length, 0, '发布的配置不能带 targets（那是别人的选课清单）');
});

test('发布物: 提交模板能渲染出可用的请求（这是整条链路的终点，不能坏）', () => {
  const vars = { id: '20261-101-A0162101001-1785413134156', csrfToken: '0123456789abcdef0123456789abcdef' };
  const built = KX.buildBody(cfg.submit.contentType, cfg.submit.body, vars);
  assert.ok(built.body.includes('bjdm=20261-101-A0162101001-1785413134156'), '目标ID要渲染进请求体');
  assert.ok(built.body.includes('csrfToken=0123456789abcdef'), 'csrfToken 要渲染进去');
  assert.ok(built.body.indexOf('{{') === -1, '不能留下未替换的占位符：' + built.body);
  assert.ok(built.headers && Object.keys(built.headers).length, 'form 提交要带 Content-Type');
  const url = KX.renderTemplate(cfg.submit.url, Object.assign({ ts: Date.now() }, vars));
  assert.ok(url.indexOf('{{') === -1, 'URL 里不能留占位符：' + url);
  assert.ok(/choiceCourse\.do\?_\=\d+/.test(url), 'URL 的防重放参数要被渲染成时间戳：' + url);
});

test('发布物: 内置预设可以直接给新用户用（且与配置文件同步）', () => {
  const keys = Object.keys(globalThis.KXPresets || {});
  assert.ok(keys.length, '至少有一个内置预设');
  const p = globalThis.KXPresets[keys[0]];
  assert.deepEqual(p.sites, ['yjsxk.jlu.edu.cn'], '预设的站点白名单');
  assert.ok(p.submit && p.submit.url && p.query && p.query.url && p.mine && p.mine.url, '预设要有三套接口');
  assert.deepEqual(p.targets, [], '预设不能带 targets');
  // 预设 + 用户已有配置 → 合并后用户的东西不能被冲掉（新用户第一次点的就是这条路）
  const merged = KX.mergeBundledConfig(p, { targets: [{ id: 'T', label: '羽毛球' }], engine: { maxReqPerMinute: 600 } });
  assert.equal(merged.targets.length, 1, '合并后必须保留用户的目标');
  assert.equal(merged.engine.maxReqPerMinute, 600, '合并后必须保留用户调的速率');
  assert.deepEqual(merged.sites, ['yjsxk.jlu.edu.cn'], '站点白名单以预设为准');
});

test('发布物: 课表档案可用（能浏览、能把档案行变成目标、能按名字找回）', () => {
  const idxPath = resolve(ROOT, 'archives/index.json');
  assert.ok(existsSync(idxPath), '要有 archives/index.json（面板靠它列举档案）');
  const idx = JSON.parse(read('archives/index.json'));
  assert.ok(Array.isArray(idx.files) && idx.files.length, '索引里至少有一个档案');
  const f = idx.files[0];
  assert.ok(f.rows > 100, '档案门数应完整（实际 ' + f.rows + '）');
  const arc = JSON.parse(read('archives/' + f.name));
  assert.ok(Array.isArray(arc.rows) && arc.rows.length === f.rows, '索引里的门数要与文件一致');
  // 字段是课表白名单（不能混进"我的已选课程"那种个人字段）
  const keys = new Set();
  arc.rows.slice(0, 30).forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  ['id', 'name', 'teacher', 'campus', 'time', 'capacity', 'used', 'remain'].forEach((k) => {
    assert.ok(keys.has(k), '课表档案缺少字段 ' + k);
  });
  ['XH', 'XKR', 'WID'].forEach((k) => assert.equal(keys.has(k), false, '课表档案不该有个人字段 ' + k));

  // 把档案行变成"面板能用"的形状（内容脚本里的 archiveAsRows 做同一件事）
  const rows = arc.rows.map((r) => ({
    id: r.id, name: r.name, remain: r.remain,
    raw: { RKJS: r.teacher, XQMC: r.campus, PKSJDDMS: r.time, KCDM: r.code, BJMC: r.klass }
  }));
  const ex = R.rowExtras(rows[0].raw);
  assert.ok(ex.teacher || ex.campus || ex.time, '档案行要能取出教师/校区/时间（加监控时用来区分同名班）');

  /* 跨年兜底：拿档案里真实存在的课，用"像但不完全一样"的名字去匹配 ——
   * 这就是"下一年教学班代码变了，按课程名找回"的核心路径。 */
  const sample = rows.find((r) => r.name && r.name.length >= 4);
  assert.ok(sample, '档案里应有可用的课程名');
  const noisy = sample.name + '（线上慕课） 01';        // 加上括号与序号（年年会变的差异）
  const cands = R.matchCoursesByName(rows, { label: noisy, teacher: ex.teacher });
  assert.ok(cands.length, '按名字应该能找到候选：' + noisy);
  assert.equal(cands[0].row.id, sample.id, '应该把原课排在第一：期望 ' + sample.id + '，实际 ' + cands[0].row.id);
  const pick = R.pickBestMatch(cands, { minScore: cfg.engine.autoResolveMinScore, minGap: cfg.engine.autoResolveMinGap });
  assert.equal(pick.ok, true, '按发布配置的门槛应该能自动采用');
});

test('从零开始: 全新环境必须自动读项目里带的课表快照（否则弹窗永远不出现）', () => {
  /* 真实 bug（在新环境实测踩到："没能实现第一次弹出历史选课表"）：
   * loadArchive() 只读 chrome.storage，而新电脑上那个键是空的 ——
   * 项目里带的 archives/*.json 从来没被自动读过，于是 archive.rows 是空的：
   *   · 「档案」页空着，挑不了课
   *   · "从零开始"引导的条件要求 hasArchive → 永远不弹
   * 现在 boot 里会调 autoLoadBundledArchive() 把最近的一份快照读进来。 */
  const c = read('src/content.js');
  assert.ok(/async function autoLoadBundledArchive/.test(c), '要有 autoLoadBundledArchive');
  assert.ok(/^\s*await autoLoadBundledArchive\(\)/m.test(c),
    'boot 里必须真的调用它（整行匹配：注释掉会失败）');
  assert.ok(/loadBundledArchive\(files\[0\]\.name\)/.test(c), '要复用按名字读取项目档案的逻辑');
  assert.ok(/Number\(b\.at\) \|\| 0\) - \(Number\(a\.at\) \|\| 0\)/.test(c), '要取档案时间最新的一份');
  // 顺序：必须在"引导判断"和"面板挂载"之前把档案准备好
  const iLoad = c.search(/^\s*await autoLoadBundledArchive\(\)/m);
  const iSeed = c.search(/^\s*await seedTargetsFromWishlist\(\)/m);
  const iMount = c.indexOf('KXPanel.mount(KXApp, ui)');
  const iOnboard = c.indexOf('const hasArchive');
  assert.ok(iLoad > 0 && iSeed > iLoad, '自动读档案要在 seedTargetsFromWishlist 之前');
  assert.ok(iLoad > 0 && iMount > iLoad, '自动读档案要在面板挂载之前（面板一挂就要显示课表）');
  assert.ok(iLoad > 0 && iOnboard > iLoad, '自动读档案要在"从零开始"引导判断之前（否则条件不成立）');
  // 已经有档案时不要覆盖（用户自己导入的更新档案优先）
  assert.ok(/if \(\(archive\.rows \|\| \[\]\)\.length\) return \{ ok: true, skipped: '已有档案' \}/.test(c),
    '已有档案时不能覆盖');
});

test('从零开始: 加完备选清单必须立刻变成监控目标（不用等下次刷新）', () => {
  /* 真实体验问题：以前 addWishlist 只存清单，要等下次页面加载 boot 时才 seed，
   * 用户会觉得"加了没反应"。 */
  const c = read('src/content.js');
  assert.ok(/const r = await seedTargetsFromWishlist\(\);/.test(c), 'addWishlist 里要立刻 seed');
  assert.ok(/seeded: seeded/.test(c), '返回值要带上 seeded（面板可以据此提示）');
  assert.ok(/^\s*autoResolveTargets\('备选清单刚生成目标'\)/m.test(c),
    '生成目标后要立刻尝试解析一次（不必等轮询）');
});

test('从零开始: 全新安装必须自动配好生效站点（跳过"加入白名单"这一步）', () => {
  /* 设计要求："明年使用是直接从零开始，跳过加入白名单的流程"。
   * 默认白名单是空的 → 不自动配的话，面板根本不会出现在学校网站上，
   * 而"新电脑上第一眼什么都看不到"是最糟的体验。 */
  const c = read('src/content.js');
  assert.ok(/async function ensureSiteConfigured/.test(c), '要有 ensureSiteConfigured');
  // 必须在算 ACTIVE 之前调用（否则这次访问就已经决定"不激活"了）
  /* 注意：断言一律用**行首锚定** —— 普通正则会匹配到注释掉的代码，
   * 这样反向验证（把调用注释掉）就抓不到问题（真实踩过：4 项全没抓到）。 */
  const iEnsure = c.search(/^\s*await ensureSiteConfigured\(\)/m);
  const iActive = c.indexOf('ACTIVE = KX.siteAllowed(HOST, cfg.sites)');
  assert.ok(iEnsure > 0 && iActive > 0 && iEnsure < iActive, '自动配站点必须发生在 ACTIVE 判断之前，且不能被注释掉');
  // 命中预设站点才应用，且**不能**动用户的数据
  assert.ok(/KX\.siteAllowed\(HOST, \[s\]\)/.test(c), '要按当前主机匹配预设的 sites');
  assert.ok(/p\.targets = cur\.targets \|\| \[\]/.test(c), '应用预设时必须保留用户已有目标');
  assert.ok(/p\.wishlist = cur\.wishlist \|\| \[\]/.test(c), '应用预设时必须保留备选清单');
  assert.ok(/p\.engine = Object\.assign\(\{\}, p\.engine \|\| \{\}, cur\.engine \|\| \{\}\)/.test(c),
    '应用预设时用户调过的 engine 参数要优先');
  // 预设在，且确实带着吉大站点
  const presetKeys = Object.keys(globalThis.KXPresets || {});
  assert.ok(presetKeys.length, '要有内置预设');
  assert.deepEqual(globalThis.KXPresets[presetKeys[0]].sites, ['yjsxk.jlu.edu.cn'], '预设要带学校站点');
});

test('从零开始: 登录页要弹出"从去年课表挑课"的引导（不用自己找设置）', () => {
  /* 设计要求："在登陆页面弹出去年的课表加入愿望单"。 */
  const c = read('src/content.js');
  /* 注意：这些调用是"带守卫的同一行"（if (KXPanel.onboarding) KXPanel.onboarding(true);）——
   * 断言要贴着**真实写法**写，否则要么漏（注释掉也匹配），要么误报（行首锚定太严）。 */
  assert.ok(/^\s*if \(KXPanel\.onboarding\) KXPanel\.onboarding\(true\);/m.test(c),
    '内容脚本要打开引导（整行匹配：注释掉这行就会失败）');
  assert.ok(/^\s*if \(KXPanel\.expand\) KXPanel\.expand\(\);/m.test(c),
    '引导时要自动展开面板（用户第一眼就能看到）');
  assert.ok(/^\s*KXPanel\.setTab\('archive'\);/m.test(c), '引导时要切到档案页（那里就是去年的课表）');
  assert.ok(/noTargets && noWish && hasArchive/.test(c) || /!noTargets \|\| !noWish \|\| !hasArchive/.test(c),
    '只在"零目标 + 零清单 + 有课表档案"时才弹');
  const p = read('src/panel.js');
  assert.ok(/S\.onboarding/.test(p), '面板要有 onboarding 状态');
  assert.ok(/先挑课（就是现在这一步）/.test(p), '档案页顶部要有醒目的"先挑课"提示');
  assert.ok(/data-act="onboard-skip"/.test(p), '要能跳过');
  assert.ok(/^\s*expand: function/m.test(p), '面板要能被程序化展开');
  assert.ok(/^\s*S\.onboarding = false;      \/\/ 挑过了/m.test(p), '挑过课之后要关掉引导（行首锚定）');
  assert.ok(/^\s*S\.onboarding = false;$/m.test(p) || /onboard-skip[\s\S]{0,200}S\.onboarding = false/.test(p),
    '「跳过」也要关掉引导');
});

test('全部命中都要: 按课程名匹配时，所有够像的教学班都必须一起加入监控', () => {
  /* 设计要求："最大兜底选课要选择全部模糊命中的课程，不能选一门抢就不抢其他的了"。
   * 理由：同名教学班常有十几个（羽毛球×12、篮球×9），只挑一个等于把机会缩小到 1/12。 */
  const rows = [
    { id: 'A1', name: '篮球', teacher: '李某', raw: {} },
    { id: 'A2', name: '篮球', teacher: '李某', raw: {} },
    { id: 'A3', name: '篮球', teacher: '王某', raw: {} },
    { id: 'B1', name: '知识产权法', teacher: '张某', raw: {} }
  ];
  const cands = R.matchCoursesByName(rows, { label: '篮球' });
  assert.ok(cands.length >= 3, '三个同名教学班都该是候选');
  const all = R.pickAllMatches(cands, { minScore: 0.6, max: 30, allowFallback: true });
  assert.equal(all.ok, true);
  assert.equal(all.rows.length, 3, '全部命中都要 → 3 个都采用（实际 ' + all.rows.length + '）');
  assert.deepEqual(all.rows.map((r) => r.id).sort(), ['A1', 'A2', 'A3']);
  assert.equal(all.fallback, false, '分数够时不该算兜底');
  // 只有一个候选时也不炸
  const one = R.pickAllMatches(R.matchCoursesByName([{ id: 'C1', name: '篮球', raw: {} }], { label: '篮球' }), { minScore: 0.6 });
  assert.equal(one.rows.length, 1);
  // 一个都不过门槛 → 兜底取最像的（allowFallback 默认开）
  const fb = R.pickAllMatches(R.matchCoursesByName([{ id: 'D1', name: '知识产权法', raw: {} }], { label: '知识产权法律基础' }),
    { minScore: 0.95, max: 30, allowFallback: true });
  assert.equal(fb.ok, true);
  assert.equal(fb.fallback, true, '不过门槛时应该是兜底（取最像的那个）');
  assert.equal(fb.rows[0].id, 'D1');
  // 关掉兜底 → 不采用
  const noFb = R.pickAllMatches(R.matchCoursesByName([{ id: 'D1', name: '知识产权法', raw: {} }], { label: '知识产权法律基础' }),
    { minScore: 0.95, max: 30, allowFallback: false });
  assert.equal(noFb.ok, false);
  // 上限保护（注意：matchCoursesByName 默认只给 5 个候选，调用方必须显式放大 —— 真实缺口）
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ id: 'M' + i, name: '篮球', raw: {} });
  assert.equal(R.matchCoursesByName(many, { label: '篮球' }).length, 5,
    '默认只给 5 个候选（面板挑选用）');
  const cands50 = R.matchCoursesByName(many, { label: '篮球' }, { max: 30 });
  assert.equal(cands50.length, 30, '显式放大后才能拿到 30 个');
  const capped = R.pickAllMatches(cands50, { minScore: 0.6, max: 10 });
  assert.equal(capped.rows.length, 10, 'expandMax 要真的截断（给 30 个候选、上限 10）');
  assert.equal(capped.truncated, true, '截断要标记出来');
  assert.equal(capped.total, 30, 'total 要反映命中总数');
  // 真实场景：羽毛球 12 个班必须全都拿到
  const badminton = [];
  for (let i = 0; i < 12; i++) badminton.push({ id: 'Y' + i, name: '羽毛球', raw: {} });
  const all12 = R.pickAllMatches(R.matchCoursesByName(badminton, { label: '羽毛球' }, { max: 30 }), { minScore: 0.6, max: 30 });
  assert.equal(all12.rows.length, 12, '羽毛球 12 个班要全部采用（不是只挑 1 个、也不是只 5 个）');
});

test('全部命中都要: 抢到一门之后不许停掉其它同名班（设计要求）', () => {
  /* 设计取舍："不能选一门抢就不抢其他的了"。
   * 引擎里唯一会"停掉同名其它班"的机制是 autoStopSameName，默认必须是 false。 */
  const cfg = JSON.parse(read('kx-config-吉大研究生选课.json'));
  assert.equal(cfg.engine.autoStopSameName, false, '默认不许自动停掉同名其它班');
  assert.equal(cfg.engine.keepPollingAfterSuccess, true, '成功之后要继续轮询');
  assert.equal(cfg.engine.expandAllMatches, true, '默认要展开全部命中');
  assert.ok(Number(cfg.engine.expandMax) >= 10, 'expandMax 要够大（当前 ' + cfg.engine.expandMax + '）');
  const c = read('src/content.js');
  assert.ok(/stopSameNameOthers\(cfg, t\)/.test(c), '保留开关（想开的人可以开）');
  assert.ok(/autoStopSameName !== true\) return 0/.test(c), '但默认关闭：只有显式 true 才停');
  // 解析时要真的追加新目标（而不是只改第一个）
  assert.ok(/const extras = \[\];/.test(c), '解析器要有 extras 数组');
  assert.ok(/targets\.concat\(extras\)/.test(c), '保存时要把追加的同名班一起写进去');
  assert.ok(/sameNameGroup: true/.test(c), '追加的目标要标记来源（面板据此提示）');
});

test('从零开始: 只有"待解析目标"时引擎也必须能启动（否则解析永远触发不了）', () => {
  /* 死锁 bug：start() 原来只把"有 ID 的目标"算数 —— 而备选清单生成的目标 ID 是空的
   * （等着按课程名解析）→ start() 拒绝启动 → 不轮询 → cycle() 不跑 →
   * 不触发解析 → 那些目标永远拿不到 ID。实测反馈"进选课页不自动选课"的原因之一。 */
  const c = read('src/content.js');
  assert.ok(/const pendingTargets = \(cfg\.targets \|\| \[\]\)\.filter/.test(c),
    'start() 里要单独识别"待解析目标"');
  assert.ok(/if \(!targets\.length && !pendingTargets\.length\) \{/.test(c),
    '只有"有ID目标 + 待解析目标"都为空时才算没有监控目标');
  assert.ok(/!String\(t\.id \|\| ''\)\.trim\(\) && \(t\.name \|\| t\.label\)/.test(c),
    '待解析目标的判定：没有ID + 有课程名');
  assert.ok(/有 ' \+ pendingTargets\.length \+ ' 个目标还没有教学班ID/.test(c),
    '要在日志里说明"待解析目标也算数、启动后会先匹配"');
  // 触发解析的那段必须在 cycle() 内部、且在**把空 ID 目标过滤掉那一行之前**
  const iCycle = c.indexOf('async function cycle()');
  const iTrig = c.indexOf("autoResolveTargets('有目标还没有教学班ID");
  const iFilter = c.indexOf('const targets = (cfg.targets || []).filter', iCycle);
  assert.ok(iCycle > 0 && iFilter > iCycle, '找不到 cycle() 或它的目标过滤行');
  assert.ok(iTrig > iCycle && iTrig < iFilter,
    '待解析触发必须在 cycle() 里、且早于"把空 ID 目标过滤掉"那一行（否则永远解析不了）');
});

test('数据安全: 自动应用配置之前必须先 load —— 否则每次导航都会抹掉用户的监控目标', () => {
  /* 真实事故（实测反馈："往年课加完监控，进选课页面突然没了"）：
   *   snapshot() 的实现是 `cache || defaults()` —— **没 load 过就返回空默认值**。
   *   boot 里原来先跑 autoApplyBundledConfig / ensureSiteConfigured，再 KX.load ——
   *   于是这两个函数读到的"当前配置"是默认值（sites:[]、targets:[]）：
   *     · ensureSiteConfigured 误判"这个站点还没配" → 每次都重新应用预设
   *     · 应用时"保留用户数据"保留的是空数组 → 把空 targets 写回存储
   *   因为每次页面加载都是全新的内存状态，**每次导航都会再抹一遍**。
   * 这个测试把顺序钉死，并确认两个函数自己也会 load（不依赖调用方）。 */
  const c = read('src/content.js');
  const iBoot = c.indexOf('async function boot()');
  assert.ok(iBoot > 0, '找不到 boot()');
  const boot = c.slice(iBoot, iBoot + 1400);
  const iLoad = boot.search(/^\s*await KX\.load\(true\);/m);
  const iApply = boot.indexOf('autoApplyBundledConfig()');
  const iSite = boot.indexOf('ensureSiteConfigured()');
  assert.ok(iLoad > 0, 'boot 里必须显式 await KX.load(true)');
  assert.ok(iLoad < iApply, 'KX.load 必须早于 autoApplyBundledConfig（否则读到空默认值）');
  assert.ok(iLoad < iSite, 'KX.load 必须早于 ensureSiteConfigured');
  // 两个函数内部也要自己 load（纵深防御：换个调用点也不会出事）
  ['autoApplyBundledConfig', 'ensureSiteConfigured'].forEach((fn) => {
    const at = c.indexOf('async function ' + fn);
    assert.ok(at > 0, '找不到 ' + fn);
    const seg = c.slice(at, at + 1200);
    const firstUse = Math.min.apply(null, [
      seg.indexOf('KX.snapshot()') === -1 ? 1e9 : seg.indexOf('KX.snapshot()'),
      seg.indexOf('KX.replace(') === -1 ? 1e9 : seg.indexOf('KX.replace(')
    ]);
    const loadAt = seg.search(/KX\.load\(true\)/);
    assert.ok(loadAt > 0 && loadAt < firstUse,
      fn + ' 必须在用 snapshot/replace 之前自己 await KX.load(true)');
  });
  // 空 targets 绝不允许从这两条路径写出去
  assert.ok(/out\.targets = keep\.targets \|\| \[\]/.test(read('src/lib/config.js')),
    'mergeBundledConfig 必须保留传入的 targets');
});

test('静态检查: 不能有"未声明就使用"的标识符（真实事故的自动防线）', async () => {
  /* 真实事故：halt() 里写了 if (!loginRelated) —— 那个变量不存在，
   * 严格模式下每次停机都抛 ReferenceError，把"登录后自动继续"整条逻辑带崩。
   * node --check 只查语法，查不出这种错；这个项目零依赖没有 eslint，
   * 所以用 tools/lint-undefined.mjs 兜住（高精度 + 基线白名单）。 */
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const fs2 = await import('node:fs');
  const os = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const ROOT2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /* 输出写进**临时文件**再读回来 —— 不用管道（受限沙箱禁止子进程开管道，
   * 会在 4 项以外的环境里假失败；这个坑在 git-commit.mjs 里也踩过一次）。 */
  const tmp = path.join(os.tmpdir(), 'kx-lint-' + process.pid + '.txt');
  let code = 0;
  try {
    const fd = fs2.openSync(tmp, 'w');
    try {
      execFileSync('node', [path.join(ROOT2, 'tools/lint-undefined.mjs')], { cwd: ROOT2, stdio: ['ignore', fd, fd] });
    } finally { fs2.closeSync(fd); }
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
  }
  const out = fs2.existsSync(tmp) ? fs2.readFileSync(tmp, 'utf8') : '';
  try { fs2.unlinkSync(tmp); } catch (e) { /* ignore */ }
  assert.equal(code, 0, '存在可疑的未声明标识符：\n' + out);
  assert.ok(/没有发现未声明就使用的标识符/.test(out), 'lint 应输出通过信息');
});

test('README: 使用方式必须在最前面，原理类放到 docs/', () => {
  /* 设计要求："github 首页说明太长了 将使用方式放在最开始的部分
   * 其他部分如实现原理稍作简化放在后面"。 */
  const md = read('README.md');
  const lines = md.split('\n').length;
  assert.ok(lines < 260, 'README 不该再是几百行（现在 ' + lines + ' 行）');
  // 使用方式要先于任何原理性章节出现
  const iUse = md.indexOf('## 怎么用');
  assert.ok(iUse > 0 && iUse < 800, '「怎么用」必须出现在很靠前的位置');
  ['## 怎么用', '## 它能做什么'].forEach((h) => assert.ok(md.includes(h), '缺少 ' + h));
  // 原理类章节必须已经搬走
  ['## 配置项速查表', '## 判定规则', '## engine 参数含义', '## 20 分钟硬超时的应对',
    '## 目录结构', '## 调试技巧', '## 界面速查'].forEach((h) => {
    assert.equal(md.includes(h), false, '这些长章节应该搬到 docs/ 了：' + h);
  });
  // 搬过去的文档要存在且真的有内容
  ['docs/CONFIG.md', 'docs/HOW-IT-WORKS.md', 'docs/DEV.md', 'docs/CAPTURE.md'].forEach((f) => {
    assert.ok(existsSync(resolve(ROOT, f)), '缺少 ' + f);
    assert.ok(read(f).length > 1500, f + ' 内容太短，搬运可能失败');
  });
  // README 里要有指向它们的链接
  assert.ok(/docs\/CONFIG\.md/.test(md), 'README 要链接配置文档');
  assert.ok(/docs\/HOW-IT-WORKS\.md/.test(md), 'README 要链接原理文档');
});

test('发布物: 引擎参数在合理范围（发布即用，不需要用户先调）', () => {
  const st = KX.deepMerge(KX.defaults(), cfg);
  assert.ok(st.engine.intervalMs >= 150, '轮询间隔不能过小（下限 150ms）');
  assert.ok(st.engine.intervalMs <= 500, '设计要求：反复轮询间隔要在 500ms 以内（当前 ' + st.engine.intervalMs + '）');
  assert.ok(st.engine.minGapMs <= 500, '两批发包间隔也要 <=500ms（当前 ' + st.engine.minGapMs + '）');
  assert.ok(st.engine.maxReqPerMinute >= 300, '每分钟上限要够高（实测反馈原来偏低，当前 ' + st.engine.maxReqPerMinute + '）');
  assert.ok(st.engine.maxReqPerMinute <= 3000, '但不能越界（闸门允许范围）');
  assert.ok(st.engine.minGapMs >= 100, '发包最小间隔要在闸门允许范围内');
  assert.ok(st.engine.maxConcurrent >= 1, '并发数至少 1');
  assert.equal(st.engine.submitOnHit, true, '要开启"命中就提交"（否则只监控不抢）');
  assert.equal(st.session.requireLoginBeforeSubmit, true, '掉线后不能继续盲目发提交');
  assert.equal(st.ui.enabled, true, 'UI 点击模式要开着（否则取不到 csrfToken 就发不出去）');
  assert.equal(st.session.autoOpenLoginBeforeMs, 0, '不按推算值提前打开登录页（会刷屏）');
  assert.equal((st.debug || {}).autoPush, false, '发布配置不打开自动推送（新用户没有本地收集器）');
});

test('零手动流程: 备选清单能跨年跨电脑带走"想选哪些课"，并在新环境自动变成监控目标', () => {
  /* 用户要的明年流程：
   *   "先预备选档案里的今年课 → 点页面登陆 → 直接进入选课页面查找模糊课程或相似课程
   *    最大兜底加入监控 → 开始自动选课（不需要第一次手动操作）"
   * 关键洞察：教学班 ID 每年都变（20261-101-A0162101001-1785413134156 这种），
   * 所以跨年/跨电脑能带走的只有"课程名"。备选清单就是它的载体。 */
  // ① 清单 → 目标：ID 必须留空（空 ID 才会触发"按名字匹配"，而不是拿空 ID 发请求）
  const targets = KX.wishlistToTargets([
    { name: '研究生心理成长', teacher: '王某某', campus: '前卫校区' },
    { name: '羽毛球' },
    { label: '只有label也算' },
    { name: '   ' }                    // 空名字要被过滤
  ]);
  assert.equal(targets.length, 3, '空名字要过滤掉');
  targets.forEach((t) => {
    assert.equal(t.id, '', 'ID 必须留空（待解析状态）');
    assert.equal(t.enabled, true);
    assert.equal(t.fromWishlist, true, '要标记来源，便于面板提示');
    assert.ok(t.name, '必须有课程名（匹配只靠它）');
  });
  // ② 新电脑（本地清单为空）→ 用项目文件里的清单（种子语义）
  const seeded = KX.mergeBundledConfig(
    { sites: ['x'], wishlist: [{ name: '去年挑好的课' }] },
    { targets: [], engine: {}, wishlist: [] }
  );
  assert.equal(seeded.wishlist.length, 1, '本地为空时必须用文件里的备选清单（新电脑自动带着课）');
  // ③ 已有自己的清单 → 不被文件覆盖
  const kept = KX.mergeBundledConfig(
    { sites: ['x'], wishlist: [{ name: '文件里的' }] },
    { targets: [], engine: {}, wishlist: [{ name: '我自己配的' }] }
  );
  assert.equal(kept.wishlist[0].name, '我自己配的', '本地有清单时不能被文件覆盖');
  // ④ 绝不能冲掉已有目标
  const withTargets = KX.mergeBundledConfig(
    { sites: ['x'], wishlist: [{ name: 'a' }] },
    { targets: [{ id: 'T1' }], engine: {}, wishlist: [] }
  );
  assert.equal(withTargets.targets.length, 1, '备选清单不能动已有的目标');
});

test('最大兜底: 相似度不够也用最像的那个（抢错能退课，错过就没了）', () => {
  /* 设计取舍："查找模糊课程或相似课程最大兜底加入监控"、
   * "模糊门槛可以更低一些，因为抢错了可以退课，比模糊不到更好"。 */
  const rows = [{ id: 'X1', name: '知识产权法', raw: { RKJS: '张老师' } }];
  const cands = R.matchCoursesByName(rows, { label: '知识产权法律基础' });
  assert.ok(cands.length, '应该给得出候选');
  assert.ok(cands[0].score < 0.8, '这个相似度确实不够高（' + cands[0].score.toFixed(2) + '）');
  // 严格模式：不采用
  const strict = R.pickWithFallback(cands, { minScore: 0.85, minGap: 0.08, allowFallback: false });
  assert.equal(strict.ok, false, '关掉兜底时不能采用');
  // 最大兜底：采用最像的那个，并标记 fallback
  const loose = R.pickWithFallback(cands, { minScore: 0.85, minGap: 0.08, allowFallback: true });
  assert.equal(loose.ok, true, '开启兜底时必须采用最像的那个');
  assert.equal(loose.fallback, true, '要标记这是兜底匹配（日志/通知里会写明）');
  assert.equal(loose.best.row.id, 'X1');
  // 一个候选都没有时，兜底也不能凭空造
  const none = R.pickWithFallback([], { allowFallback: true });
  assert.equal(none.ok, false, '没有候选时兜底也无能为力');
  // 分数够时不算兜底
  const good = R.pickWithFallback([{ row: { id: 'Y' }, score: 0.95 }], { minScore: 0.6, minGap: 0.04, allowFallback: true });
  assert.equal(good.fallback, false, '分数够时不应标记为兜底');
});

test('零手动流程: 引擎必须真的会触发这套自动解析（静态钉住关键接线）', () => {
  /* 这几行是"不需要第一次手动操作"的全部依赖：
   * 少任何一处，新电脑上就变成"装好了但什么都不发生"。 */
  const c = read('src/content.js');
  // ① 启动时把备选清单变成目标（用行首锚定：注释掉的调用不算数 —— 这个太弱的断言被反向验证抓到过）
  assert.ok(/^\s*await seedTargetsFromWishlist\(\)/m.test(c), 'boot 里必须真的调用 seedTargetsFromWishlist（不能被注释掉）');
  // ② 待解析目标要立刻解析（不受节流）
  assert.ok(/!pending\.length && Date\.now\(\) - lastAutoResolveAt/.test(c),
    '有"还没有ID"的目标时必须立刻解析，不能被节流挡住');
  assert.ok(/^\s*autoResolveTargets\('有目标还没有教学班ID/m.test(c),
    'cycle 里要真的触发解析（行首锚定，注释不算），否则空ID目标一个请求都发不出去');
  // ③ 触发必须在 targets 过滤之前（过滤会把空 ID 目标丢掉）
  const at = c.indexOf('// 2) 逐目标处理');
  const cycleSeg = c.slice(at, at + 1200);
  assert.ok(/autoResolveTargets\(/.test(cycleSeg), '触发解析必须发生在 targets 过滤之前');
  // ④ 按下标回写（按 ID 找会把所有空 ID 目标写到同一个目标上 —— 已修的真 bug）
  assert.ok(/for \(let i = 0; i < targets\.length; i\+\+\)/.test(c), '解析要按下标遍历');
  assert.ok(/targets\[i\] = Object\.assign/.test(c), '解析要按下标回写（空 ID 目标不能按 ID 匹配）');
  // ⑤ 面板要有入口与解释
  const p = read('src/panel.js');
  assert.ok(/data-act="arch-add-wishlist"/.test(p), '档案页要有「加入备选清单」按钮');
  assert.ok(/还没有教学班ID/.test(p), '目标页要解释"待解析"是正常状态');
  assert.ok(/不需要你手动操作/.test(p), '要明确告诉用户这一步是自动的');
});
