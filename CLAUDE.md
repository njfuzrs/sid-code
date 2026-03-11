# sid-code — AI 编程 CLI 工具

## 0. 任务执行规范

### AI 行为约束
- **语言要求：所有回复、代码注释、文档均使用中文**
- 先读 spec → 再读 plan → 按 task 逐个实现，禁止跳过澄清阶段
- 每个 task 完成后运行 `make build` 和 `make test`
- 不要跳过测试，不要忽略编译错误
- 不要过度工程化——Spec 只要求 2 种场景就不要设计成支持 10 种

### 当前迭代焦点
- **Sprint 2**（`docs/iterations/2026-Q1-Sprint2.md`）
- SPEC-007：集成接线 + Slash 命令 ✅ 已完成
- SPEC-008：CLI 增强 + Headless 模式（`docs/specs/active/008-cli-enhancement/`）
- SPEC-009：MCP 协议基础（`docs/specs/active/009-mcp-protocol/`）

### 偏差处理
- 实现与 Plan 不一致时，在 tasks.md 的"执行偏差记录"中记录
- 记录格式：[日期] [严重程度:低/中/高] [偏差描述] [处理方式]
- 偏差涉及接口变更时，须同步更新 plan.md
- 严重程度为"高"时，暂停执行并告知开发者
- 严禁静默偏差（实现了不同的东西但不记录）

### 收尾规范
每个 Spec 完成后：
1. 更新所有 Task 状态为 DONE
2. 更新 spec.md 状态为 Done
3. 更新 tasks.md 进度概览
4. 填写 tasks.md 归档回顾（实际 vs 预期、经验教训、产生的新知识）
5. 更新迭代文档
6. 如有架构变更，更新本文件（CLAUDE.md）
7. 如涉及架构决策，新增 ADR
8. 如发现新的失败模式，更新 `docs/failure-modes.md`

## 1. 项目概述

Go 语言实现的 AI 编程 CLI 工具，类似 Claude Code。支持多模型（Claude/OpenAI/Ollama）、完整工具系统、权限管理、MCP 协议、Hook 系统。

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

- Go 1.24+
- CLI: `cobra` + `viper`
- LLM: `anthropic-sdk-go` (v1.26.0), OpenAI-compatible HTTP client
- TUI: `bubbletea` + `lipgloss` + `glamour`

常用命令：
```bash
make build          # 编译 → 输出 ./sid-code
make run            # 编译并运行
make test           # 运行全部测试
make lint           # golangci-lint 检查
make deps           # go mod tidy
make clean          # 清理构建产物
go build ./cmd/sid-code   # 直接编译
go test ./...             # 直接测试
```

## 3. 目录结构与文件职责

```text
sid-code/
├── cmd/sid-code/main.go       # 入口
├── internal/
│   ├── cli/root.go             # Cobra 命令定义 + 参数绑定
│   ├── config/                 # Viper 配置 + 规则文件加载
│   │   ├── config.go           #   配置结构体 + 加载逻辑
│   │   └── rules.go            #   CLAUDE.md 规则加载
│   ├── llm/                    # Provider 接口 + 消息类型
│   │   ├── provider.go         #   Provider 接口定义
│   │   ├── message.go          #   统一消息类型
│   │   ├── anthropic/client.go #   Anthropic SDK 流式实现
│   │   ├── openai/client.go    #   OpenAI 兼容 SSE 实现
│   │   └── ollama/client.go    #   Ollama（复用 OpenAI client）
│   ├── app/app.go              # 应用编排 + Agentic While-Loop 主循环
│   ├── command/                # Slash 命令系统
│   │   ├── command.go          #   Command 接口 + Registry
│   │   └── builtin.go          #   内置命令（/exit /clear /help /model /status /cost /context /diff）
│   ├── tool/                   # 6 个内置工具
│   │   ├── tool.go, registry.go
│   │   ├── read.go, write.go, edit.go
│   │   ├── bash.go, grep.go, glob.go
│   │   └── tool_test.go
│   ├── mcp/                    # MCP 协议客户端
│   │   ├── types.go            #   JSON-RPC 2.0 + MCP 协议类型
│   │   ├── transport.go        #   Transport 接口
│   │   ├── transport_stdio.go  #   stdio 传输（子进程）
│   │   ├── transport_http.go   #   HTTP 传输
│   │   ├── client.go           #   MCP 客户端核心
│   │   ├── manager.go          #   多服务器管理
│   │   └── mcp_tool.go         #   MCP 工具适配器（→ Tool 接口）
│   ├── context/manager.go      # 上下文窗口管理 + 自动压缩
│   ├── permission/             # 权限检查 + 危险命令拦截
│   │   ├── permission.go, checker.go, permission_test.go
│   ├── hook/hook.go            # Hook 系统（pre/post 工具调用）
│   ├── session/store.go        # 会话持久化（JSON）
│   └── ui/model.go             # Bubble Tea TUI（viewport + textarea）
├── docs/                       # SDDD 文档体系（详见下方文档索引）
├── go.mod
└── Makefile
```

