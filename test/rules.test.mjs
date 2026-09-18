/* ============================================================
 * test/rules.test.mjs —— 规则/解析层自测（零依赖，node:test）
 * 运行：node test/rules.test.mjs
 *      或 node test/all.mjs（一次跑完全部测试）
 * 注意：不要用 `node --test test/` —— 测试运行器要 spawn 子进程抓输出，
 *       在受限沙箱（禁止命名管道）下会报 spawn EPERM，那是环境限制不是测试失败。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

// 这两个共享库是「普通脚本」，通过 globalThis 暴露；Node 里用 CJS 方式加载即可
globalThis.chrome = undefined;                    // config.js 里对 chrome 有守卫判断
await import('../src/lib/config.js');
await import('../src/lib/rules.js');

const KX = globalThis.KX;
const R = globalThis.KXRules;

test('config: renderTemplate / buildBody', () => {
  assert.equal(KX.renderTemplate('a={{id}}&b={{kch}}', { id: 'X1', kch: 'K9' }), 'a=X1&b=K9');
  assert.equal(KX.renderTemplate('t={{ts}}', { ts: 123 }), 't=123');
  assert.equal(KX.renderTemplate('missing={{nope}}', {}), 'missing=');

  const form = KX.buildBody('form', 'jxb_id={{id}}', { id: '7' });
  assert.equal(form.body, 'jxb_id=7');
  assert.match(form.headers['Content-Type'], /x-www-form-urlencoded/);

  const json = KX.buildBody('json', '{"id":"{{id}}"}', { id: '7' });
  assert.equal(json.body, '{"id":"7"}');
  assert.equal(json.headers['Content-Type'], 'application/json');
});

test('config: siteAllowed 后缀匹配', () => {
  const sites = ['jwxt.example.edu.cn', 'https://xk.example.edu.cn/xk/'];
  assert.equal(KX.siteAllowed('jwxt.example.edu.cn', sites), true);
  assert.equal(KX.siteAllowed('a.jwxt.example.edu.cn', sites), true);
  assert.equal(KX.siteAllowed('xk.example.edu.cn', sites), true);
  assert.equal(KX.siteAllowed('evil-jwxt.example.edu.cn.attacker.com', sites), false);
  assert.equal(KX.siteAllowed('example.edu.cn', sites), false);
  assert.equal(KX.siteAllowed('jwxt.example.edu.cn', []), false);
});

test('rules: evalRule 各类型', () => {
  assert.equal(R.evalRule({ type: 'regex', value: '选课成功' }, '操作结果：选课成功！'), true);
  assert.equal(R.evalRule({ type: 'regex', value: '^选课成功$' }, '选课成功，请查看'), false);
  assert.equal(R.evalRule({ type: 'contains', value: '已满' }, '该教学班已满'), true);
  assert.equal(R.evalRule({ type: 'notContains', value: '失败' }, '成功'), true);
  assert.equal(R.evalRule({ type: 'status', status: 401 }, '', 401), true);
  assert.equal(R.evalRule({ type: 'always' }, ''), true);
  assert.equal(R.evalRule({ type: 'regex', value: '(' }, 'x'), false);   // 非法正则不抛异常
});

test('rules: classify 优先级（验证码 > 成功），用真实默认规则', () => {
  const rules = KX.defaults().submit.rules;
  assert.equal(R.classify(rules, '请输入验证码后继续，上次选课成功', 200).kind, 'captcha');
  assert.equal(R.classify(rules, '选课成功', 200).kind, 'success');
  assert.equal(R.classify(rules, '该教学班人数已满', 200).kind, 'full');
  assert.equal(R.classify(rules, '你已选过该课程', 200).kind, 'dup');
  assert.equal(R.classify(rules, '会话失效，请重新登录', 200).kind, 'logout');
  assert.equal(R.classify(rules, '现在不在选课时间', 200).kind, 'closed');
  assert.equal(R.classify(rules, '系统繁忙', 500).kind, 'http');
  assert.equal(R.classify(rules, '系统繁忙', 200).kind, 'unknown');
});

test('rules: 默认规则不会把普通成功误判成掉登录', () => {
  const rules = KX.defaults().submit.rules;
  // '成功' 与 logout 关键词共存时，success 必须排在 logout 之后 —— 这是刻意的设计：
  // 宁可多问一次「是不是掉线了」，也不要漏掉已经抢到的课。
  assert.equal(R.classify(rules, '选课成功，你可以继续选课', 200).kind, 'success');
  assert.equal(R.classify(rules, '{"code":0,"msg":"操作成功"}', 200).kind, 'success');
});

test('rules: jsonGet 路径', () => {
  const data = { data: { list: [{ a: 1 }] }, rows: [{ b: 2 }] };
  assert.deepEqual(R.jsonGet(data, 'data.list.0.a'), 1);
  assert.deepEqual(R.jsonGet(data, 'rows[0].b'), 2);
  assert.deepEqual(R.jsonGet(data, 'data.*.0.a'), 1);
  assert.equal(R.jsonGet(data, 'nope.deep'), undefined);
});

test('rules: parseList JSON 自动找数组 + 字段猜测', () => {
  const body = JSON.stringify({
    code: 0,
    data: {
      rows: [
        { jxb_id: '2099000001', kcmc: '数据结构', remain: '3', teacher: '张三' },
        { jxb_id: '2099000002', kcmc: '操作系统', remain: 0, teacher: '李四' }
      ]
    }
  });
  const r = R.parseList({ type: 'json' }, body);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 2);
  assert.equal(r.list[0].id, '2099000001');
  assert.equal(r.list[0].remain, 3);
  assert.equal(r.list[0].name, '数据结构');
  assert.equal(r.list[1].remain, 0);

  const withPath = R.parseList({ type: 'json', path: 'data.rows', idField: 'jxb_id', remainField: 'remain' }, body);
  assert.equal(withPath.list.length, 2);
});

test('rules: parseList 以 id 为键的对象', () => {
  const body = JSON.stringify({ data: { '2099000001': { remain: 5, kcmc: 'A' } } });
  const r = R.parseList({ type: 'json' }, body);
  assert.equal(r.ok, true);
  assert.equal(r.list[0].id, '2099000001');
  assert.equal(r.list[0].remain, 5);
});

test('rules: parseList 单条记录回退（没有数组、没有映射表）', () => {
  const body = JSON.stringify({ code: 0, data: { jxb_id: '2099000001', kcmc: '数据结构', remain: 2 } });
  const r = R.parseList({ type: 'json' }, body);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].id, '2099000001');
  assert.equal(r.list[0].remain, 2);
});

test('rules: parseList 空对象给出可读错误', () => {
  const r = R.parseList({ type: 'json' }, JSON.stringify({ code: 0, msg: 'ok' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /未找到记录数组/);
});

test('rules: parseList HTML 用正则 + 命名组', () => {
  const html = '<tr><td>2099000001</td><td>数据结构</td><td>3</td></tr><tr><td>2099000002</td><td>操作系统</td><td>0</td></tr>';
  const r = R.parseList({
    type: 'regex',
    regex: '<td>(?<id>\\d{6,})</td><td>(?<name>[^<]+)</td><td>(?<remain>\\d+)</td>'
  }, html);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 2);
  assert.equal(r.list[1].id, '2099000002');
  assert.equal(r.list[1].remain, 0);
  assert.equal(r.list[1].name, '操作系统');
});

test('rules: parseList 非 JSON 时给出可读错误', () => {
  const r = R.parseList({ type: 'json' }, '<html>需要登录</html>');
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON|regex/);
});

test('params: splitParams form 与 json', () => {
  const form = R.splitParams('jxb_id=123&kch_id=ABC&xnm=2024', 'form');
  assert.deepEqual(form.map((p) => p.k), ['jxb_id', 'kch_id', 'xnm']);
  assert.equal(form[0].v, '123');

  const json = R.splitParams('{"jxb_id":"123","opts":{"xqm":"12"}}', 'json');
  assert.deepEqual(json.map((p) => p.k), ['jxb_id', 'opts.xqm']);
  assert.equal(json[1].v, '12');
});

test('params: diffParamKeys 找到真正变化的选课ID', () => {
  const entries = [
    { body: 'jxb_id=2099000001&kch_id=ABC&xnm=2024&xqm=12', contentType: 'form' },
    { body: 'jxb_id=2099000002&kch_id=ABC&xnm=2024&xqm=12', contentType: 'form' }
  ];
  const d = R.diffParamKeys(entries);
  assert.equal(d.length, 1);
  assert.equal(d[0].k, 'jxb_id');
  assert.equal(d[0].allDigit, true);
});

test('params: diffParamKeys 把时间戳/令牌类噪声字段排到最后', () => {
  const entries = [
    { body: 'jxb_id=2099000001&_t=1712345678901&sign=aaa111', contentType: 'form' },
    { body: 'jxb_id=2099000002&_t=1712345678999&sign=bbb222', contentType: 'form' }
  ];
  const d = R.diffParamKeys(entries);
  assert.equal(d[0].k, 'jxb_id', '真正的选课ID必须排第一');
  const noise = d.filter((x) => x.noise).map((x) => x.k);
  assert.ok(noise.includes('_t') && noise.includes('sign'), '噪声字段仍要列出来（标注出来），不能凭空消失');
  assert.equal(d[d.length - 1].noise, true, '噪声字段排在最后');
});

test('params: applyTemplate 只替换目标参数', () => {
  assert.equal(
    R.applyTemplate('jxb_id=2099000001&kch_id=ABC&xnm=2024', 'jxb_id', '{{id}}'),
    'jxb_id={{id}}&kch_id=ABC&xnm=2024'
  );
  assert.equal(
    R.applyTemplate('{"jxb_id":"2099000001","kch_id":"ABC"}', 'jxb_id', '{{id}}'),
    '{"jxb_id":"{{id}}","kch_id":"ABC"}'
  );
  assert.equal(
    R.applyUrlTemplate('https://x/xk?jxb_id=123&op=save', 'jxb_id', '{{id}}'),
    'https://x/xk?jxb_id={{id}}&op=save'
  );
});

test('params: guessIdParam 优先 id 命名', () => {
  const k = R.guessIdParam([
    { k: 'xnm', v: '2024' },
    { k: 'jxb_id', v: '2099000001' },
    { k: 'seq', v: '12345678' }
  ]);
  assert.equal(k, 'jxb_id');
});

test('config: withPath 整体替换对象（面板编辑 headers 必须用这个）', () => {
  const state = { submit: { headers: { a: '1', b: '2' }, url: 'u' }, engine: { intervalMs: 1000 } };
  const next = KX.withPath(state, 'submit.headers', { c: '3' });
  assert.deepEqual(next.submit.headers, { c: '3' }, '旧键必须被丢掉');
  assert.equal(next.submit.url, 'u', '兄弟字段不能丢');
  assert.equal(next.engine.intervalMs, 1000, '其它分组不能丢');
  assert.deepEqual(state.submit.headers, { a: '1', b: '2' }, '不能原地改原对象');

  const deep = KX.withPath({}, 'a.b.c', 1);
  assert.deepEqual(deep, { a: { b: { c: 1 } } });

  // 对比：save 的深合并语义会保留旧键，所以面板里不能用它改整体值
  assert.deepEqual(KX.deepMerge({ headers: { a: '1', b: '2' } }, { headers: { c: '3' } }).headers,
    { a: '1', b: '2', c: '3' });
});

test('config: submit/query 的高级字段都在 schema 里（不能是"影子配置"）', () => {
  const d = KX.defaults();
  // 引擎会读这些字段：如果不在 defaults() 里，文档就会漂移、导出/导入也会丢
  for (const group of ['submit', 'query']) {
    assert.equal(d[group].via, 'fetch', group + '.via 应有默认值 fetch');
    assert.equal(d[group].timeoutMs, 15000, group + '.timeoutMs 应有默认值 15000');
    assert.equal(d[group].referrer, '', group + '.referrer 应默认为空（=用当前页面地址）');
  }
  // 模板变量槽位
  assert.equal(typeof d.submit.vars, 'object');
  assert.equal(d.submit.body, '', '默认 body 故意为空：等用户从真实抓包里填进来');
  assert.match(d.submit.rules.success.value, /成功/);
  assert.match(d.submit.rules.full.value, /已满/);
});

test('config: buildVars 的变量优先级（顺序错了会静默发错参数）', () => {
  const globalVars = { xnm: '2024', xqm: '12', xkkh: 'GLOBAL-WRONG', op: 'save' };
  const target = { id: '2099000001', kch: 'CS101', label: '数据结构', vars: { xkkh: '2024-2025-1-1' } };
  const vars = KX.buildVars(globalVars, target);

  assert.equal(vars.xnm, '2024', '全局变量要保留');
  assert.equal(vars.xkkh, '2024-2025-1-1', 'targets[].vars 必须覆盖 submit.vars');
  assert.equal(vars.op, 'save');
  assert.equal(vars.id, '2099000001');
  assert.equal(vars.kch, 'CS101');
  assert.equal(vars.label, '数据结构');
  assert.equal(vars.name, '数据结构', 'name 与 label 同源');
  assert.ok(vars.ts > 1600000000000 && typeof vars.rand === 'string');

  // 内置值优先级最高：目标自身不能靠 vars 把 id 改掉
  const tricky = KX.buildVars({}, { id: 'REAL', vars: { id: 'FAKE' } });
  assert.equal(tricky.id, 'REAL', 'vars 不该能覆盖内置 id');

  // 目标缺字段时不炸
  const bare = KX.buildVars(undefined, undefined);
  assert.equal(bare.kch, '');
  assert.equal(bare.label, '');

  const body = KX.renderTemplate('jxb_id={{id}}&kch_id={{kch}}&xkkh={{xkkh}}&xnm={{xnm}}', vars);
  assert.equal(body, 'jxb_id=2099000001&kch_id=CS101&xkkh=2024-2025-1-1&xnm=2024');
});

test('config: authAnchorDecision —— 修「刚登录却提示还剩 3 分钟」的回归测试', () => {
  const now = 1_700_000_000_000;
  const HARD = 1200000;      // 20 分钟
  const STALE = 600000;      // 锚点 10 分钟没确认就作废
  const WIN = 1800000;       // 去过登录页后 30 分钟内算「刚登录」

  // ① 真实 bug 场景：锚点是 17 分钟前（上一会话/上次点过「我刚登录了」留下的），
  //    且期间没有新观测 → 必须作废，否则立刻误报「还剩 3 分钟」
  const stale = KX.authAnchorDecision({ loginAt: now - 17 * 60000, observedAt: now - 17 * 60000, now, staleGapMs: STALE });
  assert.equal(stale.reset, true, '旧锚点太久没确认，必须作废');
  assert.match(stale.reason, /没有确认过会话有效/);
  const est1 = KX.authEstimate({ loginAt: stale.reset ? 0 : now, observedAt: now, hardTimeoutMs: HARD, now });
  assert.equal(est1.leftMs, null, '锚点作废后不该再给出剩余时间（也就不会再误报）');

  // ② 刚去过登录页（background 记的标记）→ 即使锚点看起来"新鲜"也要作废
  const flow = KX.authAnchorDecision({
    loginAt: now - 17 * 60000, observedAt: now - 1000, now,
    staleGapMs: STALE, loginFlowAt: now - 30000, loginFlowWindowMs: WIN
  });
  assert.equal(flow.reset, true, '刚登录过就必须重算，哪怕锚点没有"变旧"');
  assert.match(flow.reason, /刚从登录页回来/);

  // ③ 正常的连续会话：锚点 1 分钟前、一直在确认 → 不作废，剩余 19 分钟
  const ok = KX.authAnchorDecision({ loginAt: now - 60000, observedAt: now - 5000, now, staleGapMs: STALE });
  assert.equal(ok.reset, false);
  assert.equal(KX.authEstimate({ loginAt: now - 60000, observedAt: now - 5000, hardTimeoutMs: HARD, now }).leftMs, 19 * 60000);

  // ④ 过期很久的登录页标记不再影响判断（窗口外）
  const oldFlow = KX.authAnchorDecision({
    loginAt: now - 60000, observedAt: now - 5000, now,
    staleGapMs: STALE, loginFlowAt: now - 2 * 3600 * 1000, loginFlowWindowMs: WIN
  });
  assert.equal(oldFlow.reset, false, '两小时前的登录页访问与当前会话无关');

  // ⑤ 本来就没有锚点：不折腾，也不报错
  assert.equal(KX.authAnchorDecision({ loginAt: 0, observedAt: 0, now, staleGapMs: STALE }).reset, false);
  assert.equal(KX.authEstimate({ loginAt: 0, hardTimeoutMs: HARD, now }).leftMs, null);
  // ⑥ 关掉倒计时功能（hardTimeoutMs=0）时不显示剩余时间
  assert.equal(KX.authEstimate({ loginAt: now - 60000, observedAt: now, hardTimeoutMs: 0, now }).leftMs, null);
});

test('config: aggregatePush 必须能合并「被其它日志隔开」的同 key 条目（真实事故）', () => {
  /* 真实事故：合并只在"相邻两条同 key"时生效，但盲发多目标轮转时的实际序列是
   *   full:A → throttle → submit:A → full:B → throttle → submit:B → full:A …
   * 同 key 的条目之间永远隔着别的行 → 一次都没合并，日志照样刷到 400 条。 */
  const list = [];
  const push = (msg, key) => KX.aggregatePush(list, { t: 1, msg, key: key || '', level: 'pkg', extra: 'x' }, 100);

  // 模拟两个目标各两轮
  const script = [
    ['- A 名额已满', 'full:A'], ['限速', 'throttle'], ['▶ 提交 A', 'submit:A'],
    ['- B 名额已满', 'full:B'], ['限速', 'throttle'], ['▶ 提交 B', 'submit:B'],
    ['- A 名额已满', 'full:A'], ['限速', 'throttle'], ['▶ 提交 A', 'submit:A'],
    ['- B 名额已满', 'full:B'], ['限速', 'throttle'], ['▶ 提交 B', 'submit:B']
  ];
  script.forEach((s) => push(s[0], s[1]));

  assert.equal(list.length, 5, '两个目标 × 2 类 + 1 个限速 = 5 条（不是 12 条）');
  const byKey = {};
  list.forEach((l) => { byKey[l.key] = l.count || 1; });
  assert.equal(byKey['full:A'], 2, 'A 的已满日志要合并成 ×2');
  assert.equal(byKey['submit:A'], 2);
  assert.equal(byKey['full:B'], 2);
  assert.equal(byKey['submit:B'], 2);
  assert.equal(byKey.throttle, 4, '限速被 4 个目标共享 → ×4');
  // 最近更新的排到最后（日志页倒序显示时它排最前）
  assert.equal(list[list.length - 1].key, 'submit:B');
  // 一次性事件（无 key）永不合并
  push('引擎启动', '');
  push('引擎启动', '');
  assert.equal(list.length, 7, '无 key 的日志各占一行');
});

