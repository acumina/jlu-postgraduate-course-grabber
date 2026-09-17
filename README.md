# 选课助手 · KX Grabber

> 仓库名：`jlu-postgraduate-course-grabber`　｜　扩展显示名：`选课助手 · KX Grabber`
> （`KX` = 「课选」的项目代号；扩展对用户显示的名字是「选课助手」。）

一句话定位：一个跑在**你自己的 Chrome 浏览器**里的 Manifest V3 扩展，用来抓包学习真实的选课请求 → 把请求模板化后重复发包 → 监控课程余量与选课 ID → 命中余量时自动抢课。

## 全新环境快速开始（4 步手动，其余全自动）

不需要 Node、不需要构建、不需要装任何依赖，也**不需要事先准备配置文件**（扩展内置了预设）：

| # | 你要做的 | 说明 |
| --- | --- | --- |
| 1 | `chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选本目录 | 一次性 |
| 2 | 打开选课网站（如 `yjsxk.jlu.edu.cn`）→ 面板 → 设置 → **配置导入/导出** → 点 **「载入内置预设」** | 一键配好生效站点、提交/查询模板、判定规则、运行页面限制。**这一步不能省**：默认白名单是空的，不载入预设面板就不会在这个网站上出现 |
| 3 | 在网站上**正常登录**（含验证码）→ 点进**选课页面** | 登录无法自动化（图形验证码），这是设计上的边界 |
| 4 | 面板 → **余量** 页 → 「查询一次(全量)」→ 搜课程名 → 勾选 → 「把勾选的加入监控」→ 点 **「启动」** | 之后一般不用再管 |

**载入预设之后自动进行的事**（你不用做）：

- **面板只在选课网站上出现**（预设里带了生效站点）
- **提交所需的一次性参数（csrfToken）自动取得**：取不到时自动让页面点一次「选课 → 确定」把它喂进来 —— 那次点击本身就是一次真实尝试，不浪费；你不需要手动点
- **掉线自动发现**：提交/探测返回 `HTTP 401`（约 1~2 秒内）或页面出现「未登录」文字 → 响铃 + 通知
- **掉线后自动开好登录页**（新标签页，不动正在跑的工作页）+ **光标自动放进验证码输入框** → 你只需敲 4 位验证码
- **登录后自动继续抢课**（不用手点启动）
- **页面/扩展重载后自动恢复抢课**（验证码这类主动停机除外，那种必须你手动确认）
- **会话存活时长自动实测校准**（不靠猜；实测活过推算值时会自动停用推算提醒，避免误报）
- **限速与自我保护**：每分钟请求上限、发包最小间隔、出现 429/未知错误自动退避、出现验证码自动停机
- **多目标公平轮转**（目标数超过每轮并发时靠游标轮转，不会有人被饿死）
- **日志自动合并**（同一目标的连续事件合并成一行 + `×N` 次数，不会刷屏）

**可选、需要额外环境的部分**（不装也能正常抢课）：

- `tools/collector.mjs`：本地收集器（需要 Node.js），把抓包和日志落到 `logs/` 并起一个状态页。**内置预设里默认关闭**（`debug.autoPush=false`），因为它只在"要排查问题、把日志发给别人看"时才有用。
- `mock/`、`tools/har2config.mjs`、`tools/find-token.mjs`：开发/调试工具，普通使用完全不需要。

## `logs/` 目录说明（不会随仓库分发）

- **不进版本库**：`.gitignore` 排除了它。里面是完整抓包与运行日志 —— 学号、姓名、会话令牌、你已选的全部课程都在里头，公开就是泄露。
- **不需要你手动创建**：新用户 clone 下来**不会有这个目录**（git 也不跟踪空目录），第一次跑收集器时**自动创建**：
  ```bash
  npm run collector                # 自动建 logs/ 并初始化文件
  node tools/collector.mjs --dir D:\somewhere\logs   # 也可以指定别处（会递归创建）
  ```
  这条行为有测试钉住（`test/collector.test.mjs`：目录不存在 → 启动后存在）。
- **收集器只监听 `127.0.0.1`**，不对外暴露；推送的数据在落盘前会**再脱敏一遍**（密码/验证码/学号/Cookie → `***`）。

## 课表档案（`archives/`）—— 选课未开也能先挑课

`archives/` 里随项目附带**学校公开课表快照**（例如 `jlu-yjsxk-courses-2026fall.json`，
147 门课，字段只有 课程名/班级名/课程代码/教师/校区/上课时间/容量/已选 —— **不含任何个人信息**）。

用途：
- **选课还没开的时候**就能在面板「档案」页浏览、搜索、挑目标（数据是本地快照，不需要登录）
- **下一年教学班代码变了**，用「按课程名重新解析目标」把 ID 找回（模糊匹配，存疑会让你选）
- 想自己更新：面板档案页 → 「导出为文件（下载）」 → 把 json 放进 `archives/` →
  `npm run archive-index` → 重载扩展

## 开源 / 发布前检查

这个项目处理的是你自己教务系统的**真实会话**，所以发布前务必扫一遍：

```bash
npm run scan -- --name 你的姓名     # 扫敏感信息（学号/姓名/密码哈希/令牌/Cookie…）
npm run prepare-publish             # 清空配置里的个人选课清单
npm run archive-index               # 重新生成课表档案索引
```

完整清单见 [`docs/PUBLISH.md`](docs/PUBLISH.md)（含"已经 push 了怎么办"）。

项目内已做的防护：

| 机制 | 作用 |
| --- | --- |
| 抓包自动脱敏（`src/lib/export.js`） | 密码/验证码/学号/Cookie 在推送与导出时就替换成 `***` |
| `.gitignore` | `logs/`、`*.har` 永不入库（里面是完整抓包：学号、姓名、已选课程） |
| `tools/scan-secrets.mjs` | 发布前最后一道闸，区分"高危泄露"与"测试里的示例数据" |

## 风险与合规提示（请先读这一段）

- 本工具只面向**本人在自己的账号上减少重复点击**的场景，不做身份伪造，不绕过登录，不篡改他人数据。
- 它的工作原理是「复用你浏览器里本来就会发出的请求」，这种行为**很可能与你所在学校选课系统的使用条款、教务处规定和系统风控策略相冲突**。
- 高频发包可能被判定为异常流量，后果可能包括：触发验证码、被限流（HTTP 429）、账号被临时封禁甚至纪律处理。**风险与合规责任完全由使用者自负**，作者不对任何后果负责。
- 请勿用于代抢、代人操作、对外提供抢课服务等用途。一旦系统出现验证码或异常提示，请立即停手。
- 建议先在非关键课程、非高峰时段小范围跑通流程，再考虑用于真正的抢课。

## 它能做什么

1. **抓包**：在选课页面上记录你手工操作时发出的请求（URL、方法、请求头、请求体、响应体），学习真实选课请求长什么样。
2. **模板化发包**：把其中一条请求存成「提交模板」，用 `{{id}}` 之类的变量把它变成可重复调用的动作。
3. **监控**：按配置的间隔查询课程余量与选课 ID，判断哪些教学班从「已满」变成「有名额」。
4. **自动抢课**：命中余量后自动提交，或者先让你在面板里确认再提交；成功/失败按规则判定并通知你。
5. **登录态看门狗**：针对选课系统常见的短会话限制，做存活时长实测校准、掉线即停机、自动打开登录页并把光标放进验证码框、重新登录后自动继续（详见下文专节）。

## 为什么是 Chrome MV3 扩展

- **复用已登录 Cookie**：扩展跑在浏览器里，发请求时天然带上你当前会话的 Cookie（含 `HttpOnly` 的会话票据），不需要你手工导出或复制任何凭据。
- **同源约束**：教务系统普遍依赖 `SameSite` Cookie 和 CSRF token、`Referer` 校验，脱离页面上下文的远程脚本很难正常发包；本扩展刻意让**页面自己**发请求（通过 MAIN world 桥接），最接近人工操作。
- **纯本地运行**：状态只存在 `chrome.storage.local`，不向任何服务器上传数据（只有你自己在 `notify.webhook` 里填了地址时，才会向那个地址推一条通知）。
- **零构建**：原生 JS，直接「加载已解压的扩展程序」即可，改代码不用打包。

声明的主要权限与用途：`storage`（保存配置、抓包记录与运行状态）、`tabs`（找到并管理作为工作标签页的选课页面）、`scripting`（注入 MAIN world 桥接脚本）、`alarms`（1 分钟一次的工作页看门狗）、`notifications`（桌面通知）；`host_permissions` 为 `http://*/*` 与 `https://*/*`，实际是否生效由 `sites` 白名单决定。

