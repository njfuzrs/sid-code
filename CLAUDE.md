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
│   ├── app.ts                    # Agentic While-Loop 主循环
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
│   ├── context/manager.ts        # 上下文管理 + 摘要压缩 + token 估算
│   ├── context/validator.ts      # 消息格式验证 + 自动修复
│   ├── debug/logger.ts           # 调试日志系统
│   ├── permission/               # 权限检查（6 种模式 + 规则配置 + 审计日志）
│   │   ├── types.ts, checker.ts, rules.ts, audit.ts, sensitive.ts
│   ├── hook/runner.ts            # Hook 执行器
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

模块依赖：`cli` → `app` → `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp` / `ui` / `debug`

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
- `ModelCommand` - 增强的 `/model` 命令，支持模型验证和自动更新 provider/baseURL
- `normalizeConfigKeys()` - YAML 字段名（snake_case）到 TypeScript 字段名（camelCase）的转换
- 切换模型时，如果模型配置了不同的 `provider` 或 `baseURL`，会自动更新这些配置

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
  maxTokens?: number;      // 最大 token 数（默认 180000）
}
```

## 文档维护规范

- 发现本文件与实际代码不一致，请立即更新
- 发现新的失败模式，添加到 `docs/failure-modes.md`
- 做了架构级决策，在 `docs/decisions/` 新增 ADR
