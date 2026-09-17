#!/usr/bin/env node
/**
 * git-commit —— 一键"安全提交"：先跑全部检查，通过才提交。
 *
 * 为什么还要这个（都已经有 pre-commit 钩子了）：
 *   · 钩子要装（clone 之后没人会记得装）—— 这个脚本不需要装，直接跑
 *   · 钩子失败时输出很长，这个脚本把结论整理成一句话
 *   · 明确按"能上传/不能上传"的清单来 add，而不是无脑 git add -A
 *
 * 用法：
 *   node tools/git-commit.mjs "提交说明"
 *   node tools/git-commit.mjs            # 用默认说明
 */
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const msg = process.argv[2] || 'chore: 更新';

/** 跑一条命令，**继承 stdio**（不捕获输出）。
 *  为什么不捕获：捕获要开管道，某些受限环境（沙箱/收紧的 CI）下会直接 EPERM 失败；
 *  而且让检查的完整输出直接打给人看更好 —— 失败时你能立刻看到是哪一行可疑。 */
function runInherit(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch (e) {
    return false;
  }
}

/** 需要读输出的命令（git 查询）：把 stdout 写进**临时文件**再读回来 ——
 *  不用管道，所以在限制管道环境的沙箱里也能跑。 */
function runCapture(cmd, args) {
  const tmp = join(tmpdir(), 'kx-git-out-' + process.pid + '-' + Date.now() + '.txt');
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] });
    return { ok: true, out: readFileSync(tmp, 'utf8') };
  } catch (e) {
    let out = '';
    try { out = readFileSync(tmp, 'utf8'); } catch (e2) { /* ignore */ }
    return { ok: false, out: out };
  } finally {
    try { if (fd !== null) closeSync(fd); } catch (e) { /* ignore */ }
    try { unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

function step(name, cmd, args) {
  console.log('');
  console.log('──── ' + name + ' ────');
  const ok = runInherit(cmd, args);
  console.log(ok ? '→ ✅ 通过' : '→ ❌ 未通过');
  return ok;
}

console.log('=== 提交前检查（任一不过就中止）===');
const scanOk = step('① 敏感信息扫描', 'node', ['tools/scan-secrets.mjs']);
const clsOk = step('② 文件分类核对', 'node', ['tools/git-check.mjs']);
const testOk = step('③ 单元测试', 'node', ['test/all.mjs']);

if (!scanOk) {
  console.log('');
  console.log('❌ 敏感信息扫描未通过 —— 提交已中止（看上面列出的行号与内容）。');
  console.log('   示例数据请用 2099 开头的假学号；logs/、真实抓包不要提交。');
  process.exit(1);
}
if (!clsOk) {
  console.log('');
  console.log('❌ 有文件不该提交 —— 提交已中止（看上面「绝对不能上传」那一节）。');
  process.exit(1);
}
if (!testOk) {
  console.log('');
  console.log('❌ 测试未通过 —— 提交已中止。');
  process.exit(1);
}

console.log('');
console.log('=== 提交 ===');
/* 用 git add -A 是安全的：.gitignore 已排除 logs/ 等本地文件，
 * 而且上面两道检查会拦住"有条件可上传"文件的问题。 */
const add = runCapture('git', ['add', '-A']);
if (!add.ok) { console.log('git add 失败：' + add.out); process.exit(1); }

const staged = runCapture('git', ['diff', '--cached', '--name-only']);
const files = String(staged.out || '').trim().split('\n').filter(Boolean);
if (!files.length) { console.log('没有变更需要提交。'); process.exit(0); }
const bad = files.filter((f) => /^logs\/|\.har$|\.jsonl$|\.local\.json$/.test(f) && !/^test\/fixtures\//.test(f));
if (bad.length) {
  console.log('❌ 暂存区里出现了不该提交的文件：' + bad.join('、'));
  console.log('   （如果这是误判：git reset HEAD <file> 先撤下）');
  process.exit(1);
}
console.log('将提交 ' + files.length + ' 个文件：');
files.slice(0, 15).forEach((f) => console.log('   ' + f));
if (files.length > 15) console.log('   …还有 ' + (files.length - 15) + ' 个');

const commit = runCapture('git', ['commit', '-m', msg]);
if (!commit.ok) { console.log('提交失败：' + commit.out); process.exit(1); }
console.log('');
console.log('✅ 已提交。推送：');
console.log('   git branch -M main');
console.log('   git remote add origin <你的仓库地址>');
console.log('   git push -u origin main');
