#!/usr/bin/env node
/**
 * 开源前的清理 —— 把"属于个人"的东西从**将要提交的文件**里清掉。
 *
 * 做什么：
 *   ① 清空配置里的 targets（你的选课清单不该进公开仓库）
 *      注意：应用配置时会保留本地 targets（KX.mergeBundledConfig），所以清空文件里的
 *      targets **不会**影响你浏览器里已有的目标列表。
 *   ② 报告 wishlist（备选清单）—— 它只有课程名，是"新电脑自动带着课"的载体，
 *      默认保留；不想公开就加 --clear-wishlist
 *   ③ 检查是否还有个人痕迹（交给 scan-secrets）
 *
 * 用法：node tools/prepare-publish.mjs [--clear-wishlist]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');
const argv = process.argv.slice(2);

const cfg = JSON.parse(readFileSync(FILE, 'utf8'));
const n = (cfg.targets || []).length;
if (n) {
  console.log('· 清空配置里的 targets（原有 ' + n + ' 个 —— 你的选课清单不进公开仓库）：');
  (cfg.targets || []).forEach((t) => console.log('    - ' + (t.label || t.id)));
  cfg.targets = [];
} else {
  console.log('· 配置里的 targets 已经是空的 ✅');
}
/* 备选清单会随配置文件公开 —— 它比 targets "温和"（只有课程名，没有教学班ID），
 * 但仍然是"你想选哪些课"。默认保留（否则新电脑/别人就用不上这个功能了）。 */
const wl = (cfg.wishlist || []).length;
if (argv.includes('--clear-wishlist')) {
  console.log('· 清空配置里的 wishlist（备选清单，原有 ' + wl + ' 门）');
  cfg.wishlist = [];
} else if (wl) {
  console.log('· 配置里的 wishlist 保留 ' + wl + ' 门（只有课程名，不含教学班ID）：');
  (cfg.wishlist || []).slice(0, 5).forEach((w) => console.log('    - ' + w.name));
  if (wl > 5) console.log('    …还有 ' + (wl - 5) + ' 门');
  console.log('  → 这是"明年/新电脑自动带着课"的载体，建议保留；不想公开就加 --clear-wishlist');
}
cfg._说明 = (cfg._说明 || '').replace(/。$/, '')
  + '。注意：targets 刻意留空 —— 那是每个人的选课清单，不该进公开仓库；使用时在面板「档案」页挑课加入即可。';
writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('· 已写回 ' + FILE.replace(ROOT + '\\', ''));

if (existsSync(resolve(ROOT, 'logs'))) {
  console.log('');
  console.log('· logs/ 还在（里面有学号、姓名、已选课程）。它已在 .gitignore 里，');
  console.log('  但**请确认**不会被提交：git status --short 里不该出现 logs/。');
}
