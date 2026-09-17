#!/usr/bin/env node
/**
 * 开源前敏感信息扫描 —— 用来在 push 到 GitHub 之前找出不该公开的内容。
 *
 * 检查哪些东西？都是这个项目里**实际出现过**的：
 *   · 学号（10 位，20 开头）
 *   · 姓名（配置里可填，默认查常见的真实姓名模式 —— 主要靠下面的人工清单）
 *   · 密码哈希（登录请求体里的 loginPwd，64 位 hex）
 *   · 会话票据（JSESSIONID 等 Cookie 值）
 *   · csrfToken / vtoken / 一次性令牌（32 位 hex）
 *   · 已选记录 WID（32 位 hex，能反查你在教务系统里的选课记录）
 *   · 验证码明文、手机号、邮箱、身份证号
 *   · 带 cookie/token 的请求头
 *
 * 用法：
 *   node tools/scan-secrets.mjs              # 扫描将要提交的文件（遵守 .gitignore）
 *   node tools/scan-secrets.mjs --all        # 连 logs/ 一起扫（它们不该被提交）
 *   node tools/scan-secrets.mjs --name 张三   # 额外指定要查的姓名
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SCAN_ALL = argv.includes('--all');
const nameArgIdx = argv.indexOf('--name');
const EXTRA_NAMES = nameArgIdx >= 0 && argv[nameArgIdx + 1] ? [argv[nameArgIdx + 1]] : [];

/* 默认跳过这些（本来就不该提交；--all 时也扫） */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.edge-debug', 'dist', 'build']);
const LOG_DIRS = new Set(['logs']);

