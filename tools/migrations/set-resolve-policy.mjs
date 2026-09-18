#!/usr/bin/env node
/**
 * 设定「同名教学班」的抢课策略 —— 设计要求：**继续抢，不自动收手**。
 *
 * 设计取舍："应该抢到同名的继续抢 因为你的成功判定并不可靠"
 *
 * 这个判断是对的，而且值得写进配置注释里：
 *   · 多抢一个同名班 → 代价是去学校页面**退一次课**（可逆、成本低）
 *   · 误停一个同名班 → 代价是**丢掉课程**（不可逆，可能整学期没课上）
 *   而"是否抢到了"的判定本来就不完全可靠（真实教训：选上了却判成"无法判定"，
 *   一小时里一直在白抢 —— 那次是因为响应是 {"msg":"<已选记录WID>","code":1}，
 *   不在预设的成功文案里）。拿不可靠的判断去做不可逆的动作，是设计上的错误。
 *
 * 所以：
 *   · autoStopSameName = **false**（默认）：同名班一直一起抢，抢到几个你自己退多余的
 *   · 想开启（省得退课）：设成 true —— 它**只在「已选课程」列表权威确认后才停**，
 *     那条判据直接来自服务器，不是解析响应文案猜出来的
 *   · 模糊门槛按设计要求放低：0.6 / 0.04（抢错能退，错过就没了）
 *
 * 用法：node tools/set-resolve-policy.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');
const cfg = JSON.parse(readFileSync(FILE, 'utf8'));

cfg.engine.autoResolveMinScore = 0.6;
cfg.engine.autoResolveMinGap = 0.04;
cfg.engine.autoStopSameName = false;
cfg.engine._resolveNote = [
  '同名班策略（设计要求）：默认 **不自动收手**，同名教学班一直一起抢。',
  '理由：多抢一个只是去退一次课（可逆），而误停一个是丢掉课程（不可逆）；',
  '而"是否抢到了"的判定本身不完全可靠（曾把成功响应判成"无法判定"，白抢一小时）。',
  '模糊门槛相应放低：autoResolveMinScore=0.6、autoResolveMinGap=0.04。',
  '想省得退课，可把 autoStopSameName 设为 true —— 它只在「已选课程」列表（服务器权威）确认后才停同名的其它班。'
].join('');

writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('已更新：');
console.log('  autoResolveMinScore = ' + cfg.engine.autoResolveMinScore);
console.log('  autoResolveMinGap   = ' + cfg.engine.autoResolveMinGap);
console.log('  autoStopSameName    = ' + cfg.engine.autoStopSameName + '（默认不停，同名一直一起抢）');
