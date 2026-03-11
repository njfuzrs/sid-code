# sid-code — AI 编程 CLI 工具

## 0. 核心约束

- **语言要求：所有回复、代码注释、文档均使用中文**
- 先读 spec → 再读 plan → 按 task 逐个实现，禁止跳过澄清阶段
- 每个 task 完成后运行 `make build` 和 `make test`
- 不要跳过测试，不要忽略编译错误
- 不要过度工程化——Spec 只要求 2 种场景就不要设计成支持 10 种
- 严禁静默偏差——实现了不同的东西但不记录
- **涉及安全、架构变更、Spec 状态推进、紧急修复时**，须遵守 `docs/specs/constitution.md`

### 当前迭代焦点
- **Sprint 3**（`docs/iterations/2026-Q1-Sprint3.md`）— 稳固基础 + 启用 TUI
- SPEC-011：Headless 模式修复 + 权限策略（P0）
- SPEC-010：TUI 启用 + Glamour 渲染（P1）
- SPEC-012：Token 计费追踪（P1）
- SPEC-013：测试覆盖补充（P1）
- SPEC-014：上下文压缩优化（P2，可延后）

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

- Go 1.24+, CLI: `cobra` + `viper`, LLM: `anthropic-sdk-go` (v1.26.0), TUI: `bubbletea` + `lipgloss` + `glamour`

```bash
make build    # 编译 → ./sid-code
make test     # 运行全部测试
make lint     # golangci-lint 检查
make deps     # go mod tidy
```

## 3. 目录结构

```text
sid-code/
├── cmd/sid-code/main.go       # 入口
├── internal/
│   ├── cli/root.go             # Cobra 命令定义 + 参数绑定
│   ├── config/                 # Viper 配置 + 规则文件加载
│   ├── llm/                    # Provider 接口 + 3 个实现（anthropic/openai/ollama）
│   ├── app/app.go              # 应用编排 + Agentic While-Loop 主循环
│   ├── command/                # Slash 命令系统（Command 接口 + Registry + 内置命令）
│   ├── tool/                   # 6 个内置工具（read/write/edit/bash/grep/glob）
│   ├── mcp/                    # MCP 协议客户端（types/transport/client/manager/adapter）
│   ├── context/manager.go      # 上下文窗口管理 + 自动压缩
│   ├── permission/             # 权限检查 + 危险命令拦截
│   ├── hook/hook.go            # Hook 系统（pre/post 工具调用）
│   ├── session/store.go        # 会话持久化（JSON）
│   └── ui/model.go             # Bubble Tea TUI
├── docs/                       # SDDD 文档体系
├── go.mod
└── Makefile
```

模块依赖：`cli` → `app` → `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp`

## 4. 编码约定

- Go 标准项目布局，`internal/` 私有包
- 接口驱动设计：Provider, Tool, Checker 均为接口
- 错误处理：`fmt.Errorf("xxx: %w", err)` 包装错误
- 命名：Go 标准驼峰，包名小写单词
- 测试：`_test.go` 同目录，表驱动测试

## 5. 高频失败模式（Top 3）

- **跳过澄清阶段** → 边界条件遗漏，AI 每次猜测结果不同
- **过度工程化** → Spec 只要求 2 种就不要设计 10 种
- **硬编码配置** → API Key、模型名等通过 config 注入

> 完整列表见 `docs/failure-modes.md`，或使用 `/sddd-pitfalls`

## 6. 配置加载优先级

1. 命令行参数（最高）→ 2. 环境变量 → 3. `~/.sid-code/config.yaml` → 4. 默认值

## 7. 文档与 Skills 索引

| 资源 | 路径 / 命令 | 何时使用 |
|------|------------|---------|
| 宪法 | `docs/specs/constitution.md` | 架构变更、安全决策时 |
| 失败模式 | `docs/failure-modes.md` | 开始新任务前 |
| ADR 目录 | `docs/decisions/` | 做架构决策时 |
| 迭代文档 | `docs/iterations/` | 查看 Sprint 进度 |
| Spec 模板 | `docs/specs/templates/` | 创建新 Spec 时 |
| SDDD 工作流 | `/sddd-workflow` | 开始实现 Spec 时 |
| 收尾检查 | `/sddd-closeout` | Spec 完成时 |
| 偏差记录 | `/sddd-deviation` | 执行中发现偏差时 |
| 模块检查清单 | `/sddd-module` | 新增模块时 |
| 失败模式检查 | `/sddd-pitfalls` | 开始新任务前 |
| 代码审查 | `/sddd-review` | PR Review 时 |

## 文档维护规范

- 发现本文件与实际代码不一致，请立即更新
- 发现新的失败模式，添加到 `docs/failure-modes.md`
- 做了架构级决策，在 `docs/decisions/` 新增 ADR
