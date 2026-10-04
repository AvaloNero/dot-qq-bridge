# QQ 云电脑：已有机器人只读诊断

此入口只推进 QQ 官方平台认证与 Gateway 发现，不冒充当前 dot 联通。无新 bot、扫码、消息收发、IDENTIFY、监听端口或持久凭据配置。

## 无秘密预览

`node scripts/qq-cloud-trial.js --plan`

不加载 .env，不读取凭据文件，不联网。正式 SDK 扫码入口已另行集成，见 [official-qr.md](official-qr.md)；实际扫码仍需明确授权。

## 下一步需要单独授权

指定已有 QQ bot 和 API profile，允许在云电脑内打开一次用户控制的无回显输入终端。本人在接管云电脑时输入该 bot 的 AppID/AppSecret，最后自己输入 RUN 提交；只进行一次官方 token 换取和一次 Gateway 查询，最多两个请求，每次最多30秒。不会保存配置、不收发消息、不生成新的持久访问权限。

入口：`python scripts/qq-private-diagnostic.py --profile tencent-sdk`

该示例的 profile 必须与此前已确认的账号环境一致；沙箱选择 tencent-sandbox，不能自动试完所有环境。终端只在得到上述授权后打开；不要把真实值放到聊天、命令行参数或仓库。

AppSecret 以无回显方式输入，仅在本次用户控制的进程及诊断子进程环境中使用，不落盘、不写命令历史。它不是产品秘密库，也不提供内存零化或对同用户进程的隔离保证。若需要持续运行，必须另外选择并批准安全秘密存储；本入口不能据此变成长驻配置。

诊断使用已有受信代理访问代码固定的 QQ 官方地址，TLS 和目标白名单保留；输出仅有步骤、HTTP状态及布尔结果。失败不重试、不换profile；结束释放内存token引用，不会打开WebSocket。

## 结果边界

provider_discovery_passed 仅表示 token/Gateway 查询成功，可能仍有零连接配额。它不验证主人openid、不建立真实Gateway、不读取C2C，不表示同一个 dot 已回答。

gateway_host_blocked 表示返回主机不同时满足精确配置和代码固定官方列表。不要自动新增主机；先核实官方账号配置。

provider_check_failed/cancelled_or_expired 只给出失败步骤和已收到的HTTP状态。去官方控制台核对账号/profile/IP白名单和权限，不输出原始响应、访问token或WSS查询参数。

要进入真实本人单聊闭环，仍须单一主人绑定、可验证MCP身份、受支持的MCP入口和原IP固定回调、当前dot有效订阅。现有Gateway对这些条件的启动门槛不变。
