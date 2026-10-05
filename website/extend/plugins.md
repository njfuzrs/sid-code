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

插件不在 sid-code 进程里加载代码，组件都是 Markdown 或 JSON。
但它带的 Hook 和 MCP server 会**以你的身份执行命令**：Hook 能跑任意 shell（比如下面示例里的
`${PLUGIN_ROOT}/scripts/format.sh`），stdio 类型的 MCP server 能启动任意进程，两者都能读写你的整个家目录，
权限和你手写的 Hook 一样大。**只装可信来源的插件。**

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

目前只支持从本地目录安装，没有插件市场，也不能从 git URL 安装。
团队分发靠把插件目录放进仓库或共享盘，再 `/plugin install <路径>` 或 `--plugin-dir <路径>`。

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
| `/plugin market [关键词]` | 浏览企业插件市场（需配置 `backend.url` 并 `sid-code auth login`） |
| `/plugin install <name>@company` | 从企业市场安装：下载 → sha256 校验 → 安全解包 |
| `/plugin update [name]` | 按市场目录更新市场插件，新包校验失败时保留旧版本 |
| `/plugin install <path>` | 从本地目录安装（企业策略锁定时拒绝） |
| `/plugin uninstall <name>` | 卸载（`--delete` 删文件，`--force` 忽略依赖） |
| `/plugin enable <name>` | 启用 |
| `/plugin disable <name>` | 禁用（`--force` 忽略反向依赖） |
| `/reload-plugins` | 重新加载全部插件组件 |

`/plugins` 是 `/plugin` 的别名。依赖检查是双向的：卸载被依赖的插件会被拦下，
要强行来加 `--force`。

## 企业插件市场

市场地址由 `backend.url` 推出（`<backend.url>/api/v1/ctl/marketplace/index`），请求带设备凭据。
目录拉不到（网络错 / 5xx）时用上次缓存展示，已装插件照常加载；401 不退回缓存，
凭据被吊销后目录与下载一起失效。

安装时客户端会再做一遍服务端已经做过的检查：sha256 必须与目录登记的一致，
包里不能有符号链接、硬链接、设备文件、`..` 或绝对路径，`plugin.json` 的名字和版本
必须与目录一致，组件路径必须是包内相对路径。任何一条不过，整包拒绝，插件目录不留残留。

### 锁定后只认市场来源

企业策略里任一项生效，插件来源就会被锁定：

- `strictPluginOnlyCustomization`（锁了任意一个面）
- `strictKnownMarketplaces: [{ "source": "url", "url": "https://.../ctl/marketplace/index" }]`

锁定后：

| 来源 | 结果 |
| --- | --- |
| 内置插件 | 照常 |
| 企业市场插件 | 有白名单时 index 地址必须在白名单内；没有白名单时必须是本机 `backend.url` 那个市场 |
| 本地目录安装 / `--plugin-dir` | 拒绝安装，已装的不加载 |

`strictKnownMarketplaces: []` 表示除内置插件外全部禁用。市场插件加载前会复核目录指纹，
装好后被改过内容（比如往里加了 `hooks.json`）的插件不会加载，需要 `/plugin update` 或重装。
这一层防的是误装和未审计的插件被顺手加载，挡不住有本机写权限、又存心伪造 `installed.json` 的人。

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
- 只认 `ws://` 和 `wss://`，别的协议直接报错：
  `不支持的 Bridge 传输协议: xxx（当前仅支持 ws:// / wss://）`

### 准入：连上之前先过本机这一关

远端拿到的是这台机器的执行权，而权限确认又是转发给远端自己批的，所以 `--bridge`
在建立连接之前有一道本机准入（`packages/core/src/bridge/admission.ts`），按顺序判：

1. **企业策略可以整体关掉 Bridge**：远程下发的 `bridgeEnabled: false` 或本机 settings 的
   `bridge.enabled: false` 都会直接拒绝（远程的 false 盖过本机配置）：
   `企业策略已禁用 Bridge 远程控制（settings 中 bridge.enabled = false）`
2. **明文 `ws://` 默认拒绝**，要显式加 `--bridge-insecure` 才放行：
   `拒绝明文 Bridge 连接: ws://…  改用 wss:// ，或确认风险后显式加 --bridge-insecure。`
3. **首次连某个地址要当面确认**。终端会列出这个地址和风险提示，确认后记住，下次不再问。
   记的是端点本身，URL 里的 query（常带 token）会被剥掉，不会落盘。
4. **没有终端可问时 fail-closed**：首次连接却处在非交互环境（比如脚本里），直接拒绝，
   要先在交互式终端里跑一次完成确认。

每次准入拒绝都会记一条防线触发事件，可以在轨迹里统计。

::: danger Bridge 等于把这台机器的执行权交出去
远端能让它读文件、改代码、跑命令——权限确认虽然转发到远端，但**确认的人不是你**。
默认就只接受 `wss://`，`ws://` 要显式 `--bridge-insecure`；另外务必带 `--bridge-token`、
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

能，`mcpServers` 字段写内联对象或指向文件。插件带的 server 名字会带 `plugin:<插件名>:` 前缀，
不会和你自己的配置撞名；但它不参与签名去重，和你自己配的是同一个 server 时会连两次。
企业 `mcpPolicy` 对它照样生效——见 [MCP](/extend/mcp#四层作用域与优先级)。

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
