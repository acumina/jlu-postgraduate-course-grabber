# DEV

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