## 安装

1. 打开 `chrome://extensions`。
2. 打开右上角的**开发者模式**。
3. 点**加载已解压的扩展程序**，选择目录 `E:\Code\选课插件`。
4. 修改代码后：回到 `chrome://extensions`，在该扩展卡片上点**重新加载**（🔄）。
5. 重新加载扩展后，**必须刷新**已经打开的选课页面（内容脚本只在页面加载时注入），否则页面里既没有面板也没有抓包能力。

要求 Chrome 116 或更高版本。图标已随仓库提供（`icons/icon16.png`、`icon48`、`icon128`），需要重新生成时见「开发 / 自测」。

## 5 分钟上手流程

1. **加白名单**：打开学校的选课页面，点工具栏的扩展图标打开弹窗，点**「把当前站点加入白名单」**（已在白名单时按钮会变成不可点的「当前站点已在白名单」）。弹窗会提示「请刷新当前页面，面板就会出现」——**刷新页面**。
2. **认识面板**：刷新后页面**右上角**出现面板（收起时是一个小胶囊「选课助手」，点一下展开；按住标题栏可以拖到别处）。白名单为空时插件在任何站点都不会注入面板和引擎。
3. **抓包是自动开的**：内容脚本一启动就会开启记录（不需要点任何「开始抓包」按钮），记录的是页面自己发出的 `fetch` / `XMLHttpRequest`。所以第 2 步的刷新很关键——刷新之前的请求不会被记录。
4. **手工选一次课**：在页面上正常点一次「选课 / 提交」，走完真实流程——这一步是给你的模板提供样本，不要用假设的参数手写。
5. **设为提交模板**：切到面板的**「抓包」**页，找到那条真正提交选课的请求（一般是带教学班号的 POST），点它下面的**「设为提交模板」**；想连同余量查询一起配好，就对课表/余量那条点**「设为余量查询模板」**。拿不准就点**「详情」**看参数，或勾选两条不同课程的请求点**「对比找出变化的参数字段」**、再点**「这就是选课ID → {{id}}」**。
6. **加目标**：切到**「目标」**页，把选课 ID 粘进批量导入框（每行一条，格式 `选课ID,备注`），点**「导入上面这些」**。
7. **启动**：点面板右上角的**「启动」**（或弹窗里的「启动抢课」）。若 `submit.url` 还没配、或没有启用中的目标，启动会直接报错并告诉你缺什么。

## 界面速查（面板与弹窗）

面板共五个页签：

| 页签 | 主要按钮 / 内容 |
| --- | --- |
| **抓包** | 请求列表（方法、状态码、URL、耗时）；每条可「设为提交模板」「设为余量查询模板」「详情」「复制 cURL」；勾选 2 条以上可「对比找出变化的参数字段」「取消选择」，差值里的候选参数可一键标成 `{{id}}`；顶部还有「试一次余量查询」「清空」；详情里可把某个参数标成 `→ {{id}}` 或 `→ {{kch}}` |
| **目标** | 批量导入框 + 「导入上面这些」；「检测登录态」「我刚登录了」「打开登录页」（仅登录态失效时出现）；目标表格（ID / 备注 / 状态 / 次数）里可「停用 / 启用」「重置」「删」，`confirmBeforeSubmit` 打开时还会出现「确认提交」；启动 / 停止按钮 |
| **余量** | 「查询一次」、余量列表（ID / 课程 / 余量）、「加监控」（已在目标里则显示「已监控」）；没有配查询时提示当前是「盲发」模式 |
| **日志** | 最近若干条运行日志、「清空」 |
| **设置** | 引擎 / 会话 / 提交模板 / 判定规则 / 余量查询 / 通知 / 生效站点（每行一个主机名）/ 配置导入导出 各分组（「会话」分组标题为「会话 / 20 分钟硬超时」）；按钮有「对第一个目标试提交一次」「导出 JSON」「从下面的框导入」「恢复默认配置」 |

面板顶部显示状态文案（如「待机」「抢课中」「监控中（不自动提交）」「已定时：HH:MM:SS（N 秒后启动）」「已停止：…」）和「启动 / 停止」「收起 / 展开」。目标状态徽章包括：未开始、提交中、✔ 成功、等名额、有名额、未找到、重试中、等登录、已阻塞、已放弃、待确认。

工具栏弹窗显示：站点、状态、登录态（正常 / 已掉线 / 疑似过期 / 未检测，并显示剩余时间）、目标 / 已成功、抓包 / 提交次数。按钮有：**启动抢课**、**停止**、**显示/隐藏面板**、**检测登录态**、**我刚登录了**、**打开登录页**、**小窗工作台**、**新标签页打开**、**把当前站点加入白名单**。

## 先本地演练：内置模拟教务系统

仓库自带一个零依赖的假教务系统（`mock/server.mjs`，只用 `node:http`）。**建议先用它把整条链路跑通，再考虑碰真学校系统**——真账号上一次误配就可能白刷几百次请求，甚至触发风控。

