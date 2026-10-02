# 渠道交接给主线程

交付范围：官方 QQ Webhook/Gateway → 同一持久队列 → MCP 2.0 Events → 现有 dot → 原入站 ID 的纯文本被动回复。未新建 API 模型机器人，未导出记忆。云端托管、数据库、平台认证和插件接入由主线程处理；本渠道没有创建或部署服务。

## 最少授权及真实阻塞

| 动作/条件 | 最小范围 | 当前状态 |
| --- | --- | --- |
| QQ 账号接入 | 本人选定一只官方 bot；批准从官方控制台接收已有凭据，或本人发起官方扫码 | 未获真实操作授权；未取得凭据 |
| 扫码 SDK 使用 | 明确适用于 `qqbot-connector@1.2.0` 的使用依据及运行授权 | npm/package 为 UNLICENSED、没有 LICENSE；只准备公开接口，CLI scan 禁用 |
| 主人绑定 | 独立确认一个 app-specific openid，与一个受认证 MCP 主体绑定 | 未绑定；空身份默认拒绝；普通 QQ 号不适用 |
| 云环境与秘密 | 指定 dot 管理的托管目标、持久存储、QQ 凭据/storage key 的秘密存放范围 | 主线程私有 MCP 探针准备完成，正在等待托管/数据库/平台认证批准；本服务未接入 |
| MCP 认证 | 官方支持的 OAuth 或有明确身份保证的平台认证路径；必须可验证唯一主体 | 已实现 RS256 OAuth 资源 token 验证；目标平台主体映射未验证 |
| 原 dot 插件与订阅 | 只批准读该主人消息和按已验证 ID 回答；其他外部操作继续在 ChatGPT 确认 | 未安装、未订阅、未接受持久权限 |
| 发布/费用 | 具体代码分支、测试端点的可见范围及明确费用上限 | 可本地提交；没有推送、公开或产生费用 |

主人现在可做的一步：打开 [官方 QQ Agent 指南](https://bot.q.qq.com/wiki/agent-qqbot/)，确认使用哪只已有 bot，并向主线程确认接入路线和授权范围。不要把 AppSecret、结果文件或 storage key 发到聊天。已有官方凭据路线不需扫码 SDK；缺已验证 openid 时仍存在身份取证前置条件。

## Node / SQLite / worker 启动包

源码 ZIP 由 `git archive` 生成，只包含提交的源码、lockfile、无秘密模板、文档与许可证；不包含 `.git`、`.env`、SQLite、node_modules、下载的参考包或 capture。目标先验证：Node 24.15+ 且低于 25、持久本地卷支持 SQLite WAL/FULL、单实例常驻进程、QQ WSS/HTTPS 与 MCP callback/JWKS 出网。

```sh
node --version
npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
npm run check
npm test
npm run simulate
npm run simulate:gateway
npm run connect:qq -- --plan
```

获得真实授权且在秘密管理中填好配置后再执行 `npm start`。HTTP 入口、队列 worker 和可选 Gateway 在同一个 `src/main.js` 进程运行；worker 每 500ms 领取持久工作，无需另起 cron。SIGTERM 等待 Gateway 和当前 worker 结束后关库；至少给 60 秒停止宽限。`npm run status` 只读计数；Gateway 状态在脱敏日志中。Dockerfile 已加入锁定依赖安装，但本环境无 Docker，构建仍未验证。

此代码不能直接当作 Workers/D1 handler 上传：Node HTTP、SQLite 事务/lease、受控 HTTPS/WSS 网络和持续 worker 必须适配目标平台。主线程探针验证的是平台 Events/鉴权能力，不能自动证明这里的 Node 服务、QQ Gateway 或持久队列已云端运行。若目标只允许请求级执行，需先安排可持续的 Gateway/worker 运行机制；不要用请求结束后的计时器冒充持久任务。

## 最小测试能否免额外 OAuth 服务

[官方插件认证指南](https://developers.openai.com/plugins/build/auth) 明确要求认证 MCP 的 OAuth 2.1 流程，并明确 ChatGPT 不能提供自定义 API key。公开单主人入口不能用开发 bearer 或匿名接口替代。已有共享发行方可复用，无需另建一个 OAuth 服务；资源 audience、scope、唯一 subject、PKCE 和 discovery 仍要实测。

[官方 Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 可在开发模式使用私有 HTTP MCP，依靠 tunnel runtime key 和组织/工作区关联控制通道，不需要公网 MCP 入口；它仍需批准 tunnel 权限/runtime key，不能证明 app-specific 单主人主体或本 dot 的 Events 已成立。当前资料未确认可供本服务信任的单用户身份转发，因此没有新增“免鉴权 tunnel”模式。官方只读 cookbook 的 No authentication 例子不满足这里的主人身份/回复工具要求。主线程如果验证了平台认证的明确主体保证，再决定最小受信适配；不得信任调用方自报 `clientInfo`、header 或 QQ 文本。

## 最后真实验收

仍需当前 bot 的 Gateway/C2C/被动回复权限、适用 API profile 和 QQ IP 白名单，真实 OAuth/平台主体验证，原 dot 的事件发现/订阅/签名 callback、本人 C2C 回答、提示注入负向测试、持久卷重启和个人电脑关机后的云端连续运行。本轮的模拟与自动测试不证明以上任一真实互通条件。
