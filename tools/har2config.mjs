#!/usr/bin/env node
/* ============================================================
 * tools/har2config.mjs —— HAR 抓包 → kx_state 配置（零依赖 ESM，Node 18+）
 * 用法：node tools/har2config.mjs <capture.har> [--out kx-config.json] [--host jwxt.example.edu.cn] [--pretty]
 * schema 真源 = src/lib/config.js 的 KX.defaults()：运行时读取并执行该文件，只在 defaults() 上填「能确定」的
 * 字段，其余保留默认值 → 输出与 defaults() 同构（config.js 以后加字段也不会漂移）。输出内容即 kx_state 的值：
 *   chrome.storage.local.set({ kx_state: <文件内容> })
 * 人类可读报告始终写到 stderr；--pretty 时另以 _report 字段写进 JSON（导入前删掉即可）。
 * Cookie/Referer/Origin/Host/Content-Length/:authority/sec-* 等由浏览器自动携带或在 fetch 里禁止手工设置，一律不写进配置。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- 启发式常量（按实际站点微调只改这里） ---------- */
const CONFIG_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'config.js');
const ID_KEY_RE = /(jxb_?id|^id$|xkkh|bjh|kch_?id|class_?id|course_?id|^kch$|^xh$|课号|教学班|学号)/i; const NAME_KEY_RE = /(kcmc|course_?name|^name$|title|jxbmc|bj_?mc|^mc$|课程名)/i; // 对齐 rules.js 的 ID_PATTERNS / NAME_PATTERNS
const REMAIN_KEY_RE = /(remain|rest|left|syrs|^yl$|available|surplus|balance|^num$|余量)/i; const CAP_KEY_RE = /(^zrs$|^rl$|^yxrs$|capacity|limit|selected|chosen)/i; // 余量列（对齐 rules.js）/ 容量-已选列（rules.js 会自动相减）
const KCH_KEY_RE = /(kch_?id|^kch$|course_?id|^kcid$)/i; const NOISE_KEY_RE = /(^_|ts$|time|timestamp|rand|random|nonce|token|sign|session|csrf|_t$|^ver$)/i; // 课程号类字段 → {{kch}} / 每次都变、不能当「选课ID」
const LOGIN_URL_RE = /(login|logon|sso|cas|auth)/i; const EXCLUDE_URL_RE = /(login|logon|logout|logoff|captcha|verifycode|checkcode|yzm|sso|oauth)|\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|html?)(\?|#|$)/i; // 登录页 → session.loginUrl / 直接排除的请求
const STATIC_MIME_RE = /^(image\/|font\/|audio\/|video\/|text\/css|application\/javascript|text\/javascript|application\/x-font)/i; const SUBMIT_PATH_RE = /(选课|退课|submit|save|select|choose|apply|enroll|baoming|operate|xkgo|\/add)/i; const SUBMIT_PREFIX_RE = /(\/xk|xuanke)/i; // 静态资源 / 强提交词 / 选课模块前缀（弱信号）
const QUERY_PATH_RE = /(query|list|search|jxb|\/kb|schedule|remain|syrs|yxrs|capacity|course|table|jbxx|plan|opendata)/i; const RESP_HIT_RE = /(选课成功|已选|已满|人数已满|余量|容量|可选|失败|重复)/;
const DROP_HEADER_RE = /^(content-length|host|cookie|:authority|:method|:path|:scheme|connection|accept-encoding|user-agent|origin|referer|accept-language|cache-control|pragma|dnt|te|upgrade-insecure-requests|priority|if-none-match|if-modified-since|sec-.*)$/i;
const SCORE_MIN = 3; // 分类阈值：低于此分归 other

/* ---------- 小工具 ---------- */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v); const tryJson = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };
const safeDecode = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } }; const scalar = (v) => (v == null || typeof v === 'object') ? '' : String(v);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const headerValue = (hs, name) => { const k = Object.keys(hs || {}).find((x) => x.toLowerCase() === name); return k ? hs[k] : ''; };
const kindOf = (ct) => { const s = String(ct || '').toLowerCase(); return (s.includes('application/json') || s.includes('+json')) ? 'json' : (s.includes('x-www-form-urlencoded') ? 'form' : 'raw'); }; // Content-Type → form/json/raw
const parseUrl = (s) => { try { return new URL(s); } catch (e) { return null; } };
/** 请求头过滤：丢掉 cookie/referer/origin/host/content-length/:authority/sec-* 等（fetch 里要么禁止设置、要么浏览器自动带）；raw 时保留原始 Content-Type */
function pickHeaders(harHeaders, keepContentType) {
  const headers = {}, dropped = []; for (const h of Array.isArray(harHeaders) ? harHeaders : []) {
    const name = String((h && h.name) || '').trim(), low = name.toLowerCase();
    if (!name) continue;
    if ((low === 'content-type' && !keepContentType) || DROP_HEADER_RE.test(low)) { dropped.push(name); continue; }
    headers[name] = String(h.value == null ? '' : h.value);
  }
  return { headers, dropped };
}
function rawBodyOf(req) {
  const pd = req.postData;
  if (!pd) return '';
  if (typeof pd.text === 'string') return pd.text;
  if (!Array.isArray(pd.params)) return '';
  return pd.params.map((p) => encodeURIComponent(String(p.name || '')) + '=' + encodeURIComponent(String(p.value == null ? '' : p.value))).join('&');
}
function formParams(body) {
  const map = {};
  for (const seg of String(body || '').split('&')) {
    if (!seg) continue;
    const eq = seg.indexOf('='), k = safeDecode(eq < 0 ? seg : seg.slice(0, eq));
    if (k && !(k in map)) map[k] = eq < 0 ? '' : safeDecode(seg.slice(eq + 1));
  }
  return map;
}
function jsonParams(body) { const map = {}, o = tryJson(body); if (isObj(o)) for (const k of Object.keys(o)) map[k] = scalar(o[k]); return map; }
/** 读取并执行 src/lib/config.js（IIFE → globalThis.KX），取 defaults() 作为 schema 真源 */
function loadDefaults() {
  new Function(fs.readFileSync(CONFIG_JS, 'utf8'))();
  const KX = globalThis.KX;
  if (!KX || typeof KX.defaults !== 'function') throw new Error('没能从 ' + CONFIG_JS + ' 取到 KX.defaults()');
  return KX.defaults();
}