test('config: aggregatePush —— 盲发模式下的日志合并（防每秒十几行刷屏）', () => {
  const list = [];
  const mk = (msg, key, level) => ({ t: 1000, msg, key: key || '', level: level || 'pkg', extra: 'x' });
  // 同一个 key 的连续日志就地合并
  let r = KX.aggregatePush(list, mk('▶ 提交 A', 'submit:A'), 100);
  assert.equal(r.merged, false);
  assert.equal(list.length, 1);
  r = KX.aggregatePush(list, mk('▶ 提交 A', 'submit:A'), 100);
  assert.equal(r.merged, true);
  assert.equal(list.length, 1, '同类重复不应新增行');
  assert.equal(list[0].count, 2);
  KX.aggregatePush(list, mk('▶ 提交 A', 'submit:A'), 100);
  assert.equal(list[0].count, 3);
  // 不同 key 不能合并
  KX.aggregatePush(list, mk('▶ 提交 B', 'submit:B'), 100);
  assert.equal(list.length, 2);
  // 同一个 key 一律合并（key 已经决定了这条日志的语义，级别是固定的；
  // 以前还要求 level 相同，但那只在"相邻比较"的实现里才需要，见下一条测试）
  KX.aggregatePush(list, mk('▶ 提交 B', 'submit:B', 'err'), 100);
  assert.equal(list.length, 2, '同 key 合并，不新增行');
  assert.equal(list[1].count, 2);
  // 没有 key 的日志永不合并（比如"引擎启动""掉线"这类一次性事件）
  KX.aggregatePush(list, mk('引擎启动'), 100);
  KX.aggregatePush(list, mk('引擎启动'), 100);
  assert.equal(list.length, 4);
  // 合并保留最新文案（比如限速等待的毫秒数会变）
  const l2 = [];
  KX.aggregatePush(l2, mk('等待 300ms', 'throttle', 'warn'), 100);
  KX.aggregatePush(l2, mk('等待 500ms', 'throttle', 'warn'), 100);
  assert.equal(l2.length, 1);
  assert.equal(l2[0].msg, '等待 500ms');
  // 超过上限时丢最旧的
  const l3 = [];
  for (let i = 0; i < 10; i++) KX.aggregatePush(l3, mk('m' + i, 'k' + i), 5);
  assert.equal(l3.length, 5);
  assert.equal(l3[l3.length - 1].msg, 'm9');
});

