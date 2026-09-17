/* ============================================================
 * test/collector.test.mjs —— 本地抓包收集器 + 整条「自动落盘 → 生成配置」链路
 * ------------------------------------------------------------
 * 验证的是那条你不用动手的路径：
 *   插件抓包 → POST /kx/captures → 落盘 logs/*.jsonl + logs/*.har
 *   → node tools/har2config.mjs logs/kx-captures.har → 可用配置
 * 用法：node test/collector.test.mjs
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

globalThis.chrome = undefined;
await import('../src/lib/export.js');
const KXExport = globalThis.KXExport;
const { createCollector } = await import('../tools/collector.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一条形如插件抓到的记录（带 Cookie，用来验证抹除） */
function capture(over = {}) {
  return Object.assign({
    kind: 'fetch',
    method: 'POST',
    url: 'https://jwxt.example.edu.cn/xk/xkgo?op=save',
    reqHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: 'JSESSIONID=SUPER-SECRET-VALUE'
    },
    reqBody: 'jxb_id=2099000001&kch_id=CS101&xnm=2024&xqm=12&op=save',
    status: 200,
    respHeaders: { 'Content-Type': 'application/json;charset=UTF-8', 'Set-Cookie': 'X=1' },
    respType: 'application/json',
    resp: '{"code":0,"msg":"选课成功"}',
    ms: 62,
    ts: Date.now()
  }, over);
}

