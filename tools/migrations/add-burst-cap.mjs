#!/usr/bin/env node
/**
 * 给配置加上 burstCap（令牌桶容量）这个旋钮，并写清取舍。
 *
 * 背景：标签页被隐藏 5 分钟后，Chrome 会把定时器限到每分钟 1 次（省电）。
 * 此时循环每分钟只醒一次，只能发掉桶里攒下的那几个请求 → 实测速率掉到目标的 1/10。
 *   · burstCap = 0（默认）→ 桶容量 = 并发数：匀速、突发小。**需要保持标签页可见**。
 *   · burstCap 调大（如 120）→ 被降频时"醒一次就把攒下的额度发掉"，速率能补回来，
 *     代价是变成突发（风控更容易注意到）。这是给"必须挂后台"准备的后路。
 *
 * 用法：node tools/add-burst-cap.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');

const cfg = JSON.parse(readFileSync(FILE, 'utf8'));
if (!cfg.engine) throw new Error('配置里没有 engine 段');
if (cfg.engine.burstCap === undefined) cfg.engine.burstCap = 0;
cfg.engine._burstNote = 'burstCap = 令牌桶容量（一次最多突发多少个请求）。0 = 用并发数（匀速、突发小，推荐）。只有当你必须把标签页长期挂在后台时才调大（如 120）：Chrome 会把隐藏页面的定时器限到每分钟 1 次，循环每分钟只醒一次；调大桶容量可以"醒一次就把攒下的额度发掉"把速率补回来，代价是变成突发（风控更容易注意到）。';

writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('已写入 burstCap = ' + cfg.engine.burstCap);
console.log('engine 键：' + Object.keys(cfg.engine).join(', '));