/* ---------- HAR → 记录 ---------- */
function buildRecords(har, hostFilter) {
  const entries = (har && har.log && Array.isArray(har.log.entries)) ? har.log.entries : [];
  const records = [], skipped = [], hosts = new Set(), logins = [];
  entries.forEach((e, i) => {
    const req = (e && e.request) || {}, res = (e && e.response) || {}, url = String(req.url || ''), skip = (why) => skipped.push({ i, url, why }), u = parseUrl(url);
    if (!u) return skip('URL 非法');
    const host = u.hostname.toLowerCase(), method = String(req.method || 'GET').toUpperCase(), pname = safeDecode(u.pathname);
    if (hostFilter && host !== hostFilter) return skip('--host 过滤');
    if (method !== 'POST' && method !== 'GET') return skip('method ' + method);
    if (EXCLUDE_URL_RE.test(pname)) { // 登录/logout/验证码/静态资源直接排除；顺手记下登录页地址给 session.loginUrl
      if (LOGIN_URL_RE.test(pname) && !/captcha|verify|code|image|img/i.test(pname)) logins.push(u.origin + u.pathname);
      return skip('登录/验证码/静态资源');
    }
    const mime = String((res.content && res.content.mimeType) || '').toLowerCase();
    if (STATIC_MIME_RE.test(mime)) return skip('静态资源 ' + mime);
    const reqCt = headerValue(pickHeaders(req.headers, true).headers, 'content-type'), kind = kindOf(reqCt), picked = pickHeaders(req.headers, kind === 'raw'); // form/json 的 Content-Type 交给 buildBody
    const body = rawBodyOf(req), bodyParams = kind === 'json' ? jsonParams(body) : (kind === 'form' ? formParams(body) : {}), urlParams = {}, params = {};
    u.searchParams.forEach((v, k) => { if (!(k in urlParams)) urlParams[k] = v; });
    Object.assign(params, urlParams, bodyParams);
    let respText = typeof (res.content && res.content.text) === 'string' ? res.content.text : '';
    if (respText && res.content.encoding === 'base64') { try { respText = Buffer.from(respText, 'base64').toString('utf8'); } catch (err) { /* 原样 */ } }
    hosts.add(host); records.push({ i, url, host, origin: u.origin, method, path: pname, kind, reqCt, body, bodyParams, urlParams, params, headers: picked.headers, dropped: picked.dropped, status: Number(res.status) || 0, mime, respText: respText.slice(0, 200000), respTruncated: respText.length > 200000, shape: [method, pname, kind, Object.keys(params).sort().join('|')].join(' ') });
  });
  return { records, skipped, hosts: Array.from(hosts), logins };
}

/* ---------- 响应结构分析：找记录数组 / ID 列 / 余量列 ---------- */
function findRows(node, prefix, depth) {
  if (node == null || typeof node !== 'object' || depth > 4) return null;
  if (Array.isArray(node)) return { path: prefix, rows: node };
  const keys = Object.keys(node), prefer = ['rows', 'list', 'items', 'data', 'result', 'records', 'aaData', 'content'], p = (k) => (prefix ? prefix + '.' + k : k);
  for (const k of prefer.filter((x) => keys.includes(x)).concat(keys.filter((x) => !prefer.includes(x)))) {
    if (Array.isArray(node[k])) return { path: p(k), rows: node[k] };
    if (isObj(node[k])) { const deep = findRows(node[k], p(k), depth + 1); if (deep) return deep; }
  }
  return null;
}
/** 按列统计：样本数 / 数字占比 / 去重取值 —— 用于差分出「值有变化的数字列」（余量候选） */
function analyzeRows(rows) {
  const cols = {};
  for (const row of rows.slice(0, 300)) {
    if (!isObj(row)) continue;
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v !== null && typeof v === 'object') continue;
      const c = cols[k] || (cols[k] = { n: 0, num: 0, set: new Set() }), s = String(v);
      c.n++; if (/^-?\d+$/.test(s.trim())) c.num++; if (c.set.size < 12) c.set.add(s);
    }
  }
  for (const c of Object.values(cols)) { c.numRatio = c.n ? c.num / c.n : 0; c.values = Array.from(c.set); }
  return cols;
}
function analyzeResponse(rec) {
  const r = { isJson: false, rows: null, path: '', cols: null, idKeys: [], varyNumKeys: [], nameKey: '', note: '' };
  if (!rec.respText) { r.note = 'HAR 里没有响应体（content.text 缺失）'; return r; }
  const data = tryJson(rec.respText);
  if (data === undefined) { r.note = /^\s*</.test(rec.respText) ? '响应是 HTML 不是 JSON，余量只能靠 regex 解析' : '响应不是 JSON'; return r; }
  const found = findRows(data, '', 0);
  if (!found || !found.rows.length) { r.note = '响应是 JSON 但没找到记录数组'; return r; }
  r.isJson = true; r.rows = found.rows; r.path = found.path; r.cols = analyzeRows(found.rows);
  for (const k of Object.keys(r.cols)) {
    const c = r.cols[k];
    if (ID_KEY_RE.test(k) && c.numRatio >= 0.5) r.idKeys.push(k);                          // 像课号/教学班号且基本是数字
    else if (c.numRatio >= 0.8 && c.set.size > 1) r.varyNumKeys.push(k);                   // 值有变化的数字列
    if (NAME_KEY_RE.test(k)) r.nameKey = k;
  }
  const tier = (k) => (REMAIN_KEY_RE.test(k) ? 0 : (CAP_KEY_RE.test(k) ? 2 : 1)); // 明确的余量列优先于容量/已选列
  r.varyNumKeys.sort((a, b) => tier(a) - tier(b));
  return r;
}

