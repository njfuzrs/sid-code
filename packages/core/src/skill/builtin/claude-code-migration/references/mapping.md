# Claude Code 到 sid-code 迁移映射

本文件是迁移决策的准绳。没有在这里列出的字段，一律报告为 unknown，不要自动迁移。

所有路径基于配置根目录解析：源 = Claude Code 的 `~/.claude`（可被 `CLAUDE_CONFIG_DIR` 覆盖），目标 = sid-code 的 `~/.sid-code`（可被 `SID_CONFIG_DIR` 覆盖）。

## 目标模型

sid-code 迁移目标：

| 范围 | 目标 |
|---|---|
| 用户 settings | `~/.sid-code/settings.json` |
| 项目共享 settings | `<project>/.sid-code/settings.json` |
| 项目本地 settings | `<project>/.sid-code/settings.local.json` |
| 项目 MCP | `<project>/.mcp.json` |
| 用户 commands | `~/.sid-code/commands/` |
| 项目 commands | `<project>/.sid-code/commands/` |
| 用户 skills | `~/.sid-code/skills/` |
| 项目 skills | `<project>/.sid-code/skills/` |
| 用户 agents | `~/.sid-code/agents/` |
| 项目 agents | `<project>/.sid-code/agents/` |
| 用户 output styles | `~/.sid-code/output-styles/` |
| 项目 output styles | `<project>/.sid-code/output-styles/` |
| 项目 memory（当前项目） | `~/.sid-code/projects/<sanitizeProjectKey(项目根)>/memory/` |

**与 Claude → Qoder 迁移的关键差异**：sid-code 的规则引擎**原生读取 `.claude` 记忆/规则位置**（见下方「记忆与规则」）。因此 `CLAUDE.md`、`.claude/rules/`、`CLAUDE.local.md`、`~/.claude/CLAUDE.md` **无需迁移**——它们已在 sid-code 可直接读取的位置，归入「已在兼容位置」，只报告不复制。

## 迁移状态文件

为避免在多个项目目录重复运行时，全局配置被反复当作冲突要求确认，本 skill 维护一个记账文件：

- 路径：`~/.sid-code/state/cc-migration-state.json`（inspector `--state` 默认值，随 `--home` / `SID_CONFIG_DIR` 解析）。
- **重要**：不要用 `~/.sid-code/state/migrations.json`——那是 sid-code 内核 schema 迁移 runner 的版本水位线文件，写它会破坏内核迁移状态。
- 用途：记录已成功迁移项的 identity，inspector 只读取它，把「已记录且目标仍存在」的项归入「已迁移（本次跳过）」。
- 写入时机：只由 skill 在用户批准的迁移**成功后**写入；inspector 永不写。
- schema：

```json
{
  "version": 1,
  "tool": "claude-code-to-sid-code-migration",
  "userScope": { "migratedAt": "ISO8601", "items": ["<identity>"] },
  "projects": { "<项目绝对路径>": { "migratedAt": "ISO8601", "items": ["<identity>"] } }
}
```

- identity 计算（读写两端必须一致，直接取 inspector 计划里的 `identity` 字段，**不要自行推导或改成绝对路径**）：
  - MCP server → `<inspector 目标标签>#mcpServers.<name>`。目标标签用符号形式：用户级 `~/.sid-code/settings.json`、项目共享级 `<project>/.mcp.json`、项目本地级 `<project>/.sid-code/settings.local.json`。
  - settings 字段（permissions / hooks / outputStyle / env）→ `<inspector 目标标签>#<字段>`，如 `~/.sid-code/settings.json#permissions`。
  - commands / skills / agents / output-styles 顶层项 → 目标绝对路径。
  - memory 目录项 → 目标绝对路径。
