#!/usr/bin/env node
/**
 * lint-undefined —— 找「用了但从未声明的变量」。
 *
 * 为什么需要（真实事故）：content.js 的 halt() 里写了 `if (!loginRelated) ...`，
 * 而那个变量**根本不存在**（参数名其实是 urgent）。严格模式下每次停机都抛
 * ReferenceError → 后面的"登录后自动继续"等逻辑全都没执行 →
 * 用户在新电脑上的表现就是"登录了也不自动开始抢课"。
 *
 * `node --check` 只查语法，查不出未声明变量；这个项目零依赖（没有 eslint），
 * 所以用一个够用的粗糙实现兜住这类错误：把声明收集起来，再找剩下的裸标识符。
 *
 * 用法：node tools/lint-undefined.mjs [file...]
 *   默认检查 src/**\/*.js
 * 退出码：发现可疑标识符 → 1
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* 浏览器/扩展环境提供的全局（不是我们声明的） */
const GLOBALS = new Set([
  'chrome', 'browser', 'window', 'document', 'location', 'navigator', 'console', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'fetch', 'Request', 'Response', 'Headers', 'AbortController', 'XMLHttpRequest', 'FormData', 'Blob', 'FileReader',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise', 'RegExp', 'Error', 'TypeError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'BigInt',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity', 'undefined', 'null', 'true', 'false',
  'alert', 'confirm', 'prompt', 'structuredClone', 'performance', 'crypto', 'Notification', 'MutationObserver',
  'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'HTMLElement', 'NodeList',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'atob', 'btoa', 'escape', 'unescape',
  'arguments', 'this', 'super', 'import', 'export', 'require', 'module', 'process', 'Buffer', '__dirname', '__filename',
  /* 本项目自己的全局共享库（由 presets/config/rules/export/panel 挂到 globalThis） */
  'KX', 'KXRules', 'KXPresets', 'KXPanel', 'KXApp', 'KXExport', 'KXSaveUi', 'KXCollector'
]);

/* JS 关键字（不是变量） */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'function', 'class', 'extends', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void', 'yield',
  'try', 'catch', 'finally', 'throw', 'with', 'debugger', 'var', 'let', 'const', 'this', 'super',
  'async', 'await', 'static', 'get', 'set', 'import', 'export', 'from', 'as', 'null', 'true', 'false'
]);

/** 去掉注释、字符串**和正则字面量**，避免把里面的词当标识符 */
function strip(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let lastSignificant = '';      // 用来判断 `/` 是除号还是正则开头
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      out += ' "" ';
      lastSignificant = '"';
      continue;
    }
    /* 正则字面量：`/` 前面不是标识符/数字/`)`/`]` 时视为正则开头 */
    if (c === '/' && !/[\w$\)\]]/.test(lastSignificant)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) { i++; break; }
        else if (code[i] === '\n') break;          // 正则不能跨行（说明判断错了，别吃掉代码）
        i++;
      }
      while (i < n && /[gimsuy]/.test(code[i])) i++;
      out += ' /re/ ';
      lastSignificant = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/** 收集声明名 */
function declarations(code) {
  const names = new Set();
  const patterns = [
    /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g
  ];
  patterns.forEach((re) => { let m; while ((m = re.exec(code)) !== null) names.add(m[1]); });
  /* 函数参数（粗糙但够用：括号里逗号分隔的裸标识符） */
  const fnRe = /(?:function\s*[A-Za-z_$\w]*\s*|=\s*)\(([^)]*)\)\s*(?:=>|\{)/g;
  let m;
  while ((m = fnRe.exec(code)) !== null) {
    m[1].split(',').forEach((p) => {
      const t = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
  }
  /* 解构声明里的名字（const { a, b } = ...） */
  const dstr = /\b(?:let|const|var)\s*[\{\[]([^\}\]]*)[\}\]]/g;
  while ((m = dstr.exec(code)) !== null) {
    m[1].split(',').forEach((p) => {
      const t = p.split(':').pop().trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
  }
  return names;
}

/** 找可疑的裸标识符 —— 只保留**高精度**的嫌疑：
 *  · 名字长度 ≥ 3（跳过 i/x/e/m 这类循环变量）
 *  · 全文件出现次数 ≤ 2（声明过的变量至少出现两次：声明 + 使用）
 *  · 不是关键字/全局
 * 这样几乎不误报；宁可漏，也不要天天喊狼来了（喊多了就没人看了）。 */
function suspects(code) {
  const clean = strip(code);
  const decl = declarations(clean);
  /* 统计全文出现次数（去掉属性访问） */
  const counts = new Map();
  const noProps = clean
    .replace(/\??\.[A-Za-z_$][\w$]*/g, '')            // .prop / ?.prop
    .replace(/([A-Za-z_$][\w$]*)\s*:/g, '');          // 对象键 / 标签
  let m;
  const reAll = /\b([A-Za-z_$][\w$]*)\b/g;
  while ((m = reAll.exec(noProps)) !== null) counts.set(m[1], (counts.get(m[1]) || 0) + 1);

  const out = new Map();
  const lines = noProps.split('\n');
  lines.forEach((line, idx) => {
    const re = /\b([A-Za-z_$][\w$]*)\b/g;
    let mm;
    while ((mm = re.exec(line)) !== null) {
      const name = mm[1];
      if (name.length < 3) continue;
      if (KEYWORDS.has(name) || GLOBALS.has(name) || decl.has(name)) continue;
      if ((counts.get(name) || 0) > 2) continue;      // 出现多次 → 大概率是声明过的（或环境提供的）
      /* 只认"当值用"的位置：后面跟 ) ] , ; = ? < > ! & | + - * / % 或行尾 */
      const after = line.slice(mm.index + name.length).trimStart();
      if (!/^[\)\],;=\?<>!&|+\-*\/%]|^$/.test(after)) continue;
      if (!out.has(name)) out.set(name, idx + 1);
    }
  });
  return out;
}

/* 已人工确认过的误报（粗糙实现剥离注释/正则不完美导致的）——
 * 基线化：这些不再报，**新出现的**未声明标识符一定会被报出来。
 * 每一条都注明为什么是误报，避免以后有人无脑往里加。 */
const BASELINE = new Set([
  'success',   // config.js：出现在模板字符串/注释残留里（已确认不是变量）
  'login',     // export.js：正则 /(check\/login|...)/i 里的词，剥离不完美
  'user',      // export.js：同上（正则里的词）
  'code',      // export.js：同上（正则里的词）
  'long'       // rules.js：注释里"年年会变"的残片，剥离不完美
]);

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(ROOT, p))
  : (function walk(dir, acc) {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) walk(f, acc);
        else if (n.endsWith('.js') && !/bridge\.js$/.test(n)) acc.push(f);
      }
      return acc;
    })(join(ROOT, 'src'), []);

let bad = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  const code = readFileSync(f, 'utf8');
  const s = suspects(code);
  for (const name of Array.from(s.keys())) if (BASELINE.has(name)) s.delete(name);
  if (s.size) {
    bad += s.size;
    console.log('■ ' + relative(ROOT, f));
    for (const [name, line] of s) console.log('   第 ' + line + ' 行  可疑未声明标识符: ' + name);
  }
}
console.log(bad
  ? '\n❌ 发现 ' + bad + ' 个可疑标识符（未声明就使用 —— 严格模式下会抛 ReferenceError）'
  : '✅ 没有发现未声明就使用的标识符');
process.exit(bad ? 1 : 0);