test('回归: 并发批次的 {{ts}} 必须各不相同（否则服务器可能判成重复请求）', async () => {
  /* 真实观察：同一批 9 个提交的 URL 里 ?_=<时间戳> 完全相同 ——
   * 因为并发是同步启动的，9 个 Date.now() 落在同一毫秒。
   * 而那种情况下服务器返回过 {"msg":"<随机32位hex>","code":1}（既非已满也非成功），
   * 很可能是被判成重复请求。 */
  await import('../src/lib/config.js').catch(() => {});
  const KX = globalThis.KX;
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(KX.buildVars({}, { id: 'X' }).ts);
  assert.equal(seen.size, 200, '200 次调用的 ts 必须全都不同');
  // 单调递增（仍然是个合理的时间戳）
  const a = KX.buildVars({}, { id: 'X' }).ts;
  const b = KX.buildVars({}, { id: 'X' }).ts;
  assert.ok(b > a, 'ts 要单调递增');
  assert.ok(Math.abs(a - Date.now()) < 5000, 'ts 仍应是"现在"这个量级的时间戳');
});

test('模糊匹配: 课程名归一化要抹掉"年年会变"的差异（年份换代码时靠它兜底）', async () => {
  const R = await import('../src/lib/rules.js').then(() => globalThis.KXRules);
  // 完全相同 → 1
  assert.equal(R.nameSimilarity('篮球', '篮球'), 1);
  // 括号内容、全半角、空格、末尾序号都不该影响判断
  assert.equal(R.nameSimilarity('当代马克思主义伦理学（线上慕课） 01', '当代马克思主义伦理学(线上慕课)(01)'), 1);
  assert.equal(R.nameSimilarity('篮球01', '篮球 1'), 1);
  assert.equal(R.nameSimilarity('健美操（健美操01前卫）', '健美操（健美操02前卫）'), 1);
  assert.equal(R.nameSimilarity('钢琴艺术赏析（线上慕课）', '钢琴艺术赏析'), 1, '括号差异不算差异');
  // 包含关系（缩写/全称）应该很高但不是 1
  const s = R.nameSimilarity('知识产权法律基础', '知识产权法');
  assert.ok(s > 0.75 && s < 1, '包含关系应在 0.75~1 之间，实际 ' + s.toFixed(2));
  // 不相干的课不该被误配
  assert.ok(R.nameSimilarity('篮球', '钢琴艺术赏析') < 0.3, '不相干的课相似度必须很低');
  // 归一化后空字符串（例如只有括号）不该崩
  assert.equal(R.nameSimilarity('', '篮球'), 0);
  assert.equal(R.nameSimilarity('（线上慕课）', '篮球'), 0);
});