```bash
node mock/server.mjs                  # 默认 http://127.0.0.1:8787，硬超时 20 分钟
node mock/server.mjs --ttl 120        # 登录 2 分钟就硬超时，方便测「掉线停机 → 重新登录自动继续」
node mock/server.mjs --no-auto-open   # 关掉「自动放名额」
node mock/server.mjs --port 9000      # 换个端口
```

它刻意复刻了真系统里最容易让插件翻车的四种行为：

| 模拟的行为 | 用来验证插件什么 |
| --- | --- |
| 登录满 N 分钟**硬超时**，到点所有接口 **302 跳 `/login`** | 掉线检测、自动停机、重新登录后自动继续（`session.autoResume`） |
| `选课成功` / `该教学班人数已满，请选择其他教学班` / `教学班不存在或参数错误` 三种响应 | `submit.rules` 的判定规则、已满时的退避 |
| 对同一门**已满**的课连刷 **3 次**后返回「请输入验证码」 | `stopOn.captcha` 自动停机 + 桌面/声音提醒 |
| 「数据结构」每 **20 秒**自动放出 1 个名额 | 「查询到余量 → 模拟发包 → 抢到」的完整闭环 |

三步上手：

1. `node mock/server.mjs` 启动，浏览器打开 `http://127.0.0.1:8787` → 点**「一键登录」**（模拟统一身份认证跳转）→ 点「去选课页」。
2. 点插件图标 → **「把当前站点加入白名单」** → **刷新页面**（面板出现在右上角）。然后在假系统页面上点一次**「手工查询余量」**和一次**「手工选课」**——这两条请求会出现在面板「抓包」页，分别点**「设为提交模板」**和**「设为余量查询模板」**。
3. 切到「目标」页，粘下面两行后点**「导入上面这些」**，再点「启动」：

   ```
   2099000001,数据结构（等自动放名额）
   2099000003,编译原理（永远满，用来测验证码停机）
   ```

   预期结果：`编译原理` 先被判「已满」，连刷 3 次后触发验证码并**自动停机 + 响铃**；`数据结构` 每 20 秒放出的名额会被**自动抢到**。

观察和排查：

- `http://127.0.0.1:8787/__state` 返回 JSON：当前会话剩余时间、各教学班余量、每个 ID 被刷了多少次，以及最近的请求日志——排查「插件到底发了什么」时很有用。
- `http://127.0.0.1:8787/xk/remain` 是 HTML 表格版的余量表，专门用来练 `query.parse.type = regex` 的写法。
- 测掉线恢复：用 `--ttl 120` 启动，等 2 分钟让面板提示掉线并停止，再点**「打开登录页」**重新登录一次，插件应当自动继续抢。

**所有数据都在内存里（重启进程即重置），服务只监听 `127.0.0.1`，不对外暴露。** 强烈建议先在它上面跑通，再去真系统。

## 两种运行模式

### 一、先查余量再抢（`query.enabled = true`）

引擎先用 `query` 模板轮询余量接口，根据 `query.parse` 解析出 `{id, name, remain}` 列表；只有在列表里**查到该目标且 `remain > 0`** 时才提交。

- 优点：请求量小、目标明确，不会对已满的课反复发包。
- 代价：需要额外搞清一条「查余量」的请求；如果查询接口本身有缓存或频率限制，可能读到旧数据。
- 注意：**查不到 ID 的一轮不会盲发**（该目标被标成「未找到」并跳过），这是为了防误提交。

### 二、盲发模式（`query.enabled = false`）

不做查询，直接按 `engine.intervalMs` 对每个目标 POST `submit` 模板，用 `rules.full` 判断「是不是已经满了」，满了就等下一轮，再用 `rules.success` / `rules.dup` 确认成功。

- 优点：只需要一条请求（就是那条选课请求），配置最省事。
- 代价：请求量明显更大，更容易撞限流或验证码。**请务必保留 `minGapMs` / `maxReqPerMinute` 的硬保护，并把间隔调得保守一些。**

把 `engine.submitOnHit` 关掉就是第三种用法：**只监控不提交**——命中名额时置为「有名额」并通知你，你回页面自己点。想零风险又不想盯屏幕，建议先用这个模式。

## engine 参数含义

| 参数 | 含义 |
| --- | --- |
| `intervalMs` | 一轮轮询的基础间隔（默认 1500ms）。代码里会钳制到 300–600000ms。 |
| `jitterPct` | 间隔抖动百分比（默认 25），实际等待 = 基础间隔 ×(1±抖动)，避免固定节奏；钳制到 0–80。 |
| `maxConcurrent` | 一轮里最多处理几个目标（默认 2）。目标按 `priority` 从小到大排序，`priority` 缺失按 99 处理。 |
| `submitOnHit` | 命中「有余量/非满」时是否自动提交。`false` = 只监控提醒。 |
| `confirmBeforeSubmit` | 提交前是否需要在面板点「确认提交」。 |
| `maxAttemptsPerTarget` | 每个目标的最大尝试次数，`0` 表示不限制；超限后目标置为「已放弃」。 |
| `minGapMs` | 两次发包之间的最小硬间隔（默认 300ms），钳制到 100–10000ms。 |
| `maxReqPerMinute` | 每分钟请求上限（默认 120），钳制到 5–3000；超限时引擎会等待并记一条「触发限速保护」。 |
| `backoff.onError` | 连续出错的退避倍数（默认 2，上限 ×32）；HTTP 429/503 直接 ×4（上限 ×64）。成功一次即复位。 |
| `backoff.maxMs` | 单轮等待上限（默认 30000ms），钳制到 1000–600000ms。 |
| `stopOn.captcha` / `logout` / `closed` | 命中对应判定时是否自动停机，默认都是 `true`。 |
| `stopOn.error` | 配置里有这一项（默认 `false`），但**当前实现未使用**：连续出错只做退避，不会因此停机。 |
| `scheduleAt` | `'HH:MM:SS'` 定时开抢（本地时钟）；当天该时刻已过则顺延到次日。留空表示手动启动。 |

## 20 分钟硬超时的应对

**先说结论**：你实测学校的系统是「**登录满 20 分钟硬超时**」（到点就失效，跟你有没有在操作无关）。对硬超时来说，定时发心跳请求救不了会话——所以 `session.keepAlive.enabled` 的默认值是 **`false`**。配置项仍然保留着：如果日后你发现其实是「空闲超时」，把它打开就能起到续期作用（届时探测会按 `keepAlive.method` / `headers` / `body` 发，并按 `keepAlive.cacheBuster` 自动加 `_kx=<时间戳>` 防缓存）。

针对硬超时，插件做的是三件正经事：

**① 倒计时与提前预警（注意：这是「估算」，不是精确测量）。** 内容脚本每 15 秒检查一次：以 `auth.loginAt`（推定登录时刻）加上 `session.hardTimeoutMs`（默认 1200000ms = 20 分钟）推算剩余时间，显示在弹窗与面板的「目标」页里。剩余时间进入 `session.warnBeforeMs`（默认 3 分钟）时，弹一次桌面通知 + 提示音：**「登录即将过期」**（只提醒一次，不刷屏）。到点后状态转为「疑似过期」，引擎**立即停机**并主动探测一次确认。

