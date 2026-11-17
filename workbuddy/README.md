# WorkBuddy 接入

1. 启动服务：`npm start`。
2. 在网页 `接入 WorkBuddy` 页面创建访问令牌。
3. 将 `mcp.example.json` 中的路径、服务地址和令牌替换为本机实际值，合并到 WorkBuddy 的 MCP 配置。
4. 将 `workbuddy/SKILL.md` 安装为 WorkBuddy Skill，或作为项目 Skill 使用。
5. 让 WorkBuddy 先调用 `get_balance`，再按 Skill 流程生成或编辑。

MCP Server 使用 `IMAGE_SERVICE_TOKEN` 作为 Bearer 身份。供应商 Image API 密钥始终只在实际业务服务端配置，不传给 WorkBuddy。
