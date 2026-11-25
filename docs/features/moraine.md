# Moraine 长期记忆

工作台使用 [Cairn × Xiaoran · Moraine](https://github.com/ceniran/moraine-home) 的官方 Python 包、HTTP 服务、管理界面和 MCP。接入固定在 [v0.3.0-beta.17](https://github.com/ceniran/moraine-home/releases/tag/v0.3.0-beta.17)，上游使用 [PolyForm Noncommercial 1.0.0](https://github.com/ceniran/moraine-home/blob/v0.3.0-beta.17/LICENSE) 并提供[署名说明](https://github.com/ceniran/moraine-home/blob/v0.3.0-beta.17/NOTICE.md)。

## 安装和使用

1. 新机器安装 Git 和 uv，在 CyberBoss 项目目录运行 `npm run moraine:install`。安装器建立独立 Python 3.12 环境，安装固定版本的上游包和 MCP 依赖。第一版使用 Moraine 内置关键词检索，安装器跳过独立向量服务的依赖。
2. 正常启动工作台。它启动自己的 Moraine 服务，监听本机 `127.0.0.1:4790`。上游服务绑定成功后，设置页显示「运行中」。端口被占用或启动失败时可查看错误，处理后点击「启动记忆库」。工作台退出时通过关闭进程管道结束服务。
3. 打开「设置 → Moraine 长期记忆」，点击「复制令牌并打开」，在上游页面的登录框粘贴。弹窗被拦截时可使用「打开记忆库」链接。该页支持查看、修订记忆和管理候选。Codex 自动使用本机凭据。

## 记忆从哪里来

前台聊天、自然唤醒和 Codex 托管事项各自执行时调用上游 `/api/host/turn/prepare`。聊天提供当前消息和至多两条前文，托管事项提供任务标题及说明。返回的历史线索作为数据随本轮请求提供给订阅模型。可用时，工作台还会给自己的两个 Codex app-server 注册官方 Moraine MCP。Agent 可以追查来源、直接保存用户明确要求记住的事实、提交自己归纳的候选。候选的后续整理遵循 Moraine 自身设置。记忆服务离线时工作台仍能处理任务。

明确要求记录工具、任务或完成状态时，照常写入对应的工作台功能。已有资料通过原全局检索读取。首次使用从空库开始，历史聊天和常规巡检流水不做批量导入。Magpie 按本轮任务材料执行，Moraine 工具及自动召回限于 Codex。

2026-11-25 起，每轮 Codex 执行记录保存自动查询的时间、状态、召回正文或错误。展开聊天执行过程或后台执行详情可查看；只表示提供了哪些线索，不代表模型已采纳。两通道的召回结果分别随各自回合保存。此改动尚未构建、启动或实机验证。

## 数据与备份

默认目录为项目内 `data/moraine/`。自定义 `CYBERBOSS_DESKTOP_DIR` 时使用该目录内的 `moraine/`，也可用 `CYBERBOSS_MORAINE_DIR` 显式指定。安装器和工作台须使用相同目录。记忆及其审计历史由上游保存到 `beta-store.json`，访问令牌保存在 `access-token`，Python 环境位于 `venv/`。停止工作台后可私下备份数据，或在上游界面导出。运行数据、凭据和上游安装均留在本机。