- scope 归属：用户级进 `userScope.items`；项目共享级与项目本地级都进 `projects[<项目绝对路径>].items`。
- 只记 identity 标识，**绝不**写入 secret / env / headers 值。
- 已知限制：状态是 identity 感知、非 content 感知。首次迁移后改了源里某已迁移项的值，本工具不会自动重迁；用 `--force-user`（仅用户级）或 `--force`（全部）强制重新扫描。
- 状态文件自身永不作为迁移源，也永不被迁移；删除它不影响 sid-code 运行。

## 常见 Claude Code 源

| 源 | 含义 |
|---|---|
| `~/.claude/settings.json` | 用户级 settings |
| `~/.claude.json` | 用户/本地 MCP、项目状态、auth/session/cache state |
| `<project>/.claude/settings.json` | 项目共享 settings |
| `<project>/.claude/settings.local.json` | 项目本地 settings |
| `<project>/.mcp.json` | 项目 MCP，已经位于标准位置（sid-code 也读它） |
| `~/.claude/commands/`、`<project>/.claude/commands/` | Slash commands |
| `~/.claude/skills/`、`<project>/.claude/skills/` | Skills |
| `~/.claude/agents/`、`<project>/.claude/agents/` | Agents |
| `~/.claude/output-styles/`、`<project>/.claude/output-styles/` | Output styles |
| `~/.claude/rules/`、`<project>/.claude/rules/` | Rules（sid-code 原生读取，无需迁移） |
| `~/.claude/projects/<sanitize(项目根)>/memory/` | 当前项目的 auto-memory |
| `~/.claude/CLAUDE.md`、`<project>/CLAUDE.md` | Memory / instructions（sid-code 原生读取，无需迁移） |
| `<project>/CLAUDE.local.md` | 项目本地 memory（sid-code 原生读取，无需迁移） |
| `~/.claude/keybindings.json` | Keybindings，不兼容 |

## Scope 确认规则

迁移计划和用户确认必须按 scope 拆开：

- 用户级：来源通常是 `~/.claude/**` 或 `~/.claude.json` 顶层；目标通常是 `~/.sid-code/**`。
- 项目共享级：来源通常是 `<project>/.claude/settings.json`、`<project>/.claude/**`；目标通常是 `<project>/.sid-code/**` 或 `<project>/.mcp.json`。
- 项目本地级：来源通常是 `<project>/.claude/settings.local.json` 或 `~/.claude.json` 的当前项目条目；目标通常是 `<project>/.sid-code/settings.local.json`。

确认时列出每个 scope 中要迁移的资源类型、源路径、目标路径和冲突。不要用一个模糊的「全部迁移」确认代替 scope 级说明。

## MCP

推荐目标：

| 源 | 目标 | 决策 |
|---|---|---|
| `<project>/.mcp.json` | 原文件 | 不迁移。校验并报告 sid-code 可读取。 |
| `~/.claude.json` 顶层 `mcpServers` | `~/.sid-code/settings.json` 的 `mcpServers` | 写入前确认。 |
| `~/.claude.json` 的 `projects[projectPath].mcpServers` | `<project>/.sid-code/settings.local.json` 的 `mcpServers` | 写入前确认。 |
| `<project>/.claude/settings.json` 的 `mcpServers` | `<project>/.mcp.json` | 确认后迁移，优先 `.mcp.json`。 |
| `<project>/.claude/settings.local.json` 的 `mcpServers` | `<project>/.sid-code/settings.local.json` | 写入前确认。 |
| `~/.claude/settings.json` 的 `mcpServers` | `~/.sid-code/settings.json` 的 `mcpServers` | 写入前确认。 |

**必做 schema 转换（Claude → sid-code）**：

- **`type` → `transport`**（必做）：sid-code 的 MCP server 要求必填 `transport` 字段，枚举 `stdio | http | sse | ws`；Claude 用可选的 `type`。转换规则：
  - Claude `type: "stdio"` 或缺省但有 `command` → sid-code `transport: "stdio"`。
  - Claude `type: "http"` / `"sse"` / `"ws"`（或有 `url` 无 `command`）→ 同名 `transport`；无法判定时默认按 `url` 存在推 `http`。
  - 迁移计划里必须显式列出每个 server 推导出的 `transport` 值，让用户确认。

