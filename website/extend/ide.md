---
title: IDE 集成
description: 在 VS Code / Cursor / Windsurf 里用 sid-code：选区同步、@提及、diff 视图、自动发现。
---

# IDE 集成

在 IDE 的内置终端里跑 sid-code，它会发现 IDE 并建立连接，把编辑器里的上下文带进对话——你在编辑器里选中的代码、@提及的文件，sid-code 都能看到。

这页解决三个问题：**它能做什么**、**怎么连上**、以及**扩展一侧要按什么协议接入**。

::: warning 配套 IDE 扩展尚未发布
IDE 一侧需要一个写 lockfile、提供选区 / diff 能力的扩展，这个扩展目前没有发布到
VS Code Marketplace 或 Open VSX。本页描述的是 sid-code 一侧的发现协议与 wire 契约
（[连接机制](#连接机制) + [扩展侧需要实现什么](#扩展侧需要实现什么)）：
扩展按这两节实现就能接上，现在照着装是装不上的。
:::

## 快速上手

在 VS Code / Cursor / Windsurf 的内置终端里直接启动：

```bash
sid-code
```

IDE 侧有实现了 lockfile 协议的扩展在跑时，启动会**在后台**发现并连接
（最多轮询 30 秒，每秒一次）。连接结果用 `/ide status` 查看：

```text
/ide status
```

::: tip 这两行日志默认看不到
`● [IDE] 开始搜索可用 IDE...` / `● [IDE] 已连接到 VS Code` 是 INFO 级调试日志。
不开 `--debug` 时走审计模式（`level: WARN`，只落 WARN/ERROR），它们既不写盘也不上屏；
TUI 下开 `--debug` 也只写调试日志文件（默认 `~/.sid-code/debug.log`），不输出到控制台。
想直接在终端看到它们，需要 `--debug` + 无头模式（`--print`），此时日志走 stderr。
日常确认连接请用 `/ide status`。
:::

在 IDE 终端里但没有任何扩展（`~/.sid-code/ide/` 下没有 lockfile）时，
「开始搜索可用 IDE...」**照样会打印**（只是默认不可见），30 秒后静默放弃。
没有 IDE 连接不影响任何主流程——IDE 集成是**可选增强**，不是前置依赖。

## 连接机制

sid-code 不会主动去扫端口找 IDE。连接靠一个 **lockfile 协议**：

1. IDE 扩展启动时在 `~/.sid-code/ide/` 下写一个 `<port>.lock` 文件
2. sid-code 启动时轮询这个目录，按工作区目录匹配当前 cwd 的 lockfile
3. 匹配到就把这个 IDE 注册为一个**动态 MCP Server**，复用 MCP 基础设施通信

### lockfile 格式

文件名里的 `<port>` 就是 IDE 侧 MCP server 的监听端口——**端口只从文件名解析**，
不写在 JSON 内容里。JSON 内容支持这些字段（全部可选，但扩展通常都该写）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `workspaceFolders` | string[] | IDE 打开的工作区目录。sid-code 用「当前 cwd 是否在其中」做匹配，不匹配的 lockfile 直接跳过 |
| `pid` | number | IDE 进程 PID。用于过期清理（进程没了就删 lockfile）与多窗口[祖先消歧](#多窗口与祖先消歧) |
| `ideName` | string | 显示名（如 `VS Code`），`/ide status` 与日志里用它；缺省显示 `Unknown IDE` |
| `transport` | `"ws"` \| `"sse"` | 传输协议，缺省 `sse`（即 `http://`）；填 `ws` 则连 `ws://` |
| `authToken` | string | 认证令牌，连接时作为 MCP 认证信息带上 |
| `runningInWindows` | boolean | WSL 场景：IDE 跑在 Windows 侧，连回环要走 Windows 主机 |

过期清理有两道判据，任一确定成立就删：**PID 不存活**，或 **PID 活着但端口没人监听**
（对 `127.0.0.1` 做一次 300ms 的 TCP 探活；探测本身出错时保守保留）。

### 匹配策略

按顺序：

1. **环境变量端口命中**：`SID_CODE_SSE_PORT` 指定的端口如果对应某个 lockfile，直接采纳——
   **不再做工作区匹配与祖先消歧**（这是用户显式指定的端口，再消歧反而会把指定的那个滤掉）
2. **工作区目录匹配**：当前 cwd 落在 lockfile 的 `workspaceFolders` 之下（路径做 Unicode NFC
   归一化，macOS 的 NFD 路径与 VS Code 报的 NFC 路径能对上）
3. **多窗口时按进程祖先消歧**：见下

匹配不到时，后台发现会**每秒重试、最多 30 秒**（可用 `settings.json` 的
`ide.discoveryTimeout` 改毫秒数），超时后静默放弃，不会自动重连——需要手动 `/ide connect`。

### 多窗口与祖先消歧

多个 IDE 窗口的工作区都包含当前目录时，sid-code 会看你所在的终端是哪个 IDE 窗口的子进程
（沿父进程链向上查，最多 10 层）。只有**在受支持 IDE 的内置终端里**才做这一步过滤；
外部终端里祖先链不可能包含 IDE 进程，过滤会恒为空，所以直接保留全部候选。

判不出来（进程表查不到、Windows 上没有 `ps` 等）时同样保留候选，不冒险滤掉。

最终仍然多于一个候选时：**自动连接静默放弃**（后台不弹任何东西），
手动 `/ide connect` 会报「发现多个 IDE」并列出它们。

### 自动连接的条件

满足任一即触发后台发现：

- 命令行走 `--ide`（等价于把 `ide.autoConnect` 设为 true）
- `settings.json` 里 `ide.autoConnect` 设为 true
- 环境变量 `SID_CODE_AUTO_CONNECT_IDE=true`（严格等于字符串 `true`）
- 环境变量 `SID_CODE_SSE_PORT` 设了值（同时用于上面的端口命中）
- 当前在受支持 IDE 的内置终端里运行（检测 `TERM_PROGRAM` 为 `vscode` / `cursor` / `windsurf`）

几个设计取舍值得知道：

- **IDE 是动态 MCP Server**——和你在 `mcp add` 里配的 server 走同一套连接管理、工具调用通道，只是生命周期由 lockfile 驱动
- **断开不影响主流程**——所有 IDE RPC 调用都有容错包裹，IDE 关了或断了，sid-code 照常跑，只是失去增强能力

## 它能做什么

连接建立后，三个能力自动启用：

### 选区同步

在编辑器里选中一段代码，这段选区会作为上下文注入对话。sid-code 每轮对话开始时检查一次，
注入形态是：

````text
<ide-selection>
用户在 IDE 中选中了以下代码：
文件: src/utils.ts
行范围: 12-18

```
<你选中的代码>
```
</ide-selection>
````

同一份选区只注入一次（改选区才会再注入新的一份），选区有 5 分钟有效期，过期视为没有选区；
空选区（纯空白）直接忽略。

不用手动 `@` 文件再贴行号——选中直接问就行。

### @提及

在 IDE 扩展里用 `@` 提及一个文件（带可选行范围），文件路径会作为上下文注入下一轮对话：

````text
<ide-mentions>
用户在 IDE 中引用了以下代码位置：
  - src/utils.ts:12-18
</ide-mentions>
````

提及列表是**消费语义**——注入一次后清空，不会重复带进后续每一轮；最多保留最近 10 条。

### Diff 视图

需在 `settings.json` 里开 `ide.diffPreview: true`（**默认关**：开启后每次编辑都要等你在 IDE 里表态，无人值守时会把任务挂住）。

开了之后，sid-code 改文件时，如果你连了 IDE，改动会先在 IDE 里以 **diff 标签页**展示，而不是直接落盘。你可以：

- **保存**：接受改动（可在 diff 里再改一版再保存，sid-code 会拿到你改后的内容）
- **拒绝**：否掉这次改动，不落盘
- **关闭**：关掉标签页 = 未表态，sid-code 按原改动写入（和没连 IDE 时一样）

diff 的等待超时是 30 分钟；除「拒绝」外，所有异常分支（超时、写盘前出错、IDE 断开）
都按「照原样写入」处理，不会阻断编辑。写入成功时会关掉这一轮的 diff 标签页。

## 扩展侧需要实现什么

这一节是给写 IDE 扩展的人看的 wire 契约。sid-code 一侧已经实现，扩展照着实现就能接上。

### 1. 发现：写 lockfile

在 `~/.sid-code/ide/` 下写 `<port>.lock`（端口在文件名，字段见 [lockfile 格式](#lockfile-格式)）。
sid-code 通过它发现 IDE，再按 `transport`（缺省 SSE，即 `http://host:port`；填 `ws` 则
`ws://host:port`）建立 **MCP 连接**。

### 2. IDE → agent 的通知

两个通知走 MCP 通知通道，但方法名是 IDE 扩展的私有约定——**不带 `notifications/` 前缀**。
带上前缀不会报错，只会静默匹配不上（这是本仓踩过的坑，见 `protocol.ts` 顶部注释）。

| 方法名 | 参数 | 时机 |
|---|---|---|
| `selection_changed` | `{ selection: { start: {line, character}, end: {line, character} }, text, filePath }` | 选区变化时 |
| `at_mentioned` | `{ filePath, lineStart?, lineEnd? }` | 用户在扩展里 @ 了文件 / 行范围时 |

行号是 **0-based**。`filePath` 若来自 Windows 而 agent 在 WSL 里，sid-code 会自动做路径换算。

### 3. agent → IDE 的通知

| 方法名 | 参数 | 作用 |
|---|---|---|
| `ide_connected` | `{ pid }` | 告诉 IDE 是哪个 CLI 进程连上来了，扩展的连接状态指示灯靠它点亮 |

### 4. IDE 暴露的 MCP 工具（diff 用）

| 工具名 | 参数 | 说明 |
|---|---|---|
| `openDiff` | `old_file_path`、`new_file_path`、`new_file_contents`、`tab_name` | 展示 diff 并**等待用户在 IDE 里表态** |
| `close_tab` | `tab_name` | 关闭单个 diff 标签页 |
| `closeAllDiffTabs` | `{}` | 关闭全部 diff 标签页（扩展侧契约；sid-code 当前不调用，每次只关自己开的那个 tab） |

参数名是 **snake_case**（这是对端扩展的既有契约，不要改成 camelCase）。

`openDiff` 的响应是 MCP 标准**内容块数组**：第一块是状态字面量，第二块（可选）是用户在
diff 里改过之后的全文：

```json
[{ "type": "text", "text": "FILE_SAVED" }, { "type": "text", "text": "<用户改后的文件内容>" }]
```

状态字面量只有三个：

- `FILE_SAVED`：用户保存了（第二块缺省表示「直接接受、未手改」）
- `DIFF_REJECTED`：用户点了拒绝
- `TAB_CLOSED`：用户关掉了标签页（按「未表态」处理）

## `/ide` 命令

会话内管理 IDE 连接：

```text
/ide status       显示连接状态 + 可发现的 IDE（别名 /ide ls）
/ide connect      手动连接（自动连接没触发、或发现窗口已错过时用）
/ide disconnect   断开连接
```

（早期版本有个 `/ide install` 子命令，它要安装的扩展不会发布，已移除。）

`/ide`（无参）等同 `/ide status`，输出长这样：

```text
IDE 集成状态:
  状态: ✓ 已连接
  IDE: VS Code

可发现的 IDE:
  - VS Code (http://127.0.0.1:54321)
```

状态有四种：`✓ 已连接`、`… 连接中`、`✗ 已断开`、`○ 未连接`。

未连接时，`/ide status` 分两种情况给下一步：

- **发现了 IDE**（有匹配的 lockfile）：列出可发现的 IDE，并提示「使用 /ide connect 连接」
- **没发现**（一个 lockfile 都没有）：提示需要 IDE 侧扩展在跑，并尽量点名正在运行的 IDE

## 常见问题

### 启动没自动连上 IDE

四个排查点，按顺序：

1. **在 IDE 的内置终端里跑吗**——外部终端（iTerm / 系统终端）不在 IDE 进程里，`TERM_PROGRAM` 不是 vscode/cursor/windsurf 不会自动触发。用 `/ide connect` 手动连
2. **自动发现只有 30 秒窗口**——后台每秒重试、30 秒后静默放弃，不会一直等。扩展起得晚（比如先启动 sid-code 再启动 IDE）就要手动 `/ide connect`；也可以用 `settings.json` 的 `ide.discoveryTimeout` 调大
3. **lockfile 写了吗**——IDE 侧扩展启动时会在 `~/.sid-code/ide/` 写 `<port>.lock`，没这个文件 sid-code 发现不了。这时 `/ide` 会点名正在运行的 IDE：
   `检测到 VS Code 正在运行，但没有发现 sid-code 扩展（~/.sid-code/ide/ 下没有 lockfile）`
4. **工作区目录对得上吗**——lockfile 里记的工作区目录要包含当前 cwd，跨工作区连不上

### `/ide connect` 说发现多个 IDE

多个窗口的工作区都包含当前目录，而 sid-code 又判断不出你的终端属于哪个窗口时才会出现
（比如在外部终端里跑）。在目标 IDE 窗口的内置终端里启动，或关掉多余实例再重试。

注意：自动连接遇到多实例是**静默放弃**的——后台不会弹提示，只有手动执行 `/ide connect`
才会看到这条文案。

### 连上了但选区没进上下文

三种可能：

- 选区有 5 分钟有效期，可能是选完过了一段时间才提问、选区已过期。重新选中再问
- 空选区（纯空白）会被忽略
- 同一份选区只注入一次（去重）；如果两次提问之间没有改变选区，它不会被重复注入

### 关掉 diff 标签页算拒绝吗

关掉标签页不是拒绝，是未表态：sid-code 会按原改动写入（和没连 IDE 时一致）。
要否掉这次改动请点**拒绝**。

### 环境变量 `SID_CODE_SSE_PORT` 设了但没连上

这个变量是「端口精确指定」：sid-code 只认这个端口对应的 lockfile，**不再校验工作区目录**。
端口写错就等于指定了一个不存在的 IDE，30 秒后静默放弃。

取值不是 1-65535 的整数（比如 `abc`、`0`、`123abc`）时，sid-code 会忽略这个变量，
不会因为它触发自动连接，并记一条 WARN 级日志（`SID_CODE_SSE_PORT=... 不是合法端口`）。

## 相关

- [MCP](/extend/mcp) —— IDE 集成复用 MCP 基础设施，IDE 作为动态 MCP Server 接入
- [设置参考](/ref/settings) —— `ide.autoConnect` / `ide.discoveryTimeout` / `ide.diffPreview`
- [交互模式与键位](/use/interactive) —— 不在 IDE 里时的终端交互行为
- [扩展方式总览](/extend/) —— IDE 集成与其他扩展方式的关系
