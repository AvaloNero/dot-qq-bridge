# 架构与安全边界

```mermaid
flowchart LR
  QQ[QQ 官方机器人 / 本人 C2C] -->|HTTPS 原始字节验签| Ingress[QQ Webhook]
  QQ -->|官方 TLS WSS / IDENTIFY 或 RESUME| Gateway[QQ Gateway / 单一持久租约]
  Ingress -->|主人白名单 / 提交后 ACK| DB[(SQLite WAL / 加密正文)]
  Gateway -->|主人白名单 / 入站与 seq 原子提交| DB
  DB --> Worker[常驻有界队列 Worker]
  Worker -->|Standard Webhooks 签名事件| Dot[已订阅的现有 OpenAI dot]
  Dot -->|OAuth / reply_to_qq / 入站 ID| MCP[MCP 2.0 HTTP]
  MCP -->|收件人由已验证记录确定| DB
  Worker -->|原 msg_id / msg_seq 1| API[QQ 被动回复 API]
  API --> QQ
```

桥接服务只搬运消息与受限回复，不拥有模型。dot 运行和保留自己的上下文；事件中只有消息 ID、`owner` 标签、原文字及回复截止时间，没有模型权限指令、QQ 私有鉴权字段、回调秘密或记忆。

## 入站与权限

1. 请求体限制 32 KiB；拒绝无效 UTF-8、压缩体与无效 JSON。
2. QQ 原始请求头及原始 body 验签，签名时间最多偏差 300 秒。`op:13` 是官方单独的回调验证入口，只签新鲜、限长的字母数字 challenge，不产生消息权限。
3. 只识别绑定的 AppID/Secret 和一个 `author.user_openid`。主人配置为空时拒绝；不动态配对、自动学习或接受 `*`。
4. 入站 ID、QQ 源事件 ID、签名重放记录、限流及事件 job 在同一 SQLite 事务提交，然后返回 `{op:12,d:0}`。重复已验证消息不会创建新的任务。
5. 没有有效 dot 订阅时返回失败，不存储等待以后导出的陌生历史。

Gateway 是另一种受信入站适配，不接受 HTTP 调用方提交“已验证”标记。先用固定 QQ token/API 地址发现 WSS，再对指定确切 hostname、公网 DNS、固定 IP、TLS 和禁止重定向做检查。它不使用 Webhook Ed25519 签名，真实性来自官方 API 发现及经验证的 TLS WSS 连接；同样限制 32 KiB UTF-8 JSON、主人、纯文本、截止时间和回环。

Gateway session ID 与 seq 加密存储；消息、限流、去重、事件 job 和 seq 在同一 SQLite 事务提交。暂时的订阅/容量/频控失败不前移 seq，断线后尝试 RESUME；故意拒绝的非主人/过期/非法输入只保存处理序号，不创建消息。session 无效时重新 IDENTIFY；恢复补发范围是 QQ 的平台保证，不能承诺长期离线不丢消息。缺少外层 event ID 时，适配器以已验证 session/seq 派生来源 ID，消息本身仍按原 QQ message ID 去重。

一个 60 秒持久租约、每五秒续期，阻止同库两个 Gateway 接收器；失去租约即停止，旧 token 不能提交 checkpoint。心跳只报告已提交 seq，缺 ACK 则重连；频控关闭等待一分钟，账号/协议致命关闭停止并等待操作者修复，不切换环境或扩大 intents。只订阅官方 `1 << 25`，此 intent 含 group/C2C，业务仍过滤所有群聊。

MCP OAuth 主体与 QQ 主人是两种身份，必须由操作者明确绑定。`clientInfo` 是自报元数据，不作为鉴权依据。数据库持久记录 AppID、主人和 MCP 主体；更换任意一项不能复用原数据库。沙箱/生产环境也明确绑定，切换环境使用独立库；旧版已有消息的库不能自动归为沙箱。

## 订阅与回调

订阅 ID 由已鉴权主体、回调 URL、事件名及规范化参数确定；仅一个活跃订阅。回调验证完成前不启用。刷新保持 ID，默认寿命一天，同时不超过当前 access token 有效期；到期停止。密钥轮换五分钟双签，验证成功缓存五分钟。

