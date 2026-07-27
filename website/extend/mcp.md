---
title: MCP
description: 接入 MCP server，把企业内部系统变成可调用的工具：三种传输方式、四层作用域、为什么工具"看不见"。
---

# MCP

MCP（Model Context Protocol）是一套标准协议，用来把外部系统包装成模型能调的工具。
接一次，工单系统 / 发布平台 / 内部知识库就都成了 sid-code 能直接操作的东西。

这页讲怎么接、配置放哪、以及一个几乎人人会撞的问题：**接上了但模型说"没有 mcp 工具"**。

## 快速上手

不用手写 JSON，`sid-code mcp add` 一条命令：

```bash
sid-code mcp add fs npx -y @modelcontextprotocol/server-filesystem /tmp
```

实测输出：

```text
MCP 服务器 "fs" 已添加到 project 配置（stdio）。重启会话后生效。
```

查一下：

```bash
sid-code mcp list
```

```text
已配置的 MCP 服务器（共 2 个）:

  internal-api  [http]  https://mcp.example.com/mcp
  fs  [stdio]  npx -y @modelcontextprotocol/server-filesystem /tmp
```

看单个的完整配置：

```bash
sid-code mcp get fs
```

```text
fs  [stdio]  npx -y @modelcontextprotocol/server-filesystem /tmp
{
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/tmp"
  ],
  "_pendingApproval": true,
  "scope": "project"
}
```

::: tip `_pendingApproval` 是什么
项目级 MCP server（`.mcp.json`）来自仓库，第一次用要你在会话里批准。
批准记录存在 `~/.sid-code/state/mcp-approvals.json`，按 `项目路径:server 名` 记账，
所以同一个 server 在不同项目里要分别批准。用户级配置不需要批准。
:::

`sid-code mcp` 这套子命令**不启动会话**，只读写配置文件，所以脚本和 CI 里能直接用。

## 三种传输方式

| transport | 什么时候用 | 配置要点 |
| --- | --- | --- |
| `stdio` | server 是本地可执行程序（绝大多数官方 server） | 给 `command` + `args` |
| `http` | server 是远程 HTTP 服务（内部平台常见） | 给 `url` |
| `sse` | 远程 Server-Sent Events | 给 `url` |

不写 `transport` 时按有没有 `url` 推断：有 `url` → `http`，否则 `stdio`。

## 手写配置

`~/.sid-code/settings.json`（用户级，所有项目都能用）：

