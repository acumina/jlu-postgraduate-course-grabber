#!/usr/bin/env node
/**
 * 一次性清理：把配置文件里的 `enabled` 字段删掉。
 *
 * 为什么：`enabled` 表达的是「用户想让它跑」这个**运行时意图**，
 * 而配置文件每次导入都会覆盖它 → 用户导入配置（本意只是更新模板）后，
 * 意图被冲成 false，于是"进入页面自动开始"永远不触发（真实事故）。
 * 现在它存在独立的运行时键 `kx_want_running` 里，配置文件里不该再有这个字段。
 *
 * 用法：node tools/fix-config-enabled.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');

const cfg = JSON.parse(readFileSync(FILE, 'utf8'));
if ('enabled' in cfg) {
  delete cfg.enabled;
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('已移除 enabled（运行时意图，不归配置文件管）');
} else {
  console.log('配置文件里已经没有 enabled，无需处理');
}
console.log('剩余顶层键：' + Object.keys(cfg).join(', '));