主人身份配置完整时允许发现事件，以便客户端发起首次订阅；回调白名单为空时仍拒绝该请求且不发出 challenge。拒绝结果和 `check_bridge_setup` 只向已认证主体显示 hostname 与人工配置步骤，不批准、保存或联系主机。主人身份缺失时事件仍隐藏。预检的 `configuration_ready` 只说明设置齐备，`network_checked:false`，不表示订阅或真实连接成功。

所有出站 HTTPS 都要求指定的确切主机名；回调域名白名单默认为空。真实 MCP challenge 与 event 投递都显式选择共享 callback transport。无代理时每次重新解析 DNS、拒绝非公网地址、固定审核 IP 并保留 TLS 主机名校验；有 managed proxy 时，必须有支持该安全契约的专用 adapter，否则在 DNS/请求前停止，不隐式直连。禁止重定向、URL 用户名密码、IP 字面量、fragment 和非 443 端口，保留时限和响应大小上限。callback_transport 只报告固定配置状态、network_checked:false，不证明真实连接。详细边界见 [云环境代理支持](cloud-proxy.md)；没有环境布尔值能替代受支持 adapter 契约。

## 持久队列与发送语义

SQLite `WAL`、`synchronous=FULL`、事务领取和随机 lease token 保护持久去重与工作领取。部署推荐一个常驻服务实例和本地持久卷；不是多副本分布式数据库架构。

| 类型 | 成功 | 安全重试 | 终止或需人工检查 |
| --- | --- | --- | --- |
| MCP event | 接收器 `2xx` 后 `delivered` | 网络/超时、408、429、5xx；稳定 eventId 和正文，新签名时间；最多 5 次 | 410 撤销订阅，413/3xx/其他拒绝不重试；到期丢弃 |
| QQ reply | JSON 正面回执 ID 后 `sent` | 发消息前的 token 请求失败；明确 HTTP 401/429，仍用原 msg_id/seq | 网络或超时、5xx、缺失回执 ID、进程在发送中中断为 `uncertain`；不自动重发 |

`pending` 表示工具已持久排队，不表示 QQ 收到。`sent` 表示 QQ API 返回消息 ID，不表示主人读到。事件 `2xx` 只表示接收器收到，不表示 dot 已执行或回答。网络无法保证跨 QQ 的绝对 exactly-once；首版优先避免重复，结果不确定时保留给操作者检查。

取消订阅使 pending/processing 任务失效，并在鉴权刷新和 DNS 解析后再次检查权限。已经发到网络上的请求无法撤回；已收到的 QQ 成功回执仍会如实记录。没有回执的已发请求是否到达需人工核实。更改主人配置需停机并按新绑定另建库，禁止将旧消息转交新主人。

默认回复窗口从 QQ 消息 timestamp 起 240 秒、可配置上限 300 秒；领取、工具入队及实际请求前均检查。超过期限不改为主动发送。队列容量 100、入站及回复各每分钟 10 条，状态持久化；限流等待不消耗远端发送重试次数。

## 数据与模型边界

消息/回复正文、Gateway session 及回调 URL、secret 用 AES-256-GCM 加密，并以记录类型/ID 作为 AAD。`STORAGE_KEY` 是独立的 32 字节密钥；更换错误密钥会拒绝打开库。身份、消息 ID、时间和状态仍可见，宿主磁盘、文件 ACL 和备份必须受控。

七天后将当前记录中的正文置空；去重 tombstone 长期保留，因此数据库大小仍会增长。历史 WAL 页、磁盘残留及旧备份不承诺被物理擦除，备份保留策略需另设。不要导出数据库作为 dot 记忆，也不要提交 `.env` 或请求体日志。

本桥接的接口无法付款、删除文件或调用其他收件人。它不能控制现有 dot 的其他插件、也不能仅靠工具 annotations 保证模型抗提示注入。QQ 文本中要求扩大权限、导出私有记忆或执行其他外部操作时，确认必须留在 ChatGPT。真正启用前必须审查 dot 的事件任务权限并完成负向验收。
