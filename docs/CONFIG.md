# CONFIG

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
