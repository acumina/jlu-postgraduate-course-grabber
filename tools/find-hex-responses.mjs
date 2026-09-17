#!/usr/bin/env node
/**
 * 找证据：那种 `{"msg":"<32位hex>","code":1}` 的响应到底是不是"选课成功"。
 *
 * 背景：这个系统里 code:1 是成功值（登录成功就是 {"code":"1","msg":"登录成功"}）。
 * 之前有 8 次提交返回了 code:1 + 随机 32 位 hex，被插件判成"无法判定"。
 * 如果那其实是成功响应，说明课程可能已经选上了 —— 必须查清楚，否则会一直白抢。
 *
 * 用法：node tools/find-hex-responses.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const re = /\{"msg":"([0-9a-f]{32})","code":1\}/;

console.log('=== ① 日志里 code:1 + 32位hex 的响应 ===');
if (!existsSync(resolve(ROOT, 'logs/kx-log.txt'))) {
  console.log('  logs/kx-log.txt 不存在');
} else {
  const lines = readFileSync(resolve(ROOT, 'logs/kx-log.txt'), 'utf8').split('\n');
  const hits = [];
  lines.forEach((l) => {
    const m = re.exec(l);
    if (m) hits.push({ t: (/^\[([^\]]+)\]/.exec(l) || [])[1] || '?', hex: m[1], line: l.slice(0, 120) });
  });
  console.log('  共 ' + hits.length + ' 次');
  hits.slice(0, 20).forEach((h) => console.log('    ' + h.t + '  msg=' + h.hex.slice(0, 16) + '…'));

  console.log('');
  console.log('=== ② 同一门课在那前后返回过什么（判断是否真的选上了）===');
  // 找出 hex 响应涉及的目标名，再看它之后的响应
  const names = new Set();
  hits.forEach((h) => {
    const m = /WARN \? (.+?) 结果无法判定/.exec(h.line);
    if (m) names.add(m[1]);
  });
  console.log('  涉及目标：' + ([...names].join('、') || '（没解析出目标名）'));
  [...names].forEach((n) => {
    const after = lines.filter((l) => l.indexOf(n) !== -1 && /名额已满|已选|成功|容量/.test(l)).slice(-4);
    console.log('  [' + n + '] 之后出现过：');
    after.forEach((l) => console.log('      ' + l.slice(0, 130)));
  });
}

console.log('');
console.log('=== ③ 抓包里与「已选课程 / 退课」相关的接口 ===');
const capFile = resolve(ROOT, 'logs/kx-captures.jsonl');
if (!existsSync(capFile)) {
  console.log('  没有抓包文件');
} else {
  const caps = readFileSync(capFile, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x));
  const seen = new Set();
  caps.forEach((e) => {
    let u; try { u = new URL(e.url); } catch (_) { return; }
    if (/CourseInfo|Selected|Yixuan|MyCourse|choice|tk|退课|已选/i.test(u.pathname)) {
      if (seen.has(u.pathname)) return;
      seen.add(u.pathname);
      console.log('  ' + e.method + ' ' + u.pathname + '  响应 ' + String(e.resp || '').length + ' 字节');
      const body = String(e.resp || '');
      if (/SFYX|YX|已选|退课|TK/i.test(body.slice(0, 600))) {
        console.log('      响应片段：' + body.replace(/\s+/g, ' ').slice(0, 220));
      }
    }
  });
  if (!seen.size) console.log('  （还没抓到相关接口 —— 去学校页面点一次「已选课程」标签，插件就会录到）');
}
