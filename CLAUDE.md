# sid-code — AI 编程 CLI 工具

## 0. 核心约束

- **语言要求：所有回复、代码注释、文档均使用中文**
- 先读 spec → 再读 plan → 按 task 逐个实现，禁止跳过澄清阶段
- 每个 task 完成后运行 `make build` 和 `make test`
- 不要跳过测试，不要忽略编译错误
- 不要过度工程化——Spec 只要求 2 种场景就不要设计成支持 10 种
- 严禁静默偏差——实现了不同的东西但不记录
- 硬编码配置是 bug——API Key、模型名等通过 config 注入
- **遇到不熟悉的 API、库用法、报错信息时，主动使用联网工具（WebSearch / WebFetch / context7）查询最新文档和解决方案**，不要凭记忆猜测
- **排查复杂 bug 时，主动在关键路径添加详细的调试日志**（console.log / debug 模块），帮助定位问题根因；修复确认后再清理调试日志
- **Ink 渲染铁律（违反会导致滚动重影或崩溃）：**
  - **禁止在 `<Text>` 内嵌套 `<Box>`**——Ink 会直接抛异常 `<Box> can't be nested inside <Text>`
  - **禁止在 `<Text>` 的字符串内容中使用 `\n` 换行**——会导致 `Output.get()` 的 `styledOutput`（二维数组）和 `generatedOutput`（字符串）行数不一致，破坏增量渲染的行级差分，产生滚动重影
  - **多行文本必须拆成每行一个 `<Text>`，用 `<Box flexDirection="column">` 包裹**
  - **块间空行用 `<Box height={1} />` 或空 `<Text>` 元素表示，不用 `"\n\n"` 字符串**
  - 参考 gemini-cli 的 `MarkdownDisplay.tsx`：逐行解析、每行独立组件、Fragment 返回

## 1. 项目概述

TypeScript + Bun + Ink 实现的 AI 编程 CLI 工具，类似 Claude Code。核心架构为 Agentic While-Loop：用户输入 → LLM 流式响应 → stop_reason 为 tool_use 时执行工具并继续循环，end_turn 时结束。

## 2. 技术栈与常用命令

- Bun 1.3+, CLI: `node:util` parseArgs, LLM: `@anthropic-ai/sdk`, TUI: `ink` + `@inkjs/ui`, Markdown: `marked` + `marked-terminal`

```bash
make build    # bun build --compile → ./sid-code
make test     # bun test
make run      # bun run src/cli.ts
make deps     # bun install
```

## 3. 目录结构

```text
src/
├── cli.ts              # 入口：parseArgs + 模式路由
├── app.ts              # 主循环（委托 AgentLoopRunner）
├── agent/              # 子代理系统（loop.ts / sub-agent.ts / tool.ts / custom.ts）
├── llm/                # Provider 接口 + anthropic/openai/ollama 实现 + registry + quota
├── tool/               # 6 个内置工具（read/write/edit/bash/grep/glob）+ registry
├── mcp/                # MCP 协议客户端（transport/client/manager）
├── ui/                 # Ink TUI 组件（App.tsx / VirtualizedList / InputArea / ToolStatus）
│   ├── contexts/       # KeypressContext（键盘优先级）+ ScrollProvider（统一滚动）
│   ├── components/     # VirtualizedList / MessageItemRenderer / StreamingMessage / DialogManager / SlicingMaxSizedBox / CodeColorizer
│   ├── stores/         # MessageDataStore
│   └── renderer/       # RenderController + ScreenRenderer + Rasterizer（双缓冲差分输出）
├── config/             # 配置加载 + 规则文件 + 系统提示词构建 + 附件系统
├── context/            # 上下文管理 + 智能截断 + 增量压缩 + 消息验证
├── checkpoint/         # 文件快照系统（LCS diff + gzip + /undo 回滚）
├── memory/             # 双层记忆系统（全局/项目 + 注入系统提示词）
├── debug/              # 调试日志系统
├── permission/         # 权限检查（6 种模式 + 规则 + 审计）
├── hook/               # Hook 执行器（10 种事件 + command/url + blocking）
├── session/            # 会话持久化（store.ts）+ 状态管理（state.ts）
├── command/            # 斜杠命令系统 + 自定义命令
├── skill/              # Skills 系统（提示词模板注册为工具）
└── extension/          # 三层扩展共享基础设施（扫描 + frontmatter + 缓存）
```

模块依赖：`cli` → `app` → `agent` / `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp` / `ui` / `debug`

## 4. 编码约定