test('模糊匹配: 按名字在候选里找回目标（含同名多班的取舍）', async () => {
  const R = await import('../src/lib/rules.js').then(() => globalThis.KXRules);
  const rows = [
    { id: 'NEW-1', name: '羽毛球', raw: { RKJS: '李凤丽', XQMC: '南湖校区', PKSJDDMS: '3-12周 星期六[3-4节]', KCDM: 'A0422105011' } },
    { id: 'NEW-2', name: '羽毛球', raw: { RKJS: '柳钢', XQMC: '南湖校区', PKSJDDMS: '3-12周 星期六[5-6节]' } },
    { id: 'NEW-3', name: '篮球', raw: { RKJS: '李洋', XQMC: '南岭校区' } },
    { id: 'NEW-4', name: '钢琴艺术赏析', raw: { RKJS: '王老师', XQMC: '前卫校区' } },
    { id: 'NEW-5', name: '钢琴艺术赏析', raw: { RKJS: '张老师', XQMC: '前卫校区' } }
  ];
  // 用"上一年的目标"（名字+教师）去找今年的 ID
  const t = { label: '羽毛球（南湖）', teacher: '李凤丽', campus: '南湖校区' };
  const cands = R.matchCoursesByName(rows, t);
  assert.equal(cands[0].row.id, 'NEW-1', '教师命中应该把正确那一班排到第一');
  const pick = R.pickBestMatch(cands);
  assert.equal(pick.ok, true, '唯一高分应该能自动采用');
  assert.equal(pick.best.row.id, 'NEW-1');

  // 同名多班、教师也没填 → 存疑，不能自动改
  const t2 = { label: '钢琴艺术赏析' };
  const c2 = R.matchCoursesByName(rows, t2);
  assert.equal(c2.length >= 2, true);
  assert.ok(c2[0].score >= 0.8, '名字完全一致就该达到采用阈值，实际 ' + c2[0].score.toFixed(2));
  const p2 = R.pickBestMatch(c2);
  assert.equal(p2.ok, false, '两个同名班分数接近时必须判为存疑');
  assert.equal(p2.reason, 'ambiguous');

  // 找不到任何像的课 → 不给候选/低分
  const c3 = R.matchCoursesByName(rows, { label: '量子力学导论' });
  assert.equal(R.pickBestMatch(c3).ok, false);
  assert.ok(!c3.length || c3[0].score < 0.8, '低分不能自动采用');

  /* 关键场景：**有候选、也算像，但分数不够**（0.5~0.8 区间）→ 绝不能自动采用。
   * 这是最容易"抢错课"的地带：看起来像同一门课，但可能是不同课程/不同教学班。
   * （之前的测试漏了这一档，反向验证时发现删掉阈值检查也测不出来。） */
  const c6 = R.matchCoursesByName([{ id: 'X', name: '知识产权法', raw: {} }], { label: '知识产权法律基础' });
  assert.equal(c6.length, 1, '应该给得出候选');
  assert.ok(c6[0].score > 0.5 && c6[0].score < 0.8,
    '相似度应落在"像但不够确定"的区间，实际 ' + (c6[0].score || 0).toFixed(2));
  assert.equal(R.pickBestMatch(c6).ok, false, '分数不到阈值时绝不能自动采用（否则会抢错课）');
  assert.equal(R.pickBestMatch(c6).reason, 'low-score');
  // 阈值可以调：把门槛降到 0.7 时同一个候选就能用了（面板上让用户决定时会用到）
  assert.equal(R.pickBestMatch(c6, { minScore: 0.7 }).ok, true);

  // 课程代码命中时应该明显加分（代码没变的年份直接锁定）
  const c4 = R.matchCoursesByName(rows, { label: '羽毛球', kch: 'A0422105011' });
  assert.equal(c4[0].row.id, 'NEW-1', '课程代码命中优先');
});

