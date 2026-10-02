# 核实的协议

核实日期：2026-10-02。此表描述已实现的文档契约；真实账户与客户端互通仍见 [activation.md](activation.md)。

## MCP / OpenAI

使用 [MCP 2026-07-28 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) 与 [HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。这是 MCP 2.0：无 initialize/session，支持 JSON 完整响应，不提供 SSE 长流。

| 请求方法 | 实现 |
| --- | --- |
| `server/discover` | supportedVersions、tools/events capabilities、serverInfo、private catalog |
| `tools/list` | `get_qq_message`、`reply_to_qq`、只读 `check_bridge_setup` |
| `events/list` | 主人身份配置完整后返回 `qq.message.created` 和严格 input/payload schema；空回调白名单仍拒绝订阅 |
| `events/subscribe` | 仅 owner 过滤、webhook 模式；验证回调并存储订阅 |
| `events/unsubscribe` | 按原 name/arguments/delivery URL 授权且幂等撤销 |
| `tools/call` | 输入字段严格校验，持久幂等、无收件人字段 |
| `ping` | 空完整响应 |

每个请求必须带 `_meta["io.modelcontextprotocol/protocolVersion"]` 与 `_meta["io.modelcontextprotocol/clientCapabilities"]`，同时带对应的 `MCP-Protocol-Version` 和 `Mcp-Method` HTTP 头。`tools/call` 还需匹配 `Mcp-Name`。Accept 同时包含 `application/json` 与 `text/event-stream`。完整结果有 `resultType: "complete"` 和 serverInfo 元数据。旧协议、批量 JSON-RPC、轮询、流式订阅及历史 cursor 都不支持。

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) 是事件生命周期依据；其链接的 [Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) 用于核对类型、错误和 challenge。Events 仍是正在演进的接口，协议测试不能替代真实 dot 验收。

- 订阅 delivery 是 HTTPS URL 和 `whsec_` 密钥（base64 的 24–64 字节）。服务发送签名 `{type:"verification",challenge}`，接收器须 `2xx` 回传同一 challenge。
- 事件体为 `{eventId,name,timestamp,data,cursor:null}`。正文稳定，签名覆盖 `${eventId}.${unixSeconds}.` 和原始 body；带 Standard Webhooks 的 `webhook-id`、`webhook-timestamp`、`webhook-signature` 及 `X-MCP-Subscription-Id`。
- HMAC-SHA256 遵循 [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)。Secret 不进入事件 data；重试不换 eventId。
- `refreshBefore` 为有限 ISO 时间，不超过服务限制和本次鉴权过期时间。`ttlMs:null` 不授予永久权限。无历史 replay，cursor 始终 null；错过的入站不宣称可以恢复。
- 订阅刷新、过期、轮换、撤销及 410/413 等状态均有离线自动测试。未批准的订阅只向已认证主体返回 hostname、缺失设置名和人工审查提示，完整 URL/secret 不回显；预检不执行 DNS/网络检查。当前 ChatGPT 回调域名、实际刷新行为和事件任务唤醒均未测试。

OAuth 按 [OpenAI 鉴权指南](https://developers.openai.com/plugins/build/auth) 提供 protected-resource metadata，验证预先配置的 issuer/JWKS、RS256 签名、resource audience、单一 subject、scope、nbf/exp。不接受 token 自带的 jku/x5u，不把 scope 或 clientInfo 当作其他账户授权。现有发行方的 OAuth 2.1/PKCE、客户端注册和 ChatGPT 重定向支持需实际配置验证。

## QQ

依据 [QQ 官方文档](https://bot.q.qq.com/wiki/)：

- [Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)：公网 HTTPS 入站与 ACK。
- [签名](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)：Bot Secret UTF-8 重复至至少 32 字节再截断作为 Ed25519 seed；验 `X-Signature-Timestamp + 原始 body`，验证 challenge 签 `event_ts + plain_token`。官方示例公钥和签名向量已纳入测试。
- [C2C 事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)：`d.id`、`author.user_openid`、文字与 timestamp。`GROUP_AND_C2C_EVENT` intent 是 `1 << 25`，当前账户是否获准需控制台确认。
- [Access token](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)：`appId/clientSecret` 换 access_token；缓存、提前 60 秒刷新，检查 HTTP 200 中的业务错误。
- [C2C 回复](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)：`POST /v2/users/{user_openid}/messages`，`Authorization: QQBot ...`，msg_type 0、原 msg_id、固定 msg_seq 1。

文档正文中被动回复窗口存在 60 分钟与 msg_id 字段 5 分钟的不同描述；腾讯参考代码另有 30 分钟缓存和 1 小时限制器。首版采用更短 240 秒且只发一次，实际账户的允许窗口与 msg_seq 行为必须用沙箱确认。API 主机差异及 SDK 审查见 [tencent-reference.md](tencent-reference.md)。
