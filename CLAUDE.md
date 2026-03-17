# sid-code — AI 编程 CLI 工具

## 0. 核心约束

- **语言要求：所有回复、代码注释、文档均使用中文**
- 先读 spec → 再读 plan → 按 task 逐个实现，禁止跳过澄清阶段
- 每个 task 完成后运行 `make build` 和 `make test`
- 不要跳过测试，不要忽略编译错误
- 不要过度工程化——Spec 只要求 2 种场景就不要设计成支持 10 种
- 严禁静默偏差——实现了不同的东西但不记录

## 1. 项目概述

TypeScript + Bun + Ink 实现的 AI 编程 CLI 工具，类似 Claude Code。支持多模型（Claude/OpenAI/Ollama）、完整工具系统、权限管理、MCP 协议、Hook 系统、Ink TUI。

核心架构为 Agentic While-Loop：
```
用户输入 → 追加到消息历史
         ↓
┌─→ 发送消息+工具定义给 LLM（流式）
│        ↓
│   累积流式响应，实时渲染文本
│        ↓
│   检查 stop_reason
│   ├── end_turn → 结束，等待下一次输入
│   └── tool_use → 检查权限 → 执行工具 → 收集结果
│                   ↓
└── 追加 assistant 消息 + tool_result 到历史，继续循环
```

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
sid-code/
├── src/
│   ├── cli.ts                    # 入口：parseArgs + 模式路由
│   ├── app.ts                    # Agentic While-Loop 主循环（委托 AgentLoopRunner）
│   ├── agent/                    # 子代理系统
│   │   ├── loop.ts               # AgentLoopRunner 统一循环（TUI/headless 共用）
│   │   ├── sub-agent.ts          # SubAgent（工具白名单 + 嵌套防护 + 超时控制）
│   │   └── tool.ts               # SubAgentTool（并发控制）
│   ├── llm/                      # Provider 接口 + 3 个实现
│   │   ├── types.ts              # Message, StreamEvent, Usage
│   │   ├── provider.ts           # Provider 接口
│   │   ├── anthropic.ts          # Anthropic SDK 实现
│   │   ├── openai.ts             # OpenAI fetch+SSE 实现
│   │   └── ollama.ts             # Ollama（复用 OpenAI）
│   ├── tool/                     # 6 个内置工具
│   │   ├── types.ts, registry.ts
│   │   └── read/write/edit/bash/grep/glob.ts
│   ├── mcp/                      # MCP 协议客户端
│   │   ├── types.ts, transport.ts, client.ts, manager.ts
│   ├── ui/                       # Ink TUI 组件
│   │   ├── App.tsx, MessageList.tsx, InputArea.tsx, ToolStatus.tsx, markdown.ts
│   ├── config/                   # 配置加载 + 规则文件 + 系统提示词构建
│   ├── context/manager.ts        # 上下文管理 + 智能截断 + 增量压缩 + token 估算
│   ├── context/validator.ts      # 消息格式验证 + 自动修复
│   ├── checkpoint/               # 文件快照系统（LCS diff + gzip + 回滚）
│   │   ├── manager.ts            # Checkpoint 管理器（创建/回滚/清理）
│   │   └── diff.ts               # LCS 差分算法（computeDiff/applyDiff/reverseDiff）
│   ├── memory/store.ts           # 双层记忆系统（全局/项目 + 注入系统提示词）
│   ├── debug/logger.ts           # 调试日志系统
│   ├── permission/               # 权限检查（6 种模式 + 规则配置 + 审计日志）
│   │   ├── types.ts, checker.ts, rules.ts, audit.ts, sensitive.ts
│   ├── hook/runner.ts            # Hook 执行器（10 种事件 + command/url 类型 + blocking + matcher）
│   ├── session/store.ts          # JSON 会话持久化（版本号 + 文件锁）
│   ├── session/state.ts          # SessionState 会话状态管理（单一真相源）
│   └── command/                  # 斜杠命令系统
├── tests/                        # bun:test 测试
├── internal/                     # Go 源码（保留作参考）
├── cmd/                          # Go 入口（保留作参考）
├── package.json
├── tsconfig.json
└── Makefile
```

模块依赖：`cli` → `app` → `agent` / `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp` / `ui` / `debug`

## 4. 编码约定

- TypeScript strict 模式
- 接口驱动设计：Provider, Tool, Checker, Command 均为接口
- 错误处理：`new Error("xxx", { cause: err })` 或直接 throw
- Go → TS 映射：`<-chan` → `AsyncIterable`，`context.Context` → `AbortSignal`，`sync.Mutex` → 不需要
- 测试：`tests/` 目录，`bun:test`

## 5. 高频失败模式（Top 3）

- **跳过澄清阶段** → 边界条件遗漏
- **过度工程化** → Spec 只要求 2 种就不要设计 10 种
- **硬编码配置** → API Key、模型名等通过 config 注入

## 6. 配置加载优先级

1. 命令行参数（最高）→ 2. 环境变量 → 3. `~/.sid-code/config.yaml` → 4. 默认值

环境变量：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY` / `LLM_API_KEY`、`LLM_PROVIDER`、`LLM_MODEL`、`LLM_BASE_URL`