> **为什么是"估算"，以及它曾经出过的 bug。** 插件**看不到你的登录动作** —— 登录发生在 SSO 域，而内容脚本只注入白名单站点，所以它只能拿「自己最后一次确认会话有效的时刻」当锚点往前推。早期实现把这个锚点无条件持久化并沿用，于是出现过一个真实缺陷：**你刚重新登录，它却提示"还剩 3 分钟过期"**（甚至几分钟后误停机）——因为它还在拿上一个会话的旧时刻算。
>
> 现在锚点在两种情况下会**作废重算**（`KX.authAnchorDecision`，有回归测试锁住）：
> 1. **检测到你刚去过登录页**：background 在 `tabs.onUpdated` 里发现你访问了「非白名单主机 + URL 命中 `session.loginUrlRe`」，就写一个一次性标记；你回到选课站点后内容脚本据此把锚点清零。窗口由 `session.loginFlowWindowMs`（默认 30 分钟）控制。
> 2. **锚点太久没被确认**：`observedAt`（最后一次确认会话有效的时刻）超过 `session.loginAtStaleMs`（默认 10 分钟）没有更新 → 说明中间发生过插件看不到的事（浏览器关过、隔夜、锚点来自上次会话）→ 作废。
>
> 锚点作废时**不会**给出剩余时间（也就不会误报），首次探测成功后重新起算。任何时候你都可以在面板「目标」页点 **「我刚登录了」** 精确校准 —— 提示语和面板里都会写明「按 hh:mm:ss 登录 + 20 分钟推算，插件探测推定 / 你手工校准」，所以估算一旦不准你能立刻看出来。

**② 检测到掉线立刻停机，不发无效请求。** 每一次发包（提交/查询/探测）的返回都会过一遍登录态判定：

- HTTP 状态码命中 `session.logoutStatus`（默认 `[401, 403]`）；
- 最终 URL 命中 `session.loginUrlRe`（默认 `/(login|sso|cas|auth)/`，且与请求地址不同 → 被重定向到登录页），此时会把该 URL 自动记进 `session.loginUrl`；
- 响应体命中 `session.loginMarkers`（默认正则匹配 `name="password"`、`请输入密码`、`统一身份认证`、`请先登录`、`登录已超时`、`重新登录`、`账号登录`、`用户登录`；因 `loginMarkersOnRedirectOnly` 默认为 `false`，所以不只是重定向时才算）。

命中就停机并通知，避免拿着失效会话继续刷出一堆报错请求。另外 `session.requireLoginBeforeSubmit`（默认 `true`）会在提交前再兜一道：登录态已失效时目标置为「等登录」而不是继续发包。

**③ 重新登录后自动继续。** `session.autoResume` 打开时（默认 `true`），掉线停机后每 `session.recheckMs`（默认 30 秒）探测一次登录态；一旦探测成功，就通知「登录成功 / 已自动继续抢课」并自动重启引擎。**跨页面刷新也能恢复**：待恢复标记 `resumePending` 与登录态信息写在 `chrome.storage.local` 的 `kx_runtime` 里，页面加载时内容脚本会先探一次（约 2.5 秒后），background 在 `tabs.onUpdated` 里发现 `resumePending` 或状态为「已掉线」时也会补一次探测（带 5 秒去重，防多标签页同时探）。

**要诚实说明的几点：**

- 因为是硬超时，**长时间抢课必须由你本人定期重新登录**，插件没法替你延长会话。
- 插件**不保存、也不代填学号密码**：配置里没有任何账号密码字段，唯一需要你手填的是登录页地址 `session.loginUrl`（通常由一次掉线自动记住）。它只是把「打开登录页」这个动作变快，登录这一步始终是你自己做。
- 只有「登录相关」的停机才会自动继续；碰到验证码、未开放这类停机，引擎**不会**自动重启（自动重启只会继续往风控上撞），需要你处理后在面板点「启动」。

手动干预入口（面板「目标」页与弹窗都有）：

| 按钮 | 做什么 |
| --- | --- |
| **检测登录态** | 立即探测一次登录态（`probe`），成功则刷新登录时刻、必要时触发自动继续。 |
| **我刚登录了** | 把倒计时重新计时（推定登录时刻 = 现在），并把登录态标记为正常。它**只重置计时、不会自己启动引擎**；如果你是掉线停机后手工登录的，点完它再点「启动」。 |
| **打开登录页** | 跳转到已记住的 `session.loginUrl`（面板上仅在登录态失效时出现）。还没有记住地址时它会提示你先让它掉线一次，或在设置里手工填 `session.loginUrl`。 |

### `session.*` 全字段速查表

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `session.keepAlive.enabled` | boolean | `false` | 心跳保活开关。硬超时下无效，故默认关闭；确认是空闲超时再打开。 |
| `session.keepAlive.url` | string | `''` | 心跳/探测地址；留空则回退到 `query.url`，再回退到**当前页面地址**——**不会**回退到 `submit.url`（拿 GET 去捅选课提交接口既没意义，又可能被系统记成异常请求）。 |
| `session.keepAlive.method` | string | `'GET'` | 保活请求方法（仅在 `keepAlive.enabled` 时生效，否则探测一律用 GET）。 |
| `session.keepAlive.contentType` | `'form'\|'json'\|'raw'` | `'raw'` | 保活请求体类型（仅 `enabled` 且非 GET 时生效）。 |
| `session.keepAlive.headers` | object | `{}` | 保活/探测请求头（关闭保活时也会带上）。 |
| `session.keepAlive.body` | string | `''` | 保活请求体，支持模板变量。 |
| `session.keepAlive.intervalMs` | number | `240000` | 保活间隔（4 分钟）。只有在 `keepAlive.enabled` 为真时才参与计算：探测节奏取 `min(probeEveryMs, intervalMs)`；**引擎运行中一律再收紧到 2 分钟**（免得关键时刻正好撞上硬超时却没人发现）；掉线后改用 `recheckMs`。 |
| `session.keepAlive.timeoutMs` | number | `10000` | 探测请求超时（毫秒）。 |
| `session.keepAlive.cacheBuster` | boolean | `true` | GET 探测时自动加 `_kx=<时间戳>`，避免命中缓存。 |
| `session.hardTimeoutMs` | number | `1200000` | 硬超时时长（20 分钟），用于倒计时；`0` = 关闭倒计时。 |
| `session.warnBeforeMs` | number | `180000` | 距硬超时多久开始预警（3 分钟），只提醒一次。 |
| `session.loginAtStaleMs` | number | `600000` | 登录时刻锚点超过这么久（10 分钟）没被确认过就作废重算 —— 防止拿旧会话的时刻误报「还剩 3 分钟」。 |
| `session.loginFlowWindowMs` | number | `1800000` | 检测到你访问过登录页后，多久之内回到选课站点算「刚登录」（30 分钟），据此把锚点清零。 |
| `session.probeEveryMs` | number | `300000` | 正常状态下每 5 分钟做一次登录态体检；开启保活时与 `keepAlive.intervalMs` 取较小值，引擎运行中收紧到 2 分钟。 |
| `session.recheckMs` | number | `30000` | 掉线后每 30 秒探测一次是否已重新登录。 |
| `session.autoResume` | boolean | `true` | 重新登录成功后自动继续抢课。 |
| `session.requireLoginBeforeSubmit` | boolean | `true` | 登录态已失效时不再提交，避免无效请求。 |
| `session.loginUrl` | string | `''` | 登录页地址；检测到重定向时自动记住，也可手工填。 |
| `session.loginMarkers` | object | `{type:'regex', value:'…'}` | 「这是登录页」的响应体特征规则（默认匹配 `请输入密码`、`统一身份认证`、`请先登录`、`登录已超时`、`重新登录` 等）。 |
| `session.logoutStatus` | number[] | `[401, 403]` | 视为掉线的 HTTP 状态码。 |
| `session.loginUrlRe` | string | `'/(login\|sso\|cas\|auth)'` | 最终 URL 命中即视为被重定向到登录页。 |
| `session.loginMarkersOnRedirectOnly` | boolean | `false` | `false` = 响应体命中 `loginMarkers` 也算掉线（更敏感）；`true` = 只在重定向时才判定。 |

