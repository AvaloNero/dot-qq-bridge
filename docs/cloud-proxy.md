# 云环境现有代理支持

本改动不创建代理、凭据、域名或公网入口，不修改系统代理/网络设置。固定 QQ 平台请求使用 Node 24.15+ 自带 HTTPS Agent 的 proxyEnv；callback 使用另述的共享传输契约，没有声称 Node 内置代理已满足 callback 的安全约束。本次没有安装 npm 依赖。

## 三条严格分开的网络路径

1. 固定平台请求：只有可信源码调用点显式传入 purpose: provider 才启用现有 HTTPS_PROXY/https_proxy。仍须同时匹配代码固定官方域名和调用点 hosts 白名单。api.bot.qq.com、api.sgroup.qq.com、sandbox.api.sgroup.qq.com、bots.qq.com。保留原主机名 TLS 验证，不跟随重定向，限制时限/响应体（平台 HTTP 默认 30 秒；回调仍默认 10 秒），并在连接前复核撤销条件。
2. MCP Events 回调：真实订阅 challenge 和队列 event 两个源码调用点都显式传入 purpose: callback，分派到本仓库 `packages/dot-bridge-transport` 的共享回调传输。它使用自己的精确域名、DNS/IP/TLS 与代理契约检查，不能借用固定 QQ 平台代理通道。已有 managed proxy 却没有注入项目 callback adapter 时，在 DNS/请求前明确拒绝，不能绕开环境代理偷偷直连。`managedAdapter` 是项目自己的 DI 接口，不是需要等待发布的官方同名组件。
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

必须区分以下证据：

- `pending_callback_policy` 表示项目未配置 callback 域名白名单；QQ 的展示顺序可能先显示它，同时 transport 仍为 blocked。
- `proxy_policy_unverified` 表示代码识别了代理配置但没有 adapter，在 DNS/HTTP 前主动拒绝。它既不是代理拒绝记录，也不能证明云产品不支持 callback。
- `proxy_unsupported` 也可能来自配置解析、NO_PROXY 或已选路由变化，是本地拒绝分类。
- `dns_failed`、`tls_failed`、`connection_failed` 只有与一次实际发送结果关联时才是该请求的网络证据。历史 provider 日志属于另一条发送路径。
- 注入 adapter 后的 `managed/delegated_unverified/network_checked:false` 只说明项目把传输交给了该代码，不证明代理最终目的地址或环境政策已验证。合成 adapter 与 `verified:true` 均不能提供这种证明。

## 2026-10-04 原生云环境的无网络检查

在原生云终端中，用正式 portable launcher 的 `environment()` 函数启动一次无业务凭据的元数据子进程。使用显式 Node 24.19.0；内置 Undici 7.29.0 仅为版本信息，callback sender 实际采用 `node:https.request`。代理选择为 `https_proxy`（HTTP scheme）、旁路规则变量为 `no_proxy`；未记录任何值、主机、凭据或 CA 路径。

发现父环境有 `NODE_EXTRA_CA_CERTS`，旧过滤器却丢弃它。修复仅保留已有的 `NODE_EXTRA_CA_CERTS` / `NODE_USE_SYSTEM_CA`，不设置新值，不转发完整 `NODE_OPTIONS` 或 TLS 禁用变量。相同原生检查中，默认 CA 从 120 变为 121，extra CA 从 0 变为 1；`NODE_USE_SYSTEM_CA` 当时未设置。两桥预检仍为 `blocked/proxy_policy_unverified`。这证明 CA 继承缺口与修复效果，不是 TLS 握手或回调成功的证据。

检查时没有 tunnel-client 进程，正式 8787–8789 端口没有监听；元数据检查未进行 DNS、HTTP、provider 连接或订阅。临时检查程序完成后删除。

## 2026-10-04 固定自有目标的单次连通性对照

后续在原生云终端中复用相同正式 `environment()` 与现有 Node HTTPS 代理 Agent，对经 Sites 元数据核实归属和部署源码的既有 Site 发出一次固定 `GET /mcp`。请求没有应用凭据、Cookie、正文或查询参数，客户端没有重定向或重试；既有平台代理可能使用其已有认证。该部署的 GET 源码固定返回空 405，但 Site 访问模式仍是 custom。

实测取得 HTTP response 回调中的 401，未取得应用预期的 405。Node 24.19 的 CONNECT 非 200 会走 `ERR_PROXY_TUNNEL` 错误路径，因此这次结果不能表述为 CONNECT 策略拒绝；与 Site 访问层要求认证相容，但没有保存响应身份信息，具体返回层未定位。一次性观察器在 `request` 的 socket 事件后挂接 `secureConnect`，而内置代理 Agent 可能已先完成 TLS，该事件未捕获不能当作 TLS 失败。

这个对照只增加了现有代理路径可取得真实 HTTP 响应的证据；不证明 MCP 路由、最终地址绑定、签名回调或 Events 唤醒。相同进程的正式 callback 预检仍为 `blocked/proxy_policy_unverified`。临时程序、结果文件和终端随后清理，没有启动桥接服务或创建订阅。

## Managed adapter 尚缺的底层依据

Node 的域名 CONNECT 与 Undici ProxyAgent 都把最终域名解析和拨号交给代理；本地 DNS 公网预查或 request lookup 不会绑定代理之后的目标。隧道 socket 的 `remoteAddress` 也不能证明最终目标。项目可自行实现 adapter，但要启用它，所用连接原语必须保留原域名政策并将最终公网校验与实际拨号绑定，且约束代理链、IPv4/IPv6 和每次重试。代理自身具备等效最终公网约束也可以作为依据，不要求存在一个官方名为 managedAdapter 的组件。

IP CONNECT 在客户端代码上可构造，但当前没有证据说明本执行环境同时按原域名实施政策；本项目未据此添加或启用 IP CONNECT。普通域名 CONNECT、HTTP 200、TLS 成功或 synthetic 测试均不能单独补齐上述保证。缺失的是这一个环境契约及相应项目 adapter 实现，不是已经实测失败或证明不支持。

源码依据：[Node 24.19.0 HTTPS](https://github.com/nodejs/node/blob/v24.19.0/lib/https.js)、[Undici 7.29.0 ProxyAgent](https://github.com/nodejs/undici/blob/v7.29.0/lib/dispatcher/proxy-agent.js)、[Node 24.19.0 TLS](https://nodejs.org/download/release/v24.19.0/docs/api/tls.html#tlsconnectoptions-callback)。适用范围见 [OpenAI agent security](https://learn.chatgpt.com/docs/enterprise/agent-security)；不能把其他 Codex 执行面的网络实现自动视作本 dot 云电脑契约。

callback 错误统一用 MCP `-32015` 与共享固定 reason code；原始异常、cause、代理认证、完整 callback URL 和消息内容不会进入错误对象。队列仍独立处理 408/429/5xx 的有界重试和 410 退订，共享传输不擅自重试。callback HTTP 默认最多 10 秒；请求体和响应体各最多 256 KiB；HTTP header 仍为 8 KiB。平台请求的原时限和其它网络路径未随此修改。

纯离线接线验收覆盖：真实 `createApp` 的签名 challenge 和 event 队列进入共享 managed fake adapter、2000 字中文正文、429 后相同事件重试、410 停止订阅、缺 adapter 时零 DNS/零 HTTP 创建、持久订阅重启时 Gateway 保持关闭、短 TTL 到期前连接门禁及错误脱敏。所有 DNS/adapter 都是合成注入；这不证明实际云代理或当前 dot 回调已经可用。

参考：https://nodejs.org/download/release/latest-v24.x/docs/api/http.html#built-in-proxy-support
