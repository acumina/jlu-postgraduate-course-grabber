#!/usr/bin/env node
/**
 * 把「提前打开登录页」这个设置取消掉（设计要求：只有真的扫到掉线才弹页面）。
 *
 * 事故经过：登录快过期时**疯狂弹出新标签页**。两个原因：
 *   ① 触发条件里还留着"按推算倒计时提前打开"（left <= autoOpenLoginBeforeMs）——
 *      推算值本来就不可靠，于是没掉线也开
 *   ② 防重复只有页面级的 autoOpenedLogin 标记，而每次"掉线→恢复"都会重置它
 * 现在的行为：**只在 auth.state === 'lost'（真实的 401/页面文字）时打开**，
 * 且全局 3 分钟内最多一次（时间戳持久化），background 还会先找已开着的登录页切过去。
 *
 * 所以这个字段已经没有意义了，置 0 并在注释里说明，避免以后有人以为它还在生效。
 *
 * 用法：node tools/disable-preopen-login.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');
const cfg = JSON.parse(readFileSync(FILE, 'utf8'));

cfg.session.autoOpenLoginBeforeMs = 0;
cfg.session._autoOpenNote = [
  'autoOpenLoginBeforeMs=0：**不再按推算值提前打开登录页**（推算值不可靠，提前开只会刷屏）。',
  '现在只在"真的扫到掉线"时打开：提交/体检返回 HTTP 401，或页面出现未登录文字。',
  '防重复：全局 3 分钟内最多打开一次（时间戳存在 storage，跨页面共享）；',
  '而且打开前会先找有没有已经开着的登录页 —— 有就直接切过去，绝不新开。'
].join('');

writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('autoOpenLoginBeforeMs = ' + cfg.session.autoOpenLoginBeforeMs + '（取消提前打开）');
console.log('warnBeforeMs（提前提醒保留）= ' + cfg.session.warnBeforeMs + ' ms');
