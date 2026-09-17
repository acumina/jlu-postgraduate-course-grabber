#!/usr/bin/env node
/**
 * 生成 archives/index.json —— 让扩展知道 archives/ 目录里有哪些档案文件。
 *
 * 为什么需要它：浏览器扩展**不允许枚举自己目录里的文件**（安全限制），
 * 所以必须有一个显式的索引列出文件名，扩展才能"在面板上列出档案让你点着读"。
 *
 * 用法：node tools/make-archive-index.mjs
 * 加/删了档案文件之后跑一次，然后到 chrome://extensions 重载扩展。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'archives');
if (!existsSync(DIR)) {
  console.error('archives/ 目录不存在');
  process.exit(1);
}

const files = readdirSync(DIR)
  .filter((f) => /\.json$/i.test(f) && f !== 'index.json')
  .sort();

const entries = files.map((name) => {
  const full = join(DIR, name);
  const st = statSync(full);
  const item = { name, size: st.size };
  // 从档案里读出"档案时间"和门数，面板上直接能看出是哪一年的
  try {
    const obj = JSON.parse(readFileSync(full, 'utf8'));
    if (obj && Array.isArray(obj.rows)) {
      item.rows = obj.rows.length;
      item.at = Number(obj.at) || 0;
      item.site = obj.site || '';
      // 顺手统计年级/学期线索：教学班ID 第一段通常是学年学期（如 20261）
      const terms = {};
      obj.rows.forEach((r) => {
        const m = /^(\d{5})-/.exec(String(r.id || ''));
        if (m) terms[m[1]] = (terms[m[1]] || 0) + 1;
      });
      item.terms = Object.keys(terms).sort().map((k) => k + '×' + terms[k]);
    } else {
      item.error = '不是档案格式（缺少 rows 数组）';
    }
  } catch (e) {
    item.error = 'JSON 解析失败：' + e.message;
  }
  return item;
});

const out = { generatedAt: Date.now(), dir: 'archives', files: entries };
writeFileSync(join(DIR, 'index.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log('已生成 archives/index.json：' + entries.length + ' 个档案');
entries.forEach((e) => {
  const when = e.at ? new Date(e.at).toLocaleString() : '（无时间）';
  console.log('  · ' + e.name + '　' + (e.rows !== undefined ? e.rows + ' 门' : '') 
    + '　' + when + (e.terms && e.terms.length ? '　学期 ' + e.terms.join(' ') : '')
    + (e.error ? '　⚠ ' + e.error : ''));
});
if (!entries.length) console.log('  （目录里还没有 .json 档案 —— 从面板「档案」页导出后拷进来）');
console.log('');
console.log('下一步：到 chrome://extensions 点一次「重新加载」，面板档案页就会出现这个列表。');
