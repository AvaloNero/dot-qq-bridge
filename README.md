# dot-qq-bridge

QQ 官方机器人本人单聊文字 → 自建 MCP Events → **订阅所在的现有 OpenAI dot** → `reply_to_qq` → 同一 QQ 会话。

提供可运行的 Webhook 和可审查的官方 WebSocket Gateway 入站，复用同一主人白名单、持久队列和受限回复工具。HTTP 与真实本机 WebSocket 模拟闭环均通过。已有独立部署验证了当前 dot 经 Secure MCP Tunnel 调用 QQ/飞书只读工具，以及事件目录发现；**真实 Events 订阅、唤醒和 QQ/飞书消息往返仍未验收。** 模拟器的回答是固定测试数据。项目不调用模型 API，不读取 Cookie，不迁移或导出 dot 私有记忆。

## 立即运行离线验证

需要 Node.js **24.15+、低于 25**。依赖固定为 `ws@8.21.0` 与官方扫码 connector `@tencent-connect/qqbot-connector@1.2.0`，版本及 integrity 见 lockfile。无需填写任何账户凭据。在仓库根目录运行：

```powershell
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run check
npm test
npm run simulate
npm run simulate:gateway
npm run connect:qq -- --plan
npm run connect:qq -- --demo
```

Windows 如果 PowerShell 限制 `npm.ps1`，使用 `npm.cmd`。依赖下载只访问官方 npm registry；测试只在 loopback 开启临时 HTTP/WebSocket 服务，外部请求通过注入的模拟接收器完成，不会请求 QQ、OpenAI 或 OAuth。Gateway 模拟实际执行 HELLO、IDENTIFY、断线和 RESUME，重放后仍只创建一个事件和一份回复。连接向导的 plan/demo 不扫码、不保存凭据、不改主人绑定。

```json
{
  "mode": "OFFLINE_SIMULATION",
  "current_dot_connected": false,
  "real_qq_connected": false,
  "events_delivered": 1,
  "qq_replies": 1,
  "same_conversation": true
}
```

当前验证记录见 [docs/validation.md](docs/validation.md)。可选覆盖率检查：`npm run test:coverage`。

## 两个仓库的可移植部署

将本仓库与 `dot-lark-bridge` 克隆到同一个父目录。本仓库包含 `packages/dot-bridge-transport` 共享回调传输、`packages/dot-bridge-tunnel` 固定路由聚合器，以及 [可移植启动器](tools/tunnel-stack/README.md)。飞书从同级本仓库导入共享传输，不再依赖未受 Git 管理的第三个目录。部署布局、离线检查及交接边界见 [源码交接说明](docs/source-handoff.md)。

私人 Tunnel 模式在 Linux 使用文件所有者、权限、`O_NOFOLLOW`、`/proc/self/fd` 与进程锁保护；Windows 原生分支使用本地 NTFS、所有者/SYSTEM 私有 DACL 和固定句柄，见[安全平台层](packages/dot-bridge-platform/README.md)。Windows 离线结果不代表 Linux 或真实消息验收。每个操作者使用自己的 Tunnel、服务凭据、主人配对及插件，不复制其他部署的密钥或身份。

## 能力与约束

- 只收 `C2C_MESSAGE_CREATE`，只允许一个明确配置的 `author.user_openid`。未配置主人身份、MCP 主体或有效订阅时拒绝处理。
- QQ 回调按原始字节进行 Ed25519 验签，检查时间、防重放；验签成功且入站记录提交到 SQLite 后才 ACK。
- 可选择 `QQ_TRANSPORT=gateway`：从固定官方 API 获取 WSS 地址，校验 TLS/公网 DNS 并固定实际连接 IP；只在完整主人配置及有效 dot 订阅后连接。入站和恢复序号在同一事务提交，持久租约防止同库双接入；不开放 Webhook。
- 一个有效 dot 订阅，签名验证回调地址后持久保存；固定事件 `qq.message.created`，过滤参数仅为 `{"conversation":"owner"}`。
- `get_qq_message` 读取本订阅已投递尝试的消息与状态；`reply_to_qq` 只接受已验证 `message_id` 和纯文本。收件人从数据库确定，不能传 QQ 号或任意目标。
- `check_bridge_setup` 是受同一 MCP 鉴权保护的只读配置诊断。可报告缺失设置和回调主机名，不输出 URL 路径/查询/secret，不发请求或自动批准主机；身份完整但白名单为空时仍展示事件，订阅会给出可操作的拒绝提示。
- 一条入站最多一份回答，重复相同回答幂等；固定原 `msg_id` 和 `msg_seq: 1`，不降级为主动消息。
- 默认 240 秒回复期限、每分钟 10 条入站/回复、队列 100 项、有界重试。QQ 发送结果不确定时停止自动重发。
- 群聊、附件、引用、富媒体、主动消息和自动执行付款/删除/外部写入不在首版范围。事件文字只是数据；当前 dot 的其他工具权限仍须在 ChatGPT 中单独约束和确认。

## 服务启动

离线测试不需要 `.env`。使用独立 HTTP 服务前，阅读 [接入与授权清单](docs/activation.md)，复制模板并由操作者在本地秘密存储中填入已获授权的配置：

```powershell
Copy-Item .env.example .env
npm start
```

空模板保持 `AUTH_MODE=deny`，且缺少 `STORAGE_KEY` 会拒绝启动。代码和本次开发没有生成账户凭据、绑定真实身份或创建长期权限。`AUTH_MODE=dev` 仅供 synthetic fixture 调试，要求 loopback、无 `PUBLIC_ORIGIN`；生产采用现有 OAuth 发行方签发的 RS256 JWT。此仓库实现资源服务器验证，不实现或创建 OAuth 发行方。

