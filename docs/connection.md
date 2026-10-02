# QQ 长连接和连接向导

本轮只实现代码和离线验证，没有扫码、QQ 登录、凭据保存、真实主人绑定或部署。`Gateway` 指 QQ 官方 WebSocket 入站；模型与事件订阅仍属于现有 dot。

## 官方接口和许可核实

核实 [QQ WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[通用事件协议](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html) 和 [Agent 接入指南](https://bot.q.qq.com/wiki/agent-qqbot/)。Gateway 从官方 `/gateway/bot` 获取 WSS URL/连接配额，使用 `QQBot {access_token}`、`shard:[0,1]`、`intents:1<<25`；HELLO 给出毫秒心跳周期，READY 给出 session ID，RESUME 带已提交 seq。官方建议处理事件后记录 seq；本项目将消息与 seq 放入同一耐久事务。

官方 Agent 指南推荐扫码 SDK，但不能把其他腾讯包的 MIT 许可套用到它。实际下载并只读检查了官方 registry 的 `@tencent-connect/qqbot-connector@1.2.0`：npm metadata 与 package.json 均为 `UNLICENSED`，14 个文件中没有 LICENSE；README 没有独立许可条款。这里只报告可核实状态，适用的使用许可需由主线程确认。没有复制、导入、安装或执行它的运行代码，也没有推导它的私有扫码 REST 协议。

```text
Connector integrity:
sha512-FAOUCvgxP4M9UiYbHrtVgJ7BavSlh1CHJPjeEQuTAkP9MZ91lX4yATqv6I/lB9yp15nVq+G2DaGSSJwQTSoSsA==
```

其公开 API 为 `startQrConnect(callbacks, options) -> stop()` 和 `qrConnect(options) -> credentials[]`，公开类型包含 `appId`、`appSecret`、可选 `userOpenid`。已准备 `src/connection-wizard.js` 的回调适配接口：要求扫码授权及已审查许可依据、关闭 SDK 控制台打印、仅展示官方 QQ HTTPS URL、固定超时和可取消、停止轮询、脱敏失败、不自动保存。调用者必须明确确认唯一主人；缺 QR owner 时只接受独立验证的 QQ 消息身份，不能学习第一位发言者。多账户必须明确选择一项。这个接口尚未绑定真实 SDK。

Gateway 自行实现公开协议，唯一依赖为 MIT `ws@8.21.0`，不是 OpenClaw 或腾讯推理后端。依赖版本/integrity 固定在 `package-lock.json`，对应许可在 `licenses/ws-MIT.txt`。

## 无凭据向导

```powershell
npm run connect:qq -- --plan
npm run connect:qq -- --demo
npm run simulate:gateway
```

plan 列出官方入口、最少授权和许可阻塞。demo 注入 synthetic callback，只检验公开接口及清理，不创建二维码任务；输出 `real_scan_started:false`。Gateway simulation 使用实际 loopback WebSocket，包含断线/恢复/重复输入，再调用现有 MCP 工具回到同一模拟会话；两个真实连接标记均为 false。

真实 `--scan` 被 CLI 拒绝，不通过确认开关把未核实许可变成已允许。若已另行授权得到官方 SDK 的结果，可在受控本地文件里准备如下结构，再用 `npm run connect:qq -- --inspect FILE` 只读检查。下面全部是测试值：

```json
{
  "credentials": [{"appId":"fixture-app","appSecret":"fixture-not-a-real-secret","userOpenid":"fixture-owner"}],
  "selection": {"appId":"fixture-app","confirmedOwnerOpenid":"fixture-owner","ownerEvidence":"official-qr-response"}
}
```

检查只输出布尔状态和设置名称，不输出 ID/secret，不写 `.env` 或数据库，不验证文件来源或 QQ 账户是否真实；`credentials_valid` 只是格式和明确选择通过。缺 userOpenid 且没有独立验证身份时拒绝。真正配置仍须由已授权操作者从受控渠道写入秘密管理器；不要将真实文件放在仓库、命令参数或聊天中。

## 授权后选择 Gateway

已有官方机器人凭据和已验证主人 openid 可走此路线，不依赖扫码包。普通 QQ 号不能代替 app-specific openid；若官方控制台不提供 openid，必须先获得经主线程批准的签名消息取证或许可明确的扫码结果，不能空白名单启动长连接。

1. 主线程确认目标云运行时、认证、秘密管理及权限后，安装锁定依赖，配置 `.env.example` 的现有 OAuth 主体、QQ 凭据、唯一主人、storage key 和 callback 白名单。
2. 选择 `QQ_TRANSPORT=gateway`。沙箱选 `QQ_API_PROFILE=tencent-sandbox` 并使用独立库。`QQ_GATEWAY_ALLOWED_HOSTS` 默认仅为所选 API hostname；若官方发现返回其他主机，先独立核实再批准一个确切主机，不使用 wildcard，不回退未知 URL。
3. 启动 `npm start`。完整主人配置前拒绝启动 Gateway；有效现有 dot 订阅前处于 `waiting_subscription`，不请求 QQ token。按 [activation.md](activation.md) 接入原 dot 并创建签名验证通过的订阅，随后服务自动接入 QQ。
4. 只有 Gateway READY/RESUMED、有效订阅及配置同时成立，`/readyz` 才为 200。它只表示本服务可收取；真实答案是否来自原 dot 另行验收。
5. 本人在已批准沙箱发一句文本，确认原 dot 的事件任务及回复工具回到同一 C2C。检查关机/重启、陌生人、重复、超时和撤销；真实验收未完成前不宣称可用。

Gateway 模式 `/qq/webhook` 为 404，不需要腾讯的公网回调入口；MCP 仍保留认证。`heartbeat_timeout`、`connection_closed` 会有界退避；`blocked_account_or_protocol` 或 `blocked_configuration` 停止，操作者检查官方权限/主机/协议后重启。日志仅状态和数字关闭码，无 token/session/URL/正文。租约保护范围是同一 SQLite 数据库，仍只部署一个实例和一个持久卷。长期停机、QQ 无法恢复 session 或被动回复过期时可能丢失回复机会，不转主动消息。
