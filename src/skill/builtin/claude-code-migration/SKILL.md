---
name: claude-code-migration
description: 安全检查、规划并协助把 Claude Code 的用户级和项目级配置迁移到 sid-code。当用户要求迁移 Claude Code 的 settings、MCP servers、commands、skills、agents、hooks、memory、output styles、permissions 到 sid-code，或说"迁移 Claude Code 配置"、"从 Claude Code 切到 sid-code"、"claude code 迁移"、"claude to sid"时使用。
when-to-use: 用户想把 Claude Code 的配置（settings / MCP / commands / skills / agents / hooks / memory / output-styles / permissions）迁移到 sid-code 时。
mode: activate
---

# Claude Code 到 sid-code 迁移

只用于 Claude Code -> sid-code。首要目标是保护用户现有环境：只 copy，不 move；不删除源文件；不静默覆盖目标文件。

## 不可违反的规则

- **先做只读检查。** 展示迁移计划前，不写文件、不运行安装命令。
- 默认使用用户启动 sid-code 的当前目录作为项目上下文。如果 `~/.claude.json` 里有多个项目条目匹配，先让用户选择。
- **所有写入前都要用户确认。** 高风险资源单独确认：permissions、hooks、MCP secrets/env/headers、env 字段，以及所有冲突。
- 迁移计划和确认问题必须按 scope 拆开说明：用户级、项目共享级、项目本地级分别迁移哪些、跳过哪些、写到哪里。
- 不迁移 auth state、OAuth/session 文件、managed/policy settings、trust caches 或未知 state/cache 文件。
- 只写入 `references/mapping.md` 列出的目标文件；不要创建未列出的 sid-code 配置文件。
- 允许写入迁移状态文件 `~/.sid-code/state/cc-migration-state.json`（inspector 的默认 `--state` 路径）。它是本 skill 的记账文件，不是 sid-code 运行时配置；只记录已迁移项的标识（scope、目标路径或 `目标#mcpServers.name`、时间戳、项目路径），绝不写入 secret / env / headers 值。**绝不触碰 `~/.sid-code/state/migrations.json`**——那是 sid-code 内核 schema 迁移的版本水位线文件。
- 未知、不支持、无效和空字段默认只报告；除非 `references/mapping.md` 明确写了迁移方式。
- 无论是否实际写入，最后都要生成迁移报告。

## 写入 settings.json 的硬性约束

**绝不整体覆盖写 sid-code 的 settings.json。** 只做「新增缺失的顶层字段/嵌套键」的 patch 式合并：读入现有 JSON → 只添加计划里确认的字段 → 写回。原因：sid-code 的 settings 经 Zod round-trip 整体重写会 strip 掉嵌套字段（如 `availableModels[].apiKey`）并把 `${ENV}` 占位符展开成明文落盘。若目标字段已存在，走冲突流程，不覆盖。

## 工作流

### 1. 运行只读 inspector

```bash
node <skill-dir>/scripts/inspect-migration.mjs --project "$PWD"
```

需要机器可读结果时加 `--format json`。如果没有 Node.js（sid-code 基于 Bun，通常有 `bun`，也可用 `bun <skill-dir>/scripts/inspect-migration.mjs`），不要跳过检查；按 `references/mapping.md` 列出的源文件和目标文件手动检查，并在任何写入前生成同样结构的迁移计划。

inspector 是**状态感知**的：它读取迁移状态文件（默认 `~/.sid-code/state/cc-migration-state.json`，可用 `--state` 覆盖），把「已记录迁移过且目标仍存在」的项归入「已迁移（本次跳过）」，不再当作冲突反复要求确认。逃生阀：`--force` 忽略全部状态、`--force-user` 仅忽略用户级状态，用于源配置更新后想重新迁移的场景。计划里每个可迁移/需确认项都带 `identity` 字段，执行后按它回写状态。

### 2. 阅读映射准绳