/* ---------- 分类打分 ----------
 * submit（选课提交）候选：
 *   +3 URL 路径命中 选课/submit/save/select/operate 等提交类词（URL 只有 /xk 这类模块前缀时 +1）
 *   +2 method=POST；+1..3 body 里值形如纯数字（≥4 位，候选选课ID）的参数，每个 +1，最多 +3
 *   +1..2 参数键名命中 jxb_id/xkkh/kch_id 等 ID 词，最多 +2；+2 响应文本命中「成功/已满/失败/重复」
 * query（余量/课表查询）候选：
 *   +3 URL 路径命中 query/list/search/jxb/kb/schedule 等查询类词；+1 method=GET
 *   +4 响应是 JSON 且能找到「记录数组」；+2 数组里同时有 ID 列与「值有变化的数字列」（差分证据=余量），只有后者 +1
 * 判定：两类都 ≥ SCORE_MIN 时，响应像「记录列表」判 query，否则判 submit；都不到则 other。
 * 多请求差分的结果不参与分类，只用于候选分组排序（见下）。
 * ---------------------------------- */
function scoreRecord(rec) {
  const why = [], resp = rec.resp || {};
  let submit = 0, query = 0;
  if (SUBMIT_PATH_RE.test(rec.path)) { submit += 3; why.push('路径命中提交类词'); }
  else if (SUBMIT_PREFIX_RE.test(rec.path)) { submit += 1; why.push('路径含选课模块前缀'); }
  if (QUERY_PATH_RE.test(rec.path)) { query += 3; why.push('路径命中查询类词'); }
  if (rec.method === 'POST') { submit += 2; why.push('POST'); } else { query += 1; why.push('GET'); }
  const digits = Object.keys(rec.params).filter((k) => /^\d{4,}$/.test(String(rec.params[k]).trim()) && !NOISE_KEY_RE.test(k));
  if (digits.length) { submit += Math.min(3, digits.length); why.push(digits.length + ' 个长数字参数'); }
  const idish = Object.keys(rec.params).filter((k) => ID_KEY_RE.test(k));
  if (idish.length) { submit += Math.min(2, idish.length); why.push('参数键像 ID：' + idish.slice(0, 3).join('/')); }
  if (resp.rows && resp.rows.length) {
    query += 4; why.push('响应是可解析记录数组(' + resp.rows.length + ' 行)');
    if (resp.idKeys.length && resp.varyNumKeys.length) { query += 2; why.push('数组含 ID 列 + 变化数字列'); }
    else if (resp.varyNumKeys.length) { query += 1; why.push('数组含变化数字列'); }
  }
  if (resp.text && RESP_HIT_RE.test(resp.text.slice(0, 5000))) { submit += 2; why.push('响应命中结果词'); }
  const cls = (submit >= SCORE_MIN && query >= SCORE_MIN) ? (resp.rows && resp.rows.length ? 'query' : 'submit') : (submit >= SCORE_MIN ? 'submit' : (query >= SCORE_MIN ? 'query' : 'other'));
  return { submit, query, cls, why };
}

/* ---------- 多请求差分：找「选课ID字段」----------
 * 把「结构相同」（method + 路径 + 编码类型 + 参数键集合全一致）的同类请求放一起对比，找出
 * 「键相同、值不同」的键 —— 这些才随每门课变化，其中最像 ID 的那个就是要监测的「选课ID」；
 * 时间戳/随机数/令牌类键扣分剔除。同类请求里结构不同（少一个键）的按「方法+路径」再差一次兜底。
 * ------------------------------------------------ */
function scoreIdKey(key, values) {
  let s = 0;
  const allDigit = values.every((v) => /^\d+$/.test(String(v).trim()));
  if (allDigit) s += 2; if (allDigit && values.every((v) => String(v).length >= 4)) s += 2; // 纯数字；长数字串（教学班号/学号）
  if (ID_KEY_RE.test(key)) s += 2;                                     // 键名像 jxb_id / xkkh / kch_id
  if (new Set(values).size === values.length) s += 1;                  // 每条请求都不同
  if (NOISE_KEY_RE.test(key)) s -= 4; if (values.some((v) => /^1\d{12}$/.test(String(v)))) s -= 3; if (values.every((v) => String(v).length <= 2)) s -= 1; // 噪音键 / 时间戳 / 过短
  return s;
}
function diffKeys(shape, list) {
  const out = [], keys = list.length >= 2 ? Object.keys(list[0].params) : [];
  for (const k of keys) {
    if (!list.every((r) => r.params[k] !== undefined)) continue;       // 该键不是每条请求都有
    const values = list.map((r) => String(r.params[k]));
    if (new Set(values).size < 2) continue;                            // 值完全相同 → 固定参数，不是 ID
    out.push({ key: k, shape, values, recs: list, score: scoreIdKey(k, values) });
  }
  return out;
}
function analyzeClass(recs) {
  const groups = new Map(), byPath = new Map(), best = new Map();
  let cands = []; for (const r of recs) {
    if (!groups.has(r.shape)) groups.set(r.shape, []);
    groups.get(r.shape).push(r);
    const pk = r.method + ' ' + r.path; if (!byPath.has(pk)) byPath.set(pk, []); byPath.get(pk).push(r);
  }
  for (const [shape, list] of groups) cands = cands.concat(diffKeys(shape, list));
  for (const [pk, list] of byPath) if (list.length >= 2 && new Set(list.map((r) => r.shape)).size > 1) for (const c of diffKeys(pk, list)) cands.push(Object.assign(c, { score: c.score - 1 })); // 结构不一致时的兜底，降权
  for (const c of cands) { const prev = best.get(c.key); if (!prev || c.score > prev.score || (c.score === prev.score && c.recs.length > prev.recs.length)) best.set(c.key, c); } // 同一键只留最优
  return Array.from(best.values()).sort((a, b) => b.score - a.score || b.recs.length - a.recs.length);
}
/** 只有单条抓包时的兜底：键名像 ID、值是数字 → 低置信度候选 */
function fallbackIdKeys(recs) {
  const best = new Map();
  for (const r of recs) for (const k of Object.keys(r.params)) {
    if (NOISE_KEY_RE.test(k) || !ID_KEY_RE.test(k) || !/^\d{3,}$/.test(String(r.params[k]).trim())) continue;
    if (!best.has(k)) best.set(k, { key: k, shape: r.shape, values: [String(r.params[k])], recs: [r], score: 1, low: true });
  }
  return Array.from(best.values());
}