## 工作标签页与浏览器降频

引擎（轮询、判定、提交）刻意跑在**普通页面里**，而不是 service worker：只有页面同源发包才能带上 `SameSite` 会话 Cookie，而且 MV3 的 SW 会被浏览器随时回收，定时器不可靠。background 只做协调——登记工作标签页、更新角标、发通知、推 webhook、掉线后重新拉起页面。

代价是：**浏览器会降频后台标签页的定时器**，工作标签页被切到后台甚至最小化时，抢课节奏会变慢（引擎启动时如果发现 `document.hidden` 就会在日志里警告一次）。所以弹窗提供了两个按钮：

- **小窗工作台**：用 `chrome.windows` 开一个 470×360 的小弹窗窗口并置顶——窗口可见，定时器不会被降频，抢课节奏最稳。长时间挂机推荐这个。
- **新标签页打开**：在当前窗口新开一个标签页并激活，适合你想顺手操作页面的时候。

另外，工作标签页**被关掉**时：

- 关闭的瞬间，如果引擎正在运行，background 会立刻发通知「工作标签页已关闭 / 抢课已停止」（点通知可以聚焦工作页）。
- 之后每 1 分钟一次看门狗（`chrome.alarms`）会检查工作页是否还在；如果 `enabled` 为真或存在待恢复标记，且 `worker.autoOpen` 不是 `false`，就按 `worker.url`（留空 = `sites[0]` 的 https 首页）**自动重新打开**并通知「已自动恢复工作页」。注意它是用后台标签页打开的，节奏可能仍然被降频——想稳就用「小窗工作台」。

## 配置项速查表

来源：`src/lib/config.js` 的 `defaults()`（schema 唯一真源）。所有配置存在 `chrome.storage.local` 的 `kx_state` 键下。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 总开关，只有为 `true` 时引擎才会真的发包；点「启动」会自动置为 `true`。 |
| `sites` | string[] | `[]` | 生效站点白名单，按主机名后缀匹配（`a.b.c` 命中 `b.c`）；为空则任何站点都不激活。 |
| `worker.autoOpen` | boolean | `true` | 工作标签页没了是否自动拉回（看门狗里判断）。 |
| `worker.url` | string | `''` | 工作标签页地址；留空则用 `sites[0]` 的 https 首页。 |
| `engine.intervalMs` | number | `1500` | 轮询基础间隔（毫秒），运行区间 300–600000。 |
| `engine.jitterPct` | number | `25` | 间隔抖动百分比（0–80）。 |
| `engine.maxConcurrent` | number | `2` | 一轮最多处理的目标数。 |
| `engine.submitOnHit` | boolean | `true` | 命中余量时自动提交。 |
| `engine.confirmBeforeSubmit` | boolean | `false` | 提交前需要人工点「确认提交」。 |
| `engine.maxAttemptsPerTarget` | number | `0` | 每目标最大尝试次数，`0` 为不限。 |
| `engine.minGapMs` | number | `300` | 发包最小硬间隔（100–10000ms）。 |
| `engine.maxReqPerMinute` | number | `120` | 每分钟请求上限（5–3000）。 |
| `engine.backoff.onError` | number | `2` | 出错退避倍数。 |
| `engine.backoff.maxMs` | number | `30000` | 退避等待上限（毫秒）。 |
| `engine.stopOn.captcha` | boolean | `true` | 命中验证码时停机。 |
| `engine.stopOn.logout` | boolean | `true` | 登录态失效时停机。 |
| `engine.stopOn.closed` | boolean | `true` | 不在选课时间时停机。 |
| `engine.stopOn.error` | boolean | `false` | 预留项，当前实现未使用。 |
| `engine.scheduleAt` | string | `''` | `'HH:MM:SS'` 定时开抢，空为手动。 |
| `query.enabled` | boolean | `false` | 是否启用「先查余量再抢」，`false` 即盲发模式。 |
| `query.url` | string | `''` | 余量查询接口地址。 |
| `query.method` | string | `'POST'` | 查询请求方法。 |
| `query.contentType` | `'form'\|'json'\|'raw'` | `'form'` | `form` 自动加 urlencoded 头；`json` 自动加 application/json、空体变 `{}`；`raw` 完全由你写头。 |
| `query.headers` | object | `{}` | 查询请求附加头（请求时还会自动带上 `X-Requested-With: XMLHttpRequest`）。 |
| `query.body` | string | `''` | 查询请求体，支持 `{{id}}` 等模板变量。 |
| `query.parse.type` | `'json'\|'regex'\|'none'` | `'json'` | 余量响应解析方式。 |
| `query.parse.path` | string | `''` | JSON 数据路径，如 `data.list`、`rows`；支持 `a.0.b`、`a[0].b`、`a.*.b`。 |
| `query.parse.idField` | string | `''` | 选课 ID 字段名，如 `jxb_id`；留空按常见命名自动猜。 |
| `query.parse.remainField` | string | `''` | 余量字段名，如 `remain`、`syrs`；留空自动猜（也支持「容量 − 已选」两列相减）。 |
| `query.parse.nameField` | string | `''` | 课程名字段名，如 `kcmc`。 |
| `query.parse.regex` | string | `''` | `type=regex` 时使用的正则，支持命名组 `id` / `remain` / `name`。 |
| `query.parse.idGroup` | number | `1` | 正则里第几个捕获组是 ID。 |
| `query.parse.remainGroup` | number | `2` | 正则里第几个捕获组是余量。 |
| `submit.url` | string | `''` | 选课提交接口地址。 |
| `submit.method` | string | `'POST'` | 提交方法。 |
| `submit.contentType` | `'form'\|'json'\|'raw'` | `'form'` | 提交请求体类型，语义同 `query.contentType`。 |
| `submit.headers` | object | `{}` | 提交请求附加头（同样会自动带 `X-Requested-With`）。 |
| `submit.body` | string | `''` | 提交请求体模板，例：`jxb_id={{id}}&kch_id={{kch}}&xkkh={{xkkh}}`。 |
| `submit.vars` | object | `{}` | 固定变量表，用来放 `xnm` / `xqm` / `xkkh` 这类每学期不变的值。 |
| `submit.rules.*` | object | 见下节 | `success`/`full`/`dup`/`captcha`/`logout`/`closed` 六条判定规则。 |
| `targets[].id` | string | 无（必填） | 要监测/提交的**选课 ID**，渲染成 `{{id}}`。 |
| `targets[].label` | string | `''` | 备注名（导入格式里的第二列），渲染成 `{{label}}` / `{{name}}`。 |
| `targets[].kch` | string | `''` | 课程号，渲染成 `{{kch}}`。 |
| `targets[].enabled` | boolean | `true` | 该目标是否参与本轮（面板上的停用/启用）。 |
| `targets[].priority` | number | `1` | 优先级，数字小的先处理（缺失时按 99 排）。 |
| `notify.desktop` | boolean | `true` | 桌面通知。 |
| `notify.sound` | boolean | `true` | 提示音。 |
| `notify.webhook` | string | `''` | 可选：企业微信/钉钉机器人地址（发 `msgtype=text` 结构），留空则只做本地通知。 |

