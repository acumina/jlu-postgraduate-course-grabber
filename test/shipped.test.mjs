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

test('从零开始: 全新安装必须自动配好生效站点（跳过"加入白名单"这一步）', () => {
  /* 用户要求："明年使用是直接从零开始，跳过加入白名单的流程"。
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
  /* 用户要求："在登陆页面弹出去年的课表加入愿望单"。 */
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

test('README: 使用方式必须在最前面，原理类放到 docs/', () => {
  /* 用户要求："github 首页说明太长了 将使用方式放在最开始的部分
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
  assert.ok(st.engine.intervalMs >= 300, '轮询间隔不能过小');
  assert.ok(st.engine.maxReqPerMinute >= 60 && st.engine.maxReqPerMinute <= 3000, '每分钟上限要在闸门允许范围内');
  assert.ok(st.engine.minGapMs >= 100, '发包最小间隔要在闸门允许范围内');
  assert.ok(st.engine.maxConcurrent >= 1, '并发数至少 1');
  assert.equal(st.engine.submitOnHit, true, '要开启"命中就提交"（否则只监控不抢）');
  assert.equal(st.session.requireLoginBeforeSubmit, true, '掉线后不能继续盲目发提交');
  assert.equal(st.ui.enabled, true, 'UI 点击模式要开着（否则取不到 csrfToken 就发不出去）');
  assert.equal(st.session.autoOpenLoginBeforeMs, 0, '不按推算值提前打开登录页（会刷屏）');
  assert.equal((st.debug || {}).autoPush, false, '发布配置不打开自动推送（新用户没有本地收集器）');
});

test('零手动流程: 备选清单能跨年跨电脑带走"想选哪些课"，并在新环境自动变成监控目标', () => {
  /* 用户要的明年流程（原话）：
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
  /* 用户原话："查找模糊课程或相似课程最大兜底加入监控"、
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
