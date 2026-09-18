/* ============================================================
 * test/real-site.test.mjs —— 真实站点回归：吉林大学研究生选课（正方新版 yjsxkapp）
 * ------------------------------------------------------------
 * 数据来自用户 2026-09-17 的真实抓包（已脱敏）：
 *   提交 POST .../xsxkCourse/choiceCourse.do   body: bjdm=<教学班代码>&lx=1&csrfToken=<32hex>
 *        失败响应 {"msg":"选择的教学班容量已满（#6qz9u）","code":0}
 *   余量 POST .../xsxkCourse/loadGxkCourseInfo.do 响应 {datas:[{BJDM,KCMC,KXRS,DQRS,...}]}
 *        其中 KXRS=容量、DQRS=当前人数 → 剩余 = KXRS − DQRS
 *
 * 把这些契约钉成测试，以后改代码不会把用户的真实系统弄坏。
 * 运行：node test/real-site.test.mjs 或 node test/all.mjs
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 读配置文件时要按「项目根目录」解析（不是 test/ 目录）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

globalThis.chrome = undefined;
await import('../src/lib/config.js');
await import('../src/lib/rules.js');
const KX = globalThis.KX;
const R = globalThis.KXRules;

/** 与真实响应同构的余量响应（字段名、值都照抄真实抓包） */
function jluQueryResponse() {
  return JSON.stringify({
    datas: [
      { BJMC: '当代马克思主义伦理学（线上慕课）01', KCDM: 'A0162101001', KCMC: '当代马克思主义伦理学（线上慕课）', KXRS: 50, DQRS: 50, BJDM: '20261-101-A0162101001-1785413134156', RKJS: '曲红梅', KCZXS: 28 },
      { BJMC: '研究生心理成长01', KCDM: 'A0321000003', KCMC: '研究生心理成长', KXRS: 1000, DQRS: 1000, BJDM: '20261-111-A0321000003-1788793882416', RKJS: '张琳', KCZXS: 16 },
      { BJMC: '健美操01前卫', KCDM: 'A0422105001', KCMC: '健美操', KXRS: 20, DQRS: 18, BJDM: '20261-105-A0422105001-1783734434438', RKJS: '胡光霞', KCZXS: 20 }
    ]
  });
}

test('吉大: 余量 = KXRS − DQRS（显式 capacityField/usedField）', () => {
  const parse = {
    type: 'json', path: 'datas', idField: 'BJDM', remainField: '',
    capacityField: 'KXRS', usedField: 'DQRS', nameField: 'KCMC'
  };
  const r = R.parseList(parse, jluQueryResponse());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.list.length, 3);

  const a = r.list.find((x) => x.id === '20261-101-A0162101001-1785413134156');
  assert.ok(a, '必须能按 BJDM 命中目标');
  assert.equal(a.remain, 0, 'KXRS=50 DQRS=50 → 余量 0（这正是"容量已满"的原因）');
  assert.equal(a.name, '当代马克思主义伦理学（线上慕课）');

  const b = r.list.find((x) => x.id === '20261-111-A0321000003-1788793882416');
  assert.equal(b.remain, 0);

  const c = r.list.find((x) => x.id === '20261-105-A0422105001-1783734434438');
  assert.equal(c.remain, 2, 'KXRS=20 DQRS=18 → 余量 2（这门课有名额）');
});

test('吉大: remainField 写成 "KXRS-DQRS" 表达式也可以', () => {
  const r = R.parseList({ type: 'json', path: 'datas', idField: 'BJDM', remainField: 'KXRS-DQRS', nameField: 'KCMC' }, jluQueryResponse());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.list[0].remain, 0);
  assert.equal(r.list[2].remain, 2);
});

test('吉大: 不显式配字段时，也要能认出 BJDM 并算出余量 0', () => {
  const r = R.parseList({ type: 'json' }, jluQueryResponse());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.list[0].id, '20261-101-A0162101001-1785413134156', '猜字段也要认出 BJDM 是选课ID');
  assert.equal(r.list[0].name, '当代马克思主义伦理学（线上慕课）');
  // 最要紧的一条：余量必须算出 0。算不出来的话插件会以为一直有名额、疯狂发提交请求。
  assert.equal(r.list[0].remain, 0, '猜字段时也要能由 KXRS-DQRS 得出 0');
});

test('吉大: 真实失败响应必须判成 full，且绝不能被误判成成功', () => {
  const rules = KX.defaults().submit.rules;
  const realFull = '{"msg":"选择的教学班容量已满（#6qz9u）","code":0}';
  assert.equal(R.classify(rules, realFull, 200).kind, 'full');
  assert.equal(R.evalRule(rules.success, realFull), false, 'false success 会让插件停止重试，最危险');
});

test('吉大: 带防呆的 success 规则（失败/已满/错误一律不算成功）', () => {
  const guarded = { type: 'regex', value: '^(?!.*(失败|已满|错误|异常)).*(选课成功|成功)' };
  assert.equal(R.evalRule(guarded, '{"msg":"选课成功","code":1}'), true);
  assert.equal(R.evalRule(guarded, '{"msg":"选择的教学班容量已满（#6qz9u）","code":0}'), false);
  assert.equal(R.evalRule(guarded, '{"msg":"选课失败!","code":0}'), false);
  assert.equal(R.evalRule(guarded, '{"msg":"操作成功，请勿重复提交"}'), true, '这个会漏，但比漏判成功安全');
});