## 7. 模型切换功能

支持运行时动态切换模型，无需重启程序。

### 配置示例

在 `~/.sid-code/config.yaml` 中配置可用模型列表：

```yaml
provider: openai
model: qwen3.5-plus
openai_api_key: sk-xxx
base_url: https://dashscope.aliyuncs.com/compatible-mode/v1

available_models:
  - name: qwen-plus
    provider: openai
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  - name: qwen3.5-plus
    provider: openai
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
```

### 使用命令

- `/model` - 显示当前模型和可用模型列表
- `/model <name>` - 切换到指定模型（会验证模型是否在可用列表中）
- `/model list` - 显示详细模型信息
- `/m` - `/model` 的别名

### 实现细节

- `Config.availableModels: ModelConfig[]` - 可用模型配置列表
- `ModelConfig` 支持元数据：`contextWindow`、`maxOutputTokens`、`supportsThinking`
- `ProviderRegistry` — Provider 工厂 + 缓存层，所有组件通过 registry 按需获取 provider/model
- `ModelCommand` - 增强的 `/model` 命令，支持模型验证和自动更新 provider/baseURL
- `normalizeConfigKeys()` - YAML 字段名（snake_case）到 TypeScript 字段名（camelCase）的转换
- 切换模型时，`ProviderRegistry.clearCache()` + `getProvider()` 自动重建 Provider 实例

### 子代理模型映射

支持为不同类型的子代理分配不同模型（便宜/快速模型降低成本）：

```yaml
sub_agent_models:
  explore: qwen-plus       # 探索用便宜模型
  summarize: qwen-plus     # 摘要用便宜模型
  # task/plan 未配置则跟主模型
```

- `SubAgent.fromRegistry()` 静态工厂方法，根据子代理类型动态选择 provider/model
- `SubAgentTool`、`SkillTool`、`CustomAgentTool` 均通过 `ProviderRegistry` 获取 provider

### 成本配额管理

```yaml
cost_limit: 5.0  # 5 美元上限
```

四级预警：50% info、80% warning、95% critical、100% exceeded（自动停止循环）。
`QuotaManager` 在 `AgentLoopRunner.run()` 每轮循环后检查。

### 核心文件

- `src/llm/registry.ts` — ProviderRegistry（工厂 + 缓存 + 子代理模型映射）
- `src/llm/quota.ts` — QuotaManager（四级预警 + 去重）
- `src/agent/sub-agent.ts` — `SubAgent.fromRegistry()` 静态工厂方法
- `src/agent/tool.ts` — SubAgentTool（通过 registry 创建 SubAgent）
- `src/skill/tool.ts` — SkillTool（通过 registry 创建 SubAgent，支持 modelOverride）
- `src/agent/custom.ts` — CustomAgentTool（通过 registry 创建 SubAgent）