/* ---------- 模板化：把探测到的 id 值换成 {{id}} ---------- */
function replaceParam(seg, key, ph) { const eq = seg.indexOf('='); return (eq >= 0 && safeDecode(seg.slice(0, eq)) === key) ? seg.slice(0, eq + 1) + ph : seg; }
function replaceUrlParam(url, key, ph) {
  const i = url.indexOf('?');
  return i < 0 ? url : url.slice(0, i) + '?' + url.slice(i + 1).split('#')[0].split('&').map((seg) => replaceParam(seg, key, ph)).join('&');
}
/** form 只换值、不动其它参数（避免二次编码破坏固定参数）；json 按原类型决定是否补引号 */
function templatize(rec, key, ph) {
  const out = { url: rec.url, body: rec.body, where: '' }; if (rec.bodyParams[key] !== undefined) {
    if (rec.kind === 'form') { out.body = rec.body.split('&').map((seg) => replaceParam(seg, key, ph)).join('&'); out.where = 'body(form)'; }
    else if (rec.kind === 'json') {
      const raw = String(rec.bodyParams[key]), re = new RegExp('("' + escapeRe(key) + '"\\s*:\\s*)("?' + escapeRe(raw) + '"?)(\\s*[,}])');
      if (re.test(rec.body)) { out.body = rec.body.replace(re, '$1' + (/^-?\d+(\.\d+)?$/.test(raw) ? ph : '"' + ph + '"') + '$3'); out.where = 'body(json)'; }
      else if (rec.body.includes(raw)) { out.body = rec.body.split(raw).join(ph); out.where = 'body(json 宽松替换)'; }
    } else if (rec.body.includes(String(rec.bodyParams[key]))) { out.body = rec.body.split(String(rec.bodyParams[key])).join(ph); out.where = 'body(raw)'; }
  }
  if (!out.where && rec.urlParams[key] !== undefined) { out.url = replaceUrlParam(rec.url, key, ph); out.where = 'url'; }
  return out;
}
/** 找课程号类字段（≠ 选课ID，可作为 target.kch） */
function kchOf(rec, idKey) {
  for (const k of Object.keys(rec.params)) if (k !== idKey && !NOISE_KEY_RE.test(k) && KCH_KEY_RE.test(k) && String(rec.params[k]).trim()) return String(rec.params[k]).trim();
  return '';
}
/** 查询响应 → query.parse（type 取值遵循 rules.js parseList：json | regex | none） */
function parseFor(rec) {
  const r = rec.resp;
  if (r.isJson && r.rows) return { type: 'json', path: r.path || '', idField: r.idKeys[0] || '', remainField: r.varyNumKeys[0] || '', nameField: r.nameKey || '', regex: '', idGroup: 1, remainGroup: 2 };
  if (r.note.includes('HTML')) return { type: 'regex', path: '', idField: '', remainField: '', nameField: '', regex: '', idGroup: 1, remainGroup: 2 };
  return null; // 响应体缺失 → 保留 defaults() 里的 parse
}

/* ---------- 组装 kx_state（与 defaults() 同构，只改能确定的字段） ---------- */
function buildState(defs, ctx) {
  const st = defs, s = ctx.submitChosen, q = ctx.queryChosen;
  st.enabled = false; // 保持关闭：确认无误前不允许真的发包
  st.sites = ctx.sites.length ? [ctx.sites[0]] : [];
  if (ctx.loginUrl && st.session && !st.session.loginUrl) st.session.loginUrl = ctx.loginUrl; // session.loginUrl：抓到的登录页地址
  // submit.rules / session 其余字段保留 defaults()：样本不足，需人工对照真实响应核改
  if (s) { st.submit.url = s.url; st.submit.method = s.method; st.submit.contentType = s.kind; st.submit.headers = s.headers; st.submit.body = ctx.submitBody; }
  if (q) {
    st.query.url = q.tpl.url; st.query.method = q.method; st.query.contentType = q.kind; st.query.headers = q.headers; st.query.body = q.tpl.body;
    if (q.parse) Object.assign(st.query.parse, q.parse);
  }
  st.targets = ctx.targets;
  return st;
}