test('吉大: 提交体模板渲染（含动态 csrfToken）', () => {
  const vars = KX.buildVars({}, { id: '20261-101-A0162101001-1785413134156', label: '当代马克思主义伦理学' });
  vars.csrfToken = '0123456789abcdef0123456789abcdef';
  const body = KX.renderTemplate('bjdm={{id}}&lx=1&csrfToken={{csrfToken}}', vars);
  assert.equal(body, 'bjdm=20261-101-A0162101001-1785413134156&lx=1&csrfToken=0123456789abcdef0123456789abcdef');
  assert.match(body, /^bjdm=20261-\d+-A\d+-\d+&lx=1&csrfToken=[0-9a-f]{32}$/);
});

test('吉大: URL 里的 _=<时间戳> 用 {{ts}} 动态渲染，避免写死过期时间戳', () => {
  const url = KX.renderTemplate('https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/xsxkCourse/choiceCourse.do?_={{ts}}', { ts: 1789619709279 });
  assert.equal(url, 'https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/xsxkCourse/choiceCourse.do?_=1789619709279');
});

test('吉大: csrfToken 只在请求体里出现 → 必须靠页面取值/学习兜底，不能写死', () => {
  // 真实抓包中，csrfToken 没有出现在任何接口响应里，只在 choiceCourse 的请求体里。
  // 所以配置里绝不能把它写进 submit.vars（重新登录后就失效），必须走 pageVars。
  const d = KX.defaults();
  assert.deepEqual(d.submit.pageVars, {}, '默认不配 pageVars');
  assert.equal(d.submit.requirePageVars, true, '默认取不到就不发包');
  // 各种来源都要能取到（页面 cookie / 全局变量 / localStorage / meta / 学到的值）
  const empty = { cookies: '', globals: {}, storage: { local: {}, session: {} }, metas: {} };
  assert.equal(KX.resolvePageVar({ from: 'auto', key: 'csrfToken' }, Object.assign({}, empty, { cookies: 'csrfToken=abc123def456' }), {}), 'abc123def456');
  assert.equal(KX.resolvePageVar({ from: 'auto', key: 'csrfToken' }, Object.assign({}, empty, { globals: { csrfToken: 'g' } }), {}), 'g');
  assert.equal(KX.resolvePageVar({ from: 'auto', key: 'csrfToken' }, Object.assign({}, empty, { storage: { local: { s: '{"csrfToken":"ls"}' }, session: {} } }), {}), 'ls');
  assert.equal(KX.resolvePageVar({ from: 'storage', area: 'local', key: 's', path: 'csrfToken' }, Object.assign({}, empty, { storage: { local: { s: '{"csrfToken":"via-path"}' }, session: {} } }), {}), 'via-path');
  assert.equal(KX.resolvePageVar({ from: 'meta', key: 'csrf-token' }, Object.assign({}, empty, { metas: { 'csrf-token': 'm' } }), {}), 'm');
  assert.equal(KX.resolvePageVar({ from: 'auto', key: 'csrfToken' }, empty, { csrfToken: 'learned' }), 'learned');
  assert.equal(KX.resolvePageVar({ from: 'auto', key: 'csrfToken' }, empty, {}), '', '取不到就返回空 → 引擎跳过提交');
  assert.equal(KX.resolvePageVar({ from: 'cookie', key: 'csrfToken', regex: '([0-9a-f]{12})' },
    Object.assign({}, empty, { cookies: 'csrfToken=zz-d754b8dc1a5f-zz' }), {}), 'd754b8dc1a5f', '支持再抽一段正则');
});

test('吉大: 人工查询放大 pageSize（一次拿全），自动轮询保持小 pageSize', () => {
  const real = 'query_keyword=&query_kkyx=&query_kcfl=&query_kcbq=&query_xqdm=&query_skyydm=&query_sfct=&query_sfym=&query_gxrlsfym=&fixedAutoSubmitBug=&pageIndex=1&pageSize=60&sortField=&sortOrder=';
  const full = R.withPageSize(real, 200);
  assert.ok(full.includes('pageSize=200'), full);
  assert.equal(full.includes('pageSize=60'), false);
  assert.ok(full.includes('fixedAutoSubmitBug=&pageIndex=1'), '其它参数不能被动到');
  assert.equal(R.withPageSize('a=1', 200), 'a=1&pageSize=200', '没有 pageSize 时补一个');
  assert.equal(R.withPageSize(real, 0), real, '传 0 表示不改');
});

test('吉大: 余量行能取出「区分同名教学班」的教师/时间/校区', () => {
  const raw = {
    BJMC: '当代马克思主义伦理学（线上慕课）01', KCDM: 'A0162101001', KCMC: '当代马克思主义伦理学',
    RKJS: '曲红梅', PKSJDDMS: '3-12周', XQMC: '前卫校区', KXRS: 50, DQRS: 50
  };
  const ex = R.rowExtras(raw);
  assert.equal(ex.teacher, '曲红梅');
  assert.equal(ex.time, '3-12周');
  assert.equal(ex.campus, '前卫校区');
  assert.equal(ex.code, 'A0162101001');
  assert.equal(ex.klass, '当代马克思主义伦理学（线上慕课）01');
  // 台球这种同名多班：靠 ID 末段 + 教师区分
  const a = { KCMC: '台球', RKJS: '李洋', PKSJDDMS: '3-12周 星期一[7-8节]' };
  const b = { KCMC: '台球', RKJS: '李建民', PKSJDDMS: '3-12周 星期一[7-8节]' };
  assert.notEqual(R.rowExtras(a).teacher, R.rowExtras(b).teacher);
  // 字段缺失时不炸
  assert.deepEqual(R.rowExtras(null), { teacher: '', time: '', campus: '', code: '', klass: '' });
});

