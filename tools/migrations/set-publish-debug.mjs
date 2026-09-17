#!/usr/bin/env node
/**
 * 设定发布用的 debug 默认值，并重新生成内置预设。
 *
 * 为什么要把发布配置里的 autoPush 关掉：
 *   配置里原本指向 http://127.0.0.1:8790（我们调试时的本地收集器）。
 *   新用户 clone 下来没跑收集器 → 插件会一直推送失败、日志刷错误。
 *   所以发布默认：collectorUrl 留空、autoPush=false。
 *
 * 为什么这**不影响你**：应用配置时 KX.mergeBundledConfig 会**保留你浏览器里的
 * debug 设置**（debug 属于"本地环境"，以你为准）—— 所以你的收集器照常收到数据。
 *
 * 注意：本脚本用 fs.writeFileSync 写文件（UTF-8 **不带 BOM**）。
 * 别用 PowerShell 的 Set-Content 改 JSON —— 它会写 BOM，导致 JSON.parse 直接报错
 * （这个坑今天已经踩过一次，4 个测试当场抓到）。
 *
 * 用法：node tools/migrations/set-publish-debug.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');
const cfg = JSON.parse(readFileSync(FILE, 'utf8'));

console.log('改动前 debug：' + JSON.stringify(cfg.debug));
cfg.debug = { collectorUrl: '', autoPush: false, pushLogs: false, autoPushEveryMs: 60000 };
cfg._debugNote = '发布默认：关闭自动推送（新用户没有本地收集器，开着只会一直失败）。'
  + '你自己的收集器地址与开关存在浏览器里，应用配置时会保留（KX.mergeBundledConfig），不受这里影响。';
writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('改动后 debug：' + JSON.stringify(cfg.debug));

console.log('');
console.log('重新生成内置预设…');
execFileSync('node', [resolve(ROOT, 'tools/make-preset.mjs')], { cwd: ROOT, stdio: 'inherit' });
