/* ============================================================
 * tools/collector.mjs —— 本地抓包收集器（零依赖，只用 node:http）
 * ------------------------------------------------------------
 * 为什么需要它：与其让你在 DevTools 里导出 HAR 再粘给我，不如让插件把
 * 抓到的请求自动推到这里，由它直接落盘到项目目录，我（或你）就能本地读文件。
 *
 * 用法：
 *   node tools/collector.mjs                 # 监听 http://127.0.0.1:8790
 *   node tools/collector.mjs --port 9000
 *   node tools/collector.mjs --fresh         # 启动时清空已有 logs/
 *
 * 落盘位置（默认都在项目的 logs/ 目录）：
 *   logs/kx-captures.jsonl   原始逐条记录（一行一条，便于 grep / 本地读）
 *   logs/kx-captures.har     同一批记录合成标准 HAR 1.2 —— har2config 可直接吃
 *   logs/kx-log.txt          插件推过来的运行日志（时间 + 级别 + 文本）
 *
 * 接口：
 *   POST /kx/captures   { source, host, pageUrl, entries:[...], logs:[...] }
 *   POST /kx/reset      清空
 *   GET  /kx/ping       健康检查（面板里「测试连接」用）
 *   GET  /kx/captures.har | /kx/captures.jsonl   直接下载
 *   GET  /              人看的简易状态页
 *
 * 安全：只监听 127.0.0.1；推送前会把 Cookie / Authorization / Set-Cookie
 *       这类凭据头抹掉（不是靠你手工删），其余内容原样保留。
 * ============================================================ */
import http from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 8790;
const MAX_BODY = 8 * 1024 * 1024;              // 单次推送上限 8MB

/* ---------------- 小工具 ---------------- */
const nowStr = () => new Date().toTimeString().slice(0, 8);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

/** HAR 转换与凭据抹除统一用插件那份共享库（src/lib/export.js），避免两边字段分叉 */
const EXPORT_JS = join(ROOT, 'src', 'lib', 'export.js');
function loadExportLib() {
  new Function(readFileSync(EXPORT_JS, 'utf8'))();
  const lib = globalThis.KXExport;
  if (!lib || typeof lib.captureToHarEntry !== 'function') {
    throw new Error('没能从 ' + EXPORT_JS + ' 取到 KXExport（请在项目里运行，别把本脚本复制出去）');
  }
  return lib;
}
const KXExport = loadExportLib();