```json
{
  "mcpServers": {
    "internal-api": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${INTERNAL_MCP_TOKEN}"
      }
    },
    "fs": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

`<项目>/.mcp.json`（项目级，跟仓库走，团队共享）：

```json
{
  "mcpServers": {
    "fs": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

::: danger 别把 token 明文写进 `.mcp.json`
`.mcp.json` 跟着仓库进 git。凭据用 `${环境变量}` 引用，别直接写值——
配置加载时会做环境变量展开。用户级 `settings.json` 不进仓库，但也建议同样处理。
:::

## 四层作用域与优先级

| scope | 位置 | 谁能看到 |
| --- | --- | --- |
| `dynamic` | 运行时注入（IDE 集成等） | 当前会话 |
| `user` | `~/.sid-code/settings.json` | 你的所有项目 |
| `local` | 本地实验配置 | 当前项目，不进 git |
| `project` | `<项目>/.mcp.json` | 团队共享 |

同名或**同签名**（相同 `command`+`args`，或相同 `url`）时，优先级：

```text
dynamic > user > local > project
```

`dynamic` 排最高是有意的：IDE 注册的是运行时活连接，不该被配置文件里的同名项顶掉。
其余三层的顺序对应「个人全局 > 本地实验 > 团队共享」。

签名去重的意义：同一个 server 在用户级和项目级各配了一份（名字还不一样），
不会连两次——按签名认出是同一个，只保留高优先级那份。

## 会话级注入：`--mcp-config`

不改任何配置文件，临时接一个 server：

```bash
sid-code --mcp-config /tmp/extra-mcp.json
```

配合 `--strict-mcp-config` 可以**只用**这一份，忽略其他所有来源——CI 里跑干净环境很有用：

```bash
sid-code --mcp-config /tmp/extra-mcp.json --strict-mcp-config -p "..."
```

实测日志确认了隔离生效：

```text
● [MCP] 严格 MCP 配置模式（--strict-mcp-config）：仅加载 --mcp-config 指定的 1 个服务器。
● [MCP] 开始连接 1 个 MCP 服务器
● [MCP] 连接服务器: fetch-demo
```

`--mcp-config` 可以重复给多次，也接受内联 JSON 而不只是文件路径。

## MCP 工具的名字

MCP 工具统一命名成 `mcp__<server 名>__<工具名>`：

```text
mcp__fetch-demo__echo
```

权限规则里可以按这个格式写，支持整个 server 通配：

```json
{
  "permissions": {
    "allow": ["mcp__fetch-demo__*"]
  }
}
```

## 常见问题

### 接上了，但模型说"没有 mcp 工具"

这是最常见的困惑，而且**不是故障**。实测问模型能用哪些 `mcp__` 工具：

```text
当前环境中没有 `mcp__` 前缀的工具。可用的 MCP 相关工具只有两个：
- ListMcpResources
- ReadMcpResource
```

原因：**MCP 工具默认延迟加载**。MCP 是上下文膨胀的头号来源——一个 server 十几个工具，
每个带完整 JSON Schema，几个 server 就能吃掉几万 token，而其中大部分这次任务根本用不到。
所以它们不进首轮工具池，模型要用先搜。

让模型走 `tool_search` 就能拿到，实测：

```text
搜索 `echo` 找到 1 个工具：
- `mcp__fetch-demo__echo` — 回显输入的字符串（Echoes back the input string）
```

所以正确的提问方式不是"你有 xx 工具吗"，而是直接说要干的事——模型会自己去搜。

真的需要某个工具**首轮就可见**，用 `toolSearchKeepLoaded` 豁免（支持 `mcp__server__*` 通配）：

```json
{
  "toolSearchKeepLoaded": ["mcp__internal-api__*", "mcp__fetch-demo__echo"]
}
```

代价是这些工具的 schema 每轮都占上下文，只对真正高频的工具开。

### 加了但没生效

三件事按顺序查：

1. **重启了吗** —— `mcp add` 的输出明确写了「重启会话后生效」，不热加载
2. **项目级批准了吗** —— `mcp get` 看到 `"_pendingApproval": true` 说明还没批准
3. **server 起来了吗** —— 开 `-d` 看 `[MCP] 连接服务器: xxx` 后面有没有报错

### 删一个 server

```bash
sid-code mcp remove fs
```

```text
MCP 服务器 "fs" 已移除。重启会话后生效。
```

删不存在的会明确告诉你（注意：退出码仍是 0，脚本里别只看退出码）：

```text
错误: MCP 服务器 "nope" 不存在于配置中。
```

### `mcp add` 写到哪个文件了

默认 `project`（`.mcp.json`）。要写用户级加 `--scope user`：

```bash
sid-code mcp add internal-api https://mcp.example.com/mcp --scope user
```

```text
MCP 服务器 "internal-api" 已添加到 user 配置（http）。重启会话后生效。
```

写 user 作用域时是**外科式补丁** `settings.json` 的 `mcpServers` 字段，不整体覆写文件——
这样你手写的其他配置和注释不会被冲掉，密钥也不会被重新序列化成明文。

### 把 sid-code 自己当 MCP server 用

```bash
sid-code mcp serve
```

它会把自身工具通过 stdio 暴露成 MCP server，给别的 MCP 客户端调。默认只读，
要放开写操作加 `--allow-write`。

## 相关

- [扩展方式总览](/extend/) — MCP 和 Skill / Hook / 子代理怎么选
- [权限与人工确认](/use/permissions) — `mcp__*` 规则怎么写
- [无头模式与脚本化](/extend/headless) — CI 里配合 `--strict-mcp-config`
- [CLI 参数与子命令](/ref/cli) — `mcp` 子命令与 `--mcp-config` 的完整签名
- [settings.json 字段](/ref/settings) — `mcpServers` 字段结构
