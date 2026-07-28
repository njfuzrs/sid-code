---
title: IDE 集成
description: 在 VS Code / Cursor / Windsurf 里用 sid-code：选区同步、@提及、diff 视图、自动发现。
---

# IDE 集成

在 IDE 的内置终端里跑 sid-code，它会发现 IDE 并建立连接，把编辑器里的上下文带进对话——你在编辑器里选中的代码、@提及的文件，sid-code 都能看到。

这页解决两个问题：**它能做什么**，以及**怎么连上**。

## 快速上手

在 VS Code / Cursor / Windsurf 的内置终端里直接启动：

```bash
sid-code
```

如果已装 sid-code 的 IDE 扩展，启动时会自动发现并连接，日志里能看到：

```text
● [IDE] 开始搜索可用 IDE...
● [IDE] 已连接到 VS Code
```

没装扩展或不在 IDE 终端里，这条不会出现——所有功能照常工作，IDE 集成是**可选增强**，不是前置依赖。

手动装扩展：

```text
/ide install
```

它通过 IDE 的 CLI（`code` / `cursor` / `windsurf`）安装 sid-code 扩展，装完重启 IDE 后再 `/ide connect` 连上。

## 连接机制

sid-code 不会主动去扫端口找 IDE。连接靠一个 **lockfile 协议**：

1. IDE 扩展启动时在 `~/.sid-code/ide/` 下写一个 `<port>.lock` 文件，里面记着端口号、工作区目录、认证令牌
2. sid-code 启动时轮询这个目录，按工作区目录匹配当前 cwd 的 lockfile
3. 匹配到就把这个 IDE 注册为一个**动态 MCP Server**，复用 MCP 基础设施通信

几个设计取舍值得知道：

- **IDE 是动态 MCP Server**——和你在 `mcp add` 里配的 server 走同一套连接管理、工具调用通道，只是生命周期由 lockfile 驱动
- **断开不影响主流程**——所有 IDE RPC 调用都有容错包裹，IDE 关了或断了，sid-code 照常跑，只是失去增强能力
- **多 IDE 实例需要手动选**——发现多个匹配的 lockfile 时不自动连（怕连错），用 `/ide connect` 手动连

自动连接的条件（满足任一即触发）：

- 环境变量 `SID_CODE_SSE_PORT` 指定了端口
- 环境变量 `SID_CODE_AUTO_CONNECT_IDE=true`
- `settings.json` 里 `ide.autoConnect` 设为 true
- 当前在受支持 IDE 的内置终端里运行（检测 `TERM_PROGRAM` 为 `vscode` / `cursor` / `windsurf`）

## 它能做什么

连接建立后，四个能力自动启用：

### 选区同步

在编辑器里选中一段代码，这段选区会作为上下文注入下一次对话。格式是：

```text
用户在 IDE 中选中了以下代码：
文件: src/utils.ts
行范围: 12-18

```
<你选中的代码>
```
```

不用手动 `@` 文件再贴行号——选中直接问就行。选区有 5 分钟有效期，过了自动失效，避免拿过期的选区当上下文。

### @提及

在 IDE 扩展里用 `@` 提及一个文件（带可选行范围），这个文件路径会作为上下文注入下一次输入。提及列表是**消费语义**——注入一次后清空，不会重复带进后续每一轮。

### Diff 视图

sid-code 改文件时，如果你连了 IDE，改动会在 IDE 里以 **diff 标签页**展示，而不是直接落盘。你可以：

- **保存**：接受改动（可在 diff 里再改一版再保存，sid-code 会拿到你改后的内容）
- **拒绝**：否掉这次改动
- **关闭**：关掉 diff 标签页

Agent 循环结束时，残留的 diff 标签页会被自动清理，不会留一堆没关的标签。

### 自动扩展安装

`/ide install` 检测当前终端所在的 IDE 类型（靠 `TERM_PROGRAM`），用对应 CLI 安装扩展。不在受支持 IDE 的终端里时会直接告知「当前终端不在受支持的 IDE 中」。

## `/ide` 命令

会话内管理 IDE 连接，四个子命令：

```text
/ide status       显示连接状态 + 可发现的 IDE
/ide connect      手动连接（自动连接没触发时用）
/ide disconnect   断开连接
/ide install      安装 sid-code IDE 扩展
```

`/ide`（无参）等同 `/ide status`，输出长这样：

```text
IDE 集成状态:
  状态: ✓ 已连接
  IDE: VS Code

可发现的 IDE:
  - VS Code (http://127.0.0.1:54321)
```

未连接时状态显示 `○ 未连接`，并提示用 `/ide connect`。

## 常见问题

### 启动没自动连上 IDE

四个排查点，按顺序：

1. **在 IDE 的内置终端里跑吗**——外部终端（iTerm / 系统终端）不在 IDE 进程里，`TERM_PROGRAM` 不是 vscode/cursor/windsurf 不会自动触发。用 `/ide connect` 手动连
2. **扩展装了吗**——`/ide install` 装一下，装完重启 IDE
3. **lockfile 写了吗**——扩展启动时会在 `~/.sid-code/ide/` 写 `<port>.lock`，没这个文件 sid-code 发现不了。确认扩展进程还在跑
4. **工作区目录对得上吗**——lockfile 里记的工作区目录要包含当前 cwd，跨工作区连不上

### `/ide connect` 说发现多个 IDE

开了多个 IDE 窗口且都装了扩展时会出现。关掉多余实例，只留当前工作区的那个，再重试。

### 连上了但选区没进上下文

选区有 5 分钟有效期，可能是选完过了一段时间才提问、选区已过期。重新选中再问。另外空选区（纯空白）会被忽略。

### diff 标签页关了但改动没生效

关掉 diff 标签页 = 拒绝这次改动。要接受改动得在标签页里**保存**，不是关掉。如果选了拒绝，sid-code 不会落盘这次改动。

## 相关

- [MCP](/extend/mcp) —— IDE 集成复用 MCP 基础设施，IDE 作为动态 MCP Server 接入
- [交互模式与键位](/use/interactive) —— 不在 IDE 里时的终端交互行为
- [扩展方式总览](/extend/) —— IDE 集成与其他扩展方式的关系
