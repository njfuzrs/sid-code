---
title: 从 Claude Code 迁移
description: 哪些配置不用动就能用、哪些必须改结构、以及用内置 skill 半自动迁移。
---

# 从 Claude Code 迁移

好消息是大部分东西不用迁：sid-code 会直接读 `~/.claude/` 下的一批文件。
坏消息是 `hooks` 的结构不兼容，而且它**配错了不报错、只是静默不生效**——
这是整个迁移里最值得先看一眼的地方。

这页先说什么不用动，再说什么必须改，最后给一个半自动的迁移办法。

## 快速上手

想直接开始，让 sid-code 自己带你走：

```bash
sid-code
# 然后说：迁移我的 Claude Code 配置
```

内置 skill `claude-code-migration` 会被触发，它的流程是**先只读检查、
出一份分 scope 的迁移计划、逐项确认后才写**（`src/skill/builtin/claude-code-migration/SKILL.md`）。
它的硬性约束值得知道，因为这些正是手工迁移最容易出错的地方：

- 只 copy 不 move，不删源文件，不静默覆盖
- `settings.json` **只做 patch 式新增缺失键**，绝不整体覆盖写
- `permissions` / `hooks` / MCP 的 secret 与 env 单独确认
- 不迁 auth / OAuth / managed policy / trust cache

::: warning 为什么"绝不整体覆盖写 settings.json"
sid-code 的 settings 经 Zod round-trip 整体重写会 strip 掉嵌套字段
（比如 `availableModels[].apiKey`），并把 `${ENV}` 占位符**展开成明文落盘**。
手工迁移时如果你用脚本"读出来改改再整份写回"，很可能就把 key 写成明文了。
:::

## 不用动就能用的部分

sid-code 兼容读取 `~/.claude/` 与项目 `.claude/`，同名时以 `.sid-code/` 为准（更晚合并=覆盖）：

| 资源 | CC 路径 | 是否直接读 | 证据 |
| --- | --- | --- | --- |
| 全局记忆 | `~/.claude/CLAUDE.md` | ✅ 直接读 | `src/config/rules.ts:445` |
| 规则目录 | `~/.claude/rules/` | ✅ 直接读 | `src/config/rules.ts:48` |
| 项目记忆 | `CLAUDE.md`、`.claude/CLAUDE.md` 等 5 种文件名 | ✅ 直接读 | `src/config/rules.ts:24-31` |
| 斜杠命令 | `~/.claude/commands/`、`<proj>/.claude/commands/` | ✅ 直接读 | `src/extension/loader.ts:111,155` |
| Skill | `~/.claude/skills/`、`<proj>/.claude/skills/` | ✅ 直接读 | `src/extension/loader.ts:111,155`、`src/app.ts:2749-2751` |
| 子代理 | `~/.claude/agents/`、`<proj>/.claude/agents/` | ✅ 直接读 | 同上 |
| 项目 MCP | `<proj>/.mcp.json` | ✅ 原地可用 | `references/mapping.md:91` |

项目级 `CLAUDE.md` 认这 5 个文件名（`src/config/rules.ts:24-31`）：
`CLAUDE.md`、`.claude.md`、`claude.md`、`.claude/CLAUDE.md`、`.claude/instructions.md`。

所以如果你的 CC 配置只有 CLAUDE.md + 几个 skill/command/agent，
**装完 sid-code 基本就能用**，不需要做任何迁移动作。剩下要处理的是 `settings.json` 里的东西。

## 必须改的部分

### hooks：结构不兼容，而且不报错就不生效

这是最大的差异。CC 是两层结构（`matcher` 分组包裹一个 `hooks` 数组），
sid-code 是**snake_case 事件名 + 平铺条目**。

把 CC 的配置原样搬过来，实测报错：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo x" }] }
    ]
  }
}
```

```text
⚠ hooks.PreToolUse: 未知的事件名 "PreToolUse"，有效值为 pre_tool_use, post_tool_use,
  post_tool_use_failure, user_prompt_submit, session_start, session_end, pre_compact,
  subagent_stop, permission_request, notification, instructions_loaded, teammate_idle
