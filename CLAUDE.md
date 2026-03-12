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
│   ├── config/                   # 配置加载 + 规则文件
│   ├── context/manager.ts        # 上下文管理 + 摘要压缩
│   ├── permission/               # 权限检查
│   ├── hook/runner.ts            # Hook 执行器
│   ├── session/store.ts          # JSON 会话持久化
│   └── command/                  # 斜杠命令系统
├── tests/                        # bun:test 测试
├── internal/                     # Go 源码（保留作参考）
├── cmd/                          # Go 入口（保留作参考）
├── package.json
├── tsconfig.json
└── Makefile
```

模块依赖：`cli` → `app` → `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp` / `ui`

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

## 文档维护规范

- 发现本文件与实际代码不一致，请立即更新
- 发现新的失败模式，添加到 `docs/failure-modes.md`
- 做了架构级决策，在 `docs/decisions/` 新增 ADR
