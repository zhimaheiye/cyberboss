# CyberBoss Antigravity 迁移测试指南

## 1. 目标电脑最低前置条件
- **Node.js**: 已安装 (v18+ 推荐)。
- **Antigravity CLI**: 已正确安装并加入系统 `PATH` (即终端中可直接运行 `antigravity`)。
- **环境隔离**: 建议在独立的目录中测试，避免与本机可能存在冲突。

## 2. 必需的环境变量与配置
在目标电脑上拉取代码后，在运行 CyberBoss 之前，必须在你的终端环境中指定运行时：

```powershell
# Windows PowerShell
$env:CYBERBOSS_RUNTIME="antigravity"

# MacOS / Linux
export CYBERBOSS_RUNTIME="antigravity"
```

## 3. CyberBoss MCP 是如何自动注册的？
- **零手动配置**：你不需要在目标电脑上手动将 CyberBoss 的工具注册到 Antigravity 中。
- **动态注入**：当你在 CyberBoss 中触发与 Antigravity 的对话（发消息给机器人）时，系统会自动定位该电脑的 Antigravity 全局配置文件（如 `~/.gemini/antigravity/mcp_config.json`），并基于当前工作区生成一个去重 Hash，自动将 `cyberboss_tools_<hash>` 注入进去。
- **幂等性与安全性**：代码会自动保护其他已配置的 MCP 服务（如 `maa-mcp`），不会发生覆盖。即使多次重启 CyberBoss，配置也会平滑复用。

## 4. 拉取与启动步骤
```bash
# 1. 获取代码
git clone -b feat/antigravity-mcp-runtime <远端仓库地址> cyberboss-test
cd cyberboss-test

# 2. 安装依赖
npm install

# 3. 设置环境变量并启动
# (PowerShell 示例)
$env:CYBERBOSS_RUNTIME="antigravity"
npm run start
```

启动后，发送消息 `请列出你当前拥有的项目工具` 给 CyberBoss 即可完成全链路验证。
