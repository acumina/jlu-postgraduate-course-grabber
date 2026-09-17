#!/usr/bin/env node
/**
 * 生成 Release 的更新内容（JSON），交给 gh api --input 使用。
 *
 * 为什么要走 JSON 文件：中文标题/说明直接当命令行参数传，在 Windows 的
 * PowerShell/cmd 里容易被代码页转换搞成乱码。写成 UTF-8 JSON 文件最稳。
 *
 * 用法：node tools/make-release-payload.mjs
 * 输出：dist/release-v0.1.0.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = process.argv[2] || 'v0.1.0';
const ZIP_NAME = 'jlu-postgraduate-course-grabber-' + TAG + '.zip';
const ZIP = join(ROOT, 'dist', ZIP_NAME);
const NOTES = join(ROOT, 'docs', 'releases', TAG + '.md');

if (!existsSync(NOTES)) { console.error('找不到发布说明：' + NOTES); process.exit(1); }
if (!existsSync(ZIP)) { console.error('找不到打包文件：' + ZIP + '（先跑 git archive 打包）'); process.exit(1); }

const sha = createHash('sha256').update(readFileSync(ZIP)).digest('hex').toUpperCase();
const sizeKB = Math.round(readFileSync(ZIP).length / 1024 * 10) / 10;

let body = readFileSync(NOTES, 'utf8').trimEnd();
body += '\n\n## 下载\n\n'
  + '| 文件 | 大小 | 说明 |\n| --- | --- | --- |\n'
  + '| `' + ZIP_NAME + '` | ' + sizeKB + ' KB | **推荐**：解压后 `manifest.json` 就在根目录，直接「加载已解压的扩展程序」 |\n'
  + '| Source code (zip) | — | GitHub 自动生成的源码包（会多一层文件夹） |\n\n'
  + '```\nSHA256: ' + sha + '\n```\n\n'
  + '> 校验下载是否被篡改：`certutil -hashfile ' + ZIP_NAME + ' SHA256`（Windows）\n'
  + '> 或 `sha256sum ' + ZIP_NAME + '`（macOS / Linux），结果应与上面一致。\n';

const payload = { name: TAG + ' —— 首个发布版', body: body, draft: false, prerelease: false };
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', 'release-' + TAG + '.json');
writeFileSync(out, JSON.stringify(payload), 'utf8');
/* 再写一份"粘贴即用"的纯说明文件 —— 走网页界面时直接打开复制即可 */
const notesOut = join(ROOT, 'dist', 'release-' + TAG + '-notes.md');
writeFileSync(notesOut, body, 'utf8');

console.log('已生成两个文件（dist/ 不进版本库）：');
console.log('  ' + out + '　← 给 gh api --input 用');
console.log('  ' + notesOut + '　← 走网页界面时打开它复制全文');
console.log('');
console.log('  标题: ' + payload.name);
console.log('  说明: ' + body.length + ' 字符（含下载表与校验和）');
console.log('  附件: ' + ZIP_NAME + '　' + sizeKB + ' KB　SHA256 ' + sha.slice(0, 16) + '…');
console.log('');
console.log('--- 命令行的两条命令（gh 已登录时）---');
console.log('gh release edit ' + TAG + ' --title "' + payload.name + '" --notes-file docs/releases/' + TAG + '.md');
console.log('gh release upload ' + TAG + ' "dist/' + ZIP_NAME + '"');
console.log('');
console.log('提示：gh release edit 只吃 docs/releases 里的原始说明（不含下载表）。');
console.log('      想连下载表和校验和一起更新，用 gh api --input 走生成的 JSON：');
console.log('gh api -X PATCH repos/<owner>/<repo>/releases/<id> --input "' + out + '"');