/* ---------- 报告（人类可读，走 stderr） ---------- */
function buildReport(ctx) {
  const why = {}, s = ctx.submitChosen, q = ctx.queryChosen, gmap = new Map();
  for (const x of ctx.skipped) why[x.why] = (why[x.why] || 0) + 1;  const cols = (x) => { const c = (x.resp && x.resp.cols) || {}, ks = Object.keys(c); return ks.length ? ks.slice(0, 12).map((k) => `${k}[数字比${c[k].numRatio.toFixed(2)}/${c[k].values.length}取值]`).join(' ') : '（无列信息）'; };
  for (const r of ctx.records) { const g = gmap.get(r.shape) || { n: 0, r, submit: 0, query: 0 }; g.n++; g.submit = Math.max(g.submit, r.submit); g.query = Math.max(g.query, r.query); gmap.set(r.shape, g); } // 排行按「结构相同」合并
  const rank = Array.from(gmap.values()).sort((a, b) => Math.max(b.submit, b.query) - Math.max(a.submit, a.query)).slice(0, 10)
    .map((g, n) => `  ${String(n + 1).padStart(2)}. [${g.r.cls}] submit=${g.submit} query=${g.query}  ${g.r.method} ${g.r.path}${g.n > 1 ? '  ×' + g.n + ' 条同结构' : ''}\n      理由：${g.r.why.join('；') || '无'}\n      响应：${g.r.resp.rows ? 'JSON 记录数组 ' + g.r.resp.rows.length + ' 行（path=' + (g.r.resp.path || '根') + '）' : (g.r.resp.note || '—')}｜HTTP ${g.r.status}`).join('\n');
  const ids = ctx.idCands.slice(0, 8).map((c) => `  ${c.key}  分 ${c.score}${c.low ? '（单条抓包兜底，低置信度）' : ''}  样本 ${c.recs.length} 条 / ${new Set(c.values).size} 个取值\n      取值：${c.values.slice(0, 8).join(', ')}${c.values.length > 8 ? ' ...' : ''}\n      每条请求：${c.recs.slice(0, 5).map((r) => '#' + r.i + '=' + r.params[c.key]).join('  ')}`).join('\n');
  const submitBlock = s ? `[选课提交候选 submit] ${s.method} ${s.url}\n  contentType : ${s.kind}（请求头原始 Content-Type: ${s.reqCt || '—'}）\n  body 模板   : ${ctx.submitBody || '（空，原请求没有 body）'}\n  写入配置的头: ${Object.keys(s.headers).join(', ') || '无'}（会被原样发出，仅限这类自定义头；引擎还会自动补 X-Requested-With）\n  已过滤的头  : ${s.dropped.join(', ') || '无'}（Cookie/Referer/Origin/Host/Content-Length 等由浏览器自动携带，或在 fetch 里属于禁止手工设置的请求头，不必手填）\n  模板化位置  : ${ctx.submitTemplateWhere || '未定位（需人工填写）'}`
    : '[选课提交候选] 没找到可信的提交接口 —— 请确认 HAR 里包含真实点「选课」的那次请求。';
  const queryBlock = q ? `[余量查询候选 query] ${q.method} ${q.tpl.url}   contentType=${q.kind}   ${ctx.queryTemplateWhere || '未模板化（多为全量查询）'}\n  请求体模板  : ${q.tpl.body || '（空）'}\n  parse       : ${JSON.stringify(q.parse)}\n  响应结构    : ${q.resp.rows ? q.resp.rows.length + ' 行，path=' + (q.resp.path || '根') : (q.resp.note || '—')}\n  列预览      : ${cols(q)}   ｜   变化的数字列: ${q.resp.varyNumKeys.join(', ') || '无'}  ← remainField 候选\n  ID 类列     : ${q.resp.idKeys.join(', ') || '无'}`
    : '[余量查询候选] 没找到可信的余量查询接口 —— 可能需要重新抓一次「查余量/课表」的请求。';
  return `==================== har2config 分析报告 ====================
HAR: ${ctx.harPath}   ｜   --host: ${ctx.host || '（未指定，分析全部主机）'}   ｜   站点: ${ctx.hosts.join(', ') || '（无）'}   ｜   SCORE_MIN=${SCORE_MIN}
entries: 共 ${ctx.total} 条 → 分析 ${ctx.records.length} 条，跳过 ${ctx.skipped.length} 条（${Object.keys(why).map((k) => k + '×' + why[k]).join('，') || '无'}）；分类 submit ${ctx.byClass.submit.length} / query ${ctx.byClass.query.length} / other ${ctx.byClass.other.length}
[候选接口排行]（分数仅用于排序；同分优先样本多的分组）
${rank || '  （无）'}
${submitBlock}
[候选 idField —— 多请求差分：键相同、值不同]（同一类里结构相同的请求互相比较得出）
${ids || '  没找到「键相同、值不同」的数字键：提交请求可能只有 1 条，或 ID 被加密/混淆。'}
${ctx.idField ? `  → 建议 target.id 用「${ctx.idField}」（已模板化为 {{id}}）` : '  → 无法自动确定 target.id，需人工填写'}
${queryBlock}
[可疑点]
${ctx.suspicions.map((x) => '  - ' + x).join('\n')}
[下一步：必须在扩展面板里人工确认/修改的字段]
${ctx.checklist.filter(Boolean).map((x, n) => `  ${n + 1}. ${x}`).join('\n')}
[导入方式] 文件内容就是 kx_state 的值本身：chrome.storage.local.set({ kx_state: JSON.parse(文件内容) })\n  若用了 --pretty，JSON 里多出的 "_report" 字段请在导入前删除（它不参与引擎逻辑）。`;
}