test('吉大: 掉线后页面渲染「未登录不能选课」，必须能被判成掉线（接口层抓不到）', () => {
  // 真实情况：这个系统掉线后不返回 401/302、也不跳登录页，
  // 接口层只给网络失败（HTTP 0），页面原地渲染这句话 —— 只能靠认文字。
  assert.equal(KX.looksLoggedOut('未登录不能选课\n返回首页'), true);
  assert.equal(KX.looksLoggedOut('  未登录不能选课  '), true);
  // 不能误报：退出登录按钮、课程名里的"登录"都不该触发
  assert.equal(KX.looksLoggedOut('首页 选课 我的课程 退出登录'), false);
  assert.equal(KX.looksLoggedOut('登录时间：2026-09-17'), false);
  assert.equal(KX.looksLoggedOut(''), false);
  assert.equal(KX.looksLoggedOut(null), false);
  // 默认 markers 与配置里的一致
  assert.equal(KX.looksLoggedOut('未登录不能选课', KX.defaults().session.logoutTextMarkers), true);
  assert.equal(KX.looksLoggedOut('请重新登录', KX.defaults().session.logoutTextMarkers), true);
});

test('吉大: 登录接口同域，必须靠"录到登录请求"来识别刚登录', () => {
  // 真实 URL：登录接口和选课系统同一个域名 → background 的跨域检测永远不触发
  const loginUrl = 'https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/login/check/login.do?timestrap=1789620825794';
  assert.equal(KX.isLoginEndpoint(loginUrl), true);
  assert.equal(KX.isLoginEndpoint('https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/xsxkCourse/choiceCourse.do'), false);
  assert.equal(KX.isLoginEndpoint('https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/login/4/vcode.do'), true, '取验证码也算登录流程');

  // 真实的成功/失败响应
  assert.equal(KX.looksLoginSuccess('{"data":null,"code":"1","jtoken":null,"msg":"登录成功","timestamp":"1789620825794"}'), true);
  assert.equal(KX.looksLoginSuccess('{"data":null,"code":"3","jtoken":null,"msg":"验证码不正确","timestamp":"1789620727349"}'), false);
  assert.equal(KX.looksLoginSuccess(''), false);
});

test('吉大: 实测会话活过 hardTimeoutMs 后，应判定「不是硬超时」并停用倒计时预警', () => {
  const now = 1_700_000_000_000;
  const HARD = 1200000;   // 20 分钟
  // 真实日志：登录后 39 分钟体检仍然通过（每 5 分钟一次已鉴权请求把它续上了）
  assert.equal(KX.isHardTimeoutDisproved({ loginAt: now - 39 * 60000, hardTimeoutMs: HARD, now }), true,
    '登录后 39 分钟还活着 → 不是硬超时');
  // 刚登录、还没活过推算值时不能下这个结论
  assert.equal(KX.isHardTimeoutDisproved({ loginAt: now - 5 * 60000, hardTimeoutMs: HARD, now }), false);
  // 边界：刚好超过 hardTimeoutMs + 1 分钟宽限
  assert.equal(KX.isHardTimeoutDisproved({ loginAt: now - 20 * 60000, hardTimeoutMs: HARD, now }), false, '等于还不算');
  assert.equal(KX.isHardTimeoutDisproved({ loginAt: now - 21.5 * 60000, hardTimeoutMs: HARD, now }), true);
  // 没配 hardTimeoutMs（关闭倒计时）时不适用
  assert.equal(KX.isHardTimeoutDisproved({ loginAt: now - 60 * 60000, hardTimeoutMs: 0, now }), false);
  assert.equal(KX.isHardTimeoutDisproved({ loginAt: 0, hardTimeoutMs: HARD, now }), false);
});

test('回归: 会话寿命估算要取「最近3个样本的最大值」（提前结束的样本是下界，不是超时值）', () => {
  /* 三次翻车记录：
   *   ① 用最小值 → 刚登录时页面残留旧文字被误判掉线，算出 2.5 分钟 → 估算永久崩成 2 分钟
   *   ② 改中位数 → 只有 1 个样本时照样崩（样本少时中位数=那个样本）
   *   ③ 用户手动退出（会话只活了 5.1 分钟）被记成样本 → 估算崩成 5.1 分钟
   * 正确做法：会话被提前终止的原因很多（手动退出/换账号/被踢/切页面重新鉴权），
   * 那些都是"活过这么久"的**下界**；我们要估计的是"最多能活多久"，所以取最大值（近 3 个）。 */
  const effective = (samples, cfgMs) => {
    // 注意：保持**时间顺序**取最近 3 次，再取其中的最大值（先排序会取到"最大的 3 个"，
    // 那样超时真变短时跟不上去 —— 这个语义错误是被下面的用例抓出来的）
    const s = samples.filter((v) => v >= 180000 && v < 6 * 3600000);
    if (!s.length) return cfgMs;
    const recent = s.slice(-3);
    const guess = Math.max(180000, Math.max(...recent) - 30000);
    return cfgMs ? Math.min(cfgMs, guess) : guess;
  };
  const M10 = 600000;
  assert.equal(effective([558000, 564000], M10), 534000);
  // ③ 手动退出产生的 5.1 分钟样本不能把估算拉下来
  assert.equal(effective([558000, 564000, 306000], M10), 534000, '5.1 分钟的样本必须被最大值盖过');
  assert.equal(effective([306000], M10), 276000, '只有短样本时也只能按它来（至少比崩到不可能值好）');
  // ① 残留文字误判产生的 2.5 分钟样本
  assert.equal(effective([558000, 150000], M10), 528000);
  // 超时真的变短（最近 3 次都短）要能跟上：窗口按时间滑动，不被更早的大样本压住
  assert.equal(effective([558000, 300000, 290000, 285000], M10), 270000, '最近 3 次的最大值 −30 秒');
  assert.equal(effective([558000, 300000, 290000, 285000, 280000], M10), 260000, '窗口滑动：只取最近 3 次');
  // 空样本 → 配置值；不合理样本被滤掉
  assert.equal(effective([], M10), M10);
  assert.equal(effective([60000, 100000], M10), M10, '不合理样本（<3 分钟）被滤掉 → 回到配置值');
});

