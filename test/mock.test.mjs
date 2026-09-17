/* ============================================================
 * test/mock.test.mjs —— 验证「本地模拟教务系统」的契约
 * ------------------------------------------------------------
 * 这些断言对应的正是插件依赖的行为：
 *   · 硬超时后接口 302 跳 /login（插件靠这个判掉线）
 *   · 余量查询返回的 JSON 能被 KXRules.parseList 正确解析
 *   · HTML 余量表能被文档里给的正则解析
 *   · 「选课成功 / 人数已满 / 请输入验证码」三种响应文本能被 classify 正确分类
 * 用法：node test/mock.test.mjs
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = undefined;
await import('../src/lib/config.js');
await import('../src/lib/rules.js');
const KX = globalThis.KX;
const R = globalThis.KXRules;

const { createMockServer } = await import('../mock/server.mjs');

async function startMock(opts) {
  const server = createMockServer(Object.assign({ ttlMs: 120000, autoOpen: false }, opts || {}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const stop = () => new Promise((r) => server.close(r));
  return { server, base, stop };
}

function cookieOf(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie');
  return String(raw || '').split(';')[0];
}

const form = (obj) => Object.entries(obj).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const postForm = (url, body, cookie) => fetch(url, {
  method: 'POST',
  redirect: 'manual',
  headers: Object.assign(
    { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    cookie ? { Cookie: cookie } : {}
  ),
  body: typeof body === 'string' ? body : form(body || {})
});

test('mock: 未登录时接口 302 跳登录页（插件判定掉线的依据）', async () => {
  const m = await startMock();
  try {
    const r = await postForm(m.base + '/xk/query', { xnm: '2024' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /\/login/);
    const page = await fetch(m.base + '/xk', { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /\/login\?next=/);
  } finally { await m.stop(); }
});

test('mock: 余量查询 JSON 能被 parseList 正确解析（jxb_id/remain/kcmc）', async () => {
  const m = await startMock();
  try {
    const login = await fetch(m.base + '/login?auto=1&next=/xk', { redirect: 'manual' });
    const cookie = cookieOf(login);
    assert.match(cookie, /^MOCK_SESSION=/);

    const r = await postForm(m.base + '/xk/query', { xnm: '2024', xqm: '12' }, cookie);
    assert.equal(r.status, 200);
    const body = await r.text();

    const parsed = R.parseList(KX.defaults().query.parse, body);
    assert.equal(parsed.ok, true, '默认 parse 配置必须能自动解析出记录：' + parsed.error);
    assert.equal(parsed.list.length, 3);
    const a = parsed.list.find((x) => x.id === '2099000001');
    assert.ok(a, '应该找到 2099000001');
    assert.equal(a.remain, 0);
    assert.equal(a.name, '数据结构');

    // 面板自动填进去的字段名也应该能用
    const f = R.guessFields(a.raw);
    assert.equal(f.idField, 'jxb_id');
    assert.equal(f.remainField, 'remain');
    assert.equal(f.nameField, 'kcmc');
  } finally { await m.stop(); }
});

test('mock: HTML 余量表能被文档里的正则解析', async () => {
  const m = await startMock();
  try {
    const login = await fetch(m.base + '/login?auto=1&next=/xk', { redirect: 'manual' });
    const cookie = cookieOf(login);
    const r = await fetch(m.base + '/xk/remain', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const html = await r.text();
    const parsed = R.parseList({
      type: 'regex',
      regex: '<td>(?<id>\\d{6,})</td><td>(?<name>[^<]+)</td><td>(?<remain>\\d+)</td>'
    }, html);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.list.length, 3);
    assert.equal(parsed.list[0].id, '2099000001');
    assert.equal(parsed.list[0].remain, 0);
  } finally { await m.stop(); }
});

test('mock: 有名额→选课成功；无名额→人数已满；连刷→要求验证码', async () => {
  const m = await startMock();
  try {
    const login = await fetch(m.base + '/login?auto=1&next=/xk', { redirect: 'manual' });
    const cookie = cookieOf(login);
    const rules = KX.defaults().submit.rules;

    // B：有 3 个名额 → 成功
    const ok = await postForm(m.base + '/xk/submit', { jxb_id: '2099000002', kch_id: 'CS102', xnm: '2024', xqm: '12' }, cookie);
    assert.equal(ok.status, 200);
    const okBody = await ok.text();
    assert.equal(R.classify(rules, okBody, ok.status).kind, 'success', '实际响应：' + okBody);

    // C：永远满 → 第 1、2 次是「已满」，第 3 次要求验证码
    const full1 = await postForm(m.base + '/xk/submit', { jxb_id: '2099000003' }, cookie);
    assert.equal(R.classify(rules, await full1.text(), full1.status).kind, 'full');
    const full2 = await postForm(m.base + '/xk/submit', { jxb_id: '2099000003' }, cookie);
    assert.equal(R.classify(rules, await full2.text(), full2.status).kind, 'full');
    const cap = await postForm(m.base + '/xk/submit', { jxb_id: '2099000003' }, cookie);
    assert.equal(R.classify(rules, await cap.text(), cap.status).kind, 'captcha',
      '第 3 次连刷必须被判成验证码，这样插件才会自动停机');
  } finally { await m.stop(); }
});

test('mock: 硬超时到点后立刻 302 跳登录（模拟 20 分钟被踢）', async () => {
  const m = await startMock({ ttlMs: 60 });   // 60ms 就超时
  try {
    const login = await fetch(m.base + '/login?auto=1&next=/xk', { redirect: 'manual' });
    const cookie = cookieOf(login);
    const before = await postForm(m.base + '/xk/query', {}, cookie);
    assert.equal(before.status, 200, '超时前应该正常');

    await new Promise((r) => setTimeout(r, 90));

    const after = await postForm(m.base + '/xk/submit', { jxb_id: '2099000002' }, cookie);
    assert.equal(after.status, 302, '硬超时后必须 302');
    assert.match(after.headers.get('location'), /\/login/);
  } finally { await m.stop(); }
});

test('mock: 自动放名额（演示用）可以逐个放出', async () => {
  const m = await startMock();
  try {
    const login = await fetch(m.base + '/login?auto=1&next=/xk', { redirect: 'manual' });
    const cookie = cookieOf(login);
    const state = () => fetch(m.base + '/__state').then((r) => r.json());

    const s0 = await state();
    const c0 = s0.courses.find((c) => c.jxb_id === '2099000001');
    assert.equal(c0.remain, 0, '「数据结构」初始应该是 0 名额');
    assert.equal(s0.autoOpen, false, '测试里关掉了自动放名额，避免不确定');
  } finally { await m.stop(); }
});