/* ---------- 主分析流程 ---------- */
function analyze(har, args, harPath) {
  const built = buildRecords(har, args.host), records = built.records, pick = (f) => records.filter(f), loginHint = built.logins[0] || '';
  for (const r of records) { r.resp = analyzeResponse(r); Object.assign(r, scoreRecord(r)); }
  const byClass = { submit: pick((r) => r.cls === 'submit'), query: pick((r) => r.cls === 'query'), other: pick((r) => r.cls === 'other') };
  // 差分：提交类里找「选课ID」；查询类里的 ID 做交叉验证
  let idCands = analyzeClass(byClass.submit);
  if (!idCands.length) idCands = fallbackIdKeys(byClass.submit);
  const queryIdCands = analyzeClass(byClass.query);
  for (const r of records) r.hasId = idCands.concat(queryIdCands).some((c) => c.score >= 3 && c.recs.includes(r));
  const idField = (idCands[0] && (idCands[0].score >= 3 || idCands[0].low)) ? idCands[0].key : ''; // low = 单条抓包的兜底推断，报告里会标注低置信度
  const groupOf = (list) => { const m = new Map(); for (const r of list) { if (!m.has(r.shape)) m.set(r.shape, []); m.get(r.shape).push(r); } return Array.from(m.values()); };
  const gScore = (list, key) => Math.max.apply(null, list.map((r) => r[key] || 0)) + Math.min(3, list.length - 1) * 0.5 + (list.some((r) => r.hasId) ? 3 : 0); // 组内最高分 + 样本奖励 + 差分出 ID 的奖励
  const rank = (gs, key) => gs.slice().sort((a, b) => gScore(b, key) - gScore(a, key));
  // 模板源：优先「差分出 ID 的那组样本」，组内取参数最全的一条（保留最多固定参数）
  const submitGroup = rank(groupOf(byClass.submit), 'submit')[0] || null, submitList = (idField && idCands[0].recs.length > 1) ? idCands[0].recs : submitGroup;
  const submitChosen = submitList ? submitList.slice().sort((a, b) => Object.keys(b.params).length - Object.keys(a.params).length)[0] : null;
  const queryChosen = rank(groupOf(byClass.query), 'query').map((g) => g.slice().sort((a, b) => (b.resp.rows ? b.resp.rows.length : 0) - (a.resp.rows ? a.resp.rows.length : 0))[0])[0] || null;
  const kchField = ((idField && idCands.find((c) => c.key !== idField && c.score >= 3 && KCH_KEY_RE.test(c.key))) || {}).key || ''; // 课程号键 → {{kch}}
  const queryId = (queryIdCands.find((c) => c.score >= 3 && !c.low) || {}).key || '';
  // 模板化：探测到的 id → {{id}}（{{kch}} 也差分出来就一并换）；查询请求只在确实差分出可信 ID 时才模板化
  // 除 {{id}}/{{kch}} 外，其它「随课程变化」的键也要一起模板化 —— 否则它们会保留第一条抓包的固定值，
  // 抢别的教学班时参数就错了（正方系统的 xkkh 就是典型：每门课一个值）。
  const extraVary = idCands.filter((c) => c.score >= 3 && c.key !== idField && c.key !== kchField).map((c) => c.key);
  let submitBody = '', submitTemplateWhere = '', queryTemplateWhere = '';
  if (submitChosen) {
    const t = idField ? templatize(submitChosen, idField, '{{id}}') : { url: submitChosen.url, body: submitChosen.body, where: '' };
    const t2 = kchField ? templatize(Object.assign({}, submitChosen, { body: t.body }), kchField, '{{kch}}') : null;
    submitBody = t2 ? t2.body : t.body;
    const wheres = [t.where && t.where + '={{id}}', t2 && t2.where + '={{kch}}'].filter(Boolean);
    for (const key of extraVary) {
      const tn = templatize(Object.assign({}, submitChosen, { body: submitBody }), key, '{{' + key + '}}');
      if (tn.where) { submitBody = tn.body; wheres.push(key + '={{' + key + '}}'); }
    }
    submitTemplateWhere = wheres.join('  ');
    if (idField && !t.where) submitChosen.url = t.url; // body 里没有 → 退回改 URL
  }
  if (queryChosen) { const t = queryId ? templatize(queryChosen, queryId, '{{id}}') : { url: queryChosen.url, body: queryChosen.body, where: '' }; queryChosen.tpl = t; queryTemplateWhere = t.where ? t.where + ' 的 ' + queryId + '→{{id}}' : ''; queryChosen.parse = parseFor(queryChosen); }
  // targets：来自差分出的 id 值（去重），label / kch 尽量回填，额外变化键冻结进每个 target 的 vars
  const nameById = {}, targets = [], seen = new Set();
  if (queryChosen && queryChosen.resp.rows && queryChosen.resp.idKeys[0] && queryChosen.resp.nameKey) { const ik = queryChosen.resp.idKeys[0], nk = queryChosen.resp.nameKey; for (const row of queryChosen.resp.rows.slice(0, 500)) if (isObj(row)) nameById[String(row[ik])] = String(row[nk] || ''); }
  if (submitChosen && idField) for (const r of (idCands[0].recs.length > 1 ? idCands[0].recs : [submitChosen])) {
    const id = String(r.params[idField] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const vars = {};
    for (const key of extraVary) { const v = r.params[key]; if (v !== undefined && v !== null && String(v) !== '') vars[key] = String(v); }
    const t = { id, label: nameById[id] || '', kch: kchField ? String(r.params[kchField] || '') : kchOf(r, idField), enabled: true, priority: targets.length + 1 };
    if (Object.keys(vars).length) t.vars = vars;   // {{xkkh}} 之类由这里提供，见 README「按目标变化的参数」
    targets.push(t);
  }
  const sites = []; // 站点白名单：优先提交接口所在主机
  for (const r of [submitChosen, queryChosen]) if (r && r.host && sites.indexOf(r.host) === -1) sites.push(r.host);
  if (!sites.length && built.hosts.length) sites.push(built.hosts[0]);
  // 可疑点
  const q = queryChosen, susp = [], S = (cond, msg) => { if (cond) susp.push(msg); }, tok = (r) => r && Object.keys(r.headers).some((h) => /token|csrf/i.test(h));
  S(!records.length, '过滤后没有可分析的请求：确认 HAR 里包含 XHR/fetch（不是只勾了 Doc/JS）。'); S(submitChosen && !idField, '没能差分出选课ID：请多抓几次不同课程的选课请求（同一会话连续选 2~3 门）后重跑。');
  S(idField && idCands[0].low, 'idField 是单条抓包的兜底推断，置信度低，务必人工核对。'); S(tok(submitChosen), '抓到了 token/csrf 类请求头：会话级令牌可能很快过期，写死会导致提交失败。');
  S(submitChosen && !tok(submitChosen), '请求头里没有 x-csrf-token：若站点必须带 CSRF 令牌，请在面板手工补。'); S(records.some((r) => r.respTruncated), '有响应体超过 200KB 被截断，字段分析可能不完整。');
  S(!records.some((r) => r.respText) && records.some((r) => r.cls !== 'other'), '响应体在 HAR 里缺失（content.text 为空），字段只能靠键名猜 —— 导出 HAR 时请选 with content。');
  S(q && q.parse && q.parse.type === 'regex', '余量响应是 HTML：query.parse.type 已设为 regex，但 regex 必须由你手写。');
  S(q && q.parse && q.parse.type === 'json' && !q.parse.remainField, '没找到余量类数字列：余量可能是「容量-已选」两列（如 zrs/yxrs），rules.js 会在 remainField 为空时自动相减，但请核对列名。');
  S(q && !queryTemplateWhere && q.method === 'POST', '查询请求里没有随课程变化的 ID 参数 → 多半是「全量查询」，一次就能拿到所有课余量，更适合监控。');
  S(q && queryTemplateWhere, 'query.url/body 里带了 {{id}}：请确认引擎对 query 也做模板渲染（不渲染就改成全量查询或去掉 {{id}}）。');
  S(submitChosen && submitChosen.kind === 'raw', '提交请求是 raw 编码（可能是 multipart/自定义），body 模板需要人工整理。'); S(!Object.keys(nameById).length, '没能从余量/课表响应关联出课程名，targets[].label 为空。'); S(q && !queryTemplateWhere && Object.keys(q.params).some((k) => ID_KEY_RE.test(k) || KCH_KEY_RE.test(k)), 'query 请求里带着写死的课号/教学班号参数（只抓到 1 条无法差分）：确认它是「全量查询」，否则请把它换成 {{id}}/{{kch}}，不然只会反复查同一门课。');
  const otherVary = extraVary;
  S(otherVary.length > 0, '提交参数里还有其它「随课程变化」的键（' + otherVary.join('/') + '）：已自动模板化成 {{' + otherVary.join('}}/{{') + '}} 并写进每个 target 的 vars，请核对取值对不对（原始值来自你的抓包）。');
  // 必须人工确认的字段
  const checklist = [
    `sites：当前为 ${JSON.stringify(sites)}，确认它就是选课系统站点（引擎只在该主机生效）。`, 'enabled / worker.autoOpen：保持 enabled=false 先手工试跑；worker.url 留空 = 用 sites[0] 的 https 首页。',
    submitChosen ? `submit.url（${submitChosen.url}）与 submit.body 模板：确认 {{id}} 落在正确参数上（${submitTemplateWhere || '未定位'}），固定参数（xnm/xqm/xkkh 等）是否都要保留。` : '手工填写 submit.url / method / contentType / body（没找到可信提交接口）。',
    'submit.rules 六条文案仍是 defaults 的通用正则：对照本次真实响应把「成功/已满/重复/验证码/掉登录/未开放」的实际文案填准（type 可用 regex|contains|notContains|status|empty|always）。',
    idField ? `targets：已按差分结果生成 ${targets.length} 条，idField=${idField}；label 需你补成课程名，kch 为 ${targets[0] && targets[0].kch ? '“' + targets[0].kch + '”' : '空（需核对 {{kch}} 是否必要）'}${extraVary.length ? `；vars 里冻结了 ${extraVary.join('/')}（每门课各不相同，来自抓包原始值）` : ''}。` : 'targets：差分失败，手工填写要监测的选课ID（元素形如 { id, label, kch, vars, enabled, priority }）。',
    kchField ? `⚠ {{kch}} 已写进 submit.body（来自差异字段 ${kchField}）：手工新增/编辑 target 时必须填 kch，否则渲染出来是空值、提交会被后端判为参数错误或随机选课；上面自动生成的 ${targets.length} 条已带上 kch，别删。` : '', queryChosen ? 'query.enabled 默认 false：先在浏览器控制台手工 fetch 一次 query.url 确认结构再开启；query.parse 的 path/idField/remainField/nameField 要逐字段核对。' : '如需余量监控，请重新抓一次「查询余量/选课列表」的请求再跑本工具。',
    'query.parse.idField 的取值必须与 targets[].id 完全一致（类型/前导零/空格），否则引擎对不上号；submit.headers 里若有 token/csrf 也要确认是否长期有效。',
    `session：loginUrl ${loginHint ? '已填 “' + loginHint + '”' : '没抓到登录页地址，需手工填'}；keepAlive.enabled 仍为 false（若系统是「空闲超时」而非硬超时，可打开它并核对 keepAlive.url/method）。`,
    'engine 参数（intervalMs/jitterPct/maxReqPerMinute/minGapMs）与「盲发」模式：query.enabled=false 时引擎按间隔直接 POST submit、用 full 规则判满；间隔按学校限流强度调，别一上来就压到几百毫秒。'
  ];
  const ctx = {
    harPath, host: args.host || '', total: (har && har.log && har.log.entries) ? har.log.entries.length : 0, loginUrl: loginHint,
    records, skipped: built.skipped, hosts: built.hosts, byClass, idCands, queryIdCands, idField, submitChosen, submitBody,
    submitTemplateWhere, queryChosen, queryTemplateWhere, targets, sites, suspicions: susp, checklist
  };
  ctx.report = buildReport(ctx);
  return ctx;
}

/* ---------- CLI ---------- */
function printUsage() {
  console.error(`用法：node tools/har2config.mjs <capture.har> [--out kx-config.json] [--host jwxt.example.edu.cn] [--pretty]
  <capture.har> 必填（DevTools → Network → 右键 → Save all as HAR with content）；--out <file> 写入文件（省略则打印到 stdout）；--host <host> 只分析该主机（多站点 HAR 时用）；--pretty 缩进输出并把报告以 _report 写进 JSON
报告：人类可读报告始终写到 stderr（--pretty 时同时写进 JSON 的 _report，导入前删除即可）；导入：chrome.storage.local.set({ kx_state: JSON.parse(文件内容) })`);
}
function parseArgs(argv) {
  const a = { har: '', out: '', host: '', pretty: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i], val = () => { const v = argv[++i] || ''; if (!v) a.errors.push(t + ' 缺少参数值'); return v; };
    if (t === '--pretty') a.pretty = true;
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '--out') a.out = val(); else if (t.startsWith('--out=')) a.out = t.slice(6);
    else if (t === '--host') a.host = val(); else if (t.startsWith('--host=')) a.host = t.slice(7);
    else if (t.startsWith('-')) a.errors.push('未知参数 ' + t);
    else if (!a.har) a.har = t; else a.errors.push('多余的位置参数 ' + t);
  }
  a.host = a.host.toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].replace(/:\d+$/, '');
  return a;
}
/* ---------- 输入格式适配 ----------
 * 除了标准 HAR，还直接吃两类「插件收集器」产物，这样整条链路不用你手工转换：
 *   · logs/kx-captures.har   收集器合成的 HAR（本来就能吃）
 *   · logs/kx-captures.jsonl 逐行一条的原始抓包记录（每行含 method/url/reqBody/resp…）
 *   · 面板「导出抓包 HAR」下载的文件（同上）
 * 做法：把原始记录先转成 HAR entry（用插件自己的 src/lib/export.js），后面流程完全不变。
 */