模板变量：`{{id}}`（目标选课 ID）、`{{kch}}`（目标课程号）、`{{label}}` / `{{name}}`（备注名）、`{{ts}}`（当前时间戳）、`{{rand}}`（随机串），以及你在 `submit.vars` 里自定义的任意键。

`submit` 与 `query` 各有三个**高级字段**：`via`（默认 `'fetch'`，用页面 fetch 重放；极少数只认 XHR 的系统可改成 `'xhr'`）、`timeoutMs`（单次请求超时，默认 `15000`）与 `referrer`（默认 `''` = 用当前页面地址，浏览器自动带）。它们在 schema（`defaults()`）里，但面板设置页没有对应输入框，需要**「导出 JSON」→ 改这几个值 → 「从下面的框导入」**。发送时插件还会自动补上 `X-Requested-With: XMLHttpRequest`，并过滤掉 `Cookie`/`Content-Length`/`Host`/`Origin`/`Referer`/`sec-*` 这些**浏览器自己会处理或禁止手工设置**的请求头 —— 所以 `Referer` 不需要抄进配置；万一系统非要校验某个特定来源地址，才用 `referrer` 指定（同源才生效，跨源会被浏览器剥掉）。

另有一个**按目标变化**的参数槽位：如果提交请求里除了选课 ID 和课程号，还有第三个「每个教学班都不一样」的值（典型是 `xkkh`），就在该目标上写 `vars`：

```json
"targets": [{ "id": "2099000001", "label": "数据结构", "kch": "CS101", "vars": { "xkkh": "2024-2025-1-1" } }]
```

`targets[].vars` 会与 `submit.vars`（全局固定值）一起参与 `{{xxx}}` 替换，且**优先级更高**；内置的 `{{id}}`/`{{kch}}`/`{{label}}` 则由目标字段自动填。`tools/har2config.mjs` 的分析报告会把所有「键相同、值不同」的参数都列出来，方便你判断哪个该进 `{{id}}`、哪个该进 `{{kch}}`、哪个该进 `vars`。

## 判定规则

规则引擎实现在 `src/lib/rules.js`，每条规则形如 `{ type, value }`，`type` 可取：

| type | 语义 |
| --- | --- |
| `regex` | 响应文本匹配正则（默认 `i` 忽略大小写），默认规则都用这个。 |
| `contains` | 响应文本包含 `value`。 |
| `notContains` | 响应文本不包含 `value`。 |
| `empty` | 响应体为空（去空白后长度为 0）。 |
| `status` | HTTP 状态码等于 `status`（缺省比较 `value`，再缺省为 200）。 |
| `always` / `never` | 恒真 / 恒假，用于临时禁用某条或强制某条命中。 |

`submit.rules` 的六种判定及其默认正则：

| 判定 | 默认值 | 作用 |
| --- | --- | --- |
| `success` | `选课成功\|成功\|SUCCESS` | 认定抢课成功，目标置为「成功」并通知。 |
| `full` | `已满\|容量已满\|人数已满\|余量为0` | 名额已满，目标置为「等名额」，等下一轮（盲发模式靠它判断）。 |
| `dup` | `已选\|重复选择\|已经选过` | 已经选过，视作完成，不再重复提交。 |
| `captcha` | `验证码\|滑块\|captcha\|verify` | 触发验证码，**风控信号**。 |
| `logout` | `未登录\|登录超时\|重新登录\|session` | 登录态失效，需要你去重新登录。 |
| `closed` | `未开放\|不在选课时间\|选课已结束` | 当前不在选课时间窗口。 |

判定优先级是：`captcha` → `logout` → `closed` → `dup` → `full` → `success`（**成功放最后当兜底**）；都不命中且 HTTP 状态码不在 200–399 之间时记为 `http` 错误，否则记为 `unknown`（会记一条「结果无法判定，请检查 success 规则」的日志）。

> **为什么成功要放最后**：你可以把 `success` 规则取得很宽松（例如「HTTP 200 且响应里没有失败特征就算成功」，本项目的配置文件就是这么配的）。这种宽规则会匹配任何响应；如果它排在前面，「容量已满」就会被它抢走、误判成成功。
> 配合 `engine.keepPollingAfterSuccess`（默认 `true`，判定成功后**继续轮询**这个目标）：「误判成功」的代价只剩一条通知（我们继续抢），而「误判失败」的代价是丢掉课程 —— 所以在"继续轮询"的前提下，成功规则就该往宽里配。

**命中 `captcha` / `logout` / `closed` 时，如果 `engine.stopOn` 里对应开关为 `true`（默认都是），引擎会自动停机并推送通知**，提醒你回到页面人工处理。这是刻意设计的「保命符」：遇到验证码或掉登录还继续硬发，只会让风控更快盯上你的账号。其中只有「登录相关」的停机会在重新登录后自动继续，验证码/未开放类停机需要你人工处理后再点「启动」。

## 抓包自动落盘（不用手工导出 HAR，推荐）