详细文档：`docs/model-switching.md`、`docs/examples/model-switching-example.md`

## 8. 调试模式

支持完整的调试日志系统，记录所有关键流程的执行细节。

### 启用方式

```bash
# 命令行参数
sid-code --debug                    # 启用调试模式（默认 DEBUG 级别）
sid-code -d                         # 短选项
sid-code --debug --debug-level INFO  # 指定日志级别
sid-code --debug --debug-log-file /tmp/debug.log  # 自定义日志文件

# 配置文件 ~/.sid-code/config.yaml
debug: true
debug_level: DEBUG  # ERROR, WARN, INFO, DEBUG
debug_log_file: ~/.sid-code/debug.log
```

### 日志级别

- **ERROR**: 只记录错误信息
- **WARN**: 记录警告和错误
- **INFO**: 记录一般信息、警告和错误（推荐用于生产环境）
- **DEBUG**: 记录所有详细信息（推荐用于开发调试）

### 记录内容

- **配置加载**: 配置文件路径、加载的配置项、环境变量覆盖
- **应用初始化**: 系统提示词长度、注册的工具数量、CLAUDE.md 规则加载
- **LLM 请求/响应**: 请求参数（模型、消息数、工具数）、响应状态、Token 用量
- **工具执行**: 工具名称和参数、执行时间、输出长度、错误信息和堆栈
- **Agent 循环**: 每轮对话的轮次、消息历史长度、停止原因
- **MCP 连接**: 服务器连接状态、注册的工具列表、连接错误

### 实现细节

- `src/debug/logger.ts` - 日志系统核心实现
- `getLogger()` - 获取全局 logger 单例
- `initLogger(options)` - 初始化 logger（在 cli.ts 中调用）
- 日志格式：`[时间戳] [级别] [分类] 消息 + JSON 数据`
- 日志文件：默认 `~/.sid-code/debug.log`，每次启动清空旧日志

详细文档：`docs/debug-mode.md`

## 9. SessionState 会话状态管理

对标 Claude Code 的 SessionState，作为"单一真相源"集中管理会话运行时状态。

### 核心功能

- **按模型分开统计** token 用量（支持多模型混用场景）
- **成本计算**：区分缓存 token 计价（缓存读取 90% 折扣，缓存写入 25% 加价）
- **耗时追踪**：API 调用耗时 vs 工具执行耗时分开统计，方便诊断瓶颈
- **内置定价表**：Claude Opus/Sonnet/Haiku，未知模型按 $0 计算

### 实现细节

- `src/session/state.ts` — `SessionState` 类
- `updateUsage(model, usage, durationMs)` — 每次 API 调用后更新
- `addToolDuration(durationMs)` — 每次工具执行后累加
- `calculateCost(model, usage)` — 单次成本计算
- `getTotalUsage()` — 兼容旧 `Usage` 接口的汇总
- `/cost` 命令展示：会话时长、总费用、API/工具耗时、按模型分开的详细统计

### 流式处理增强

- **心跳检测**：`processStream` 中 30 秒无数据自动超时，防止流挂死
- **重试 Jitter**：指数退避加 ±10% 随机抖动，避免惊群效应
- **上下文溢出自动恢复**：捕获 `input + max_tokens > context_limit` 错误，自动缩小 `maxTokens`（至少保留 3000 tokens），无法恢复时触发自动压缩

### 会话持久化增强

- `SessionData.version` 字段（当前 "1.0"），方便后续格式升级
- 文件锁机制：`save` 时写入 `.lock` 文件，防止并发写入，5 分钟超时自动清理僵尸锁
- `--continue` / `--resume <id>`：CLI 中完整接入会话恢复，消息多时注入摘要

## 10. 权限系统增强

对标 Claude Code 的权限系统，支持 6 种权限模式、规则配置、五层配置继承、会话记忆、审计日志、目录白名单/黑名单。

### 6 种权限模式