async function startCollector(opts) {
  const logDir = mkdtempSync(join(tmpdir(), 'kx-collector-'));
  const server = createCollector(Object.assign({ logDir, fresh: true }, opts || {}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const stop = () => new Promise((r) => server.close(r));
  const cleanup = () => rmSync(logDir, { recursive: true, force: true });
  return { server, base, logDir, stop, cleanup };
}

test('collector: 只监听本机，且 ping 返回落盘路径', async () => {
  const m = await startCollector();
  try {
    const addr = m.server.address();
    assert.equal(addr.address, '127.0.0.1', '必须只绑本机');
    const r = await fetch(m.base + '/kx/ping');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'kx-collector');
    assert.equal(body.entries, 0);
    assert.ok(body.files.har.endsWith('kx-captures.har'));
    assert.ok(body.files.jsonl.endsWith('kx-captures.jsonl'));
    // 私网访问响应头（页面/扩展从公网上下文打 localhost 时需要）
    assert.equal(r.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally { await m.stop(); m.cleanup(); }
});

test('collector: 推送后落盘 jsonl + har，且抹掉 Cookie/Set-Cookie', async () => {
  const m = await startCollector();
  try {
    const payload = { source: 'kx-grabber', host: 'jwxt.example.edu.cn', pageUrl: 'https://jwxt.example.edu.cn/xk', entries: [capture()], logs: [{ t: Date.now(), level: 'ok', msg: '引擎启动' }] };
    const r = await fetch(m.base + '/kx/captures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.added, 1);
    assert.equal(body.total, 1);

    // jsonl
    const jsonlPath = join(m.logDir, 'kx-captures.jsonl');
    assert.ok(existsSync(jsonlPath), 'jsonl 必须生成');
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.reqBody.includes('2099000001'), true, '请求体必须原样保留（这是找选课ID 的依据）');
    assert.equal(Object.keys(rec.reqHeaders).some((k) => /cookie/i.test(k)), false, 'Cookie 必须被抹掉');
    assert.equal(Object.keys(rec.respHeaders).some((k) => /set-cookie/i.test(k)), false, 'Set-Cookie 必须被抹掉');
    assert.deepEqual(rec._redactedHeaders.sort(), ['Cookie', 'Set-Cookie']);
    assert.ok(!readFileSync(jsonlPath, 'utf8').includes('SUPER-SECRET-VALUE'), '凭据值绝不能落盘');

    // har
    const harPath = join(m.logDir, 'kx-captures.har');
    assert.ok(existsSync(harPath), 'har 必须生成');
    const har = JSON.parse(readFileSync(harPath, 'utf8'));
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, 1);
    const e = har.log.entries[0];
    assert.equal(e.request.method, 'POST');
    assert.equal(e.request.url, 'https://jwxt.example.edu.cn/xk/xkgo?op=save');
    assert.equal(e.request.postData.text.includes('jxb_id=2099000001'), true);
    assert.equal(e.request.postData.mimeType.includes('x-www-form-urlencoded'), true);
    assert.equal(e.response.content.text.includes('选课成功'), true);
    assert.equal(e.request.queryString[0].name, 'op');
    assert.ok(!JSON.stringify(har).includes('SUPER-SECRET-VALUE'));

    // 日志
    assert.ok(readFileSync(join(m.logDir, 'kx-log.txt'), 'utf8').includes('引擎启动'));

    // 状态页与 raw 下载
    const page = await (await fetch(m.base + '/')).text();
    assert.ok(page.includes('1'), '状态页应显示条数');
    const dl = await (await fetch(m.base + '/kx/captures.har')).text();
    assert.equal(JSON.parse(dl).log.entries.length, 1);
  } finally { await m.stop(); m.cleanup(); }
});

test('collector: 重复推送同一条不会写两遍（插件重试场景）', async () => {
  const m = await startCollector();
  try {
    const one = capture();
    const send = () => fetch(m.base + '/kx/captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'x', entries: [one, one], logs: [] })
    }).then((r) => r.json());
    const first = await send();
    assert.equal(first.added, 1, '同一批里的重复要去掉');
    const second = await send();
    assert.equal(second.added, 0, '再次推送同一条不应重复入库');
    assert.equal(second.total, 1);
    assert.equal(readFileSync(join(m.logDir, 'kx-captures.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { await m.stop(); m.cleanup(); }
});

test('collector: 坏 JSON / 未知接口 / 清空 都能正确处理', async () => {
  const m = await startCollector();
  try {
    const bad = await fetch(m.base + '/kx/captures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{不是JSON' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);

    const unknown = await fetch(m.base + '/nope');
    assert.equal(unknown.status, 404);

    await fetch(m.base + '/kx/captures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [capture()] }) });
    const reset = await (await fetch(m.base + '/kx/reset', { method: 'POST' })).json();
    assert.equal(reset.entries, 0);
    assert.equal(readFileSync(join(m.logDir, 'kx-captures.jsonl'), 'utf8'), '');
  } finally { await m.stop(); m.cleanup(); }
});

test('collector: OPTIONS 预检返回 204（CORS/私网预检）', async () => {
  const m = await startCollector();
  try {
    const r = await fetch(m.base + '/kx/captures', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-private-network'), 'true');
  } finally { await m.stop(); m.cleanup(); }
});

test('端到端: 收集器落盘的 HAR 能直接喂 har2config 生成可用配置', async () => {
  const m = await startCollector();
  let outDir = null;
  try {
    // 两条不同课程的提交（差分才能找出选课ID），加一条余量查询
    const query = capture({
      url: 'https://jwxt.example.edu.cn/xk/queryJxbList',
      reqBody: 'xnm=2024&xqm=12',
      resp: JSON.stringify({ code: 0, data: { rows: [{ jxb_id: '2099000001', kcmc: '数据结构', remain: 0 }, { jxb_id: '2099000002', kcmc: '操作系统', remain: 3 }] } })
    });
    const s1 = capture({ reqBody: 'xkkh=2024-2025-1-1&jxb_id=2099000001&kch_id=CS101&xnm=2024&op=save' });
    const s2 = capture({ reqBody: 'xkkh=2024-2025-1-2&jxb_id=2099000002&kch_id=CS102&xnm=2024&op=save', resp: '{"code":1,"msg":"该教学班人数已满"}' });
    await fetch(m.base + '/kx/captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'jwxt.example.edu.cn', entries: [query, s1, s2], logs: [] })
    });

    const harPath = join(m.logDir, 'kx-captures.har');
    assert.ok(existsSync(harPath));

    // 用 CLI 跑（stdio 用 inherit，沙箱下不能用管道）
    outDir = mkdtempSync(join(tmpdir(), 'kx-out-'));
    const outPath = join(outDir, 'kx-config.json');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'har2config.mjs'), harPath, '--host', 'jwxt.example.edu.cn', '--out', outPath], { cwd: ROOT, stdio: 'inherit' });
    assert.equal(r.status, 0, 'har2config 应该成功');
    const cfg = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.match(cfg.submit.url, /xkgo/, '应识别出提交接口');
    assert.match(cfg.submit.body, /jxb_id=\{\{id\}\}/, '应把选课ID 模板化');
    assert.equal(cfg.enabled, false, '生成后不能立刻发包');
    assert.ok(cfg.targets.length >= 2, '应生成监控目标：' + JSON.stringify(cfg.targets));

    // 第三个变化键（xkkh 这种每门课一个值）必须模板化 + 冻结到每个目标的 vars，
    // 否则抢第二门课时会带着第一门课的 xkkh 发出去（静默发错参数）
    assert.match(cfg.submit.body, /xkkh=\{\{xkkh\}\}/, 'xkkh 也应被模板化：' + cfg.submit.body);
    const t1 = cfg.targets.find((t) => t.id === '2099000001');
    const t2 = cfg.targets.find((t) => t.id === '2099000002');
    assert.equal(t1.vars.xkkh, '2024-2025-1-1', '每个目标要带自己的 xkkh');
    assert.equal(t2.vars.xkkh, '2024-2025-1-2');
    // 渲染一遍，确认每个目标发出去的参数是对的
    globalThis.chrome = undefined;
    await import('../src/lib/config.js');
    const KX = globalThis.KX;
    const body1 = KX.renderTemplate(cfg.submit.body, KX.buildVars(cfg.submit.vars, t1));
    const body2 = KX.renderTemplate(cfg.submit.body, KX.buildVars(cfg.submit.vars, t2));
    assert.match(body1, /xkkh=2024-2025-1-1&jxb_id=2099000001&kch_id=CS101/);
    assert.match(body2, /xkkh=2024-2025-1-2&jxb_id=2099000002&kch_id=CS102/);

    // 被抹掉的 Cookie 不该出现在配置里（它本来也不该）
    assert.equal(JSON.stringify(cfg).includes('SUPER-SECRET-VALUE'), false);
  } finally { await m.stop(); m.cleanup(); if (outDir) rmSync(outDir, { recursive: true, force: true }); }
});

test('端到端: 原始 jsonl 也能直接喂 har2config', async () => {
  const m = await startCollector();
  let outDir = null;
  try {
    await fetch(m.base + '/kx/captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'jwxt.example.edu.cn', entries: [capture()], logs: [{ t: Date.now(), level: 'ok', msg: '日志行不该干扰解析' }] })
    });
    const jsonlPath = join(m.logDir, 'kx-captures.jsonl');
    outDir = mkdtempSync(join(tmpdir(), 'kx-out2-'));
    const outPath = join(outDir, 'kx-config.json');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'har2config.mjs'), jsonlPath, '--out', outPath], { cwd: ROOT, stdio: 'inherit' });
    assert.equal(r.status, 0, 'JSONL 输入应被接受');
    const cfg = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.match(cfg.submit.url, /xkgo/);
  } finally { await m.stop(); m.cleanup(); if (outDir) rmSync(outDir, { recursive: true, force: true }); }
});

test('export.js: toHar 输出标准 HAR，且凭据被抹掉', () => {
  const har = KXExport.toHar([capture()], { host: 'jwxt.example.edu.cn' });
  assert.equal(har.log.entries.length, 1);
  const e = har.log.entries[0];
  assert.equal(e._redactedHeaders.includes('Cookie'), true);
  assert.deepEqual(e.request.headers.map((h) => h.name), ['Content-Type', 'X-Requested-With']);
  assert.ok(e.startedDateTime.includes('T'));
  assert.equal(e.request.postData.text.includes('{{'), false, '导出时不该动原始 body');
  assert.ok(!JSON.stringify(har).includes('SUPER-SECRET-VALUE'));
});
