#!/usr/bin/env node
/**
 * 给配置补上「已选课程」段（mine），并清掉已废弃的「退课」段（drop）。
 *
 * 为什么只保留 mine：
 *  · mine（已选课程接口）解决的是「这门课到底选上没有」—— 这是**权威判据**。
 *    真实事故：15:28:31 选上了「研究生心理成长」，提交响应是 {"msg":"<32位hex>","code":1}，
 *    插件只敢说"看起来成功了，请你去学校页面确认"；而抓包里早就有 loadStdCourseInfo 这个接口，
 *    它返回本人在该学期已选的全部教学班，直接比对即可确认。
 *  · drop（退课）：设计要求**不做自动化**，退课他自己去学校页面手动退。
 *    这里只保留一条必要的提醒：退课前先把目标「停」或「删」，否则插件会把它又抢回来。
 *
 * 用法：node tools/add-mine.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'kx-config-吉大研究生选课.json');
const cfg = JSON.parse(readFileSync(FILE, 'utf8'));

if (!cfg.mine) {
  cfg.mine = {
    _note: '已选课程接口：用来**权威地**判断"这门课我到底选上没有"（比解析提交响应可靠得多）。'
      + '插件会在启动时和运行中定期核对它：在里面的目标直接标成"已选上"；'
      + '顺带能发现"课已满但其实我已经在里面了"——因为服务器先校验容量、后校验重复。'
      + '说明：退课**不做自动化**，请去学校页面手动退；但退之前先把对应目标「停」或「删」，否则会被抢回来。',
    url: 'https://yjsxk.jlu.edu.cn/yjsxkapp/sys/xsxkapp/xsxkCourse/loadStdCourseInfo.do?_={{ts}}',
    method: 'GET',
    path: 'results',
    idField: 'BJDM',
    nameField: 'KCMC',
    teacherField: 'RKJS',
    widField: 'WID',
    dropAllowedField: 'IS_SFYXTK',
    enrollModeField: 'XKFS',
    checkEveryMs: 180000,
    timeoutMs: 15000
  };
}

const removedDrop = 'drop' in cfg;
if (removedDrop) delete cfg.drop;

writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('mine.url = ' + cfg.mine.url.split('/').pop());
console.log(removedDrop ? '已移除 drop 段（退课不做自动化）' : 'drop 段本来就没有');
console.log('顶层键：' + Object.keys(cfg).join(', '));