✗ hooks.PreToolUse[0].command: command 类型的 Hook 必须指定 command 字段
```

两个问题同时中：事件名大驼峰不认，`{matcher, hooks:[]}` 嵌套结构里找不到 `command`。
转换后的正确写法（实测加载无告警、hook 正常触发）：

```json
{
  "hooks": {
    "pre_tool_use": [
      { "type": "command", "matcher": "bash", "command": "echo x >&2" }
    ]
  }
}
```

转换规则就三条：

1. 事件名转 snake_case：`PreToolUse` → `pre_tool_use`
2. 拆掉 `{matcher, hooks:[...]}` 这层包裹，把内层每条提到外层数组
3. `matcher` 作为**同级字段**保留在每条上（工具名用小写，如 `bash` 而非 `Bash`）

事件名对照（`src/hook/types.ts:93-119` 的 `LEGACY_EVENT_MAP`）——CC 的这些都有同名对应：
`pre_tool_use`、`post_tool_use`、`user_prompt_submit`、`session_start`、`session_end`、
`pre_compact`、`subagent_stop`、`notification`、`stop`。

sid-code 独有的事件（CC 没有）：`post_tool_use_failure`、`post_compact`、`subagent_start`、
`permission_request`、`permission_denied`、`stop_failure`、`setup`、`config_change`、
`file_changed`、`cwd_changed`、`task_created`、`task_completed`、`instructions_loaded`、
`teammate_idle`、`elicitation`、`elicitation_result`。全部 32 类见[Hook 事件参考](/ref/hooks)。

::: tip 迁移完先验证 hook 真的在跑
配置校验只对**结构**报错，不保证 hook 逻辑生效。让 hook 往 stderr 写一句
（`echo sentinel >&2`），跑一个会触发它的任务，看有没有那句话。
`session_start` 是个例外——它是 fire-and-forget，**无法注入上下文**，
详见[Hook](/extend/hooks)。
:::

### MCP：`type` 要改成 `transport`

sid-code 的 MCP server **必填 `transport`**（枚举 `stdio` / `http` / `sse` / `ws`），
CC 用的是可选的 `type`（`references/mapping.md:100-107`）：

| CC 写法 | sid-code 写法 |
| --- | --- |
| `"type": "stdio"` 或缺省但有 `command` | `"transport": "stdio"` |
| `"type": "http"` / `"sse"` / `"ws"` | 同名 `transport` |
| 有 `url` 无 `command`、类型判不出来 | 按 `http` 推 |
| `"disabled": true` | `"enabled": false` |

sid-code 支持的字段：`transport`、`command`、`args`、`env`、`url`、`headers`、
`enabled`、`timeout`、`retries`、`includeTools`、`excludeTools`。

CC 独有、sid-code 不支持的（`cwd`、`trust`、`oauth`、`extension`、`headersHelper`、
`alwaysAllow`）会被忽略。OAuth token 与审批状态不迁移，需要重新授权。

### provider 与模型：这部分要重配，不是搬

CC 的 `model` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 这套跟 sid-code 的
`availableModels` 体系语义不同，迁移 skill 对它们**默认只报告不搬运**
（`references/mapping.md:127-129`）。

要新学的一条规则是 `baseURL` 的 `/v1`：**anthropic 族不带 `/v1`，openai 族要带**。
这是 CC 用户最容易踩的新坑，因为 CC 只有一族。完整说明与两种配错的真实报错见
[配置 LLM Provider](/start/configure)。

配完先跑 `sid-code auth status` 验证，别靠"能不能启动"判断——两种配错都不阻碍启动，
要等发第一条消息才炸。

### permissions：结构同名，但要重看一遍

`allow` / `deny` / `ask` / `defaultMode` 四个字段与 CC 同名兼容
（`src/config/settings/types.ts:28-33`），可以直接搬。但有两点值得重看：

- **规则语法有差异细节**：`Bash(npm *)` 的 `*` 不跨空格边界、
  `Read(/src/**)` 是**项目根相对**而 `//etc/**` 才是文件系统绝对。逐条语义见[权限系统](/use/permissions)。
- **项目级 settings 有提权过滤**：`.sid-code/settings.json` 里的 `permissionMode` /
  `skipPermissions` / `allowedTools` 等 8 个字段会被剥掉，危险的自我授权 allow 规则
  （`Bash(*)` 之类）也会被剔除。详见[企业 policy](/team/policy)。如果你的 CC 项目配置
  依赖这些字段，迁过来会看到告警且不生效——这是刻意的。

## 目标路径对照

迁移 skill 的映射准绳（`references/mapping.md:11-25`）：

| 范围 | 目标路径 |
| --- | --- |
| 用户 settings | `~/.sid-code/settings.json` |
| 项目共享 settings | `<proj>/.sid-code/settings.json` |
| 项目本地 settings | `<proj>/.sid-code/settings.local.json` |
| 项目 MCP | `<proj>/.mcp.json` |
| commands / skills / agents / output-styles | `~/.sid-code/<type>/`、`<proj>/.sid-code/<type>/` |
| 项目记忆 | `~/.sid-code/projects/<项目键>/memory/` |

`~/.claude.json` 里的 MCP 配置按位置分流：顶层 `mcpServers` → 用户 settings；
`projects[path].mcpServers` → 该项目的 `settings.local.json`（`mapping.md:91-98`）。

配置根都可覆盖：CC 侧 `CLAUDE_CONFIG_DIR`，sid-code 侧 `SID_CONFIG_DIR`。

## 永不自动迁移的东西

迁移 skill 明确列了黑名单（`references/mapping.md:239-250`），手工迁移也照这个来：

- auth state / OAuth / session 文件——重新登录
- managed / policy settings——企业策略应由管理员下发，见[企业 policy](/team/policy)
- trust cache、`~/.claude.json` 里的未知 per-project state
- keybindings——schema 不兼容
- `enabledPlugins` / `extraKnownMarketplaces`——sid-code 没有插件 marketplace 字段
- **`~/.sid-code/state/migrations.json`**——这是 sid-code 内核的
  [schema 迁移水位线](/team/defaults#只补一次)，写它会破坏内核状态

## 迁过来能多用到什么

不是重点，但迁完值得知道自己多了什么：

- **成本可见**：`/cost` 直接看这次会话花了多少、缓存命中率多少（[成本与用量](/use/cost)）
- **子代理按类型分级用便宜模型**：零配置下 explore / plan / summarize 已自动降档
  （[子代理](/extend/subagents)）
- **32 类 Hook 事件**（CC 约 9 类）
- **轨迹落盘可聚合**：[轨迹采集与可观测](/team/observability)
- **配额与预算规则**：[配额与成本控制](/team/quota)

反过来 CC 有而 sid-code 没有的主要是插件 marketplace 生态，以及 keybindings 自定义。

## 常见问题

### 迁移 skill 报"找不到 node"怎么办

不用装。它会先探测运行时，优先用 `bun`（跑 sid-code 的那个 bun 一定在）。
两者都探不到时会降级为纯内置 `read`/`glob`/`grep` 手查，
**明确不会引导你装 node**（`SKILL.md:49-62`）。

### 迁移能重复跑吗

能。它有状态文件 `~/.sid-code/state/cc-migration-state.json` 记账已迁项，
再跑时跳过。注意这是 **identity 感知而非 content 感知**——
源文件改了内容但路径没变，它仍认为已迁过。想强制重来用 `--force` / `--force-user`。

### CLAUDE.md 要改名成别的吗

不用。`CLAUDE.md` 是一等公民文件名，不需要改。记忆合并链是七层
（managed → user → userRulesDir → project → subdir → rulesDir → local），
细节见[记忆与规则](/use/memory)。

### 迁完怎么确认没漏

三个检查点：

```bash
sid-code auth status     # provider / key 配对了吗
sid-code agents          # 子代理认到了吗（自定义的会标 [custom(...)]）
sid-code -p "ok"         # 有没有 ⚠ / ✗ 开头的配置校验告警
```

第三条最容易被忽略：配置校验的告警是**非致命**的，启动照常继续。
所以一定要看一眼输出里有没有 `⚠ hooks.` 或 `⚠ quota.` 这类行——
它们意味着某段配置静默失效了。

## 相关

- [配置 LLM Provider](/start/configure) —— `/v1` 两族规则，迁移后必读
- [Hook](/extend/hooks) —— 转换后的 hook 怎么写、三个实跑场景
- [Hook 事件参考](/ref/hooks) —— 全部 32 类事件的 schema
- [权限系统](/use/permissions) —— 规则语法逐条语义
- [记忆与规则](/use/memory) —— CLAUDE.md 七层合并链
- [企业 policy 与安全边界](/team/policy) —— 项目级提权过滤为什么会剥掉你的字段
