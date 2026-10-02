# 本地验证记录

日期：2026-10-02。环境：Windows RMB16 工作区、Node `v24.15.0`。原仓库基于 `6a21cde`（只含现有 MIT LICENSE），新增代码没有覆盖已有实现；工作分支 `feat/qq-mcp-events-v1`。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 21 个 JavaScript 文件语法通过；package 和两个 plugin JSON 模板可解析 |
| `npm test` | 62 项测试通过；0 失败、0 跳过 |
| `npm run test:coverage` | 同一 62 项通过；全文件行 96.21%、分支 89.42%、函数 96.83% |
| `npm run simulate` | HTTP 闭环通过；一次事件、一次回复、正确原单聊、重复入站和回复幂等 |
| `git diff --check` | 通过，无空白错误 |

覆盖率是测试过程指标，不代表安全证明或真实客户端兼容。模拟回答固定为 `4`，没有模型推理。测试以公开 synthetic fixture、进程内临时密钥和临时 SQLite 文件运行，未创建真实账号凭据或绑定；临时库在验证后关闭清理。

## 检查范围

- QQ 官方签名/public-key golden vectors、challenge、原始字节篡改、签名时间窗口、主人默认拒绝及非文字过滤。
- MCP 2.0 discovery、元数据与 HTTP 头、严格 schema、订阅验证/刷新/轮换/撤销、签名投递和无历史 cursor。
- 真正 loopback HTTP 的收取、工具调用和模拟出站；并发去重、一条回答幂等与禁止任意收件人。
- SQLite 独立句柄 lease、独立进程/重启持久性、不同主人/AppID/主体/密钥不可复用原库、正文加密与保留。
- 内网/保留 IP、DNS rebinding、连接固定 IP 与 TLS 校验、禁止重定向、超时和体积上限。
- OAuth 合成 JWT 的 issuer、resource audience、scope、唯一 subject、RS256/JWKS、安全拒绝与到期。
- 排队/频控/有界重试、被动期限、模糊 QQ 回执不重发、发送前撤销与已发请求成功回执、优雅停机。
- 本地身份 capture 验签不会自动绑定，状态命令不解密正文或输出秘密，缺配置/库失败时不创建服务。

## 没有证明的事项

**真实 QQ 或原 dot 都未连接。** 没有发出真实 QQ token/消息请求，没有 OAuth 登录、真实 callback challenge、插件注册/安装、dot 订阅或事件任务执行。没有公网 TLS 回调、固定出网配置、Docker 构建、云端部署或电脑关机测试。没有接受新的持续权限、迁移记忆或产生托管费用；代码尚未推送。

真实验收及下一步最小授权见 [activation.md](activation.md)。腾讯参考审查与版本证据见 [tencent-reference.md](tencent-reference.md)。
