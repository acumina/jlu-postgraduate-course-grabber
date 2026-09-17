#!/usr/bin/env node
/**
 * 安装 git hooks —— 让"含敏感信息的提交"根本提交不上去。
 *
 * 为什么需要：.gitignore 只是建议，`git add -f` 或手滑都能绕过；
 * 而 logs/ 里是完整抓包（学号、姓名、会话令牌、你已选的全部课程）。
 * 一旦 push 出去，删文件没用 —— git 历史里还在，必须改历史或删库重建。
 *
 * 装的钩子：
 *   pre-commit —— 提交前跑 ① 敏感信息扫描 ② 文件分类核对 ③ 单元测试（可跳过）
 *                 任一失败就**中断提交**
 *
 * 用法：
 *   node tools/install-hooks.mjs           # 安装（默认带测试）
 *   node tools/install-hooks.mjs --no-test # 安装但不跑测试（提交更快）
 *   node tools/install-hooks.mjs --remove  # 卸载
 */
import { writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(ROOT, '.git', 'hooks');
const HOOK = join(HOOKS, 'pre-commit');
const args = process.argv.slice(2);
const NO_TEST = args.includes('--no-test');
const REMOVE = args.includes('--remove');

if (!existsSync(join(ROOT, '.git'))) {
  console.error('这里还不是 git 仓库 —— 先 git init');
  process.exit(1);
}
mkdirSync(HOOKS, { recursive: true });

if (REMOVE) {
  if (existsSync(HOOK)) { rmSync(HOOK); console.log('已卸载 pre-commit 钩子'); }
  else console.log('没有装过钩子');
  process.exit(0);
}

const script = `#!/bin/sh
# 由 tools/install-hooks.mjs 生成 —— 提交前拦截敏感信息
# 想临时跳过：git commit --no-verify（不推荐；跳过就等于这层保护没了）

# 这个项目用扩展**不需要 Node**，只有开发/提交才需要。
# 没装 Node 时给个明确提示并放行 —— 否则别人 clone 下来会被一个跑不动的钩子卡住。
if ! command -v node >/dev/null 2>&1; then
  echo "[pre-commit] ⚠ 没找到 node，跳过敏感信息检查。"
  echo "             强烈建议装 Node 后再提交（这层保护就是为了防止把学号/令牌推上 GitHub）。"
  exit 0
fi

echo "[pre-commit] ① 扫描敏感信息…"
node tools/scan-secrets.mjs
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 发现高危敏感信息，提交已中断（看上面列出的行号）。"
  echo "   示例数据请用 2099 开头的假学号；logs/ 等本地文件不要提交。"
  exit 1
fi

echo "[pre-commit] ② 检查文件分类…"
node tools/git-check.mjs
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 有文件不该提交（见上面「绝对不能上传」），提交已中断。"
  exit 1
fi
${NO_TEST ? '' : `
echo "[pre-commit] ③ 跑单元测试…"
node test/all.mjs > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "❌ 测试未通过，提交已中断（跑 node test/all.mjs 看详情）。"
  exit 1
fi
`}
echo "[pre-commit] 通过 ✅"
`;

writeFileSync(HOOK, script, 'utf8');
try { chmodSync(HOOK, 0o755); } catch (e) { /* Windows 上可能失败，无所谓 */ }

console.log('已安装 pre-commit 钩子：' + HOOK);
console.log('');
console.log('它会在每次 git commit 前执行：');
console.log('  ① node tools/scan-secrets.mjs   —— 扫敏感信息（学号/姓名/密码哈希/令牌/Cookie…）');
console.log('  ② node tools/git-check.mjs      —— 核对"哪些文件能上传"并体检有条件可上传的文件');
if (!NO_TEST) console.log('  ③ node test/all.mjs             —— 跑单元测试');
console.log('');
console.log('任一失败 → 提交中断（含敏感信息就提交不上去）。');
console.log('确实需要临时跳过：git commit --no-verify');
console.log('');
console.log('提示：.git/hooks 不进版本库 —— 别人 clone 之后需要自己跑一次本脚本。');
