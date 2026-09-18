# tools/migrations —— 一次性迁移脚本（历史记录）

这里的脚本**已经跑过了**，配置里已经包含它们改动的结果。留着是为了：
1. 记录"为什么这么配"（每个脚本头部都写清了当时的事故与取舍）
2. 你的配置如果从旧版本升级过来，可以再跑一次

**新用户不需要运行这些** —— 直接加载扩展即可，配置文件已经是最终状态。

| 脚本 | 做了什么 | 原因（都有真实事故） |
| --- | --- | --- |
| `fix-config-enabled.mjs` | 删掉配置里的 `enabled` 字段 | 它被误当成配置，导入一次就把"用户想让引擎跑"的意图冲成 false |
| `add-burst-cap.mjs` | 加 `engine.burstCap`（令牌桶容量） | 标签页被隐藏时 Chrome 把定时器限到每分钟 1 次，需要一个可调的突发容量 |
| `add-mine.mjs` | 加 `mine`（已选课程接口），删 `drop` | "选上没选上"要以**已选课程列表**为准（权威判据）；退课不做自动化 |
| `disable-preopen-login.mjs` | `autoOpenLoginBeforeMs` 置 0 | 按推算值"提前打开登录页"会在没掉线时刷屏 |
| `set-resolve-policy.mjs` | 设定模糊找回门槛与同名班策略 | 设计要求：门槛放低（抢错能退课），同名班一起抢、不自动收手（成功判定不可靠） |

运行方式（在项目根目录）：

```bash
node tools/migrations/set-resolve-policy.mjs
```

> 注意：这些脚本会**直接改写** `kx-config-吉大研究生选课.json`，跑完记得
> `node tools/make-preset.mjs` 同步内置预设，并重载扩展。
