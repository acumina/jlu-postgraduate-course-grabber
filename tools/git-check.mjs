#!/usr/bin/env node
/**
 * git-check —— 明确告诉你"哪些文件能上传到 GitHub、哪些绝对不能"，
 * 并且**自动核对**：不该上传的文件是不是真的被 .gitignore 挡住了。
 *
 * 为什么需要它：.gitignore 只是"建议"—— 一个 `git add -f` 就能绕过，
 * 而 logs/ 里是完整抓包（学号、姓名、会话令牌、你已选的全部课程）。
 * 这个工具把分类写成代码，并把"有条件可上传"的文件（配置、课表档案）**逐项体检**。
 *
 * 用法：
 *   node tools/git-check.mjs          # 分类 + 体检 + 核对 .gitignore
 *   node tools/git-check.mjs --list   # 额外打印每个文件的归属
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOW_LIST = process.argv.includes('--list');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/* ============================================================
 * ① 绝对不能上传（含个人信息或本地会话）
 * ============================================================ */
const NEVER = [
  { re: /^logs\//, why: '抓包与日志：学号、姓名、会话令牌、你已选的全部课程都在里面' },
  /* 注意：test/fixtures/*.har 是**测试夹具**（内容是我编的假数据），要允许上传 ——
   * 里面万一混进真实抓包，由 tools/scan-secrets.mjs 兜住（它会扫学号/令牌/密码哈希）。 */
  { re: /\.har$/i, why: 'HAR 抓包导出（含请求头/Cookie/响应体）', unless: /^test\/fixtures\// },
  { re: /\.jsonl$/i, why: '抓包/日志流（同上）' },
  { re: /^kx-captures/, why: '抓包导出文件' },
  { re: /^\.edge-debug\//, why: '调试用浏览器 profile（含 Cookie 数据库）' },
  { re: /(^|\/)(chrome-profile|user-data|profile)\//i, why: '浏览器配置目录（含 Cookie！）' },
  { re: /\.(sqlite|db|sqlite3)$/i, why: '浏览器存储数据库（含 Cookie/登录态）' },
  { re: /\.local\.json$/i, why: '标记为"本地"的配置（约定含个人数据）' },
  { re: /kx-state.*\.json$/i, why: '扩展存储导出（含目标清单与运行状态）' },
  { re: /(^|\/)node_modules\//, why: '依赖目录（本项目零依赖，出现就是误操作）' },
  { re: /^\.git\//, why: 'git 自身目录' }
];

/* ============================================================
 * ② 有条件可上传 —— 每次都要体检
 * ============================================================ */
const CONDITIONAL = [
  {
    re: /^kx-config-.*\.json$/,
    label: '项目配置（可上传）',
    check: (file) => {
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const problems = [];
      if ((cfg.targets || []).length) {
        problems.push('targets 不是空的（' + cfg.targets.length + ' 个）—— 那是你的选课清单，发布前请跑 node tools/prepare-publish.mjs');
      }
      const s = JSON.stringify(cfg);
      if (/\b20\d{8}\b/.test(s)) problems.push('内容里出现了像学号的数字');
      /* 只查**真实的凭据值**，不查规则里的词 ——
       * 配置里本来就有形如 name=["']password 的匹配规则，那不是泄露。 */
      if (/loginPwd=[0-9a-fA-F]{16,}/.test(s)) problems.push('出现了密码哈希值');
      if (/verifyCode=[A-Za-z0-9]{3,8}(&|"|$)/.test(s)) problems.push('出现了验证码值');
      if (/JSESSIONID=[^;"\s]{6,}/.test(s)) problems.push('出现了会话 Cookie 值');
      if (/"WID"\s*:\s*"[0-9a-fA-F]{32}"/.test(s)) problems.push('出现了已选记录 WID');
      return problems;
    }
  },
  {
    /* 课表档案白名单：字段对不上就说明放错文件了 */
    re: /^archives\/(?!index\.json$).*\.json$/,
    label: '课表档案（可上传：是学校公开课表）',
    check: (file) => {
      const problems = [];
      let obj;
      try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return ['不是合法 JSON：' + e.message]; }
      if (!Array.isArray(obj.rows)) return ['不是档案格式（缺 rows 数组）'];
      // 课表字段白名单：一旦出现这些字段，说明放进来的是"我的已选课程"而不是公开课表
      const PERSONAL_FIELDS = ['XH', 'XKR', 'XKRXM', 'WID', 'LCWID', 'IS_SFYXTK', 'XKFS'];
      const keys = new Set();
      obj.rows.slice(0, 50).forEach((r) => Object.keys(r || {}).forEach((k) => keys.add(k)));
      const bad = PERSONAL_FIELDS.filter((k) => keys.has(k));
      if (bad.length) problems.push('出现了个人字段 ' + bad.join('、') + ' —— 这像是"我的已选课程"，不是公开课表');
      const s = JSON.stringify(obj.rows.slice(0, 200));
      if (/\b20\d{8}\b/.test(s)) problems.push('内容里出现了像学号的数字');
      return problems;
    }
  },
  {
    /* 测试夹具（含 sample.har）：默认是假数据，扫一遍确认 */
    re: /^test\/fixtures\//,
    label: '测试夹具（可上传：应为假数据）',
    check: (file) => {
      const problems = [];
      const s = readFileSync(file, 'utf8');
      const realId = (s.match(/\b20\d{8}\b/g) || []).filter((v) => !/^2099/.test(v));
      if (realId.length) problems.push('出现像真实学号的数字：' + realId.slice(0, 3).join('、') + '（测试数据请用 2099 开头）');
      if (/loginPwd=[0-9a-fA-F]{16,}/.test(s) && !/0{16,}/.test(s)) problems.push('出现密码哈希（应全 0 占位）');
      return problems;
    }
  }
];

/* ============================================================
 * ③ 项目本体（正常上传）
 * ============================================================ */
const PROJECT = [
  /^src\//, /^test\//, /^mock\//, /^docs\//, /^tools\//, /^icons\//,
  /^manifest\.json$/, /^package\.json$/, /^README\.md$/, /^LICENSE$/, /^\.gitignore$/, /^\.gitattributes$/,
  /^archives\/README\.md$/, /^archives\/index\.json$/
];

function walk(dir, out) {
  let entries = [];
  try { entries = readdirSync(dir); } catch (e) { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) {
      // .git / node_modules 直接跳过（不要把目录本身当文件分类，否则会报"未分类 .git"）
      if (name === '.git' || name === 'node_modules') continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

const all = walk(ROOT, []);
const never = [], conditional = [], project = [], unknown = [];

for (const file of all) {
  const r = rel(file);
  const n = NEVER.find((x) => x.re.test(r) && !(x.unless && x.unless.test(r)));
  if (n) { never.push({ file: r, why: n.why }); continue; }
  const c = CONDITIONAL.find((x) => x.re.test(r));
  if (c) {
    let problems = [];
    try { problems = c.check(file) || []; } catch (e) { problems = ['体检失败：' + e.message]; }
    conditional.push({ file: r, label: c.label, problems });
    continue;
  }
  if (PROJECT.some((x) => x.test(r))) { project.push({ file: r }); continue; }
  unknown.push({ file: r });
}

/* ---------------- 核对 .gitignore 是否真的挡住了 NEVER ---------------- */
const gi = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
const giRules = gi.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
function ignored(file) {
  // 简化版匹配：目录前缀 / 后缀 / 文件名包含
  return giRules.some((rule) => {
    const r = rule.replace(/^\//, '');
    if (r.endsWith('/')) return file.startsWith(r) || file.includes('/' + r);
    if (r.startsWith('*')) return file.endsWith(r.slice(1));
    return file === r || file.endsWith('/' + r) || file.startsWith(r);
  });
}
const notIgnored = never.filter((x) => !ignored(x.file));

/* ---------------- 输出 ---------------- */
console.log('══════════ 能上传 GitHub 的 ══════════');
console.log('');
console.log('① 项目本体（' + project.length + ' 个文件）—— 正常提交');
console.log('   src/ test/ mock/ docs/ tools/ icons/ manifest.json package.json README.md LICENSE .gitignore');
console.log('');
console.log('② 有条件可上传（' + conditional.length + ' 个文件）—— 已逐项体检：');
if (!conditional.length) console.log('   （没有）');
conditional.forEach((c) => {
  if (!c.problems.length) console.log('   ✅ ' + c.file + '　' + c.label);
  else {
    console.log('   ❌ ' + c.file);
    c.problems.forEach((p) => console.log('        问题：' + p));
  }
});
console.log('');
console.log('══════════ 绝对不能上传 ══════════');
console.log('');
console.log('③ 含个人数据 / 本地会话（' + never.length + ' 个）—— 已被 .gitignore 排除：');
const byWhy = {};
never.forEach((x) => { (byWhy[x.why] = byWhy[x.why] || []).push(x.file); });
Object.keys(byWhy).forEach((why) => {
  console.log('   · ' + why);
  console.log('       ' + byWhy[why].slice(0, 4).join('\n       ') + (byWhy[why].length > 4 ? '\n       …共 ' + byWhy[why].length + ' 个' : ''));
});
if (!never.length) console.log('   （当前不存在这类文件 —— 很好）');
console.log('');
if (unknown.length) {
  console.log('④ 未分类（' + unknown.length + ' 个）—— 请你自己判断：');
  unknown.forEach((u) => console.log('   ? ' + u.file));
  console.log('');
}

if (SHOW_LIST) {
  console.log('--- 完整清单 ---');
  project.forEach((p) => console.log('  上传      ' + p.file));
  conditional.forEach((c) => console.log('  上传(条件) ' + c.file));
  never.forEach((n) => console.log('  排除      ' + n.file));
  unknown.forEach((u) => console.log('  待定      ' + u.file));
  console.log('');
}

/* ---------------- 结论 ---------------- */
const condBad = conditional.filter((c) => c.problems.length);
let fail = false;
if (notIgnored.length) {
  fail = true;
  console.log('❌ 有本该排除的文件**没有被 .gitignore 挡住**：');
  notIgnored.forEach((x) => console.log('   ' + x.file + '　（' + x.why + '）'));
  console.log('   → 把对应规则加进 .gitignore，否则一次 git add -A 就会提交出去。');
  console.log('');
}
if (condBad.length) {
  fail = true;
  console.log('❌ 有条件可上传的文件体检不通过（见上面②）—— 处理掉再提交。');
  console.log('');
}
if (unknown.length) {
  console.log('⚠ 有 ' + unknown.length + ' 个未分类文件 —— 确认它们不含个人信息后再提交。');
  console.log('');
}
if (!fail && !unknown.length) {
  console.log('✅ 可以安全提交：');
  console.log('   git add -A && git commit -m "..."');
  console.log('   （提交前建议装钩子：node tools/install-hooks.mjs —— 含敏感信息就提交不上去）');
} else if (!fail) {
  console.log('⚠ 分类通过，但有未分类文件需要你确认。');
}

process.exit(fail ? 1 : 0);