sid-code 支持的 MCP server 字段：

`transport`、`command`、`args`、`env`、`url`、`headers`、`enabled`、`timeout`、`retries`、`includeTools`、`excludeTools`。

规则：

- 除上述 `type→transport` 外，原样保留支持字段。
- Claude 独有、sid-code 不支持的字段（如 `cwd`、`trust`、`oauth`、`extension`、`headersHelper`、`alwaysAllow`、`disabled`——注意 sid-code 用 `enabled` 不是 `disabled`）列为不支持，报告源路径和 server 名，不写入。`disabled: true` 可转换为 `enabled: false`（列入计划确认）。
- `env`、`headers` 视为敏感项。展示 key 名和目标位置，不主动打印完整 secret value，除非用户要求。
- 如果目标中已存在同名 server，停止并询问：保留目标、替换目标、重命名源 server 或跳过。
- 不迁移 OAuth tokens、审批状态或连接状态。

## Settings

| 字段 | 迁移策略 |
|---|---|
| `permissions.allow` / `deny` / `ask` | 必须确认。结构同名兼容，展示目标 scope 和访问边界影响后再保留值。sid-code 的 `permissions.defaultMode` 若源没有则不补。 |
| `hooks` | 必须确认（执行风险）。**必做结构转换**，见下方 Hooks 节。 |
| `outputStyle` | 必须确认。只有对应 style 文件已在 sid-code 目标位置存在后，才设置 active style。 |
| `mcpServers` | 按 MCP 规则处理（含 `type→transport`）。 |
| `env` | 敏感项，必须逐条确认。sid-code **有**顶层 `env` 字段（不同于 Qoder），可迁移，但：① 值多为 secret（如 `*_API_KEY`、`*_AUTH_TOKEN`），只展示 key 名不打印值；② Claude 专属 env（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`ANTHROPIC_MAX_TOKENS`、`API_TIMEOUT_MS` 等）语义与 sid-code 的 provider/model 配置不同，**默认只报告**，让用户决定是否改写为 sid-code 的 `baseURL`/`anthropicKey`/`maxTokens` 等原生字段，而非原样搬运 env。 |
| `model` / `fallbackModel` | 默认只报告。模型名、provider 和 auth 面不同；sid-code 有自己的 `provider`/`availableModels`/`fallbackModel` 体系。 |
| `enabledPlugins` / `extraKnownMarketplaces` | 只报告。**sid-code 无插件 marketplace 字段**，无对应迁移目标。 |
| managed 或 policy 字段 | 不迁移，只报告。 |
| 空对象、空数组、`null` | 跳过，列为 empty skipped。 |
| 未知字段 | 只报告。 |

sid-code 的 settings.json **必须用 patch 式写入**（`patchSettingsFile` / 合并缺失顶层键），**禁止整体覆盖写**：整体覆盖会经 Zod round-trip strip 掉嵌套字段（如 `availableModels[].apiKey`）并把 `${ENV}` 占位符展开成明文。迁移写入只做「新增缺失字段」，不覆盖已有字段。

## Hooks

**必做结构转换**：Claude Code 与 sid-code 的 hooks 结构不同。

Claude Code（两层，含 matcher 分组包裹）：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "...", "timeout": 5 } ] }
    ]
  }
}
```

sid-code（扁平，每个 HookEntry 直接带命令）：

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "event": "PreToolUse", "matcher": "Write", "command": "...", "timeout": 5 }
    ]
  }
}
```

转换规则（对每个事件名）：

