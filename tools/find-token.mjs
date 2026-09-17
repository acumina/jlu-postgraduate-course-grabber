/* ============================================================
 * tools/find-token.mjs —— 从抓包里追查「会话 token 从哪来」
 * ------------------------------------------------------------
 * 用途：像 csrfToken 这种「每次会话都会变、又必须随提交一起发」的参数，
 * 必须找到它的来源才能自动续期。这个脚本把三条线索一次性查出来：
 *   1. 已知 token 值是否出现在任何响应体里（→ 能靠调接口取）
 *   2. 响应体里有没有 32 位十六进制串（正方 csrfToken 就是这形态）
 *   3. 响应体里有没有键名像 token/csrf 的字段
 *   4. 提交请求里 token 的变化历史（证明它是不是每次登录都变）
 *
 * 用法：
 *   node tools/find-token.mjs                    # 自动取最近一次提交里的 csrfToken 作为线索
 *   node tools/find-token.mjs <32位token>        # 指定要追的值
 *   node tools/find-token.mjs --file logs/xxx.jsonl
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let file = path.join(ROOT, 'logs', 'kx-captures.jsonl');
let token = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') file = args[++i];
  else if (!token && /^[0-9a-f]{16,}$/i.test(args[i])) token = args[i];
}
if (!fs.existsSync(file)) { console.error('找不到抓包文件：' + file); process.exit(1); }

const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
const entries = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
if (!entries.length) { console.error('抓包文件里没有记录。'); process.exit(1); }

const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return String(u); } };
const clock = (ts) => { const d = new Date(Number(ts) || Date.now()); const p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };

/* 线索 0：提交请求里出现过的 token（用来判断"是不是每次都变"） */
const submitish = entries.filter((e) => e.method === 'POST' && /token|csrf/i.test(String(e.reqBody || '')));
console.log('=== 提交类请求里出现的 token ===');
if (!submitish.length) console.log('  （没有带 token 的 POST）');
const seen = [];
for (const e of submitish) {
  const m = String(e.reqBody).match(/([A-Za-z_]*token|csrf[A-Za-z_]*)=([^&]+)/i);
  if (!m) continue;
  seen.push({ at: e.ts, key: m[1], value: m[2], url: pathOf(e.url) });
  console.log('  ' + clock(e.ts) + '  ' + m[1] + '=' + m[2] + '   ← ' + pathOf(e.url));
}
if (!token && seen.length) token = seen[seen.length - 1].value;
if (seen.length > 1) {
  const uniq = [...new Set(seen.map((s) => s.value))];
  console.log('  共 ' + seen.length + ' 次、' + uniq.length + ' 个不同取值 → ' + (uniq.length > 1 ? '**每次都会变，绝不能写死在配置里**' : '本次抓包内没变（但不能保证下次会话不变）'));
}

if (!token) { console.log('\n没有可追查的 token 值（抓包里没有带 token 的提交请求）。'); process.exit(0); }
console.log('\n追查的目标 token：' + token);

/* 线索 1：token 是否出现在响应体里 */
console.log('\n=== 1. 这个 token 有没有出现在某个响应体里（出现了就能靠调那个接口拿到）===');
let hitResp = false;
for (const e of entries) {
  if (String(e.resp || '').includes(token)) { hitResp = true; console.log('  ★ ' + clock(e.ts) + '  ' + e.method + ' ' + pathOf(e.url)); }
}
if (!hitResp) console.log('  没有。说明它不是任何接口返回的 —— 只可能由页面 JS 生成、或藏在 cookie/前端存储里。');

/* 线索 2：响应体里的 32 位十六进制串 */
console.log('\n=== 2. 响应体里的 32 位十六进制串（token 的候选形态）===');
let anyHex = false;
for (const e of entries) {
  const m = String(e.resp || '').match(/[0-9a-f]{32}/gi);
  if (m) { anyHex = true; console.log('  ' + pathOf(e.url) + ' → ' + [...new Set(m)].slice(0, 5).join(', ')); }
}
if (!anyHex) console.log('  没有。');

/* 线索 3：响应体里的 token 类键名 */
console.log('\n=== 3. 响应体里键名像 token/csrf 的字段 ===');
let anyKey = false;
for (const e of entries) {
  const m = String(e.resp || '').match(/"[A-Za-z_]*?(?:token|csrf)[A-Za-z_]*?"\s*:\s*"?[^,"}]{0,64}/gi);
  if (m) { anyKey = true; console.log('  ' + pathOf(e.url) + ' → ' + m.slice(0, 4).join('  |  ')); }
}
if (!anyKey) console.log('  没有。');

console.log('\n=== 结论建议 ===');
if (hitResp) console.log('  token 来自接口响应 → 可以配 tokenFrom（引擎提交前先调那个接口取新 token），做到全自动续期。');
else if (anyKey || anyHex) console.log('  响应里有 token 嫌疑字段 → 逐个核对上面列出的值，确认哪个等于 ' + token);
else console.log('  token 不在任何响应里 → 它由页面 JS 生成或藏在 cookie/存储里。可行方案：'
  + '\n    a) 用 submit.pageVars 从 cookie/localStorage/sessionStorage/window 里取（先跑面板「探测页面 token」）'
  + '\n    b) 兜底用「从抓包学到的值」：你每次重新登录后手点一次选课，token 就会被学到（当前就是这样）');