模块依赖关系：`cli` → `app` → `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp`

## 4. 核心工作流

### 交互模式（默认）
```
用户启动 sid-code
  → cli/root.go 解析参数，config.Load() 加载配置
  → app.New() 初始化（Provider + 工具注册 + 权限 + Hook + MCP + Session）
  → config.LoadRules() 加载 CLAUDE.md 注入 system prompt
  → ui/model.go 启动 Bubble Tea TUI
  → 用户输入 → 检查是否 /slash 命令
    ├── 是 → command.Registry 分发执行
    └── 否 → 追加到 context.Manager → 进入 agentLoop
      → LLM 流式响应 → 实时渲染 Markdown（Glamour）
      → tool_use → permission.Check() → hook.RunPre() → tool.Execute() → hook.RunPost()
      → 结果追加到消息历史 → 继续循环直到 end_turn
  → session.Store 自动保存会话
```

### Headless 模式（`--print`）
```
sid-code --print "prompt"
  → 同上初始化，但跳过 TUI
  → 直接执行 agentLoop，纯文本输出（无 ANSI）
  → 支持 --output-format json 和 --max-turns 限制
```

## 5. 编码约定

- Go 标准项目布局，`internal/` 私有包
- 接口驱动设计：Provider, Tool, Checker 均为接口
- 错误处理：`fmt.Errorf("xxx: %w", err)` 包装错误
- 命名：Go 标准驼峰，包名小写单词
- 测试：`_test.go` 同目录，表驱动测试

## 6. 常见失败模式

- **跳过澄清阶段** — 直接从 Spec 跳到实现，遗漏边界条件
- **任务粒度过大** — 单个 Task 超过 4 小时，应拆分
- **忽略偏差记录** — 实现偏离 Plan 但未记录，导致文档与代码不同步
- **不更新文档** — 代码完成但 Spec/CLAUDE.md 未同步更新
- **硬编码配置** — API Key、模型名等应通过 config 注入
- **AI 过度工程化** — 不必要的抽象、工厂模式，Spec 只要求 2 种场景就不要设计成支持 10 种
- **AI 回写偏差但开发者不看** — 偏差越积越多，Spec 与代码严重脱节
- **Hotfix 不补文档** — 紧急修复后 48 小时内必须补充完整文档

> 完整的失败模式记录见 `docs/failure-modes.md`

## 7. 新增模块检查清单

添加新功能时，必须检查并同步修改以下文件：

- [ ] `internal/app/app.go` — 新模块是否需要在 App 中初始化和接线？
- [ ] `internal/tool/registry.go` — 新增工具是否注册到 Registry？
- [ ] `internal/command/builtin.go` — 新增 slash 命令是否注册？
- [ ] `internal/config/config.go` — 新增配置项是否添加到 Config 结构体？
- [ ] `internal/cli/root.go` — 新增 CLI 参数是否绑定？
- [ ] `~/.sid-code/config.yaml` — 配置文件示例是否更新？
- [ ] `CLAUDE.md` — 目录结构和文档索引是否更新？
- [ ] `docs/failure-modes.md` — 是否发现新的失败模式？

## 文档维护规范

- 如果发现本文件中的路径、命令、描述与实际代码不一致，请立即更新
- 如果发现新的失败模式，请添加到 `docs/failure-modes.md`
- 如果做了架构级决策，请在 `docs/decisions/` 中新增 ADR

## 配置加载优先级

1. 命令行参数（最高）
2. 环境变量 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
3. `~/.sid-code/config.yaml`
4. 默认值（最低）

## 关键接口

```go
// LLM Provider
type Provider interface {
    Name() string
    SendMessageStream(ctx context.Context, params SendParams) (<-chan StreamEvent, error)
}

// Tool
type Tool interface {
    Name() string
    Description() string
    InputSchema() json.RawMessage
    Execute(ctx context.Context, input json.RawMessage) (Result, error)
}

// Permission Checker
type Checker interface {
    Check(ctx context.Context, req PermissionRequest) (Decision, error)
}
```

## 文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| 宪法 | `docs/specs/constitution.md` | SDDD 方法论、规范定义 |
| 失败模式 | `docs/failure-modes.md` | AI 常犯错误和已知的坑 |
| ADR 目录 | `docs/decisions/` | 架构决策记录 |
| 迭代文档 | `docs/iterations/` | Sprint 跟踪 |
| Sprint 1 | `docs/iterations/2026-Q1-Sprint1.md` | Phase 1-6（SPEC-001~006） |
| Sprint 2 | `docs/iterations/2026-Q1-Sprint2.md` | 集成接线 + CLI 增强 + MCP |
| Spec 模板 | `docs/specs/templates/spec-template.md` | 新 Spec 模板 |
| Plan 模板 | `docs/specs/templates/plan-template.md` | 新 Plan 模板 |
| Tasks 模板 | `docs/specs/templates/tasks-template.md` | 新 Tasks 模板 |
| Hotfix 模板 | `docs/specs/templates/hotfix-template.md` | 紧急修复模板 |