/* ---------------- 收集器 ---------------- */
export function createCollector(options = {}) {
  const logDir = options.logDir || join(ROOT, 'logs');
  const jsonlPath = join(logDir, 'kx-captures.jsonl');
  const harPath = join(logDir, 'kx-captures.har');
  const logPath = join(logDir, 'kx-log.txt');

  const S = {
    jsonlPath, harPath, logPath, logDir,
    entries: [],          // 去重后的记录（保持接收顺序）
    seen: new Set(),
    logs: 0, received: 0, redacted: 0,
    startedAt: Date.now(), lastAt: 0, lastHost: '', lastPage: ''
  };

  mkdirSync(logDir, { recursive: true });
  if (options.fresh) {
    for (const p of [jsonlPath, harPath, logPath]) { if (existsSync(p)) rmSync(p, { force: true }); }
  }
  if (!existsSync(jsonlPath)) writeFileSync(jsonlPath, '', 'utf8');

  function dedupeKey(e) {
    return [e.method, e.url, e.reqBody || '', e.ts || 0].join('\u0001');
  }

  function writeHar() {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'kx-grabber collector', version: '0.1.0' },
        pages: [],
        entries: S.entries.map((e) => KXExport.captureToHarEntry(e)),
        _meta: { host: S.lastHost, pageUrl: S.lastPage, collectedAt: new Date().toISOString(), count: S.entries.length }
      }
    };
    writeFileSync(harPath, JSON.stringify(har, null, 2), 'utf8');
  }

  function ingest(payload) {
    const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
    const logs = Array.isArray(payload && payload.logs) ? payload.logs : [];
    let added = 0;
    const fresh = [];
    for (const e of entries) {
      if (!e || !e.url) continue;
      S.received++;
      const key = dedupeKey(e);
      if (S.seen.has(key)) continue;      // 插件重试或重复推送时不要写两遍
      S.seen.add(key);
      S.entries.push(e);
      fresh.push(e);
      added++;
    }
    if (fresh.length) {
      // 落盘前再抹一次凭据头（插件侧已抹；这里兜底，防止有人直接 POST 原始记录进来）
      const clean = fresh.map((e) => KXExport.redactCapture(e));
      appendFileSync(jsonlPath, clean.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      S.redacted += clean.filter((e) => e._redactedHeaders && e._redactedHeaders.length).length;
    }
    if (logs.length) {
      const lines = logs.map((l) => `[${new Date(Number(l.t) || Date.now()).toTimeString().slice(0, 8)}] ${String(l.level || 'info').toUpperCase().padEnd(4)} ${l.msg || ''}${l.extra ? ' :: ' + String(l.extra).slice(0, 300) : ''}`);
      appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');
      S.logs += logs.length;
    }
    S.lastAt = Date.now();
    if (payload && payload.host) S.lastHost = String(payload.host);
    if (payload && payload.pageUrl) S.lastPage = String(payload.pageUrl);
    if (fresh.length) writeHar();
    return { added, total: S.entries.length, logs: S.logs };
  }

  function reset() {
    S.entries = []; S.seen = new Set(); S.received = 0; S.logs = 0; S.redacted = 0;
    writeFileSync(jsonlPath, '', 'utf8');
    writeFileSync(harPath, JSON.stringify({ log: { version: '1.2', creator: { name: 'kx-grabber collector' }, pages: [], entries: [] } }, null, 2), 'utf8');
    writeFileSync(logPath, '', 'utf8');
  }

  const statusJson = () => ({
    ok: true,
    service: 'kx-collector',
    version: '0.1.0',
    entries: S.entries.length,
    received: S.received,
    logLines: S.logs,
    redactedEntries: S.redacted,
    lastAt: S.lastAt,
    lastHost: S.lastHost,
    files: { jsonl: jsonlPath, har: harPath, log: logPath },
    upsSince: S.startedAt
  });

  function page() {
    const recent = S.entries.slice(-25).reverse().map((e) => {
      let p = e.url;
      try { const u = new URL(e.url); p = u.pathname + (u.search ? u.search.slice(0, 60) : ''); } catch (err) { /* 原样 */ }
      const hasId = /\d{4,}/.test(e.reqBody || '') || /\d{4,}/.test(e.url || '');
      return `<tr><td>${esc(String(e.method || '').toUpperCase())}</td><td>${e.status >= 200 && e.status < 400 ? '' : 'color:#c00'}</td>
        <td class="m">${esc(p)}</td><td>${esc((e.reqBody || '').slice(0, 110))}</td><td>${hasId ? '★' : ''}</td></tr>`;
    }).join('');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>抓包收集器</title>
<style>body{font-family:system-ui,"Microsoft YaHei";max-width:1000px;margin:24px auto;line-height:1.6;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #e5e7eb;padding:5px;text-align:left;vertical-align:top}
.m{font-family:Consolas,monospace}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}
.big{font-size:22px;font-weight:700}</style></head><body>
<h2>本地抓包收集器</h2>
<p><span class="big">${S.entries.length}</span> 条记录已落盘（接收 ${S.received} 条，去重后）　日志 ${S.logs} 行　其中 ${S.redacted} 条含被抹掉的凭据头</p>
<p>最后推送：${S.lastAt ? nowStr() + '（' + esc(S.lastHost || '未知主机') + '）' : '还没有收到任何数据'}</p>
<p>文件：<br><code>${esc(S.jsonlPath)}</code><br><code>${esc(S.harPath)}</code><br><code>${esc(S.logPath)}</code></p>
<p><b>下一步：</b>在项目目录里跑
<code>node tools/har2config.mjs logs/kx-captures.har --host ${esc(S.lastHost || '你的域名')} --out kx-config.json --pretty</code>
（也可以直接吃 <code>logs/kx-captures.jsonl</code>）　　<a href="/kx/reset">清空</a></p>
<h3>最近 25 条</h3>
<table><tr><th>方法</th><th></th><th>路径</th><th>请求体（截断）</th><th>含数字ID?</th></tr>${recent || '<tr><td colspan=5>暂无</td></tr>'}</table>
</body></html>`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',   // 页面/扩展从公网上下文打 localhost 需要它
      'Cache-Control': 'no-store'
    };
    const json = (obj, code = 200) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, cors));
      res.end(body);
    };
    const html = (body, code = 200) => {
      res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, cors));
      res.end(body);
    };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (p === '/kx/ping') return json(statusJson());
    if (p === '/kx/reset') {
      reset();
      if (req.method === 'GET') {
        return html('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>已清空</title></head><body><p>已清空。</p><p><a href="/">返回</a></p></body></html>');
      }
      return json(statusJson());
    }
    if (p === '/kx/captures.jsonl') {
      const text = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf8') : '';
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/x-ndjson; charset=utf-8' }, cors));
      return res.end(text);
    }
    if (p === '/kx/captures.har') {
      const text = existsSync(harPath) ? readFileSync(harPath, 'utf8') : '{}';
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      return res.end(text);
    }

    if (p === '/kx/captures' && req.method === 'POST') {
      let size = 0, chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (e) { return json({ ok: false, error: 'JSON 解析失败：' + e.message }, 400); }
        const result = ingest(payload);
        console.log(`[${nowStr()}] +${result.added} 条（累计 ${result.total}）来自 ${payload && payload.host ? payload.host : '未知主机'}`);
        return json(Object.assign({ ok: true }, result, { files: { jsonl: jsonlPath, har: harPath } }));
      });
      req.on('error', () => json({ ok: false, error: '请求体读取失败' }, 400));
      return;
    }

    if (p === '/' && req.method === 'GET') return html(page());
    return json({ ok: false, error: '未知接口 ' + p }, 404);
  });

  server.collector = { state: S, ingest, reset, status: statusJson, files: { jsonlPath, harPath, logPath } };
  return server;
}

/* ---------------- 直接运行时启动 ---------------- */
function parseArgv(argv) {
  const out = { port: DEFAULT_PORT, fresh: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (argv[i] === '--fresh') out.fresh = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const argv = parseArgv(process.argv.slice(2));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (argv.help) {
    console.log('用法：node tools/collector.mjs [--port 8790] [--fresh]');
  } else {
    const server = createCollector(argv);
    server.listen(argv.port, '127.0.0.1', () => {
      const f = server.collector.files;
      console.log('本地抓包收集器已启动： http://127.0.0.1:' + argv.port);
      console.log('  落盘：' + f.jsonlPath);
      console.log('        ' + f.harPath);
      console.log('        ' + f.logPath);
      console.log('  下一步：插件面板 → 设置 → 「本地抓包落盘」填 http://127.0.0.1:' + argv.port + '/kx/captures 并勾选自动推送');
    });
  }
}