除了手工在 DevTools 里导出 HAR，更省事的做法是让插件把抓到的请求**自动写进项目目录**，之后直接读文件即可：

```powershell
node tools/collector.mjs          # 本地收集器，监听 http://127.0.0.1:8790（只绑本机）
```

1. 面板 → **设置 → 「本地抓包落盘」** → 收集器地址填 `http://127.0.0.1:8790/kx/captures` → 勾上 **自动推送抓包**（建议连 **运行日志** 一起推）
2. 正常在页面上操作一次「选课」，抓到的请求会攒批（默认 1 秒）自动推过去；「抓包」页的 **推送** 按钮可随时手动推
3. 落盘成三个文件：

| 文件 | 内容 |
| --- | --- |
| `logs/kx-captures.jsonl` | 一条一行（`method` / `url` / `reqHeaders` / `reqBody` / `resp` / `status`），便于 grep 和逐条看 |
| `logs/kx-captures.har` | 同一批数据合成的标准 HAR 1.2 |
| `logs/kx-log.txt` | 插件推过来的运行日志（时间 + 级别 + 文本） |

4. 直接生成配置（`.har` 和 `.jsonl` 两种都能吃）：

```powershell
node tools/har2config.mjs logs/kx-captures.har --host 你的域名 --out kx-config.json --pretty
node tools/har2config.mjs logs/kx-captures.jsonl --out kx-config.json     # 也行
```

浏览器打开 `http://127.0.0.1:8790/` 能看到落盘条数、文件路径和最近 25 条请求。

**安全性（这块是刻意设计的）**：

- 收集器**只监听 `127.0.0.1`**，不对外暴露；`/kx/reset` 可一键清空。
- **Cookie / Authorization / Set-Cookie 一律被抹掉**，而且是两侧各抹一次：插件推送前抹一次（凭据连 127.0.0.1 都不发），收集器落盘前再抹一次（防有人直接 POST 原始记录进来）。被抹掉的头会记录在 `_redactedHeaders` 里，不会让你以为抓包丢了。
- background 里**硬性拒绝**非 `127.0.0.1` / `localhost` 的收集器地址，避免抓包被发到外部。
- 这个功能**默认关闭**，地址留空就完全不启用，不影响抓包与抢课。

**一个容易误会的点**：分析报告是**故意写到 stderr** 的，所以在 PowerShell 里会显示成红色错误文字。判断成功看是否出现 `已写出 …` 以及 `$LASTEXITCODE` 是否为 0，不是看颜色。

## 用 HAR 自动生成配置

如果你已经手工导出了 HAR（见 `docs/CAPTURE.md`），用法一样：

```bash
node tools/har2config.mjs capture.har --host jwxt.example.edu.cn --out kx-config.json
```

```bash
node tools/har2config.mjs capture.har --host jwxt.example.edu.cn --out kx-config.json
```

真实用法（`node tools/har2config.mjs --help`）：

```
用法：node tools/har2config.mjs <capture.har> [--out kx-config.json] [--host jwxt.example.edu.cn] [--pretty]
  <capture.har>  必填。DevTools → Network → 右键 → Save all as HAR with content
  --out <file>   把生成的 kx_state JSON 写入文件（省略则打印到 stdout）
  --host <host>  只分析该主机（多站点 HAR 时用），例：jwxt.example.edu.cn
  --pretty       缩进 2 空格输出，并把分析报告以 _report 字段写进 JSON；-h/--help 显示本说明
```

它读 HAR、按分数给请求分类（提交 / 查询 / 其它），用「结构相同的多条请求做差分」找出「键相同、值不同」的选课 ID 字段并模板化成 `{{id}}`，输出一份与 `defaults()` 同构的配置：

- **输出内容就是 `kx_state` 的值本身**，导入方式是 `chrome.storage.local.set({ kx_state: <文件内容> })`，或直接用面板设置页的「从下面的框导入」；用了 `--pretty` 时记得先删掉 `_report` 字段。
- 分析报告始终写到 stderr（人类可读）；**`enabled` 固定输出为 `false`**，即生成后不会自动发包。
- Cookie 不会被写进配置（浏览器自动携带），`Content-Length` / `Host` / `Origin` / `sec-*` 等头也会被过滤。
- **自动推断必须人工核对**：`submit.rules` 的六条文案仍是通用默认正则（要换成你真实响应里的原文）、`targets[].label` 大多是空的、`query.parse` 的字段名要逐项确认。工具自己会在报告末尾列出「必须在扩展面板里人工确认/修改的字段」。

## 开发 / 自测

```bash
node test/all.mjs             # 一次跑完全部自测：规则层 + 清单一致性 + 模拟系统契约，全部通过
node test/rules.test.mjs      # 只跑配置/规则/解析层自测
node test/manifest.test.mjs   # 只跑清单与文件一致性自测
node test/mock.test.mjs       # 只跑「本地模拟教务系统」的契约测试
node test/har2config.test.mjs # 只跑 HAR 转换工具的契约测试
node tools/make-icons.mjs     # 重新生成 icons/icon16.png、icon48.png、icon128.png
node tools/har2config.mjs --help   # 查看 HAR 转换工具的用法
node mock/server.mjs          # 启动本地假教务系统（见上文「先本地演练」）
```

根目录已经有 `package.json`（**零依赖**，只提供脚本，不安装任何包）：

| 命令 | 等价于 |
| --- | --- |
| `npm test` | `node test/all.mjs` |
| `npm run mock` | `node mock/server.mjs` |
| `npm run collector` | `node tools/collector.mjs` |
| `npm run har` | `node tools/har2config.mjs` |
| `npm run icons` | `node tools/make-icons.mjs` |
| `npm run har` | `node tools/har2config.mjs` |

（另有 `npm run test:rules` / `test:manifest` / `test:mock`，分别只跑其中一组。）

- **不要用 `node --test test/`**：`node:test` 的运行器会 spawn 子进程去抓输出，在禁止命名管道的受限沙箱里会直接报 `spawn EPERM`——那是环境限制，不是测试失败。请用 `npm test` / `node test/all.mjs`，或单独跑某个 `test/*.test.mjs`（`test/all.mjs` 就是在同一个进程里依次 `import` 各个测试文件：规则层、清单一致性、模拟系统契约、har2config 契约等）。
- `tools/make-icons.mjs` 是零依赖的最小 PNG 编码器，用来画扩展图标；图标是 `chrome.notifications` 发通知时必需的。
- 两个共享库 `src/lib/config.js`、`src/lib/rules.js` 是**普通脚本**（非 ES module），通过 `globalThis.KX` / `globalThis.KXRules` 暴露，所以内容脚本、弹窗、service worker 三处共用同一份实现，也能被 Node 直接 `import` 做自测。

自带假教务系统的启动参数、复刻行为与演练步骤见上文**「先本地演练：内置模拟教务系统」**一节，细节也可以看 `mock/README.md`。

## 常见问题排查