function loadExportLib() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'export.js');
  new Function(fs.readFileSync(p, 'utf8'))();
  const lib = globalThis.KXExport;
  if (!lib || typeof lib.captureToHarEntry !== 'function') throw new Error('没能从 ' + p + ' 取到 KXExport');
  return lib;
}

function wrapEntries(entries, meta) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'kx-grabber har2config adapter', version: '0.1.0' },
      pages: [],
      entries: entries,
      _meta: meta || {}
    }
  };
}

/** 把各种输入统一成 HAR 形状 */
function readInput(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const isJsonl = /\.(jsonl|ndjson)$/i.test(filePath);
  const looksLikeHar = (obj) => obj && obj.log && Array.isArray(obj.log.entries);
  const isCapture = (o) => o && typeof o === 'object' && typeof o.url === 'string' && typeof o.method === 'string';
  const isLogLine = (o) => o && typeof o === 'object' && !o.url && (o.msg !== undefined || o.level !== undefined);

  const lib = loadExportLib();
  const toEntries = (caps) => wrapEntries(caps.filter(isCapture).map(lib.captureToHarEntry),
    { source: path.basename(filePath), convertedFrom: 'kx-capture', count: caps.length });

  if (!isJsonl) {
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { obj = undefined; }
    if (obj !== undefined) {
      if (looksLikeHar(obj)) return { har: obj, format: 'HAR' };
      if (Array.isArray(obj)) return { har: toEntries(obj), format: '抓包记录数组' };
      if (Array.isArray(obj.entries)) {
        const caps = obj.entries.filter(isCapture);
        return { har: toEntries(caps), format: '抓包记录（面板导出/收集器推送体）' + (obj.logs ? '，含日志 ' + obj.logs.length + ' 条（已忽略）' : '') };
      }
      return { error: 'JSON 结构不认识：既不是 HAR(log.entries)，也没有 entries 数组' };
    }
  }

  // JSONL：逐行解析，挑出抓包行（日志行忽略）
  const caps = [], logs = [];
  let bad = 0;
  raw.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    let o;
    try { o = JSON.parse(s); } catch (e) { bad++; return; }
    if (isCapture(o)) caps.push(o);
    else if (isLogLine(o)) logs.push(o);
  });
  if (!caps.length) return { error: '这个 JSONL 里没有一条抓包记录（共 ' + bad + ' 行解析失败）' };
  return { har: toEntries(caps), format: '抓包 JSONL' + (logs.length ? '（另含日志 ' + logs.length + ' 行，已忽略）' : '') + (bad ? '，' + bad + ' 行无法解析' : '') };
}