- TypeScript strict 模式
- 接口驱动设计：Provider, Tool, Checker, Command 均为接口
- 错误处理：`new Error("xxx", { cause: err })` 或直接 throw
- Go → TS 映射：`<-chan` → `AsyncIterable`，`context.Context` → `AbortSignal`，`sync.Mutex` → 不需要
- 测试：`tests/` 目录，`bun:test`

## 5. 配置加载优先级

1. 命令行参数（最高）→ 2. 环境变量 → 3. `~/.sid-code/config.yaml` → 4. 默认值

环境变量：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY` / `LLM_API_KEY`、`LLM_PROVIDER`、`LLM_MODEL`、`LLM_BASE_URL`

## 6. 关键架构决策

### 模型切换

- `ProviderRegistry`（`src/llm/registry.ts`）：Provider 工厂 + 缓存，切换时 `clearCache()` + `getProvider()` 重建
- `normalizeConfigKeys()` 处理 YAML snake_case → TS camelCase
- 子代理模型映射：`sub_agent_models` 配置，`SubAgent.fromRegistry()` 按类型选模型
- 成本配额：`QuotaManager` 四级预警（50%/80%/95%/100%），100% 自动停止循环

### 权限系统（6 种模式）

- `default`（写操作确认）、`always-allow`、`deny-write`、`acceptEdits`（文件操作放行）、`plan`（只读）、`dontAsk`（智能决策）
- 五层配置继承：`/etc/` → `~/` → 项目 → 项目 local → 会话记忆
- 规则格式：`工具名` 或 `工具名(glob模式)`，优先级：deny > allow > ask

### System Prompt 动态拼接

固定模板 4 部分（身份/环境/工具指南/行为约束）+ 动态附件按优先级排序：
- p5 权限模式 → p10 CLAUDE.md → p15 诊断 → p20 IDE 选中 → p30 记忆 → p35 Todo → p40 Git 状态 → p50 追加提示词 → p60 文件提示词
- 超限时保留核心模板，按优先级逐个截断低优先级附件

### 上下文管理

- 智能截断（>30K 字符）：代码块 60%头+40%尾，文件内容前20行+后10行，普通文本 70%头+30%尾
- 压缩阈值 0.7，两段式监控：94-100% 警告，100% 强制 autoCompact
- `addMessage` 时对 tool_result 增量截断

### 子代理系统（4 种类型）

| 类型 | 可用工具 |
|------|----------|
| `explore` | read, grep, glob |
| `task` | read, write, edit, bash, grep, glob |
| `plan` | read, grep, glob |
| `summarize` | 无（纯文本） |

安全防护：工具白名单隔离、嵌套 MAX_DEPTH=1、超时 120s、并发 MAX_CONCURRENT=3

### 流式处理

- 心跳检测：30 秒无数据超时
- 重试：指数退避 + ±10% Jitter
- 上下文溢出自动恢复：缩小 maxTokens（至少 3000），无法恢复时触发压缩

### TUI 渲染架构（Alternate Screen Buffer + React 虚拟化）

- 进入 alternate screen buffer（`\x1b[?1049h`），整个屏幕由 Ink 组件树控制
- 消息区域（上方）：`VirtualizedList` 虚拟化滚动，只渲染可见项 + 缓冲项，`MessageItemRenderer` 用 `renderMarkdownToReact()` 渲染
- 流式输出：`StreamingMessage` 组件，状态驱动（`streamingText` / `isStreaming`），安全分割已完成/未完成部分
- 底部固定区域：`ToolStatus` / `DialogRenderer`（权限确认）或 `InputArea` / `StatusBar`
- 键盘事件：`KeypressProvider` 单一 `useInput()` 入口，按优先级分发（Critical > High > Normal > Low）
- 滚动管理：`ScrollProvider` 注册表模式，`queueMicrotask` 合并同帧滚动，支持 PageUp/Down/Shift+↑↓/鼠标滚轮
- `RenderController` 光栅化整棵组件树 + `ScreenRenderer` 双缓冲差分输出
- resize 时直接清屏重绘（alternate screen 无 scrollback reflow 问题）
- 退出时恢复主缓冲区（`\x1b[?1049l`），输出简要对话摘要

## 7. 扩展体系

三层扩展，共享 `src/extension/`（文件扫描 + frontmatter 解析 + 5 分钟 TTL 缓存）：

- **自定义 Commands**：`.sid-code/commands/*.md`，文件名即命令名，支持 `$1`/`$@` 参数替换
- **Skills**：`.sid-code/skills/*.md`，注册为工具 `skill__<name>`（最多 20 个），frontmatter: name/description/allowed-tools/when-to-use/model
- **自定义 Agents**：`.sid-code/agents/*.md`，注册为工具 `agent__<name>`，frontmatter: name/description/tools

## 8. Hook 系统

10 种事件：`pre_tool_use`(可阻止) / `post_tool_use` / `post_tool_use_failure` / `user_prompt_submit`(可阻止+修改输入) / `session_start` / `session_end` / `pre_compact`(可阻止) / `subagent_stop` / `permission_request`(预留) / `notification`(预留)

- 2 种类型：command（shell + 环境变量 `SID_CODE_*` + stdin JSON）、url（HTTP POST）
- blocking hook 可阻止后续操作，matcher 支持精确/正则匹配

## 9. MCP 协议

- 三种传输：stdio / http / sse
- 工具名格式：`mcp__<serverName>__<toolName>`
- 配置：`~/.sid-code/config.yaml` 的 `mcp_servers` + 项目级 `.mcp.json`（覆盖同名）
- 生命周期：启动时 `connectAll()` 并行连接，失败不阻止启动，退出时 `closeAll()`

## 10. 命令系统

### 内置命令

**基础命令**:
- `/help [command]` - 显示帮助信息，可指定命令查看详情
- `/model [name]` - 显示/切换模型，`/model list` 显示所有可用模型
- `/cost` - 显示 token 用量和费用
- `/compact` - 压缩对话历史
- `/clear` - 清空对话
- `/rewind [n]` - 回退最近 n 轮对话（默认 1 轮）
- `/stats` - 显示会话统计
- `/config` - 显示当前配置
- `/undo` - 撤销最近一次文件修改
- `/init` - 初始化项目 .sid-code/ 配置目录
- `/exit` - 退出

**MCP 管理** (`/mcp`):
- `/mcp list` - 列出所有 MCP 服务器状态
- `/mcp add <name> <cmd|url> [args...]` - 添加 MCP 服务器
  - `--scope user|project` - 配置作用域（默认 project）
  - `--transport stdio|http|sse` - 传输方式（默认 stdio）
  - `--env KEY=VALUE` - 环境变量（stdio）
  - `--header KEY:VALUE` - HTTP 头（http/sse）
  - `--timeout <ms>` - 连接超时
  - `--trust` - 信任服务器（跳过工具确认）
- `/mcp remove <name>` - 移除 MCP 服务器
  - `--scope user|project`
- `/mcp enable <name>` - 启用 MCP 服务器
  - `--session` - 仅当前会话
- `/mcp disable <name>` - 禁用 MCP 服务器
  - `--session` - 仅当前会话
- `/mcp test <name>` - 测试连接
- `/mcp prompts` - 列出所有 MCP 提示词
- `/mcp resources` - 列出所有 MCP 资源

**Memory 管理** (`/memory`):
- `/memory set <key> <value>` - 设置记忆
  - `--scope global|project` - 作用域（默认 project）
- `/memory get <key>` - 获取记忆
- `/memory delete <key>` - 删除记忆
- `/memory list` - 列出所有记忆
- `/memory search <keyword>` - 搜索记忆

**Skills 管理** (`/skills`):
- `/skills list` - 列出所有 skills
  - `--all` - 显示所有（含内置）
- `/skills enable <name>` - 启用 skill
  - `--scope user|project` - 配置作用域（默认 user）
- `/skills disable <name>` - 禁用 skill
  - `--scope user|project`

**扩展管理**:
- `/agents list` - 列出所有自定义 agents
- `/commands list` - 列出所有自定义命令

### 自定义命令

在 `.sid-code/commands/` 或 `~/.sid-code/commands/` 目录创建 `.md` 文件，文件名即命令名。

**参数替换**:
- `$1`, `$2`, ... - 位置参数
- `$@` 或 `{{args}}` - 所有参数
- `@{path}` - 文件注入（读取文件内容）
- `!{cmd}` - Shell 注入（执行命令并替换输出，需用户确认）

**示例** (`.sid-code/commands/review.md`):
```markdown
<!-- 代码审查 -->
请审查以下文件的代码质量：

@{$1}

重点关注：
- 代码可读性
- 潜在 bug
- 性能问题
```

使用：`/review src/app.ts`

### 命令参数解析

支持现代 CLI 风格的参数：
- 位置参数：`/mcp add myserver npx`
- `--key=value`：`/mcp add server --scope=user`
- `--key value`：`/mcp add server --scope user`
- 布尔标志：`/skills list --all`

### 子命令架构

命令可以定义子命令，Registry 自动路由：
- `/mcp list` → `MCPListCommand`
- `/skills enable` → `SkillsEnableCommand`
- `/help mcp` → 显示 MCP 命令详细帮助

## 文档维护规范

- 发现本文件与实际代码不一致，请立即更新
- 发现新的失败模式，添加到 `docs/failure-modes.md`
- 做了架构级决策，在 `docs/decisions/` 新增 ADR
