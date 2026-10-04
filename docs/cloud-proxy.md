# 云环境现有代理支持

本改动不创建代理、凭据、域名或公网入口，不修改系统代理/网络设置。固定 QQ 平台请求使用 Node 24.15+ 自带 HTTPS Agent 的 proxyEnv；callback 使用另述的共享传输契约，没有声称 Node 内置代理已满足 callback 的安全约束。本次没有安装 npm 依赖。

## 三条严格分开的网络路径

1. 固定平台请求：只有可信源码调用点显式传入 purpose: provider 才启用现有 HTTPS_PROXY/https_proxy。仍须同时匹配代码固定官方域名和调用点 hosts 白名单。api.bot.qq.com、api.sgroup.qq.com、sandbox.api.sgroup.qq.com、bots.qq.com。保留原主机名 TLS 验证，不跟随重定向，限制时限/响应体（平台 HTTP 默认 30 秒；回调仍默认 10 秒），并在连接前复核撤销条件。
2. MCP Events 回调：真实订阅 challenge 和队列 event 两个源码调用点都显式传入 purpose: callback，分派到本仓库 `packages/dot-bridge-transport` 的共享回调传输。它使用自己的精确域名、DNS/IP/TLS 与代理契约检查，不能借用固定 QQ 平台代理通道。已有 managed proxy 却缺受支持 callback adapter 时，在 DNS/请求前明确拒绝，不能绕开环境代理偷偷直连。
3. OAuth/JWKS 与原 Sites 路径：继续原有调用目的、DNS/IP 校验和连接方式，本次不扩展其代理信任或鉴权范围。

平台代理负责解析固定的官方服务主机。这是受限、明确的信任边界变化，不声称与任意回调的 IP 固定等价；它依赖云环境已有、可信且获准的代理。代理可能观察连接元数据，若环境终止 TLS，也可观察流量；没有额外启用 TLS 拦截或关闭证书校验。

只采用现有 HTTPS_PROXY，遵循小写优先。配置非法或不支持的代理协议时报错，不直接重试。若现有 NO_PROXY/no_proxy 匹配目标，则拒绝该请求，防止隐式绕过代理；不会修改或删除进程环境设置。错误不输出代理 URL、认证信息或原始底层异常。

## 长连接

QQ：代理 WSS 同时要求已有精确 Gateway 白名单和代码固定官方域名。自定义 Gateway 主机不能借此进入代理路径；没有获准支持的主机时失败关闭。直接连接模式仍使用原 DNS/IP 校验。握手超时、TLS 检查、不跟随重定向、禁用压缩与帧大小上限保留。

## 已验证范围

- 本地 HTTP CONNECT 代理 + 临时合成 TLS 服务：HTTPS 请求及 WSS 回显均真正经过代理。
- 测试覆盖目的地越界、重定向、响应过大、无效代理、NO_PROXY、撤销、TLS 拒绝、CONNECT 失败脱敏、相同官方域名的回调不走平台代理。
- 测试证书为每次运行临时创建，只在该测试 Agent 中信任；不改全局 CA。测试需本机 openssl。
- 无真实 QQ/飞书凭据、无 OAuth 授权、无真实消息。合成 WSS 成功不等于真实平台认证长连接成功。

callback 生产调用点已接到共享接口，不代表此云环境的 managed proxy adapter 已具备支持契约或真实可用。配置诊断与服务状态会给出固定枚举/布尔的 callback_transport；pending_callback_transport 时不能靠有效旧订阅启动 QQ。只有合成 adapter 测试通过时，仍只证明接线与拒绝边界，不证明当前 dot 签名 challenge、真实事件投递或 24 小时服务成功。

共享模块随本仓库保存在 `packages/dot-bridge-transport`，统一入口保存在 `packages/dot-bridge-tunnel`，部署时保留仓库内的相对模块布局。若同时使用 Lark，将 `dot-qq-bridge` 和 `dot-lark-bridge` 两个 Git 克隆放在同一父目录。每位使用者有自己的配置和凭据。没有布尔环境变量能够声称平台代理安全契约已获验证，也没有降级直连开关。

## Callback 状态与离线验收

`check_bridge_setup`、service preflight 和 service status 使用同一闭合对象 `callback_transport`，只含 `ready`、`mode`、`reason`、`proxy_configured`、`destination_binding`、`network_checked:false`。缺 adapter 的已有 managed proxy 报 `blocked/proxy_policy_unverified`；裸 custom send 或畸形状态报 `blocked/transport_unverified`。配置层 `ready:true` 仍不是网络验收。CLI 可以保留本地诊断监听，但不依赖旧持久订阅绕过此门禁。

callback 错误统一用 MCP `-32015` 与共享固定 reason code；原始异常、cause、代理认证、完整 callback URL 和消息内容不会进入错误对象。队列仍独立处理 408/429/5xx 的有界重试和 410 退订，共享传输不擅自重试。callback HTTP 默认最多 10 秒；请求体和响应体各最多 256 KiB；HTTP header 仍为 8 KiB。平台请求的原时限和其它网络路径未随此修改。

纯离线接线验收覆盖：真实 `createApp` 的签名 challenge 和 event 队列进入共享 managed fake adapter、2000 字中文正文、429 后相同事件重试、410 停止订阅、缺 adapter 时零 DNS/零 HTTP 创建、持久订阅重启时 Gateway 保持关闭、短 TTL 到期前连接门禁及错误脱敏。所有 DNS/adapter 都是合成注入；这不证明实际云代理或当前 dot 回调已经可用。

参考：https://nodejs.org/download/release/latest-v24.x/docs/api/http.html#built-in-proxy-support