- `default` — 默认模式，写操作需要用户确认
- `always-allow` — 自动放行所有操作
- `deny-write` — 拒绝所有写操作
- `acceptEdits` — 自动接受文件操作（read/write/edit），bash 仍需确认
- `plan` — 只读模式，只允许 read/grep/glob，拒绝所有写入和 bash
- `dontAsk` — 智能自动决策：读操作放行，工作目录内写入放行，危险操作拒绝

### 权限规则配置

支持 `allow/deny/ask` 规则，带 glob 模式匹配：

```yaml
# .sid-code/permissions.yaml
permissions:
  allow:
    - Read
    - Glob
    - Bash(npm *)
  deny:
    - Edit(.env*)
    - Bash(rm *)
  ask:
    - Edit
    - Write
```

规则格式：`工具名` 或 `工具名(glob模式)`，优先级：deny > allow > ask

### 五层配置继承

1. `/etc/sid-code/policy.yaml` — 策略配置（企业级）
2. `~/.sid-code/config.yaml` — 全局配置（permissions 字段）
3. `<project>/.sid-code/permissions.yaml` — 项目配置（团队共享）
4. `<project>/.sid-code/permissions.local.yaml` — 本地配置（个人）
5. 会话内记忆 — 内存中的临时决策

### 会话内权限记忆

用户确认时可选 `a`（always allow），本次会话内记住决策，不再重复询问。最多记忆 1000 条。

### 审计日志

JSONL 格式，路径 `~/.sid-code/permissions-audit.log`，10MB 自动轮转，保留 10 个历史文件。

### 目录白名单/黑名单

```yaml
permissions:
  allowed_directories:
    - /Users/dev/projects
  blocked_directories:
    - /Users/dev/projects/secrets
```

黑名单优先于白名单。

### 核心文件

- `src/permission/types.ts` — PermissionRule, AuditEntry, Checker 接口
- `src/permission/checker.ts` — 14 层权限检查（会话记忆 → 危险命令 → 禁用工具 → 目录白名单 → 路径安全 → 敏感文件 → 规则检查 → 模式检查 → 读操作 → 预授权 → deny-write → always-allow → 用户确认）
- `src/permission/rules.ts` — 规则解析和 glob 匹配
- `src/permission/audit.ts` — 审计日志（JSONL + 轮转）
- `src/config/config.ts` — `loadPermissionRules()` 五层配置加载

## 11. System Prompt 动态拼接

对标 Claude Code 的 11 部分动态拼接，系统提示词不再是固定结构，而是由固定模板 + 动态附件组成。

### 架构设计

```
固定模板（4 部分，必须保留）:
  1. 身份指令 — buildIdentitySection()
  2. 环境信息 — buildEnvironmentSection(workingDir)
  3. 工具指南 — buildToolGuideSection(tools)
  4. 行为约束 — buildConstraintsSection()

动态附件（按优先级排序，超限时截断低优先级）:
  priority 5  — 权限模式提示词（plan/readonly/strict 等）
  priority 10 — CLAUDE.md 项目规则
  priority 15 — 诊断信息（预留）
  priority 20 — IDE 选中代码（预留）
  priority 30 — 记忆信息（全局/项目双层记忆）
  priority 35 — Todo 列表（预留）
  priority 40 — Git 状态（分支 + 变更 + 最近提交）
  priority 50 — 追加提示词
  priority 60 — 文件提示词
```

### 核心文件

- `src/config/system-prompt.ts` — 构建器（缓存 + 附件收集 + Token 截断）
- `src/config/attachments.ts` — 附件系统（Attachment 接口 + 各类生成函数）
- `src/config/token-utils.ts` — Token 估算（区分中文/英文/代码）+ 按优先级截断
- `src/config/rules.ts` — CLAUDE.md 搜索（5 种文件名 + 向上查找 + 全局配置）

### 关键特性