test('配置自动应用: 合并时必须保留"属于用户"的部分（目标清单 / 调速 / 通知）', async () => {
  /* 背景："这个配置json能自动配置吗" —— 能，但要分清"谁的东西"：
   *   · 系统协议（站点白名单、提交/查询/已选接口、判定规则、会话与UI策略）→ 以文件为准
   *   · 用户的东西（选课清单 targets、面板上调的 engine 速率、通知/收集器偏好）→ 保留
   * 否则自动应用会变成"每次重载冲掉你的目标列表"（今天已经因为导入干过一次）。 */
  await import('../src/lib/config.js').catch(() => { });
  const KX = globalThis.KX;
  const fileCfg = {
    sites: ['yjsxk.jlu.edu.cn'],
    submit: { url: 'https://x/choiceCourse.do', body: 'bjdm={{id}}' },
    engine: { intervalMs: 300, maxReqPerMinute: 400, burstCap: 0 },
    targets: [],
    notify: { desktop: true, sound: true, webhook: '' },
    debug: { collectorUrl: '', autoPush: false }
  };
  const stored = {
    sites: ['old.example.com'],
    submit: { url: 'https://old/old.do' },          // 旧的提交模板
    engine: { maxReqPerMinute: 600, autoStopSameName: false },  // 用户调过速率
    targets: [{ id: 'T1', label: '羽毛球' }],        // 用户的选课清单
    notify: { desktop: false, sound: false, webhook: 'http://127.0.0.1:9999/hook' },
    debug: { collectorUrl: 'http://127.0.0.1:8790/kx/captures', autoPush: true }
  };
  const m = KX.mergeBundledConfig(fileCfg, stored);
  // 系统协议以文件为准
  assert.deepEqual(m.sites, ['yjsxk.jlu.edu.cn'], '站点白名单要用文件里的（否则面板不出现在学校站点）');
  assert.equal(m.submit.url, 'https://x/choiceCourse.do', '提交模板要用文件里的');
  // 用户的东西保留
  assert.equal(m.targets.length, 1, '目标清单必须保留（否则重载一次就丢一次）');
  assert.equal(m.targets[0].label, '羽毛球');
  assert.equal(m.engine.maxReqPerMinute, 600, '你在面板上调的速率要保留');
  assert.equal(m.notify.webhook, 'http://127.0.0.1:9999/hook', '通知偏好保留');
  assert.equal(m.debug.autoPush, true, '收集器偏好保留');
  // 文件里的**新键**仍要能补进来（否则以后加新配置项永远不生效）
  assert.equal(m.engine.burstCap, 0, '文件里的新 engine 键要补进合并结果');
  assert.equal(m.engine.intervalMs, 300);
  // 空/缺字段不能崩
  const m2 = KX.mergeBundledConfig({}, {});
  assert.deepEqual(m2.targets, []);
  assert.deepEqual(m2.engine, {});
  const m3 = KX.mergeBundledConfig(null, null);
  assert.deepEqual(m3.targets, []);
});

test('params: guessFields 猜余量响应字段', () => {
  const f = R.guessFields({ jxb_id: '1', kcmc: '数据结构', remain: 3, teacher: '张三' });
  assert.equal(f.idField, 'jxb_id');
  assert.equal(f.remainField, 'remain');
  assert.equal(f.nameField, 'kcmc');
});
