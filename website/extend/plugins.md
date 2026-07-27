---
title: 插件与 Bridge
description: 插件目录的加载规则与扩展边界，以及 Bridge 远程控制模式。
---

# 插件与 Bridge

插件是**分发容器**：把命令、Skill、Hook、MCP 配置打成一个目录，团队成员一个参数就全拿到。
自己用写单个 Skill 就够，要发给十个人才需要插件。

Bridge 是另一件事——让 sid-code 接受远程客户端操控。两者放一页是因为都属于
"把 sid-code 接到别的东西上"。

## 快速上手

一个能跑的插件最少要 `plugin.json` + 一个组件目录：

```bash
mkdir -p /tmp/my-plugin/commands /tmp/my-plugin/skills/hello

cat > /tmp/my-plugin/plugin.json <<'EOF'
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "示例插件：一个斜杠命令 + 一个 skill",
  "commands": "commands/",
  "skills": "skills/"
}
EOF

cat > /tmp/my-plugin/commands/ping.md <<'EOF'
---
description: 回一句 pong 并报出当前分支
---

回答「pong」，然后用一句话说出当前 git 分支名。
EOF

cat > /tmp/my-plugin/skills/hello/SKILL.md <<'EOF'
---
name: hello-plugin
description: 演示插件提供的 skill：输出固定问候语 PLUGIN-SKILL-OK。
mode: activate
---

输出恰好一行：PLUGIN-SKILL-OK
EOF

sid-code --plugin-dir /tmp/my-plugin
```

启动日志确认加载成功（实测）：

```text
● [PLUGIN] 加载了 1 个插件命令
● [PLUGIN] 加载了 1 个插件 Skill
● [PLUGIN] 插件组件: 1 命令, 0 Agent, 0 MCP 服务器
```

会话里输入 `/my-plugin:ping` 用那个命令。Skill 名会带插件前缀 `my-plugin:hello-plugin`。

## 三层架构

| 层 | 是什么 | 在哪 |
| --- | --- | --- |
| 意图层 | `installed.json` 声明装了哪些、启用哪些 | `~/.sid-code/plugins/installed.json` |
| 物化层 | 插件的实际文件 | `~/.sid-code/plugins/<name>/` |
| 活跃层 | 运行时生效的命令 / Skill / Agent / Hook / MCP | 内存 |

设计上插件**通过协议暴露能力，不注入代码**——组件都是 Markdown 或 JSON，
没有可执行插件代码被 load 进进程。这也是为什么插件比"插件 API"安全：
它能声明一个 Hook 去跑命令，但不能直接在 sid-code 进程里执行任意逻辑。

## plugin.json 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | **slug 格式**：小写字母 / 数字 / `-` / `_`，且以字母或数字开头 |
| `version` | 是 | 版本号（semver） |
| `description` | 是 | 一句话说明 |
| `author` / `license` | 否 | 字符串 |
| `commands` | 否 | 命令目录，默认 `commands/`。可给数组 |
| `skills` | 否 | Skill 目录，默认 `skills/`。可给数组 |
| `agents` | 否 | 子代理目录，默认 `agents/`。可给数组 |
| `hooks` | 否 | Hook 配置**文件**路径，默认 `hooks.json`（只能是字符串，不能是数组） |
| `mcpServers` | 否 | MCP 配置：内联对象，或指向文件的字符串 |
| `dependencies` | 否 | 依赖的其他插件名（字符串数组） |

三个必填字段缺任一个插件都不会加载，校验会明确报错，比如
`name 必须是 slug 格式（小写字母、数字、-、_，且以字母或数字开头）`。

## 命令的命名规则

插件命令名带插件前缀，子目录变成命名空间：

```text
commands/deploy.md         → /my-plugin:deploy
commands/env/staging.md    → /my-plugin:env:staging
```

好处是不同插件的同名命令不冲突（`plugin-a:deploy` vs `plugin-b:deploy`）。

## 插件里带 Hook

`hooks.json` 和 `settings.json` 的 `hooks` 字段同格式，额外支持 `${PLUGIN_ROOT}`
变量指向插件自己的目录——这样脚本可以放插件里一起分发：

```json
{
  "post_tool_use": [
    {
      "type": "command",
      "matcher": "edit|write",
      "command": "${PLUGIN_ROOT}/scripts/format.sh"
    }
  ]
}
```

事件名要 snake_case、hook 对象要平铺，规则和普通 Hook 完全一致——
细节和排错见 [Hook 指南](/extend/hooks)。

::: tip Hook 热重载是原子的
`/reload-plugins` 重新加载时，旧 hooks 一直有效直到新的准备好，一次性整体替换。
不会出现"旧的已清掉、新的还没注册"的窗口——那个窗口意味着约束短暂失效。
:::