- **抓不到包**：内容脚本在 `document_start` 注入，桥接脚本则以 `<script src="chrome-extension://.../src/bridge.js">` 的形式注入页面 MAIN world（因此不受 `script-src 'unsafe-inline'` 限制，但页面 CSP 若彻底禁止外部脚本仍可能失败）。最常见的原因其实是**在安装/重新加载扩展之前就打开了页面**——刷新页面再试。另外，桥接只 hook `fetch` 和 `XMLHttpRequest`：用 WebSocket、`sendBeacon`，或表单直接提交（整页跳转）发出的请求抓不到，这类页面请用 DevTools 手工抓包（见 `docs/CAPTURE.md`）。
- **提交返回「成功」但课表没变**：多半是 `success` 正则太宽松，匹配到了「操作成功」这类无关文案；也可能是缺了某个上下文参数（学期、批次、`xkkh` 之类）。把 `submit.body` 与真实请求逐参数对比，必要时把这些固定值写进 `submit.vars`。
- **被限流（HTTP 429）或频繁弹验证码**：立刻停引擎。把 `intervalMs` 调到 3000–5000ms 以上、`jitterPct` 保持 25% 以上、`maxConcurrent` 降到 1、`maxReqPerMinute` 降到 30 以下；确认是不是同一账号开了多个插件实例在跑。
- **登录态失效/掉线**：默认会自动停机、每 30 秒探测一次，你重新登录成功后会自动继续。如果日志里反复出现「疑似过期」但你没掉线，多半是实际超时时间比 20 分钟短（或你点过「我刚登录了」把计时推后了），按 `docs/CAPTURE.md` 里的方法测一次真实超时时间，再把 `session.hardTimeoutMs` 改准。
- **想彻底关掉自动继续**：把 `session.autoResume` 关掉，掉线停机后就完全靠你手点「启动」。
- **面板挡住页面**：面板是 Shadow DOM 浮层、可拖动，点「收起」会缩成一个小胶囊；确认无误后也可以临时在 `chrome://extensions` 里关掉扩展，需要时再开。
- **开了很多标签页，只有一个在工作**：这是设计行为——引擎跑在**单一工作标签页**里，只有该标签页能带上同源 Cookie 发包。其他标签页只是普通页面；想让别的标签页当工作标签页，就在那个标签页里重新启动引擎。
- **抢课节奏忽快忽慢**：工作标签页在后台会被降频，用弹窗的「小窗工作台」把它变成一个可见小窗最稳。日志里出现「触发限速保护」则是 `minGapMs` / `maxReqPerMinute` 在起作用。
- **想复现问题又不想碰真系统**：`node mock/server.mjs` 起本地假教务系统（见上文「先本地演练：内置模拟教务系统」），它有硬超时、已满、验证码、自动放名额这些行为，用来验证「抓包 → 模板 → 自动抢到 → 掉线恢复」这条链路比在真系统上试安全得多。

## 目录结构

```
package.json           npm scripts（test / mock / collector / har / icons 等），零依赖
manifest.json          MV3 清单：权限、内容脚本、服务工作线程、弹窗入口、图标
src/background.js      Service worker（协调层，不跑引擎）：工作页登记、角标、通知、webhook、看门狗、页面加载后补探测、把抓包推给本地收集器
src/content.js         内容脚本（isolated world）：引擎、登录态看门狗、限速闸门、消息处理、运行时状态持久化、抓包攒批推送
src/bridge.js          MAIN world 桥接（web_accessible_resource）：hook 页面 fetch/XHR 录包，并以页面身份「重放」发包
src/panel.js           注入到页面里的悬浮面板（Shadow DOM，右上角、可拖动，五个页签：抓包 / 目标 / 余量 / 日志 / 设置）
src/popup.html/.js     工具栏弹窗：状态一览、启动/停止、登录态入口、小窗工作台、加白名单
src/lib/config.js      共享配置层：schema 唯一真源（defaults()）、storage 读写、模板渲染与变量拼装
src/lib/rules.js       共享规则层：响应判定与余量列表解析（纯函数）
src/lib/export.js      共享导出层：抓包记录 → HAR 1.2，统一抹掉 Cookie/Authorization 等凭据头
tools/har2config.mjs   抓包（HAR / 收集器 .har / .jsonl）→ kx_state 配置 的转换脚本（含分析报告）
tools/collector.mjs    本地抓包收集器：接收插件推送并落盘成 logs/*.jsonl + *.har（只监听 127.0.0.1，落盘前抹凭据）
tools/make-icons.mjs   零依赖生成 icons/*.png
logs/                  收集器落盘目录（运行后才产生，可随时删）
test/                  各层自测（rules / manifest / mock / har2config / panel / collector）+ all.mjs 汇总入口 + fixtures/ 样本
mock/server.mjs        零依赖的假教务系统 HTTP 服务（仅监听 127.0.0.1）
mock/README.md         假系统的使用说明与演练步骤
icons/                 扩展图标（16/48/128）
docs/CAPTURE.md        抓包实战指南
```

`manifest.json` 里的内容脚本按 `src/lib/config.js` → `src/lib/rules.js` → `src/lib/export.js` → `src/panel.js` → `src/content.js` 的顺序注入，`run_at` 为 `document_start`，且只在顶层框架运行（`all_frames: false`）。

## 调试技巧

- 在 `chrome://extensions` 里找到本扩展，点 **服务工作线程 / Service worker** 查看 SW 的控制台日志。
- 页面里的面板自带**「日志」页**，能看到每轮轮询、命中、退避、限速等待、停机原因和登录态变化的实时记录；弹窗底部也会显示最近几条。
- `chrome.storage.local` 里的键（DevTools → **Application → Storage → Extension Storage**）：
  - `kx_state`：全部配置（改坏了删掉即回默认值）
  - `kx_captures`：抓包记录（默认只保留最近 40 条）
  - `kx_runtime`：运行状态——每个目标的进度、统计、登录态、`resumePending`（自动继续的标记）
  - `kx_worker`：工作标签页的 tabId / windowId
  - `kx_ui`：面板位置、展开状态、当前页签
  - `kx_popup_log`：弹窗展示用的最近日志
- 引擎不发包时，按顺序确认：`enabled` 是否为 `true` → 当前主机名是否命中 `sites` → 是否已配 `submit.url`（用「只监控不提交」模式时改为检查是否配了 `query.url`）→ `targets` 里是否有启用中的 ID → 登录态是否为「已掉线」。
- 想只验证模板对不对，用设置页的**「对第一个目标试提交一次」**（会二次确认），确认无误再启动引擎。

## 免责声明

本项目仅用于学习和研究浏览器扩展与 HTTP 抓包的基本原理，以及在**本人账号**上减少重复操作。使用者应自行确认所在学校关于选课系统的使用规定，并自行承担全部后果。请勿用于任何形式的代抢、牟利或干扰他人选课的行为。