| 路径 | 用途 |
| --- | --- |
| `POST /mcp` | MCP 2.0 HTTP、工具和事件订阅；必须鉴权 |
| `POST /qq/webhook` | QQ 公网 HTTPS 回调，由 QQ 协议验签；不使用浏览器登录 |
| `GET /.well-known/oauth-protected-resource/mcp` | OAuth 资源元数据，OAuth 模式下提供 |
| `GET /healthz` | 存活检查，`200` 不代表真实互通 |
| `GET /readyz` | 配置及有效订阅检查；没有订阅为 `503`，也不证明模型已回答 |

持久库只读状态：`npm run status`。不要打开公共管理页面或直接修改队列来重发。

QQ 官方沙箱选择 `QQ_API_PROFILE=tencent-sandbox`，同时使用独立 `DATABASE_PATH`，例如 `data/sandbox.sqlite`；token 请求走 `bots.qq.com`，回复只走 `sandbox.api.sgroup.qq.com`。正式环境选择适用的 production profile，禁止共用已绑定环境的数据库。

可试用的渠道交接与具体授权见 [docs/handoff.md](docs/handoff.md)。官方长连接及连接向导步骤见 [docs/connection.md](docs/connection.md)。扫码包 `@tencent-connect/qqbot-connector@1.2.0` 按官方 README 公开 API 以普通依赖接入，固定版本与 integrity。其 metadata 为 UNLICENSED，不被本项目 MIT 许可覆盖；无内部源码复制。独立扫码入口、用户确认和未验证项见 [docs/official-qr.md](docs/official-qr.md)。授权后的已有官方凭据 + 已验证主人 openid 路线不依赖这个包。

## 架构、协议与交付物

- [docs/architecture.md](docs/architecture.md)：持久队列、认证边界、去重、故障语义。
- [docs/protocol.md](docs/protocol.md)：核实的官方协议与限制。
- [docs/activation.md](docs/activation.md)：真实 QQ、OAuth、当前 dot 接入的最小清单及验收项。
- [docs/deployment.md](docs/deployment.md)：持续托管、TLS、固定出网、存储和停机运行指南。
- [docs/tencent-reference.md](docs/tencent-reference.md)：腾讯参考模块、端点与回复窗口差异、SDK 复用判断及许可证。
- [docs/connection.md](docs/connection.md)：长连接和离线向导。
- [docs/handoff.md](docs/handoff.md)：主线程云端交接、认证边界和最少授权。
- `plugin/`：按官方 Agent Plugins 结构编写的手动接入模板，远程地址为保留的 `.invalid` 占位符；尚未注册或安装。
- `Dockerfile`：持续容器托管模板，尚未构建、部署或选择收费服务。

官方 [MCP Events](https://developers.openai.com/plugins/build/mcp-events) 描述了现有 dot 的订阅入口；[连接 ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) 描述了 MCP 注册及插件测试步骤。QQ 使用 [官方开放平台协议](https://bot.q.qq.com/wiki/)。本仓库按文档实现，并将账户可用性、公网回调、当前 dot 行为及 Sites 托管能力保留为真实联调验收项。

现有 MIT [LICENSE](LICENSE) 保持不变。参考审查见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 云环境代理兼容

固定官方平台请求使用独立代理路径；MCP Events 的 challenge 与 event 投递显式走共享 callback 传输，managed proxy 缺受支持 adapter 时在 DNS/请求前拒绝，不偷偷降级直连。OAuth/Sites 原路径不变。网络边界、共享组件部署和剩余限制见 [云环境代理支持](docs/cloud-proxy.md)。这不代表当前 dot 或真实平台已接通。

## QQ 云电脑已有账号诊断

新增[已有机器人只读诊断](docs/cloud-trial.md)：无秘密plan及用户本人控制的无回显、仅内存输入入口。需单独授权后才执行最多两个官方请求；不会接收或回复消息，也不代表当前dot已连接。

Native Windows private storage and finite-window supervision:
[platform boundary and tests](packages/dot-bridge-platform/README.md),
[portable stack configuration](tools/tunnel-stack/README.md). This does not
authorize reuse of saved keys or attest real current-dot delivery.

Official SDK scan: see [docs/official-qr.md](docs/official-qr.md).

Formal continuous service: [docs/persistent-service.md](docs/persistent-service.md).

Explicit tunnel/Sites mode contract: [docs/bridge-modes.md](docs/bridge-modes.md).

## 私有单主人 Tunnel 接入检查

新增显式 `AUTH_MODE=tunnel-service`，原默认 `deny` 和 OAuth 路径不变。仅适用于操作者确认只有自己拥有 Tunnel Use 权限的独立部署；不识别逐用户 ChatGPT 身份。以后分享代码时，每个人创建自己的 Tunnel 和凭据，不能共用本实例。

当前新增入口 `scripts/run-tunnel-readiness.js` 只运行空内存库与只读 MCP，QQ transport 必须 `disabled`，拒绝任何机器人/主人/回调绑定。独立服务 key 由官方客户端的 `mcp.extra_headers` 文件引用注入；不使用 OpenAI API key 当下游密码。详见 [私有 Tunnel 运行配置](docs/tunnel-runtime-setup.md)。

正式私有运行已完成离线实现：`TUNNEL_SERVICE_OPERATION=live` 必须显式选择，并通过官方 QR owner 凭据文件、独立存储 key 文件、私有数据库/模式锁与正式 CLI 确认。默认仍为 readiness，旧只读入口不能激活 live。回调白名单为空时只开放目录与设置检查；有效当前 dot Events 订阅建立前不请求 QQ。完整配置、文件格式、实际存储边界和待授权步骤见 [Tunnel live 运行说明](docs/tunnel-live.md)。本次实现不等于已部署或真实消息往返成功。