## 三种来源与优先级

| 来源 | 怎么来 | 标识 |
| --- | --- | --- |
| 内置 | 随二进制分发 | `name@builtin` |
| 已安装 | `~/.sid-code/plugins/<name>/` | `name@local` |
| 会话级 | `--plugin-dir <路径>` | `name@inline` |

同名时优先级：**inline > 已安装 > 内置**。

inline 排最高是给调试用的：改插件时不用先卸载已安装的版本，
直接 `--plugin-dir` 指向工作副本就覆盖掉了。

`--plugin-dir` 可以重复给：

```bash
sid-code --plugin-dir /tmp/plugin-a --plugin-dir /tmp/plugin-b
```

## 会话里管理插件

| 命令 | 作用 |
| --- | --- |
| `/plugin list` | 列出所有插件（启用 / 禁用 / 错误） |
| `/plugin info <name>` | 看详情 |
| `/plugin install <path>` | 从本地目录安装 |
| `/plugin uninstall <name>` | 卸载（`--delete` 删文件，`--force` 忽略依赖） |
| `/plugin enable <name>` | 启用 |
| `/plugin disable <name>` | 禁用（`--force` 忽略反向依赖） |
| `/reload-plugins` | 重新加载全部插件组件 |

`/plugins` 是 `/plugin` 的别名。依赖检查是双向的：卸载被依赖的插件会被拦下，
要强行来加 `--force`。

## Bridge：远程控制

`--bridge` 让 sid-code 连上一个 WebSocket 中继，接受远程客户端操控：

```bash
sid-code --bridge wss://relay.example.com/session/abc --bridge-token <token>
```

数据流是这样：

```text
远程客户端 ──ws──▶ sid-code 内核（执行工具、改文件）
                   │
                   └──ws──▶ 输出 / 工具调用 / 权限请求 回传远程
```

关键点：

- **权限确认也走远程**。工具要确认时请求转发给远程客户端，由那边决定放行还是拒绝——
  不是自动放行。这是 Bridge 和 `--dangerously-skip-permissions` 的本质区别。
- **一次只跑一轮**。远程消息在上一轮没结束时排队串行消费，和交互模式的单轮语义一致。
- **消息去重**。按 UUID 去重（有界环形缓冲），网络重传不会导致同一条消息执行两遍。
- 只支持 `ws://` 和 `wss://`，别的协议直接报错：
  `不支持的 Bridge 传输协议: xxx（当前仅支持 ws:// / wss://）`

::: danger Bridge 等于把这台机器的执行权交出去
远端能让它读文件、改代码、跑命令——权限确认虽然转发到远端，但**确认的人不是你**。
生产上务必：用 `wss://`（不要 `ws://` 明文）、带 `--bridge-token`、
中继服务器自己可控。不要连不明来源的中继。
:::

## 常见问题

### 插件装了但命令找不到

`/plugin list` 先看状态。加载失败会显示错误原因，最常见是 `plugin.json` 缺必填字段
或 `name` 不是 slug 格式。

确认加载成功还找不到命令，检查名字——插件命令**必须带前缀**：
是 `/my-plugin:ping`，不是 `/ping`。

### 问模型"有没有 xx 斜杠命令"，它说没有

斜杠命令是**给你用的**，不进模型上下文——模型压根不知道有哪些斜杠命令。
实测让模型列含 ping 的命令，它翻遍目录后回答"没有任何命令名含 ping"，
而那个命令其实加载得好好的（日志有 `[PLUGIN] 加载了 1 个插件命令`）。

要确认命令在不在，用 `/plugin info <name>`，别问模型。

### 改了插件文件要重启吗

`/reload-plugins` 就够，不用重启进程。

### 插件能带 MCP server 吗

能，`mcpServers` 字段写内联对象或指向文件。插件带的 server 会打上插件作用域标记，
参与正常的 MCP 优先级合并——见 [MCP](/extend/mcp#四层作用域与优先级)。

### 插件里的 Skill 和自己写的 Skill 有区别吗

格式完全一样（`SKILL.md` + frontmatter），走同一套加载与校验。
区别只在名字带插件前缀，以及优先级按插件来源算。

## 相关

- [扩展方式总览](/extend/) — 什么该打成插件，什么不用
- [Skill](/extend/skills) — 插件里的 Skill 用同一套格式
- [Hook 指南](/extend/hooks) — `hooks.json` 的完整字段与排错
- [MCP](/extend/mcp) — 插件带 MCP server 时的合并规则
- [斜杠命令](/ref/slash-commands) — `/plugin`、`/reload-plugins` 的完整列表
- [CLI 参数与子命令](/ref/cli) — `--plugin-dir`、`--bridge` 的完整签名