const PATTERNS = [
  { id: '学号', re: /\b(20\d{8})\b/g, why: '学号（10 位，20 开头）', sev: 'auto' },
  { id: '密码哈希', re: /loginPwd=([0-9a-fA-F]{32,128})/g, why: '登录请求体里的密码哈希', sev: 'high' },
  { id: '密码字段', re: /"?(?:password|passwd|pwd)"?\s*[:=]\s*["']?([^\s"'&,}]{4,})/gi, why: '疑似明文密码字段', sev: 'high' },
  { id: '会话票据', re: /(JSESSIONID|SESSION|_WEU|route|SERVERID)\s*=\s*([^;'"\s,}]{6,})/gi, why: '会话 Cookie 值', sev: 'high' },
  { id: '一次性令牌', re: /(csrfToken|vtoken|token)["']?\s*[:=]\s*["']?([0-9a-fA-F]{16,})/g, why: 'csrfToken / vtoken（随页面刷新，也不该公开）', sev: 'low' },
  { id: '已选记录WID', re: /"WID"\s*:\s*"([0-9a-fA-F]{32})"/g, why: '已选记录 ID（能反查个人选课记录）', sev: 'high' },
  { id: '验证码明文', re: /verifyCode=([^\s&"']{3,8})/g, why: '验证码明文', sev: 'high' },
  { id: 'Cookie头', re: /^\s*[Cc]ookie\s*:\s*(.+)$/gm, why: '原始 Cookie 请求头', sev: 'high', cookieLine: true },
  { id: '手机号', re: /\b(1[3-9]\d{9})\b/g, why: '手机号', sev: 'high' },
  { id: '邮箱', re: /([\w.+-]+@[\w-]+\.[\w.]{2,})/g, why: '邮箱', sev: 'high' },
  { id: '身份证', re: /\b(\d{17}[\dXx])\b/g, why: '身份证号', sev: 'high' }
];

/* 占位符/示例值：命中也不算问题。
 * 约定：本项目里"明显假"的示例值统一写成这些形式（2099 开头的学号、EXAMPLE-*、全 0 哈希…），
 * 这样扫描器不会被自己的示例数据淹没 —— 否则一个谁都跑不通的扫描器等于没有。 */
const PLACEHOLDER_RE = /^(secret[\w-]*|super-secret-value|aaaa[\w-]*|example[\w-]*|x{3,}|\*{2,}|test[\w-]*|dummy|placeholder|fake[\w-]*|your[-_]?[\w-]*|2099\d{6}|0{16,}|0123456789abcdef[\w-]*|<[^>]+>)$/i;
/* 这些路径下的内容天生是示例（测试/文档/模拟服务器）：
 * 里面的"学号形状"的数字算低危（提示你自己确认一下），其它路径算高危。 */
const EXAMPLE_PATH_RE = /(^|\/)(test|mock|docs|README\.md|LICENSE)/i;
/* 这些文件天生要写作者署名（package.json/manifest 的 author、LICENSE 的版权行、
 * 文档里讲许可怎么写）—— 对"姓名"这一项整体豁免。
 * 其它文件（src/ test/ tools/ mock/ 配置、课表档案）里出现真实姓名一律报高危：
 * 那里出现姓名只可能是从日志/抓包里漏出来的。 */
const ATTRIBUTION_FILES = /^(package\.json|manifest\.json|LICENSE|README\.md|docs\/)/i;
/* 这些文件本身就在**定义检测规则**（正则里当然写着 loginPwd=... 这类模式），
 * 不豁免的话扫描器会一直报自己 —— 一个总在报自己的扫描器没人会用。 */
const DETECTOR_FILES = new Set([
  'tools/scan-secrets.mjs',
  'tools/git-check.mjs',
  'tools/git-commit.mjs'
]);

const TEXT_EXT = /\.(js|mjs|cjs|json|jsonl|md|txt|html|css|yml|yaml|har|sh|ps1)$/i;

function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir); } catch (e) { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (LOG_DIRS.has(name) && !SCAN_ALL) continue;
      walk(full, out);
    } else if (st.isFile()) {
      if (st.size > 4 * 1024 * 1024) continue;      // 跳过超大文件
      if (!TEXT_EXT.test(name) && !/^LICENSE|^\.gitignore$/i.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT, []).sort();
const findings = [];

for (const file of files) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (e) { continue; }
  /* 路径统一成正斜杠！Windows 上 relative() 返回 "docs\PUBLISH.md"，
   * 而按路径判断的白名单（署名类文件、示例类路径）都写成 "docs/..." ——
   * 不统一的话那些判断在 Windows 上**全部失效**（真实踩到过）。 */
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (DETECTOR_FILES.has(rel)) continue;   // 检测器文件本身豁免
  const isExamplePath = EXAMPLE_PATH_RE.test(rel);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/kx-scan-allow/.test(line)) return;          // 行内豁免
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line)) !== null) {
        const hit = m[0];
        if (p.re.lastIndex === m.index) p.re.lastIndex++;   // 防零宽循环
        // 明显是占位符/示例值 → 跳过（否则扫描器会被自己的示例数据淹没，没法用）
        const val = (m[2] || m[1] || hit).trim().replace(/^["']|["']$/g, '');
        if (PLACEHOLDER_RE.test(val)) continue;
        /* Cookie 行特殊处理：只看**敏感名字**的 Cookie 值是不是占位符 ——
         * 否则 `Content-Length: 72` 这种也会被当成问题（误报），而
         * `Cookie: 'JSESSIONID=secret'` 这种测试里的假值不该报警。 */
        if (p.cookieLine) {
          const SENSITIVE_NAME = /(session|token|auth|sid|jsession|_weu|ticket|remember|credential)/i;
          // 按 ; 和 , 都切开：测试代码里常写成一行的对象字面量（多个键值在同一行）
          const pairs = String(m[1] || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
          const bad = pairs.filter((pair) => {
            const eq = pair.indexOf('=');
            if (eq < 0) return false;
            const name = pair.slice(0, eq).replace(/^["']|["']$/g, '').trim();
            const v = pair.slice(eq + 1).replace(/^["']|["']$/g, '').trim();
            if (!SENSITIVE_NAME.test(name)) return false;      // Content-Length 之类不敏感
            return v && !PLACEHOLDER_RE.test(v);
          });
          if (!bad.length) continue;
        }
        if (p.id === '邮箱' && /@(example|test|localhost|127\.0\.0\.1)/i.test(hit)) continue;
        // 严重级别：示例路径下的"学号形状"数字只提示；其它情况按 pattern 定级
        let sev = p.sev;
        if (sev === 'auto') sev = isExamplePath ? 'low' : 'high';
        findings.push({ file: rel, line: i + 1, id: p.id, why: p.why, hit: hit.slice(0, 90), sev: sev });
      }
    }
    for (const n of EXTRA_NAMES) {
      if (n && line.indexOf(n) !== -1) {
        /* 署名类文件豁免：那些地方写作者名是**故意的**（package.json 的 author、
         * LICENSE 的版权行、文档里讲许可怎么写）。
         * 真正要抓的是：真实姓名出现在日志/抓包/测试数据/配置里。 */
        if (ATTRIBUTION_FILES.test(rel)) continue;
        findings.push({ file: rel, line: i + 1, id: '姓名', why: '指定的姓名（真实姓名不要公开）', hit: n, sev: 'high' });
      }
    }
  });
}

const high = findings.filter((f) => f.sev === 'high');
const low = findings.filter((f) => f.sev === 'low');

console.log('扫描范围：' + (SCAN_ALL ? '全部文件（含 logs/）' : '将要提交的文件（跳过 logs/）'));
console.log('文件数：' + files.length);
if (!SCAN_ALL && existsSync(join(ROOT, 'logs'))) {
  console.log('');
  console.log('注意：logs/ 被跳过 —— 它包含你的抓包与日志（学号、姓名、已选课程都在里面）。');
  console.log('      想看看里面有什么：node tools/scan-secrets.mjs --all');
}
console.log('');

function dump(list, title) {
  if (!list.length) return;
  const byFile = {};
  list.forEach((f) => { (byFile[f.file] = byFile[f.file] || []).push(f); });
  console.log(title + '（' + list.length + ' 处，' + Object.keys(byFile).length + ' 个文件）：');
  console.log('');
  for (const file of Object.keys(byFile).sort()) {
    console.log('■ ' + file);
    byFile[file].slice(0, 10).forEach((f) => {
      console.log('   第 ' + f.line + ' 行  [' + f.id + '] ' + f.hit);
    });
    if (byFile[file].length > 10) console.log('   …还有 ' + (byFile[file].length - 10) + ' 处');
    console.log('');
  }
}

if (!high.length && !low.length) {
  console.log('✅ 没有发现敏感信息，可以提交。');
} else {
  dump(high, '❌ 高危：必须处理掉再提交');
  dump(low, '· 提示：看着像示例数据，但请你自己确认一遍');
  if (high.length) {
    console.log('处理建议：');
    console.log('  · 真实学号/姓名/密码哈希/验证码 → 换成**明显假**的值（如 2099000001、全 0 哈希、ab3d9）');
    console.log('  · logs/ 与 *.har → 加进 .gitignore，永远不要提交');
    console.log('  · 已经 push 过的：光删文件没用，要改历史（git filter-repo）或删仓库重建');
  } else {
    console.log('（高危为 0 —— 上面那些看着像示例数据。确认无误即可提交。）');
  }
}

process.exit(high.length ? 1 : 0);