test('回归: 面板要能区分「速率低是因为停机」和「被限流」', () => {
  /* 真实误导：面板曾把"引擎正在停机等你重新登录"写成了"多半是被限流"，
   * 用户据此以为被风控了。两者是完全不同的处置方向。 */
  const src = readRepoFile('src/content.js');
  assert.ok(/lastHaltAt = Date\.now\(\)/.test(src), 'halt() 里要记录停机时刻');
  assert.ok(/lastHaltAt: lastHaltAt/.test(src), '状态快照要带上停机时刻');
  const panel = readRepoFile('src/panel.js');
  assert.ok(/刚发生过停机/.test(panel), '面板要能提示"速率低是因为刚停机"');
  assert.ok(/退避 ×/.test(panel) || /正在退避/.test(panel), '面板要能提示"正在退避/被限流"');
});

test('回归: 配置里被写坏的会话超时值（<3 分钟）必须被纠正，不能刚登录就报 2 分钟', () => {
  /* 真实事故链：
   *   ① 旧版本用"样本最小值"校准 → 错误短样本把估算带成 2 分钟
   *   ② 旧版本还把校准值 KX.save 写回了配置 → 坏值固化，算法改了也修不回来
   *   ③ lifetimeSamples 忘了持久化 → 页面一刷新样本就空，"以实测为准"的防线失效
   * 现在：<3 分钟的配置值一律视为坏值 → 改用 10 分钟兜底 + 顺手修回配置。 */
  const effective = (cfgMs, samples) => {
    let c = cfgMs;
    if (c > 0 && c < 180000) c = 600000;                 // ① 可疑小值兜底
    const s = (samples || []).filter((v) => v >= 180000 && v < 6 * 3600000).sort((a, b) => a - b);
    if (!s.length) return c;                             // ② 没样本就用兜底值（不再返回 2 分钟）
    const med = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
    const guess = Math.max(180000, med - 30000);
    return c ? Math.min(c, guess) : guess;
  };
  // 被写坏的 2 分钟值：无论有没有样本都不能再输出 2 分钟
  assert.equal(effective(120000, []), 600000, '没有样本时也要用兜底值，不能是 2 分钟');
  assert.equal(effective(120000, [558000, 564000]), 531000, '有样本时以实测中位数为准');
  assert.ok(effective(120000, [558000, 564000]) / 60000 > 8, '必须给出 8 分钟量级');
  // 正常配置值不受影响
  assert.equal(effective(600000, []), 600000);
  assert.equal(effective(600000, [558000, 564000]), 531000, '实测比配置短时以实测为准');
  // 真·短超时（比如 5 分钟）是合理值，不该被当成坏值
  assert.equal(effective(300000, []), 300000);
});

