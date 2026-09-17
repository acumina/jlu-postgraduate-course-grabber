# 发布到 GitHub 前的检查清单

这个项目里**曾经出现过**真实学号、姓名、密码哈希、验证码、你已选的全部课程 ——
所以发布前请按这个清单走一遍。全部做完大约 5 分钟。

---

## 一、自动扫描（必做）

```bash
node tools/scan-secrets.mjs --name 你的姓名
```

- **退出码 0 且"高危"为 0** → 可以提交
- 有高危 → 按提示改掉（示例数据换成明显假的值，如 `2099000001`、全 0 哈希、`ab3d9`）
- `--all` 可以把 `logs/` 也扫一遍（看看里面有什么，但**不要提交它**）

它会检查：学号、姓名、密码哈希、明文密码字段、会话 Cookie、csrfToken/vtoken、
已选记录 WID、验证码明文、手机号、邮箱、身份证号。

> 扫描器有"严重级别"：真泄露（高危）才会让命令失败；测试/文档里的示例学号只提示，
> 否则一个被自己示例数据淹没的扫描器等于没有。

## 二、确认敏感文件不被提交

```bash
git status --short
```

**不该出现**：`logs/`、`*.har`、`*.jsonl`、`.edge-debug/`

`.gitignore` 已经排除它们。`logs/` 里是完整抓包与日志（学号、姓名、已选课程全在里面）。

## 三、清掉个人数据（必做）

```bash
node tools/prepare-publish.mjs       # 清空配置里的 targets（你的选课清单）
node tools/make-archive-index.mjs    # 重新生成课表档案索引
```

- `kx-config-*.json` 里的 `targets` 应该为空数组
- `archives/*.json` 是**学校公开课表**（只有课程/教师/时间/容量字段，无个人信息），可以一起开源
- 你浏览器里的目标列表**不会**被清空 —— 应用配置时会保留本地 targets

## 四、其它检查

- [x] `package.json` 的 `author`（Acumina）、`repository` / `homepage` / `bugs` 已填
      —— 如果 GitHub 仓库名不是 `kx-grabber`，把这三个 URL 一起改掉
- [x] `manifest.json` 也带了 `"author"`（会显示在 `chrome://extensions` 上）
- [x] `LICENSE` 版权行已填：`Copyright (c) 2026 Acumina`
- [ ] `README.md` 顶部「风险与合规提示」保留 —— 这类工具必须写清楚
- [ ] 确认没有把**别人的**课表/抓包一起提交（`archives/` 里只放公开课表）

> 关于版权行：`Copyright (c) <年份> <版权持有者>` 就够。持有者可以是真名、GitHub ID
> 或组织名 —— 用 handle（Acumina）完全合规且常见，不必写真实姓名。
> 年份写**首次发布**那一年；跨年更新可以写成 `2026-2027`。
> 不需要 `All rights reserved`（那是另一套模板的写法）。
> MIT 要求再分发时保留这份 LICENSE 与版权声明 —— 这正是你想要的：别人能用，但要署名。

## 五、创建仓库并推送

**本地已经准备好了**：git 身份已配（`acumina <邮箱>`）、SSH 已能连上 GitHub
（`ssh -T git@github.com` 会回 `Hi acumina!`）、分支已经是 `main`、remote 还没配。

### 第一步：在 GitHub 上创建**空**仓库

打开 https://github.com/new ，仓库名建议 `kx-grabber`，然后：

- **不要**勾选 "Add a README file" / "Add .gitignore" / "Choose a license"
  —— 本地已经有这些文件了，勾了会在 push 时冲突。
- 公开/私有随意（开源选 Public）。

> 本机装了 `gh`（2.98.0）但**没登录**。想用命令行建仓库就先 `gh auth login`，
> 然后一条命令搞定（会自动配 remote 并推送）：
> ```bash
> gh repo create kx-grabber --public --source=. --remote=origin --push
> ```

### 第二步：配 remote 并推送（用 SSH）

```bash
git remote add origin git@github.com:acumina/kx-grabber.git
git push -u origin main
```

> 仓库名不是 `kx-grabber` 的话，改这一行；同时把 `package.json` 里的
> `repository` / `homepage` / `bugs` 三个 URL 一起改掉（否则链接 404）。

### 关于提交里的邮箱（推送前是最后一次能低成本改的机会）

每个提交都会记录 `作者名 <邮箱>`，**push 之后任何人都能看到**。
当前用的是你本地 git 配的邮箱（`git config user.email` 可以查看，本文件刻意不写出，
免得把邮箱再抄一份到公开文档里）。

- 不介意公开 → 什么都不用做。
- 想隐藏 → 用 GitHub 的 noreply 地址（GitHub → Settings → Emails 里能看到，
  形如 `12345678+acumina@users.noreply.github.com`）：

```bash
git config user.email "12345678+acumina@users.noreply.github.com"
# 把已有 7 个提交的作者邮箱一起改掉（本地还没推送，改起来很干净）
git filter-branch -f --env-filter '
  export GIT_AUTHOR_EMAIL="12345678+acumina@users.noreply.github.com"
  export GIT_COMMITTER_EMAIL="12345678+acumina@users.noreply.github.com"
  export GIT_AUTHOR_NAME="acumina"
  export GIT_COMMITTER_NAME="acumina"
' -- --all
```

改完再 push。**一旦推上去再想改就得强推 + 别人已 clone 的副本不会跟着变。**

## 六、如果不小心推了敏感信息

**光删文件 + 再 commit 是没用的** —— 历史里还在，任何人都能 `git log -p` 看到。

处理方式：

```bash
# 方式一：改历史（推荐，保留仓库）
pip install git-filter-repo
git filter-repo --path logs --invert-paths          # 把 logs/ 从所有历史里抹掉
git filter-repo --replace-text <(echo '真实学号==>2099000001')   # 替换具体字符串
git push --force

# 方式二：删仓库重建（最干净）
# 在 GitHub 上删掉仓库 → 清理本地 → 重新 init/push
```

**并且：立刻改掉教务系统密码** —— 一旦密码哈希泄露且学校用的是无盐 SHA-256（这个系统就是），
等于密码明文泄露（网上有现成的彩虹表）。

---

## 项目里已经做的防护

| 机制 | 在哪 | 作用 |
| --- | --- | --- |
| 抓包自动脱敏 | `src/lib/export.js` | 密码/验证码/学号/Cookie 在**推送与导出时**就被替换成 `***` |
| 推送前二次脱敏 | `src/content.js` 的 `flushPush` | 即使抓包漏了，推送前再抹一遍 |
| 敏感信息扫描 | `tools/scan-secrets.mjs` | 发布前的最后一道闸 |
| `.gitignore` | 仓库根 | `logs/` 等永不入库 |
| 本地收集器只监听 127.0.0.1 | `tools/collector.mjs` | 不对外暴露 |