- **缓存机制**：5 分钟 TTL，最多 100 条，相同上下文直接返回缓存
- **Token 估算**：中文 ~2.0 字符/token，代码 ~3.0，英文 ~3.5
- **智能截断**：超限时保留核心模板，按优先级逐个添加附件
- **CLAUDE.md 搜索**：`CLAUDE.md` / `.claude.md` / `claude.md` / `.claude/CLAUDE.md` / `.claude/instructions.md` + `~/.claude/CLAUDE.md`
- **Git 状态注入**：自动获取当前分支、变更文件、最近提交
- **权限模式提示词**：6 种模式（default/bypassPermissions/plan/readonly/yesMode/strict）

### SystemPromptContext 接口

```typescript
interface SystemPromptContext {
  tools: Tool[];           // 已注册工具
  projectRules?: string;   // CLAUDE.md 内容
  appendPrompt?: string;   // 追加提示词
  filePrompt?: string;     // 文件提示词
  workingDir?: string;     // 工作目录
  permissionMode?: string; // 权限模式
  gitStatus?: boolean;     // 是否包含 Git 状态
  ideSelection?: string;   // IDE 选中代码（预留）
  diagnostics?: string;    // 诊断信息（预留）
  todoList?: string;       // Todo 列表（预留）
  memorySummary?: string;  // 记忆摘要（全局/项目双层记忆）
  maxTokens?: number;      // 最大 token 数（默认 180000）
}
```

## 12. 上下文管理优化（对标 Claude Code）

### 智能截断（三层策略）

工具输出超过 30K 字符时，按内容类型智能截断：

