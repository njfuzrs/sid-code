# sid-code — AI 编程 CLI 工具

## 0. 核心约束

- **语言要求：所有回复、代码注释、文档均使用中文**
- 每个 task 完成后运行 `make build` 和 `make test`
- **遇到不熟悉的 API、库用法、报错信息时，主动使用联网工具（WebSearch / WebFetch / context7）查询最新文档和解决方案**，不要凭记忆猜测
- **排查复杂 bug 时，主动在关键路径添加详细的调试日志**（console.log / debug 模块），帮助定位问题根因；修复确认后再清理调试日志

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