在解释 inspector 输出、提出迁移方案或执行迁移前，先阅读 `references/mapping.md`，严格按其中的 scope、字段映射、schema 转换（MCP `type→transport`、hooks 结构展开）和缺口处理。

### 3. 向用户展示计划

- 发现了哪些源文件
- 将会触碰哪些目标文件
- 用户级、项目共享级、项目本地级分别计划迁移哪些内容，分别不迁移哪些内容
- **哪些内容已经在 sid-code 可读取的位置（compatibleInPlace）**：sid-code 原生读取 `.claude` 的记忆/规则位置（`CLAUDE.md`、`.claude/rules/`、`CLAUDE.local.md`、`~/.claude/CLAUDE.md`）以及项目根 `.mcp.json`，这些**无需迁移**，明确告知用户「已经能用，不用搬」
- 哪些内容因迁移状态记录被判定为「已迁移（本次跳过）」；告知如需重迁可用 `--force-user` 或 `--force`
- 建议迁移的项目和目标路径
- 冲突和可选处理方式
- 只报告、不支持、未知和空字段
- **如涉及 MCP**：列出每个 server 推导出的 `transport` 值（Claude 的 `type` 会转成 sid-code 的 `transport`），以及 `disabled→enabled` 转换和不支持字段；env/headers 作为敏感项只展示 key 名
- **如涉及 hooks**：把它作为执行风险项请用户确认。展示①事件名与展开后的 sid-code 扁平 HookEntry 结构（Claude 两层 matcher 分组会被展开）；②`$CLAUDE_PROJECT_DIR → $SID_CODE_PROJECT_DIR` 的 token 替换；③含其他 `CLAUDE_*`/`claude`/`.claude` 引用的 hook 命令需人工核对
- **如涉及 env 字段**：作为敏感项确认。只展示 key 名不打印值；提醒 Claude 专属 env（`ANTHROPIC_*`/`CLAUDE_CODE_*`/`API_TIMEOUT_MS`）语义与 sid-code 的 provider 配置不同，建议改写为 sid-code 原生字段（`baseURL`/`anthropicKey`/`maxTokens`）而非原样搬运
- **如涉及项目 memory**（当前项目的 `~/.claude/projects/<id>/memory/`）：作为**敏感项单独确认**。memory（尤其 `MEMORY.md` 与 `team/`）可能含个人信息或凭据。列出源/目标路径，但**不打印 memory 内容**；提醒用户迁移前后自查。注意源目录名与目标目录名用**两套不同的 sanitize 规则**（inspector 已算好，直接用计划里的路径，不要自己推导）
- **如涉及 plugins**（`enabledPlugins`/`extraKnownMarketplaces`）：只报告。sid-code 无插件 marketplace 机制，说明需用户改用 sid-code 的 skill/MCP/agent 重建等价能力

### 4. 请求用户确认

低风险 copy-only 项（commands/skills/agents/output-styles 无冲突时）可以按 scope 合并确认；高风险资源必须单独确认（permissions、hooks、MCP secrets/env/headers、env 字段、项目 memory 以及所有冲突）。不要只问「是否全部迁移」，要让用户看清每个 scope 的来源、目标和资源类型。

用 sid-code 的结构化提问能力（`ask_user_question`）给出可枚举的确认选项（迁移 / 跳过 / 冲突处理方式），而不是逐条口头问逼用户手敲。

### 5. 只执行用户批准的项目

