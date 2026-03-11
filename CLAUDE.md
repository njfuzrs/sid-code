# sid-code — AI 编程 CLI 工具

## 项目定位

Go 语言实现的 AI 编程 CLI 工具，类似 Claude Code。支持多模型（Claude/OpenAI/Ollama）、完整工具系统、权限管理、MCP 协议、Hook 系统。

## 技术栈

- Go 1.24+
- CLI: `cobra` + `viper`
- LLM: `anthropic-sdk-go` (v1.26.0), OpenAI-compatible HTTP client
- TUI: `bubbletea` + `lipgloss` + `glamour`（待实现）

## 核心架构：Agentic While-Loop

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

## 项目结构

```text
sid-code/
├── cmd/sid-code/main.go       # 入口
├── internal/
│   ├── cli/root.go             # Cobra 命令
│   ├── config/                 # Viper 配置 + 规则文件加载
│   │   ├── config.go
│   │   └── rules.go
│   ├── llm/                    # Provider 接口 + 消息类型
│   │   ├── provider.go
│   │   ├── message.go
│   │   ├── anthropic/client.go # Anthropic 实现（流式）
│   │   ├── openai/client.go    # OpenAI 兼容实现（SSE）
│   │   └── ollama/client.go    # Ollama（复用 OpenAI）
│   ├── app/app.go              # 应用编排 + Agentic While-Loop
│   ├── tool/                   # 6 个内置工具
│   │   ├── tool.go, registry.go
│   │   ├── read.go, write.go, edit.go
│   │   ├── bash.go, grep.go, glob.go
│   │   └── tool_test.go
│   ├── context/manager.go      # 上下文窗口管理 + 自动压缩
│   ├── permission/             # 权限检查 + 危险命令拦截
│   │   ├── permission.go
│   │   ├── checker.go
│   │   └── permission_test.go
│   ├── hook/hook.go            # Hook 系统（pre/post 工具调用）
│   └── session/store.go        # 会话持久化（JSON）
├── docs/                       # SDDD 文档体系
│   ├── specs/
│   │   ├── SPEC_COUNTER.txt
│   │   ├── constitution.md     # 项目宪法
│   │   ├── active/             # 进行中的 Spec（目录化）
│   │   ├── archive/            # 已完成的 Spec 归档
│   │   ├── backlog/            # 待排期
│   │   ├── hotfix/             # 紧急修复
│   │   └── templates/          # Spec/Plan/Tasks/Hotfix 模板
│   ├── decisions/              # ADR（架构决策记录）
│   └── iterations/             # 迭代文档
├── go.mod
└── Makefile
```

## 编码约定

- Go 标准项目布局，`internal/` 私有包
- 接口驱动设计：Provider, Tool, Checker 均为接口
- 错误处理：`fmt.Errorf("xxx: %w", err)` 包装错误
- 命名：Go 标准驼峰，包名小写单词
- 测试：`_test.go` 同目录，表驱动测试

## 任务执行规范

1. 先读 spec → 再读 plan → 按 task 逐个实现
2. 每个 task 完成后运行 `go build ./cmd/sid-code` 和 `go test ./...`
3. 不要跳过测试，不要忽略编译错误

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
4. 更新迭代文档
5. 如有架构变更，更新本文件（CLAUDE.md）
6. 如涉及架构决策，新增 ADR

### 常见失败模式
- **跳过澄清阶段** — 直接从 Spec 跳到实现，遗漏边界条件
- **任务粒度过大** — 单个 Task 超过 4 小时，应拆分
- **忽略偏差记录** — 实现偏离 Plan 但未记录，导致文档与代码不同步
- **不更新文档** — 代码完成但 Spec/CLAUDE.md 未同步更新
- **硬编码配置** — API Key、模型名等应通过 config 注入

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
| Spec 模板 | `docs/specs/templates/spec-template.md` | 新 Spec 模板 |
| Plan 模板 | `docs/specs/templates/plan-template.md` | 新 Plan 模板 |
| Tasks 模板 | `docs/specs/templates/tasks-template.md` | 新 Tasks 模板 |
| Hotfix 模板 | `docs/specs/templates/hotfix-template.md` | 紧急修复模板 |
| ADR 目录 | `docs/decisions/` | 架构决策记录 |
| 迭代文档 | `docs/iterations/` | Sprint 跟踪 |
