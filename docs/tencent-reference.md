# 腾讯参考审查与首版差异

审查 [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)，固定 commit `a730701d36aa7a070f98d4cba0f340f91f15e5f5`，package version `2.0.3`。另从官方 npm registry 获取它使用的 `@tencent-connect/qqbot-nodejs@1.0.4` 源码包，只静态阅读，禁用 scripts，没有安装/执行 OpenClaw 或导入其推理后端。

SDK tarball integrity：

```text
sha512-gU5HySLplczZXMUjM7NtiUACY7YfX9YlI/R9PKzCLMgLmHvwsX9L2sitsrYPMentGUr9b8NLfSaSTsndF77NBA==
```

## 已实际阅读的模块

| 参考文件 | 核实内容 | 本桥接的取舍 |
| --- | --- | --- |
| `src/gateway/qqbot-gateway.ts` | QQBot 实例、token prefetch、Webhook 和 gateway 两种入口、session 持久化、OpenClaw 回复超时 | 只参考 QQ 协议，不接 OpenClaw backend |
| `src/adapter/webhook.ts`；SDK `protocol/transport/webhook*.ts` | unsigned op13 challenge、原始 body Ed25519 验签、ACK `{op:12,d:0}` | 加时间窗口、防重放；持久提交后 ACK |
| SDK `protocol/api/token.ts`、`api-client.ts`、`messages.ts` | access_token 缓存/刷新，QQBot Authorization，API/业务错误，msg_seq | 自己的简明 sender；固定 seq=1，不自动递增 |
| SDK `protocol/gateway/gateway-connection.ts`、`reconnect.ts`、`utils/session-store.ts` | `/gateway` URL、WebSocket HELLO/IDENTIFY/RESUME、heartbeat、session_id/seq、重连和终止行为 | 自行实现官方 `/gateway/bot` 公开协议；消息/seq 原子提交、单一持久租约、TLS/DNS 固定 IP；真实权限待验证 |
| SDK `protocol/gateway/event-dispatcher.ts` | C2C `author.user_openid`、message_scene.ext 的 msg_idx/ref 等 | 身份与路由取标准 ID；不转发 auth_token/扩展鉴权字段 |
| `src/middleware/access-control.ts`、`src/adapter/pairing.ts` | allowlist 为空或 `*` 可放行、OpenClaw 动态配对 | 本桥接空白名单拒绝，只显式绑定一个主人，无配对流程 |
| `src/setup/login.ts`、`src/setup/finalize.ts` | connector 的 `startQrConnect` / `qrConnect` 返回 app 凭据及可选 `userOpenid`，随后写 OpenClaw 配置 | 只核实可选官方扫码路线；本桥接缺主人 ID 必须拒绝，未导入/执行 connector，不自动登记 Webhook |
| `src/features/msgid-cache.ts` | 群聊 5 分钟、C2C 30 分钟缓存最近消息 ID | SQLite 持久指定入站 ID，不用“最近一条”路由 |
| `src/outbound/reply-limiter.ts`、`outbound-service.ts` | 默认四次/1 小时限制器、可退为主动消息、任意 to 目标 | 单入站一答、默认 240 秒、不允许主动降级或调用方指定目标 |
| `src/gateway/lifecycle.ts`、`src/outbound/deliver-pipeline.ts` | 生命周期清理、媒体交付 | 仅借鉴停机需求；不添加群聊/附件/媒体 |

参考代码的 C2C 身份、签名和 ACK 与官方协议一致，但不是安全策略的直接模板。OpenClaw 的动态配对、空名单放行、最近 ID 路由和主动 fallback 与本项目的主人限定要求冲突。

## 两组官方主机与回复窗口

| `QQ_API_PROFILE` | Token | 消息 API | 依据 |
| --- | --- | --- | --- |
| `documented`（默认） | `https://api.bot.qq.com/app/getAppAccessToken` | `https://api.bot.qq.com` | 当前 QQ 官方网页文档 |
| `tencent-sdk` | `https://bots.qq.com/app/getAppAccessToken` | `https://api.sgroup.qq.com` | 上述固定版本腾讯 SDK 与参考 gateway 默认值 |
| `tencent-sandbox` | `https://bots.qq.com/app/getAppAccessToken` | `https://sandbox.api.sgroup.qq.com` | QQ 官方接入指南的专用沙箱环境 |

配置只允许这三种枚举，没有任意 API URL，也不在失败时悄悄试另一个主机。三者均由离线测试核实 body、authorization 和绑定 route；没有真实请求，哪组适用当前账号仍是验收项。沙箱与生产使用独立数据库，防止旧排队记录被发往另一环境。

被动回复文档的 60 分钟/5 分钟表述与参考的 30 分钟缓存/1 小时计数器不一致。缓存 TTL 或客户端 limiter 不能证明平台允许的回复期限。首版只用 240 秒安全余量，配置上限 300 秒，发送前再次检查，不自动尝试逾期主动消息。

## SDK 复用判断与许可

Webhook 不引入腾讯 SDK。长连接加入了与该 SDK 一致的 `ws@8.21.0` MIT 依赖，固定版本/integrity；自行实现已公布的 QQ Gateway 协议以保留严格主人、原 ID 回复、受控网络及原子接受策略，没有导入腾讯 SDK 或 OpenClaw 模型/backend、媒体 pipeline、主动 fallback。

参考 gateway 保存 seq、分派 onMessage 不等待本桥接队列的耐久提交；所以直接拷贝 WS 代码不能获得本项目的“持久接受后确认”。需要单独验证 reconnect/resume 和 crash gap；WebSocket 只是减少 QQ 公网入站依赖，不能证明当前 dot 的 Events/OAuth 或云端队列已可用。

参考仓库为 MIT，许可中的版权主体见 [固定版本 LICENSE](https://github.com/tencent-connect/openclaw-qqbot/blob/a730701d36aa7a070f98d4cba0f340f91f15e5f5/LICENSE)。SDK npm 包声明 MIT。本版未复制或打包这些运行时代码，也未改写原仓库许可证；今后如复制实质代码须保留对应版权与 MIT 许可，若引入依赖须复核具体包版本的许可与维护状态。

扫码使用的是另一个包 `@tencent-connect/qqbot-connector@1.2.0`，不能从参考仓库或 qqbot-nodejs 的 MIT 许可推断其许可。本轮从官方 registry 下载只读审查 package.json、README、公开 d.ts 及文件列表：npm/package 标为 `UNLICENSED`，没有 LICENSE；没有阅读/复制其混淆运行实现、安装或执行 connector。已准备公开接口的受控向导，真实扫码待单独许可审查和授权；细节与 integrity 见 [connection.md](connection.md)。官方流程见 [Agent 接入](https://bot.q.qq.com/wiki/agent-qqbot/)。
