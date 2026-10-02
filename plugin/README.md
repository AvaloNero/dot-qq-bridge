# 手动接入模板，尚未注册/安装

结构依据 OpenAI [Package your plugin](https://developers.openai.com/plugins/build/plugins) 的 portable Agent Plugins 示例。`mcp.json` 使用保留的 `.invalid` 域名，不会指向已发布服务；没有 token、registered app ID、生命周期 hook 或自动授权 skill。

经主人批准托管后，再将 URL 改成已验证的 HTTPS `/mcp`。先按 [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt) 注册、验证 OAuth 和 event discovery。当前 ChatGPT dot 是否需要 registered MCP app 映射，必须由实际 UI/官方 plugin-creator 生成并核对真实 `plugin_asdk_app...` ID；不要编造 ID 或把本模板视为已安装。选择既有 dot 的订阅步骤见 [activation.md](../docs/activation.md)。

本次仅创建仓库模板，不改动个人 marketplace、不安装插件、不创建 automation、不接受持久权限。模板语法会离线检查，但其远程安装与账户可用性未验证。
