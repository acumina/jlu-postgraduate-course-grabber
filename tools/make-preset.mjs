#!/usr/bin/env node
/**
 * 从 kx-config-*.json 生成扩展内置预设 src/lib/presets.js
 *
 * 为什么需要：内置预设让「全新浏览器」也能安装即用 —— 用户不必再去别处找配置文件
 * 导入（默认白名单是空的，新装时面板甚至不会在学校网站上出现）。
 *
 * 生成时会做三处「通用化」调整（预设是给任何人用的，不该带个人数据与本地依赖）：
 *   · targets 清空 —— 选课清单是每个人自己的，不该由预设决定
 *   · enabled=false —— 别一装上就自己开抢
 *   · collector 关闭 —— 新环境没有本地收集器（tools/collector.mjs），开着只会白报错
 *
 * 用法：node tools/make-preset.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'kx-config-吉大研究生选课.json');
const OUT = resolve(ROOT, 'src/lib/presets.js');
const PRESET_KEY = 'jlu-yjsxk';

const cfg = JSON.parse(readFileSync(SRC, 'utf8'));
delete cfg._说明;
cfg._说明 = '内置预设：吉林大学研究生选课（正方新版）。载入后只需自己添加要抢的教学班（余量页搜课 → 加监控），再点启动。';
cfg.targets = [];
delete cfg.enabled;   // 运行时意图（kx_want_running），不归配置文件管
cfg.debug = { collectorUrl: '', autoPush: false, pushLogs: false, autoPushEveryMs: 60000 };

const header = `/* 内置预设：让「全新浏览器」也能安装即用 —— 不必再去别处找配置文件导入。
 *
 * 只包含「站点规则 + 提交/查询模板 + 判定规则 + 会话与 UI 设置」，
 * **刻意不含 targets**（选课清单是每个人自己的）。
 *
 * 本文件由 tools/make-preset.mjs 从 kx-config-吉大研究生选课.json 生成，请勿手改；
 * 配置有变动就重新生成：node tools/make-preset.mjs
 */
`;

const body = `globalThis.KXPresets = {
  '${PRESET_KEY}': ${JSON.stringify(cfg, null, 2).split('\n').join('\n  ')}
};
`;

writeFileSync(OUT, header + body, 'utf8');
console.log('已生成 ' + OUT.replace(ROOT + '\\', '') + '（' + (header + body).length + ' 字节）');
console.log('  预设键 : ' + PRESET_KEY);
console.log('  sites  : ' + JSON.stringify(cfg.sites));
console.log('  targets: ' + cfg.targets.length + ' 个（刻意为空）');
console.log('  submit : ' + String(cfg.submit.url).split('/').pop());