- 复制文件/目录，不移动。
- **不覆盖已有目标。** 遇到冲突时，让用户选择跳过、追加、重命名副本或手动合并。
- **settings.json 用 patch 式合并**（见上方硬性约束），不整体覆盖。
- **MCP 写入时执行 `type→transport` 转换**：每个 server 补上 `transport` 字段（`stdio`/`http`/`sse`/`ws`，按 mapping.md 规则推导），`disabled` 转 `enabled`，丢弃 sid-code 不支持的字段（如 `cwd`/`trust`/`oauth`）。项目级 MCP 优先写项目根 `.mcp.json`；如果项目根已有有效 `.mcp.json`，只报告 sid-code 可直接读取，不复制。
- **hooks 写入时执行结构展开**：把 Claude 的 `event -> [{matcher, hooks:[inner]}]` 展开成 sid-code 的扁平 `event -> [{type, event, matcher, command, timeout, ...}]`，并替换 `$CLAUDE_PROJECT_DIR` token。目标已有 hooks 时按事件名追加（需确认）。
- **memory 复制**：把源 memory 目录整体 copy 到目标目录（inspector 计划里的目标路径）；`team/` 子目录整体保留结构；目标已存在时走冲突流程，绝不覆盖合并。
- **compatibleInPlace 项不复制**：只告知用户它们已能被 sid-code 读取。

### 6. 更新迁移状态文件（仅在有实际成功写入时）

- 写回 inspector 计划里报告的 `stateFile.path`（未指定 `--state` 时为默认的 `~/.sid-code/state/cc-migration-state.json`）。不要自行拼默认路径，否则用了 `--state` 时会写错文件。目录不存在时先创建。
- 读取现有状态；不存在则新建 `{ "version":1, "tool":"claude-code-to-sid-code-migration", "userScope":{"items":[]}, "projects":{} }`。
- 把本次**成功迁移**项的 `identity`（直接取自 inspector 计划，不要自行重新推导）合并进对应 scope：用户级进 `userScope.items`；项目共享级和项目本地级进 `projects[<项目绝对路径>].items`。去重后更新对应的 `migratedAt` 为当前时间。
- 只在实际写入成功后追加。用户跳过、冲突未解决或写入失败的项不要记入。执行中断时不要写脏状态。
- 状态文件只记 identity 标识，绝不写入 secret / env / headers 值。项目根 `.mcp.json` 中 compatibleInPlace 的项不需要记（它本就无需迁移）。

### 7. 输出最终迁移报告

包含：

- 已迁移项目（按 scope 分列）
- 已跳过项目和原因（含因状态记录而「已迁移（本次跳过）」的项、compatibleInPlace 项）
- 迁移状态文件的位置，以及本次新记录了哪些 identity
- 冲突及用户选择的处理方式
- 执行的 schema 转换（MCP transport、hooks 展开、token 替换）
- 不支持或未知字段
- 只报告项目
- 创建的新文件或备份文件
- 建议的人工后续处理
- 如迁移了项目 memory：提醒用户 memory 可能含个人信息或凭据，请迁移后自查；仅迁移了当前项目的 memory，其他项目需在对应目录分别运行本 skill
- **收尾提醒**：如果迁移过来的 skills、agents、hooks、commands 或 output styles 中写死了 Claude 模型名、provider、auth 或模型相关环境变量，需要按 sid-code 支持的配置调整（`provider`/`availableModels`/`subAgentModels`/`baseURL` 等）

## 资源说明

- `references/mapping.md`：迁移映射和缺口的准绳。解释检查结果或改文件前**必须读取**。
- `scripts/inspect-migration.mjs`：确定性的只读扫描脚本。会**只读**读取迁移状态文件来识别已迁移项；不得写文件、安装或访问网络。
- 迁移状态文件 `~/.sid-code/state/cc-migration-state.json`：本 skill 的记账文件，记录已迁移项的 identity，让多次运行不重复处理全局配置。由 skill 在迁移成功后写入，inspector 只读。删除它不影响 sid-code 运行，只会让下次运行重新提示已迁移项。

## 已知限制

- 状态是 identity 感知、非 content 感知：首次迁移后改了源里某项的值，本工具不自动重迁，需 `--force-user` / `--force`。
- 只处理当前项目的 auto-memory；其他项目需分别在对应目录运行。
- Claude 的 model/provider/auth/env、plugins（`enabledPlugins`/`extraKnownMarketplaces`）无法自动迁移为 sid-code 可用配置，只报告，需用户手动改写。
- Keybindings schema 不兼容，只报告，需手动重映射。
