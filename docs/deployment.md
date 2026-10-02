# 持续云端托管与运行

本次未构建容器、选择服务商、购买域名、公开端点或部署。Docker 在开发环境中不可用，Dockerfile 是待授权构建验证的模板。实际运行环境须使用 Node 24.15+ 的 Linux 常驻进程或容器，不依赖 RMB16 持续在线。

用户目标是 dot 管理的云环境，不要求本人自备服务器。能否原样运行取决于该环境是否提供上述 Node 运行时、持久卷、常驻后台进程、经批准的 MCP 路由/认证和必要出网；这些能力尚未在 dot 云电脑验证。现有实现不能直接作为 Workers/D1 请求 handler 上传：需要 HTTP 入口适配、替换本地 SQLite/WAL 事务与 lease、使用可靠队列消费者替换进程计时器，并适配 crypto/受控出站 HTTPS/WSS 且保留 SSRF 防护。OAuth 发行方或有明确主体保证的平台认证仍是前提。本轮没有实施这类迁移或发布；共享云端探针和服务/数据库/认证授权由主线程处理，具体交接见 [handoff.md](handoff.md)。

## 托管必须满足的条件

- 服务及队列 worker 持续运行，不自动休眠；受控的重启策略、至少 60 秒停止宽限时间。
- 一个服务实例、可靠的本地持久卷，SQLite WAL/FULL/fsync 可用；不使用临时文件系统或共享 NFS 来假装多副本持久队列。
- 公网 HTTPS 443、有效证书与 DNS。反向代理转发原始请求体，保留 `Authorization`、QQ 验签头、MCP 方法/版本/名字头和正确的公开 Host。
- Webhook 模式的 `/qq/webhook` 可由腾讯直接访问，使用协议验签；不能跳转到 Sites 私有登录页。Gateway 模式关闭该入口，须能持续出站 WSS；`/mcp` 仍由桥接 OAuth 保护，元数据可被发现。
- 出站可访问选定 QQ token/API 主机、指定 JWKS 主机和经批准的 ChatGPT callback。若 QQ 当前账户要求 IP 白名单，须有固定公网出网 IP 并由主人在 QQ 控制台配置。
- 秘密注入不进镜像或 Git；`STORAGE_KEY` 与加密 DB 的备份配套保存，磁盘和备份有访问控制。

Sites 的 HTTP MCP 与 D1 不足以证明此架构可直接部署：QQ 公网回调穿过私有鉴权、事件插件注册、持续 worker/重试、固定出网及 D1 适配均未验证。本版使用可移植 Node HTTP + SQLite，不把 Sites 或任意 serverless 的请求后计时器当作可靠队列。

腾讯 WebSocket Gateway 入站已实现并通过离线 loopback 恢复闭环，避免 QQ 公网 Webhook；当前账号的权限、真实 WSS、沙箱行为和云端常驻仍未验证。它不能替代 MCP 身份认证和持久任务执行条件，启用步骤见 [connection.md](connection.md)。

## 授权后构建示例

使用 [官方 Node Docker 镜像](https://github.com/nodejs/docker-node)，首次正式构建应确认 Node 版本并将 base image 固定到审查过的 digest。此示例只供后续操作者执行：

```sh
docker build -t dot-qq-bridge:0.1.0 .
docker volume create dot-qq-data
docker run -d --name dot-qq-bridge \
  --restart unless-stopped --stop-timeout 60 \
  --env-file .env \
  -e HOST=0.0.0.0 -e DATABASE_PATH=/data/bridge.sqlite \
  -p 127.0.0.1:3000:3000 \
  -v dot-qq-data:/data \
  dot-qq-bridge:0.1.0
```

`.env` 应为已审查的 `AUTH_MODE=oauth` 配置；禁止把开发 bearer 调试模式通过代理暴露。外部 TLS 代理单独配置，将公开 `/mcp`、QQ Webhook 和元数据路径转给内网 3000，其他路径关闭；32 KiB 请求体限制，应用原始 body 不重写。此文档没有执行 Docker 指令或创建卷。

匿名 VOLUME 不作为正式存储方案，必须命名挂载。宿主 bind mount 要给非 root `node` 用户写权限；不要将 `.env` 挂载到公共目录。容器 healthcheck 只测存活；`/readyz` 需有效订阅，部署初始 `503` 是预期状态。

## 日常运行

```powershell
npm run status
```

只读本地数据库状态，输出各 job 状态的计数，不解密正文、不输出 callback/秘密/主人 ID，不触发任何发送。容器中等效命令为 `docker exec dot-qq-bridge node scripts/status.js`。

| 现象 | 操作 |
| --- | --- |
| `pending` 增长 | 查订阅寿命、出网、配置、限流；不要盲目加 worker |
| `uncertain` | 在 QQ 官方记录或本人会话核实；保持不重发。需要新回答时，让本人发送新的入站消息 |
| `expired` | 回复晚于窗口；缩短 dot 处理/批处理等待，勿启用主动降级 |
| `dead` | 查安全错误标签及账号权限；不输出 token/body 做公共排错 |
| `cancelled` | 订阅已撤销或授权失效；重新订阅只影响未来合法工作 |
| `/readyz` 503 | 确认完整身份配置、已验证 callback 白名单及有效订阅；不通过放宽鉴权修复 |

SIGINT/SIGTERM 先停止领取，等待进行中的 worker 完成并关闭 DB。硬停后 event 的 lease 到期可恢复；发送中的 QQ reply 标记 uncertain，禁止自动猜测重发。持久卷丢失会丢失去重保证，所以先停服务再一致备份整个数据库目录，或使用正确的 SQLite 在线备份工具；不要只复制正在写入的主 `.sqlite` 文件。

定期审查七天正文保留、长期 ID tombstone 的增长与备份过期；备份中的历史密文不自动消失。JWT 撤销不依赖在线 introspection：订阅最长到已验证 token 的 exp，JWKS 缓存最长五分钟；需要立即停用时撤销订阅/停止服务并撤销发行方权限。不能修改原数据库绑定来更换主人或转发历史。
