/* ============================================================
 * test/har2config.test.mjs —— 独立验证 HAR → 配置 转换工具
 * ------------------------------------------------------------
 * 不依赖子代理的自我报告：拿一份真实形状的 HAR 跑一遍 CLI，
 * 再按 schema 逐项断言输出。
 *
 * 运行方式说明：CLI 在 import 时就会执行 main()，所以这里用子进程跑它，
 * 并且刻意用 stdio:'inherit'（受限沙箱禁止管道 stdio，会报 spawn EPERM），
 * 结果文件则通过 --out 写到系统临时目录再读回来断言。
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'har2config.mjs');
const HAR = join(ROOT, 'test', 'fixtures', 'sample.har');

function runTool(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'kx-har-'));
  const out = join(dir, 'kx-config.json');
  const r = spawnSync(process.execPath, [TOOL, HAR, '--out', out].concat(extraArgs || []), {
    cwd: ROOT,
    stdio: 'inherit'      // 不要用管道：沙箱下会 EPERM
  });
  const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return { status: r.status, text, out, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('har2config: --help 能正常退出并给出用法', () => {
  const r = spawnSync(process.execPath, [TOOL, '--help'], { cwd: ROOT, stdio: 'inherit' });
  assert.equal(r.status, 0);
});

test('har2config: 无参数时报错退出（不静默失败）', () => {
  const r = spawnSync(process.execPath, [TOOL], { cwd: ROOT, stdio: 'inherit' });
  assert.equal(r.status, 1, '没有参数时应该以非 0 退出');
});

test('har2config: 真实形状的 HAR → 能用的 submit 模板', () => {
  const r = runTool();
  try {
    assert.equal(r.status, 0, 'CLI 应该成功退出');
    assert.ok(r.text.length > 0, '应该写出配置文件');
    const cfg = JSON.parse(r.text);

    // 接口识别
    assert.match(cfg.submit.url, /\/xk\/xkgo$/, '应识别出提交接口：' + cfg.submit.url);
    assert.equal(cfg.submit.method, 'POST');
    assert.equal(cfg.submit.contentType, 'form');

    // 「监测选课ID」的核心：两次不同课程的提交做差分 → 变化的参数被模板化
    // 注意：本 fixture 里 jxb_id 和 kch_id 都随课程变化，所以两个都会变成模板变量
    //（这是工具刻意的选择：变量化所有变化参数，代价是 targets 必须带上 kch）
    assert.match(cfg.submit.body, /jxb_id=\{\{id\}\}/, 'jxb_id 应被换成 {{id}}：' + cfg.submit.body);
    assert.match(cfg.submit.body, /kch_id=\{\{kch\}\}/, 'kch_id 也随课程变化，应被换成 {{kch}}：' + cfg.submit.body);
    // 不随课程变化的参数必须原样保留（这是「只换该换的」的证明）
    assert.match(cfg.submit.body, /xnm=2024/, '学期等上下文参数必须保留');
    assert.match(cfg.submit.body, /xqm=12/, 'xqm 必须保留');
    assert.match(cfg.submit.body, /op=save/, '固定操作参数必须保留');

    // 既然用了 {{kch}}，就必须把 kch 落到 targets 上，否则提交会发空值
    assert.ok(cfg.targets.length >= 2, '应该从差分结果生成目标：' + JSON.stringify(cfg.targets));
    const t0 = cfg.targets.find((t) => t.id === '2099000002');
    assert.ok(t0, '应生成 2099000002 这个目标');
    assert.equal(t0.kch, 'CS102', '用了 {{kch}} 就必须把课程号填进目标，否则会发出空值');
    assert.equal(cfg.targets.every((t) => t.kch), true, '每个自动生成的目标都要有 kch');
    for (const t of cfg.targets) assert.equal(t.enabled, true);

    // 请求头：保留有用头，去掉浏览器自己会带的
    const hk = Object.keys(cfg.submit.headers || {}).map((k) => k.toLowerCase());
    assert.ok(hk.includes('x-requested-with'), '要保留 X-Requested-With');
    for (const bad of ['cookie', 'content-length', 'host', 'origin', 'referer', 'sec-ch-ua']) {
      assert.ok(!hk.includes(bad), '不该写进配置的请求头：' + bad);
    }

    // schema 同构 + 安全默认
    assert.equal(cfg.enabled, false, 'enabled 必须是 false，避免生成后立刻发包');
    assert.ok(Array.isArray(cfg.targets));
    assert.ok(cfg.engine && cfg.session && cfg.notify, '输出必须与 defaults() 同构');
    assert.equal(cfg._report, undefined, '默认不该把 _report 写进配置');

    // 余量查询那一条也应该被识别
    assert.match(cfg.query.url, /queryJxbList/, '应识别出余量查询接口：' + cfg.query.url);
  } finally { r.cleanup(); }
});

test('har2config: 静态资源/登录页不会被当成提交接口', () => {
  const r = runTool();
  try {
    const cfg = JSON.parse(r.text);
    assert.ok(!/app\.js/.test(cfg.submit.url + cfg.query.url), '静态 js 不能入选');
    assert.ok(!/login/i.test(cfg.submit.url), '登录页不能当成提交接口');
  } finally { r.cleanup(); }
});

test('har2config: --pretty 时额外带 _report，且必须是给人工核对用的报告', () => {
  const r = runTool(['--pretty']);
  try {
    const cfg = JSON.parse(r.text);
    assert.equal(typeof cfg._report, 'string');
    assert.ok(cfg._report.length > 40, '报告不能是空壳');
    assert.match(cfg._report, /jxb_id|选课|确认/, '报告里应能看出要人工确认什么');
  } finally { r.cleanup(); }
});

test('har2config: --host 过滤其它站点的请求', () => {
  const r = runTool(['--host', 'other.example.com']);
  try {
    // 指定一个 HAR 里不存在的主机时，不应该识别出任何提交接口
    assert.equal(r.status, 0, '不该崩');
    if (r.text.trim()) {
      const cfg = JSON.parse(r.text);
      assert.equal(cfg.submit.url, '', '其它主机不该被误识别：' + cfg.submit.url);
    }
  } finally { r.cleanup(); }
});
