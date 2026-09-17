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

## 五、初始化并推送

```bash
git init
git add -A
git commit -m "feat: 选课助手 KX Grabber —— Chrome MV3 选课自动化插件（零构建、原生 JS）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/kx-grabber.git
git push -u origin main
```

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