1. **代码块**（\`\`\` 包裹）：保留 60% 头 + 40% 尾（行级别）
2. **文件内容**（行号特征 `→` 或 `数字│`）：保留前 20 行 + 后 10 行
3. **普通文本**：70% 头 + 30% 尾（字符级别）

### 压缩阈值

- `compactThreshold`: **0.7**（对齐 Claude Code 的 70%）
- `compactWithSummary` 默认保留最近 **10** 条消息

### 两段式自动压缩监控

在 AgentLoopRunner 每轮循环中检测上下文使用率：
- **94-100%**：输出警告 `[Context left until auto-compact: X%]`
- **100%（剩余 0%）**：强制触发 `autoCompact()`

### 增量压缩

`addMessage` 时对 `tool_result` 内容块自动应用截断，在源头控制上下文膨胀。

### 核心文件

- `src/context/manager.ts` — 智能截断 + 增量压缩 + 阈值调优

## 13. Checkpoint 文件快照系统

在 write/edit 工具执行前自动保存文件快照，支持 `/undo` 回滚。

### 存储策略

- 第一次保存完整内容（>1KB 时 gzip 压缩 + base64）
- 后续保存增量 diff（LCS 算法）
- 每文件最多 50 个 checkpoint，总共最多 200MB，30 天自动清理
- 存储路径：`~/.sid-code/checkpoints/<session-id>/`

### 使用命令

- `/undo` — 撤销最近一次文件修改，回滚到上一个 checkpoint

### 核心文件

- `src/checkpoint/manager.ts` — Checkpoint 管理器（创建/回滚/清理/索引持久化）
- `src/checkpoint/diff.ts` — LCS 差分算法（computeDiff/applyDiff/reverseDiff）

## 14. 双层记忆系统

全局/项目双层记忆，跨会话持久化，自动注入系统提示词。

### 存储路径

- 全局记忆：`~/.sid-code/memory/memories.json`
- 项目记忆：`<project>/.sid-code/memory/memories.json`

### 查询优先级

项目记忆 > 全局记忆（同 key 时项目覆盖全局）

### 使用命令

- `/memory` 或 `/memory list` — 列出所有记忆
- `/memory set <key> <value>` — 保存项目记忆
- `/memory set <key> <value> --global` — 保存全局记忆
- `/memory get <key>` — 查询记忆
- `/memory delete <key>` — 删除记忆
- `/memory search <keyword>` — 搜索记忆

### 系统提示词注入

记忆通过附件系统注入（priority 30），在应用初始化时自动加载。

### 核心文件

- `src/memory/store.ts` — MemoryStore（CRUD + 搜索 + 摘要生成）
- `src/config/attachments.ts` — `generateMemoryAttachment()` 记忆附件生成

## 15. 子代理系统

支持 4 种子代理类型，每种有独立的工具白名单和系统提示词。

### 子代理类型

| 类型 | 用途 | 可用工具 |
|------|------|----------|
| `explore` | 搜索和分析代码库 | read, grep, glob |
| `task` | 执行编码子任务 | read, write, edit, bash, grep, glob |
| `plan` | 代码分析和规划 | read, grep, glob |
| `summarize` | 总结大量内容 | 无（纯文本） |

### 安全防护

- **工具白名单隔离**：每种子代理类型只能使用白名单内的工具，`Registry.filter()` 实现过滤
- **嵌套防护**：`SubAgent.depth` 静态计数器，`MAX_DEPTH=1`，不允许子代理再 spawn 子代理
- **超时控制**：默认 120 秒，通过 `AbortSignal.any()` 合并外部 signal 和超时 signal
- **并发控制**：`SubAgentTool.running` 静态计数器，`MAX_CONCURRENT=3`

### 统一 Agent 循环

`AgentLoopRunner`（`src/agent/loop.ts`）是 TUI 和 headless 共用的核心循环逻辑：
- thinking hint 解析 → 上下文两段式监控 → LLM 请求（含重试/回退/溢出自动调整）→ 流式处理 → 工具执行 → max_tokens 续写
- 通过 `AgentLoopCallbacks` 接口处理 UI 差异（TUI 用 updateState，headless 用最小回调）

### 核心文件

- `src/agent/loop.ts` — AgentLoopRunner + AgentLoopCallbacks + AgentLoopDeps
- `src/agent/sub-agent.ts` — SubAgent（白名单 + 嵌套防护 + 超时 + executeCustom）
- `src/agent/tool.ts` — SubAgentTool（并发控制）
- `src/agent/custom.ts` — CustomAgentLoader + CustomAgentTool（自定义 Agent）
- `src/tool/registry.ts` — `Registry.filter()` 工具过滤 + `definitions()` 含 usageGuide

## 16. Commands/Skills/Agents 三层扩展体系

对标 Claude Code 的扩展系统，支持用户自定义斜杠命令、Skills（LLM 可调用的提示词模板）、Agents（自定义子代理）。

### 共享基础设施

`src/extension/` 模块提供三层扩展共用的文件扫描、frontmatter 解析、TTL 缓存：

- `src/extension/types.ts` — ExtensionSource, ExtensionFile, ParsedExtensionFile
- `src/extension/frontmatter.ts` — 轻量 YAML frontmatter 解析器（复用 `yaml` 库）
- `src/extension/loader.ts` — ExtensionLoader（扫描 `~/.sid-code/{type}/` 和 `{project}/.sid-code/{type}/`，5 分钟 TTL 缓存，project 覆盖 user）

### 自定义 Commands

从 `.sid-code/commands/*.md` 加载用户自定义斜杠命令：

```bash
# 创建自定义命令
mkdir -p .sid-code/commands
cat > .sid-code/commands/review.md << 'EOF'
---
description: 代码审查
---
请审查以下代码，关注代码质量、潜在 bug 和性能问题: $@
EOF

# 使用
/review src/app.ts
```

- 文件名即命令名，frontmatter `description` 或第一行 HTML 注释 `<!-- ... -->` 作为描述
- 支持参数替换：`$1`, `$2`, `$@`（所有参数）
- 保护命令名（help/exit/clear 等）不可覆盖
- `execute()` 将替换后的文本注入对话，触发 LLM 响应

核心文件：`src/command/custom.ts`

### Skills 系统

Skills 是带元数据的提示词模板，注册为工具后 LLM 可自动调用：

```bash
mkdir -p .sid-code/skills
cat > .sid-code/skills/review.md << 'EOF'
---
name: code-review
description: 代码审查
allowed-tools: read, grep, glob
when-to-use: 当用户要求审查代码时
argument-hint: 要审查的文件路径
---
请审查以下代码，关注：
1. 代码质量
2. 潜在 bug
3. 性能问题
EOF
```

frontmatter 字段：
- `name` — Skill 名称（默认用文件名）
- `description` — 描述
- `allowed-tools` — 允许使用的工具（逗号分隔或数组）
- `when-to-use` — 何时使用（提示 LLM）
- `argument-hint` — 参数提示
- `model` — 指定模型（可选）
- `disable-model-invocation` — 禁止 LLM 自动调用（仅手动触发）

注册为工具名 `skill__<name>`，最多 20 个。

核心文件：`src/skill/types.ts`, `src/skill/loader.ts`, `src/skill/tool.ts`

### 自定义 Agents

从 `.sid-code/agents/*.md` 加载自定义 Agent 定义：

```bash
mkdir -p .sid-code/agents
cat > .sid-code/agents/checker.md << 'EOF'
---
name: code-checker
description: 代码检查代理
tools: read, grep, glob
---
你是一个代码检查代理。检查代码中的问题并报告。
EOF
```

frontmatter 字段：`name`, `description`, `tools`（逗号分隔或数组）

注册为工具名 `agent__<name>`，通过 `SubAgent.executeCustom()` 执行。

核心文件：`src/agent/custom.ts`

### usageGuide 注入

`Registry.definitions()` 中，如果工具实现了 `usageGuide()`，将其拼接到 description 末尾，格式为 `\n\n使用指南:\n{guide}`。

## 17. Hook 系统

对标 Claude Code 的 Hook 系统，支持 10 种事件、2 种钩子类型、blocking 机制、matcher 匹配、stdin JSON 传递、返回值解析。

### 10 种事件类型

| 事件 | 触发时机 | 可阻止 | 调用位置 |
|------|----------|--------|----------|
| `pre_tool_use` | 工具执行前 | 是 | `app.ts` executeSingleTool |
| `post_tool_use` | 工具执行后 | 否 | `app.ts` executeSingleTool |
| `post_tool_use_failure` | 工具执行失败后 | 否 | `app.ts` executeSingleTool catch |
| `user_prompt_submit` | 用户提交输入时 | 是（可修改输入） | `agent/loop.ts` run |
| `session_start` | 会话开始 | 否 | `app.ts` init |
| `session_end` | 会话结束 | 否 | `app.ts` runHeadless/runTUI |
| `pre_compact` | 上下文压缩前 | 是 | `app.ts` autoCompact |
| `subagent_stop` | 子代理停止 | 否 | `agent/sub-agent.ts` execute/executeCustom |
| `permission_request` | 权限请求时 | 否 | 预留 |
| `notification` | 通知事件 | 否 | 预留 |

### 2 种钩子类型

- **command**（默认）：执行 shell 命令，通过环境变量 + stdin JSON 传递上下文
- **url**：HTTP 远程回调（fetch POST），JSON body 传递上下文

### blocking 机制

- `blocking: true` 的 hook 可以阻止后续操作（工具执行、压缩、用户输入）
- command 类型：非零退出码 或 stdout JSON `{"blocked":true}` 触发阻止
- url 类型：非 2xx 响应触发阻止
- 阻止后立即中断 hook 链，不执行后续 hook

### matcher 匹配

- 无 matcher：通配所有工具
- 精确匹配：`matcher: "bash"`（不区分大小写）
- 正则匹配：`matcher: "/^(bash|write)$/"`

### 数据传递

- **环境变量**：`SID_CODE_HOOK_EVENT`、`SID_CODE_TOOL_NAME`、`SID_CODE_TOOL_INPUT`、`SID_CODE_TOOL_OUTPUT`、`SID_CODE_TOOL_IS_ERROR`、`SID_CODE_SESSION_ID`、`SID_CODE_USER_INPUT`、`SID_CODE_ERROR`
- **stdin JSON**：完整上下文 `{ event, toolName, toolInput, ... }`
- **返回值**：stdout JSON 解析为 `HookResult`，支持 `blocked`、`reason`、`modifiedInput` 字段

### 配置格式

新格式（按事件分组，推荐）：
```yaml
hooks:
  pre_tool_use:
    - type: command
      command: "echo 检查安全性"
      matcher: Bash
      blocking: true
      timeout: 10
  post_tool_use:
    - type: url
      url: "https://audit.company.com/log"
      method: POST
      blocking: false
  session_start:
    - type: command
      command: "./scripts/session-init.sh"
```

旧格式（数组，向后兼容，自动按 event 分组）：
```yaml
hooks:
  - event: pre_tool_use
    command: "echo hook"
    timeout: 30
```

### 核心文件

- `src/hook/runner.ts` — HookRunner（事件分发 + matcher + blocking + command/url 执行 + 返回值解析）
- `src/config/config.ts` — HookConfig / HooksConfig 接口 + 旧格式兼容转换

## 18. MCP 协议集成

对标 Claude Code 的 MCP（Model Context Protocol）支持，连接外部工具服务器，扩展工具能力。

### 配置方式

全局配置 `~/.sid-code/config.yaml`：

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    timeout: 15000
    retries: 2
  remote:
    transport: sse
    url: https://mcp.example.com/sse
    headers:
      Authorization: "Bearer xxx"
  disabled-server:
    transport: stdio
    command: some-server
    enabled: false  # 临时禁用
```

项目级配置 `.mcp.json`（覆盖全局同名服务器）：

```json
{
  "mcpServers": {
    "project-tools": {
      "transport": "stdio",
      "command": "node",
      "args": ["./tools/mcp-server.js"]
    }
  }
}
```

### MCPServerConfig 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `transport` | `"stdio" \| "http" \| "sse"` | 传输方式 |
| `command` | `string` | stdio 模式：可执行命令 |
| `args` | `string[]` | stdio 模式：命令参数 |
| `env` | `Record<string, string>` | stdio 模式：环境变量 |
| `url` | `string` | http/sse 模式：服务器 URL |
| `headers` | `Record<string, string>` | http/sse 模式：HTTP 头 |
| `enabled` | `boolean` | 默认 true，设为 false 临时禁用 |
| `timeout` | `number` | 请求超时毫秒，默认 30000 |
| `retries` | `number` | 重试次数，默认 2 |

### 三种传输方式

- **stdio**：通过子进程 stdin/stdout 通信，最常用
- **http**：HTTP POST 请求通信
- **sse**：GET 连接 SSE 流接收响应/通知，POST 发送请求（MCP Streamable HTTP）

### 生命周期

1. `cli.ts` 中创建 `MCPManager`，调用 `connectAll()` 并行连接所有启用的服务器
2. MCP 工具适配为内部 `Tool` 接口，工具名格式：`mcp__<serverName>__<toolName>`
3. 连接失败不阻止应用启动（优雅降级）
4. 应用退出时（exit/Ctrl+C/headless/TUI）调用 `mcpManager.closeAll()` 清理连接

### 使用命令

- `/mcp` — 显示已连接服务器列表、状态、工具数量

### 核心特性

- **重试机制**：指数退避 + ±30% 随机抖动，默认重试 2 次
- **通知处理**：`notifications/initialized` 作为通知发送（无 id），监听 `notifications/tools/list_changed` 自动刷新工具列表
- **工具变更回调**：服务器通知工具列表变更时，自动移除旧工具、注册新工具

### 核心文件

- `src/mcp/types.ts` — JSON-RPC 2.0 + MCP 协议类型
- `src/mcp/transport.ts` — Transport 接口 + StdioTransport + HTTPTransport + SSETransport
- `src/mcp/client.ts` — MCPClient（initialize/listTools/callTool + 重试 + 通知监听）
- `src/mcp/manager.ts` — MCPManager（多服务器管理 + 工具适配 + 状态查询）
- `src/config/config.ts` — MCPServerConfig 接口 + `.mcp.json` 加载

## 文档维护规范

- 发现本文件与实际代码不一致，请立即更新
- 发现新的失败模式，添加到 `docs/failure-modes.md`
- 做了架构级决策，在 `docs/decisions/` 新增 ADR
