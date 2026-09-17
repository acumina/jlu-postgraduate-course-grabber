#!/usr/bin/env node
/**
 * 从抓包里读出「已选课程」列表（loadStdCourseInfo.do 的响应）。
 *
 * 为什么重要：判断"这门课到底选上没有"，最可靠的证据不是提交接口的响应文案，
 * 而是**已选课程列表**。这个接口返回本人在该学期已选的全部教学班（含 BJDM）。
 * 顺带也拿到了退课需要的字段。
 *
 * 用法：node tools/show-my-courses.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAP = resolve(ROOT, 'logs/kx-captures.jsonl');
if (!existsSync(CAP)) { console.log('没有 logs/kx-captures.jsonl'); process.exit(0); }

const caps = readFileSync(CAP, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x));
const hits = caps.filter((e) => /loadStdCourseInfo/.test(e.url));
console.log('抓到 ' + hits.length + ' 次「已选课程」请求');
if (!hits.length) process.exit(0);

const last = hits[hits.length - 1];
let obj = null;
try { obj = JSON.parse(last.resp); } catch (e) { console.log('响应不是 JSON：' + String(last.resp).slice(0, 200)); }
const rows = (obj && (obj.results || obj.datas || obj.rows)) || [];
console.log('抓取时间：' + new Date(Number(last.ts)).toLocaleString());
console.log('已选课程数：' + rows.length);
console.log('');
if (rows.length) {
  // 打印关键字段（不同系统字段名略有差异，这里把能给人类看的都列出来）
  const keys = Object.keys(rows[0]);
  console.log('字段：' + keys.join(', '));
  console.log('');
  rows.forEach((r, i) => {
    const pick = (ks) => ks.map((k) => r[k]).filter((v) => v !== undefined && v !== null && String(v) !== '').join(' | ');
    console.log((i + 1) + '. ' + pick(['KCMC', 'BJMC', 'KCDM', 'BJDM', 'RKJS', 'XQMC', 'PKSJDDMS', 'XF', 'XKFS', 'WID']));
  });
}