- 遍历 Claude 的 `event -> [ { matcher?, hooks: [ inner... ] } ]`，把每个内层 hook 展开成一条 sid-code HookEntry：`{ type, command, matcher: 分组的 matcher, timeout, event: 事件名 }`。丢弃中间的 `hooks` 包裹层。
- sid-code HookEntry 支持字段：`type`(`command|url`)、`event`、`command`、`url`、`method`、`headers`、`timeout`、`blocking`、`matcher`。Claude hook 里不在此列的字段列为不支持并报告。

明确支持的 token 替换：

| Claude token | sid-code token |
|---|---|
| `$CLAUDE_PROJECT_DIR` | `$SID_CODE_PROJECT_DIR` |
| `${CLAUDE_PROJECT_DIR}` | `${SID_CODE_PROJECT_DIR}` |

规则：

- 写入前展示 hook diff（转换后的 sid-code 结构 + token 替换结果），并把 hooks 标为需要用户确认的执行风险项。
- 仅自动替换上表列出的 token。其他 `CLAUDE_*` 变量、环境变量名、命令名称、matcher、timeout、type、事件名和顺序都保持原样。
- 如果 hook 含有其他 `CLAUDE_*` token、显式调用 `claude`、读取 Claude 状态文件（如 `~/.claude/...`）或依赖 Claude-only 路径，默认只报告转换后仍需人工核对，除非用户明确批准。
- 如果目标已存在 hooks，询问追加、替换或跳过。事件名下的 HookEntry 数组按追加合并（不去重覆盖）需用户确认。

## 记忆与规则（关键差异：多为兼容位置，无需迁移）

sid-code 的规则引擎原生读取以下 Claude 位置（`src/config/rules.ts`），因此它们**不是迁移目标**，归入「已在兼容位置」只报告：

| 源 | sid-code 行为 | 决策 |
|---|---|---|
| `<project>/CLAUDE.md`（及 `.claude.md` / `claude.md` / `.claude/CLAUDE.md` / `.claude/instructions.md`） | 项目根规则原生加载 | 兼容位置，不迁移 |
| `<project>/CLAUDE.local.md`、`<project>/.claude/CLAUDE.local.md` | 本地私有规则原生加载 | 兼容位置，不迁移 |
| `<project>/.claude/rules/**/*.md` | 项目规则目录原生加载 | 兼容位置，不迁移 |
| `~/.claude/CLAUDE.md` | 全局规则原生加载（sid-code 优先读 `~/.claude/CLAUDE.md`，回退 `~/.sid-code/CLAUDE.md`） | 兼容位置，不迁移 |

只在用户明确要求「把全局记忆搬到 `~/.sid-code/CLAUDE.md`」时才复制 `~/.claude/CLAUDE.md → ~/.sid-code/CLAUDE.md`，且目标存在时绝不覆盖（走冲突流程）。默认不主动搬。

## 项目 auto-memory 目录（关键差异：源/目标用不同 sanitize 规则）

| 源 | 目标 | scope | 默认行为 |
|---|---|---|---|
| `~/.claude/projects/<CC-sanitize(项目根)>/memory/` | `~/.sid-code/projects/<sid-sanitize(项目根)>/memory/` | 项目本地级 | 敏感项，始终需用户显式确认；直接 copy，绝不覆盖。 |

**源目录名与目标目录名用的是两套不同的 sanitize 规则**（不同于 Claude→Qoder 迁移的同规则）：

- **源（Claude Code）sanitize**：`name.replace(/[^a-zA-Z0-9]/g, '-')`（不折叠连续 `-`，不去首尾 `-`，不保留 `.`/`_`）；结果 >200 字符时取 `slice(0,200) + '-' + djb2(原始路径).toString(36)`。
  - 例：`/Users/x/Code/proj` → `-Users-x-Code-proj`（保留前导 `-`）。
- **目标（sid-code）sanitize**（`sanitizeProjectKey`，见 `src/memory/paths.ts:40`）：去首尾分隔符 → 路径分隔符转 `-` → `[^a-zA-Z0-9._-]` 转 `-` → 折叠连续 `-` → 去首尾 `-`；空则 `"default"`。**保留 `.` 和 `_`，无 hash。**
  - 例：`/Users/x/Code/proj` → `Users-x-Code-proj`（无前导 `-`）。