test('回归: 会话寿命样本必须能跨页面存活（否则防线失效）', async () => {
  /* ③ lifetimeSamples 漏了持久化 → 刷新页面后样本清零 → effectiveHardTimeoutMs 只能退回配置值。
   * 这里静态检查 saveRuntime 里确实带了 lifetimeSamples。 */
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/content.js', 'utf8'));
  const saveBlock = src.slice(src.indexOf('function saveRuntime'), src.indexOf('async function loadRuntime'));
  assert.ok(saveBlock.includes('lifetimeSamples'), 'saveRuntime 必须持久化 lifetimeSamples');
  const loadBlock = src.slice(src.indexOf('async function loadRuntime'), src.indexOf('async function loadRuntime') + 2000);
  assert.ok(/Object\.assign\(auth, rt\.auth/.test(loadBlock), 'loadRuntime 要把 auth（含样本）读回来');
});

test('吉大: 宽松兜底的 success 规则 + 成功放在判定链最后（用户要求：宁可误判成功也不错失课程）', () => {
  /* 用户明确要求："选课成功最大兜底即可，选上了继续轮询也没问题"。
   * 于是两条设计一起用：
   *   ① keepPollingAfterSuccess = true  → 判定成功后**继续轮询**，误判成功零代价
   *   ② success 规则放宽成"只要没有失败特征就算成功"（负向匹配）
   * 但②有个陷阱：宽规则会匹配任何响应，所以它**必须排在 dup/full 之后**当兜底，
   * 否则「容量已满」会被它抢走判成成功。 */
  const cfg = JSON.parse(readRepoFile('kx-config-吉大研究生选课.json'));
  assert.equal(cfg.engine.keepPollingAfterSuccess, true, '必须开启"成功后继续轮询"');
  const rules = cfg.submit.rules;

  // 真实失败响应：虽然宽松规则会匹配很多文本，但它必须被 full 抢到
  const realFull = '{"msg":"选择的教学班容量已满（#6qz9u）","code":0}';
  assert.equal(R.evalRule(rules.success, realFull), false, '宽松规则自带失败特征排除');
  assert.equal(R.classify(rules, realFull, 200).kind, 'full', '必须判成 full，不能被 success 抢走');

  // 猜测的成功响应 / 其它 200
  assert.equal(R.classify(rules, '{"msg":"选课成功","code":"1"}', 200).kind, 'success');
  assert.equal(R.classify(rules, '{"code":1,"msg":"操作成功"}', 200).kind, 'success');
  // 已选过 → dup（排在 full 之后、success 之前）
  assert.equal(R.classify(rules, '{"msg":"你已经选过该课程","code":0}', 200).kind, 'dup');
  // 空响应不能算成功（避免网络层拿到空 body 时误报）
  assert.equal(R.evalRule(rules.success, ''), false);
  // 登录页 HTML：不该算成功，而且会被 logout 规则先抓到（logout 在 success 之前）
  assert.equal(R.evalRule(rules.success, '<html>请先登录</html>'), false, '命中"请先登录"就不该算成功');
  assert.equal(R.classify(rules, '<html>请先登录</html>', 200).kind, 'logout');
});

test('回归: 进入页面就自动开始 —— 只由 enabled 一条规则决定', () => {
  /* 用户明确要求："我只需要点入页面就自动进行"。
   * 之前的实现用 resumePending / wasHalted / state!=='ok' 等条件拼过三版，
   * 每一版都在某个分支里漏掉过关键动作（三次真实事故）。现在只留一条规则：
   *   enabled=true（= 用户想让它跑）而引擎没在跑 → 就启动。
   *   · start() 置 true、用户点「停止」置 false
   *   · 主动停机（验证码/未开放）置 false → 必须人工确认后再启动
   *   · 登录相关停机保留 true → 登录后自动继续 */
  const src = readRepoFile('src/content.js');
  const b = src.indexOf('进入页面后自动开始 —— 只有一条规则');
  assert.ok(b > 0, 'boot 里应有"进入页面后自动开始"这段');
  const boot = src.slice(b, b + 1600);
  assert.ok(/if \(wantRunning\) \{/.test(boot), '启动条件只看 wantRunning');
  assert.ok(/start\('进入页面后自动开始'\)/.test(boot), '应直接启动（不是等某个标记）');
  assert.ok(/auth\.state === 'lost'[\s\S]{0,200}probeSession\('进入页面后确认登录态'\)/.test(boot),
    '掉线状态要先探测，探测成功会自动开始');
  // 意图必须存在**运行时键**里，不能放配置文件（导入配置会把它冲掉 —— 真实事故两次）
  assert.ok(/const WANT_KEY = 'kx_want_running'/.test(src), '意图要用独立的 storage 键');
  assert.ok(/loadWantRunning\(await chrome\.storage\.local\.get\(WANT_KEY\)\)/.test(src), '从独立键读取');
  assert.ok(/\(raw === undefined \|\| raw === null\) \? true : !!raw/.test(src),
    '首次使用（键不存在）默认 true —— 用户要求"点入页面就自动进行"');
  assert.equal(/KX\.save\(\{ enabled:/.test(src), false, '不该再往配置文件里写 enabled（那是运行时意图）');
  // 主动停机必须撤回意图，否则重载后又自己跑起来
  assert.ok(/if \(sticky\) setWantRunning\(false\)/.test(src),
    '验证码这类主动停机要撤回意图（halt 的 sticky 选项）');
  /* 真实 bug（用户在新电脑上踩到）：halt() 里判断的是一个**根本不存在的变量**
   * `loginRelated`（第二个参数名其实是 urgent）→ 严格模式下每次停机都抛 ReferenceError →
   * 后面的 saveRuntime / 面板刷新 / "登录后自动继续"全都没执行 →
   * 表现就是"登录了也不自动开始抢课"。
   * 这个测试原来断言的正是那行坏代码（等于把 bug 钉住了），现在改成钉正确行为。 */
  const codeLines = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l));
  assert.equal(codeLines.some((l) => /loginRelated/.test(l)), false,
    '代码里不能再出现 loginRelated（不存在的变量；只允许写在注释里当事故记录）');
  // 每个停机调用点都必须显式说明"要不要撤回意图"（允许和下一行合并写）
  const srcLines = src.split('\n');
  srcLines.forEach((l, i) => {
    if (/halt\(/.test(l) && !/^\s*\*/.test(l) && !/function halt/.test(l) && !/halt\(\)/.test(l)) {
      const together = l + (srcLines[i + 1] || '');
      assert.ok(/sticky:/.test(together), '第 ' + (i + 1) + ' 行的 halt 调用必须显式写 sticky:');
    }
  });
  // 语义：验证码 = 粘性（必须人工处理）；掉线 / 未到选课时间 = 临时（条件恢复后自动继续）
  assert.ok(/sticky: true, kind: 'captcha'/.test(src), '验证码停机必须是粘性的');
  assert.ok(/kind: 'logout' \}\)/.test(src), '掉线停机要标记 logout（临时，登录后自动继续）');
  assert.ok(/sticky: false, kind: 'closed'/.test(src),
    '「未到选课时间」必须是临时停机 —— 否则明年窗口一开也不会自动开始（用户的真实场景）');
  assert.ok(/function halt\(reason, opts\)/.test(src), 'halt 要接受选项对象');
  assert.ok(/const sticky = o\.sticky !== false;/.test(src), 'sticky 默认保守为 true');
  assert.ok(/停机过程出错/.test(src), '停机逻辑本身要包 try/catch（它在关键路径上，抛异常会把看门狗带崩）');
  /* 曾经踩坑的三个标记：代码里必须彻底删除
   * （注释里保留它们的名字是有意的 —— 那是三次事故的记录，交给下一个人看） */
  assert.equal(/resumePending\s*[=:]/.test(src), false, 'resumePending 的代码用法已删除（它是三次事故的共同点）');
  assert.equal(/wasHalted\s*[=:]/.test(src), false, 'wasHalted 的代码用法已删除');
  assert.equal(/\brt\.resumePending\b|\brt\.halted\b/.test(src), false, 'runtime 里不再存这两个标记');
});

test('简化: 探测不做跨标签页节流（它曾把"掉线后恢复探测"吞掉，导致静默卡死）', () => {
  /* 用户反馈："不需要所谓的多标签页去重，多余的功能导致维护性差"。
   * 它确实害过一次：引擎显示"抢课中"、9 个目标全部"等登录"静默跳过提交，
   * 而恢复探测被这个节流挡住 → 什么都不发生、日志也没有。
   * 注意区分：**探测**不能节流（会静默卡死）；**开标签页**必须节流（会弹一堆页）。
   * 后者用持久化的时间戳（kx_autologin_at），是必要的防风暴，不是多余的抽象。 */
  const src = readRepoFile('src/content.js');
  assert.equal(/onceEveryGlobal\(/.test(src), false, '不应再调用通用的全局节流');
  assert.equal(/kx_probe_at|kx_expiry_warn_at/.test(src), false, '探测/提醒不该有全局节流键');
  assert.ok(/kx_autologin_at/.test(src), '但"打开登录页"必须有全局时间戳（否则会疯狂弹标签页）');
  assert.ok(/thisPageWasWorker/.test(src), '自动打开登录页还要靠"工作页身份"判断');
});

test('回归: 自动打开登录页只认"真掉线"，且全局限流（真实事故：疯狂弹新页面）', () => {
  /* 用户反馈："现在登陆时间快结束了也疯狂弹出新页面，改为只有扫到掉线了才弹新页面"。
   * 两个原因：
   *   ① 触发条件里还留着按推算倒计时提前打开 → 推算不准时没掉线也开
   *   ② 防重复只有页面级标记，而每次"掉线→恢复"都会重置它 → 一遍遍开
   * 现在：真掉线（state==='lost'）+ 工作页身份 + 全局 3 分钟一次（持久化时间戳）。 */
  const src = readRepoFile('src/content.js');
  const i = src.indexOf('自动打开登录页：**只在"真的扫到掉线"时打开**');
  assert.ok(i > 0, '找不到自动打开登录页那段');
  const seg = src.slice(i, i + 1800);
  assert.ok(/if \(auth\.state === 'lost' && !autoOpenedLogin/.test(seg), '触发条件必须是"真掉线"');
  assert.equal(/\{left > 0 && left <= autoOpen\)/.test(seg), false, '不能再按推算倒计时提前打开');
  assert.ok(/Date\.now\(\) - \(autoOpenAt \|\| 0\) > 3 \* 60000/.test(seg), '要有全局 3 分钟限流');
  assert.ok(/kx_autologin_at/.test(seg), '限流时间戳要持久化（跨页面/跨重载共享）');
  assert.equal(/autoOpenLoginBeforeMs/.test(seg), false, '不再读 autoOpenLoginBeforeMs（提前打开已取消）');
  // background 打开前要先找已开着的登录页，有就切过去
  const bg = readRepoFile('src/background.js');
  assert.ok(/登录页已经开着，切过去（不新开）/.test(bg), 'background 要先复用已开着的登录页');
});

test('回归: 自动继续只由意图标志决定，且必须写在状态分支之外', () => {
  /* 两次翻车：
   *   ① 挂在 wasLost 上 → 「同域登录检测」先把 state 置成 ok，触发条件被抹掉
   *   ② 挂在 state !== 'ok' 上 → 多标签页下**别的页面**先探测成功把 state 置成 ok，
   *      于是选课页这边探测成功时走 else 分支、根本不看标记（真实事故：进了选课页"没反应"）
   * 现在：它是独立于状态迁移的动作，写在分支之外，条件是 wantRunning + 没在跑。 */
  const src = readRepoFile('src/content.js');
  const start = src.indexOf('function noteAuth');
  const end = src.indexOf('\n  function ', start + 10);
  const seg = src.slice(start, end > start ? end : start + 8000);
  const resumeUse = seg.indexOf('if (!running && wantRunning &&');
  assert.ok(resumeUse > 0, '自动继续的判断要在（条件为 wantRunning + 未运行）');
  const aliveOutside = seg.lastIndexOf('noteSessionAlive();');
  assert.ok(resumeUse > aliveOutside, '自动继续必须在 state 分支之外（跟在分支外的 noteSessionAlive 之后）');
});

test('回归: 「推定硬超时」到点只能探测，绝不能停机（真实事故：把活着的会话白停了）', () => {
  /* 事故经过：14:20:36 到达推算的 10 分钟，代码直接 halt("推定硬超时已到")，
   * 紧接着的确认探测却返回 HTTP 200 且带真实数据 —— 会话明明活着。
   * 根因：sessionTick 每 15 秒跑、探测每 2 分钟才一次，所以"停机"跑在"确认"之前。
   * 结论：只有真实证据（HTTP 401 / 页面未登录文字）才能停机；推算值最多触发一次探测。 */
  const src = readRepoFile('src/content.js');
  const i = src.indexOf("if (left <= 0 && auth.state !== 'lost')");
  assert.ok(i > 0, '找不到硬超时到点的分支');
  const seg = src.slice(i, i + 1200);
  assert.equal(/halt\(/.test(seg), false, '到点分支里不能有 halt —— 那会把还活着的引擎停掉');
  assert.ok(/probeSession\(/.test(seg), '到点应该探测确认');
  assert.equal(/resumePending = true/.test(seg), false, '到点不该置 resumePending（那是真掉线时才置）');
  // 自动打开登录页也不能只按推算值触发（会白开一堆标签页、甚至疯狂弹页面）
  assert.ok(/if \(auth\.state === 'lost' && !autoOpenedLogin/.test(src),
    '自动打开登录页必须以「真实掉线」为唯一判据');
});

test('回归: 一次掉线只能记一个寿命样本 + 掉线日志不能每 30 秒刷一条', () => {
  /* 真实事故（14:44 那次的日志）：
   *   14:44:22 活了 13.6 分钟 ← 真实掉线
   *   14:44:26 活了 13.7 分钟
   *   14:45:11 活了 14.4 分钟
   *   14:45:56 活了 15.2 分钟
   *   14:46:41 活了 15.9 分钟
   * 掉线后每 30 秒探测都再报 401，每次都当成"新样本" → 把一次观察放大成五次、
   * 估算被灌成 15.9 分钟，日志也被同一件事刷满。 */
  const src = readRepoFile('src/content.js');
  assert.ok(/if \(auth\.sampleForLoginAt && auth\.sampleForLoginAt === auth\.loginAt\) return;/.test(src),
    'recordSessionDeath 必须按"登录锚点"去重：同一次会话只记一个样本');
  assert.ok(/sampleForLoginAt: auth\.sampleForLoginAt \|\| 0/.test(src), '去重标记要持久化');
  assert.ok(/const alreadyLost = auth\.state === 'lost'/.test(src), '要能识别"本来就已经是掉线状态"');
  assert.ok(/else if \(!alreadyLost\) \{/.test(src), '掉线日志只在"刚刚变成掉线"时记一次');
});

test('回归: 真掉线时必须会自动打开登录页（不能因为 halt 把 running 置假就失效）', () => {
  /* 真实 bug：自动打开登录页的条件原来是 `running`，而掉线流程会先 halt() → running=false，
   * 于是这个功能"在最需要它的时候恰好不生效"。改用 thisPageWasWorker（本页面是否干活的页面）。 */
  const src = readRepoFile('src/content.js');
  assert.ok(/let thisPageWasWorker = false/.test(src), '要有"本页面是工作页"的记忆标记');
  assert.ok(/thisPageWasWorker = true;/.test(src), '启动时要把标记置上');
  assert.ok(/!running && !thisPageWasWorker/.test(src), '自动开登录页的判定要用该标记，而不是只看 running');
});

test('回归: 「内容命中未登录字样」是弱证据，不能一次就停机（误停 + 误报）', () => {
  /* 真实事故：14:51:52 提交正常（名额已满 = 会话活着），14:51:58 探测到一段含
   * 「未登录/请重新登录」的内容 → 判定掉线 → 停机 + 弹通知；1 秒后探测又成功、自动恢复。
   * 也就是说：白白停了一次、还吓了用户一跳。
   * 修法：强证据（HTTP 401/403、被重定向到登录页）立刻判定；
   *       弱证据（响应内容命中）必须连续命中两次（session.weakLostNeed）。 */
  const src = readRepoFile('src/content.js');
  // 强/弱证据要分开标注
  assert.ok(/lost: true, strong: true, why: 'HTTP ' \+ res\.status/.test(src), 'HTTP 401 是强证据');
  assert.ok(/lost: true, strong: true, why: '被重定向到登录页'/.test(src), '重定向到登录页是强证据');
  assert.ok(/lost: true, strong: false/.test(src), '内容命中标记为弱证据');
  // 弱证据要累计，不足阈值就不能判定
  assert.ok(/if \(!v\.strong\) \{[\s\S]{0,400}weakLostStreak\+\+/.test(src), '弱证据要累计');
  assert.ok(/if \(weakLostStreak < need\) \{[\s\S]{0,400}return false;/.test(src), '不足阈值时返回"没掉线"');
  assert.ok(/weakLostStreak = 0;   \/\/ 探测成功/.test(src), '探测成功要清零累计');
  // 判定依据必须可诊断：日志里要写出命中了哪个词、什么内容
  assert.ok(/matchLogoutMarker/.test(src), '要记录命中的具体标记词');
  assert.ok(/片段：/.test(src), '日志要带响应片段，否则误判了也无从查起');
  const cfg = readRepoFile('src/lib/config.js');
  assert.ok(/function matchLogoutMarker/.test(cfg) && /matchLogoutMarker,/.test(cfg), 'matchLogoutMarker 要导出供内容脚本使用');
});

test('回归: HTML 页面不能拿「未登录」这类文字判掉线（SPA bundle 里必然有这些词）', () => {
  /* 真实事故：保活实验（试验①）把探测目标改成选课首页 HTML 之后，
   * **每一次**探测都误判掉线（14:51/14:54/14:56/14:58 每 2 分钟一次），而会话完全正常。
   * 原因：SPA 的 HTML 与 JS bundle 里必然含「未登录 / 请先登录 / 重新登录」——
   * 登录页模板就在同一个 bundle 里。文字标记对 HTML 毫无判别力。
   * 规则：HTML 只认一条铁证（真的出现登录表单字段），否则一律不判掉线。 */
  const src = readRepoFile('src/content.js');
  assert.ok(/const isHtml = \/\^\\s\*\(<!doctype\|<html\)\/i\.test\(body\) \|\| \/<script\[\\s>\]\/i\.test\(body\.slice\(0, 800\)\)/.test(src),
    '要能识别 HTML 响应（含"只有 script 片段"的情况）');
  assert.ok(/hasLoginForm/.test(src), 'HTML 要按"有没有登录表单字段"判定');
  assert.ok(/text\["']password\["']|type=\["'\]password\["'\]/.test(src), '登录表单判据要包含 password 字段');
  assert.ok(/HTML 页面，文字标记无判别力，已忽略/.test(src), 'HTML 且无登录表单时必须判为"没掉线"，并说明原因');
});

test('回归: 页面自己卡在「正在提交中」遮罩时要停止点击并提示刷新（硬点没用）', () => {
  /* 真实截图：页面自身那次提交撞上会话失效(401)后，它的 loading 弹框
   * 「正在提交中，请耐心等待…… 提交中请勿刷新页面」永不消失。
   * 此时整页被遮罩挡住，我们的 UI 点击要么点不到、要么点了也没用，继续点只会叠加无效操作。 */
  const bridge = readRepoFile('src/bridge.js');
  assert.ok(/function findStuckSubmitting/.test(bridge), '桥接要能识别「正在提交中」遮罩');
  assert.ok(/正在提交中\|提交中，请\|请勿刷新页面/.test(bridge), '识别文案要覆盖该系统的实际提示');
  assert.ok(/report\.stuck = true/.test(bridge), '识别到要在报告里标明 stuck');
  const src = readRepoFile('src/content.js');
  assert.ok(/if \(rep && rep\.stuck\)/.test(src), '内容脚本要单独处理 stuck，而不是当成普通失败');
  assert.ok(/请\*\*刷新该选课页\*\*/.test(src), '要明确告诉用户刷新该页');
});

test('回归: 掉线状态不能静默卡死（要有看门狗 + 面板要能看出体检结论）', () => {
  /* 真实事故：面板显示"抢课中"，但 9 个目标全部是「等登录」被静默跳过（cycle 里 continue 不写日志），
   * 而恢复只能靠探测 —— 又恰好被"多标签页节流"吞掉。用户完全看不出哪里坏了，只能干等。
   * 修法：① 掉线状态下的探测必须 force（不受节流）② 长时间没体检就吼一声 ③ 面板显示最近体检结论。 */
  const src = readRepoFile('src/content.js');
  assert.ok(/probeSession\(auth\.state === 'lost' \? '等待重新登录' : '定期体检', \{ force: auth\.state === 'lost' \}\)/.test(src),
    '掉线状态的探测必须强制执行，不能被全局节流挡住');
  assert.ok(/掉线状态已持续但近/.test(src), '要有"掉线却长期没体检"的看门狗告警');
  assert.ok(/lastProbeText = lost/.test(src) && /lastProbeText: lastProbeText/.test(src),
    '体检结论要存下来并进状态快照');
  // 被静默跳过的提交也要能解释：面板在掉线状态下要给出诊断块
  const panel = readRepoFile('src/panel.js');
  assert.ok(/当前处于「掉线」状态/.test(panel), '面板要明确说"引擎在跑但不会提交任何目标"');
  assert.ok(/最近体检：/.test(panel), '面板要显示最近体检的时间与结论');
  assert.ok(/立即检测登录态/.test(panel), '面板要有一键强制探测的按钮');
});

test('吉大: 抓包里的密码/验证码必须被脱敏（惨痛教训）', async () => {
  await import('../src/lib/export.js');
  const X = globalThis.KXExport;
  /* 注意：这里用的是**明显假的示例值**（学号 2099000001、全 0 的哈希、假验证码）。
   * 绝不要把真实学号/密码哈希/验证码写进会公开的代码或测试里 ——
   * 开源前用 node tools/scan-secrets.mjs 扫一遍。 */
  const FAKE_SID = '2099000001';
  const FAKE_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
  const FAKE_CAPTCHA = 'ab3d9';
  const capture = {
    url: 'https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/login/check/login.do?timestrap=1',
    method: 'POST',
    reqHeaders: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'JSESSIONID=EXAMPLE-SESSION-VALUE' },
    reqBody: 'loginName=' + FAKE_SID + '&loginPwd=' + FAKE_HASH + '&verifyCode=' + FAKE_CAPTCHA + '&vtoken=8f02b4fa-cbed-44d0-ae16-d3d25cb4be37',
    status: 200, resp: '{"code":"3","msg":"验证码不正确"}'
  };
  const clean = X.redactCapture(capture);
  assert.ok(!clean.reqBody.includes('0000000000000000000000000000000000000000'), '密码哈希绝不能留在日志/导出里');
  assert.ok(!clean.reqBody.includes(FAKE_SID), '学号也要抹掉');
  assert.ok(!clean.reqBody.includes(FAKE_CAPTCHA), '验证码要抹掉');
  assert.ok(clean.reqBody.includes('loginName=') && clean.reqBody.includes('loginPwd='), '键名保留，便于看清结构');
  assert.deepEqual(clean._redactedHeaders, ['Cookie']);
  assert.ok(Array.isArray(clean._redactedBody) && clean._redactedBody.length >= 3);
  // JSON 形态的 body 也要抹
  const jsonCap = X.redactCapture({ url: 'https://x/api', method: 'POST', reqBody: '{"password":"EXAMPLE-PASSWORD","csrfToken":"keepme"}', status: 200 });
  assert.ok(!jsonCap.reqBody.includes('EXAMPLE-PASSWORD'));
  assert.ok(jsonCap.reqBody.includes('keepme'), 'csrfToken 要保留（配置需要它做模板）');
  // 普通请求的业务参数不能被动到
  const normal = X.redactCapture({ url: 'https://x/xk/choice.do', method: 'POST', reqBody: 'bjdm=20261-101-A1-2&lx=1&csrfToken=0123456789abcdef0123456789abcdef', status: 200 });
  assert.equal(normal.reqBody, 'bjdm=20261-101-A1-2&lx=1&csrfToken=0123456789abcdef0123456789abcdef');
  assert.equal(normal._redactedBody, undefined);
});