function main() {
  const args = parseArgs(process.argv.slice(2)), die = (msg) => { console.error('错误：' + msg); printUsage(); process.exitCode = 1; };
  if (args.help) return printUsage();
  if (args.errors.length) return die(args.errors.join('；'));
  if (!args.har) return die('必须给出抓包文件路径（HAR / 收集器导出的 .har / logs/kx-captures.jsonl 都行）');
  const harPath = path.resolve(args.har); let har, defs, input;
  try { input = readInput(harPath); } catch (e) { return die('读取/解析失败 ' + harPath + ' → ' + e.message); }
  if (input.error) return die(input.error + '（文件：' + harPath + '）');
  har = input.har;
  try { defs = loadDefaults(); } catch (e) { return die(e.message + '\n（本工具以 src/lib/config.js 的 KX.defaults() 为 schema 真源，请在项目内运行。）'); }
  const ctx = analyze(har, args, harPath), state = buildState(defs, ctx);
  if (input.format && input.format !== 'HAR') console.error('[输入格式] ' + input.format);
  const text = JSON.stringify(args.pretty ? Object.assign({ _report: ctx.report }, state) : state, null, args.pretty ? 2 : 0);
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, text + '\n', 'utf8');
    console.log('已写出 ' + outPath + '（' + Buffer.byteLength(text, 'utf8') + ' 字节，targets ' + ctx.targets.length + ' 条）');
  } else console.log(text);
  console.error(ctx.report);
}
main();