- inspector 用同一个「项目根路径」分别套两套规则算源目录名和目标目录名，**不要假定两者相同**。
- 项目根路径解析：源用当前项目路径；目标用 sid-code 的 canonical git root（`git rev-parse --show-toplevel`，失败回退 `resolve(cwd)`）。inspector 用传入的 `--project`（默认 `$PWD`）作为两端的项目根输入。

规则：

- 只处理**当前项目**的 memory。其他项目需在对应目录分别运行本 skill。
- 敏感性：memory 可能含个人信息或凭据。必须作为敏感项让用户**单独确认**，不并入低风险批量确认。**不打印 memory 内容**，只展示源/目标路径。
- `team/` 或 `team-memory/` 子目录作为**单个目录 item** 整体 copy 保留结构，用一个 identity（= 目标子目录路径）追踪。
- 冲突：目标 `MEMORY.md` 或整个 memory 目录已存在时走冲突流程（跳过 / 重命名副本 / 手动合并），保守不自动合并覆盖。
- 源缺失兜底：若 memory 目录不存在或为空，只报告期望的源路径（让用户判断是「没有 memory」还是「目录名没匹配上」），不静默跳过、不报错。

## Commands、Skills、Agents、Output Styles

从对应 Claude 位置 copy 到 sid-code 位置。保留相对路径，不覆盖已有文件。迁移计划按顶层 item 粒度展示：一个 command 文件或 namespace 目录、一个 skill 目录、一个 agent 文件/目录、一个 output style 文件作为一项。

- **frontmatter 兼容性**：sid-code 的 skill/agent/command frontmatter 与 Claude Code 高度同源（`name`/`description`/`allowed-tools`/`when-to-use`/`model`/`mode` 等），直接 copy 即可加载。差异只影响激活时机，不报错。
- 复制 output style 文件和设置 `outputStyle` 为 active 是两个独立动作。active setting 必须单独确认。
- 如果 commands、skills、agents、hooks、output styles 内部包含 Claude 模型名、provider、auth 或模型相关环境变量，不要自动按原值迁移为可用配置。报告这些位置，并说明需要改成 sid-code 支持的模型配置（sid-code 的 `subAgentModels`、`availableModels`、`provider` 体系）。

## Keybindings

不迁移。Claude Code keybindings 和 sid-code keybindings 使用不同 schema。报告源文件，说明需要手动重映射。

## Plugins

**只报告，不迁移**。sid-code 没有 `enabledPlugins` / `extraKnownMarketplaces` 对应的 settings 字段，也没有等价的 marketplace/install 命令体系。

- 检测到 `enabledPlugins` / `extraKnownMarketplaces` 时，列出它们的内容供用户知晓，说明 sid-code 暂无对应机制，需用户改用 sid-code 的 skill / MCP / agent 机制手动重建等价能力。
- 不 copy 插件 cache/state 文件，不编辑任何插件状态。
- 插件内的 commands/hooks/skills 若硬编码 `CLAUDE_*` 变量或 Claude-specific 路径，报告风险。

## 永不自动迁移

- Auth/session tokens、OAuth state
- Managed settings 和 remote settings
- Trust caches 和项目审批选择
- Runtime caches、`~/.claude.json` 中未知的 per-project state
- Keybindings
- `enabledPlugins` / `extraKnownMarketplaces`（sid-code 无对应字段）
- Claude 模型名、provider、auth 或模型相关环境变量（默认只报告，由用户改写为 sid-code 原生配置）
- 不支持或未知字段
- 迁移状态文件 `~/.sid-code/state/cc-migration-state.json` 自身
- sid-code 内核迁移水位线文件 `~/.sid-code/state/migrations.json`（绝不触碰）
