# sid-code — AI 编程 CLI 工具

## 0. 核心约束

- **语言要求：所有回复、代码注释、文档均使用中文**
- 每个 task 完成后运行 `make build` 和 `make test`
- **遇到不熟悉的 API、库用法、报错信息时，主动使用联网工具（WebSearch / WebFetch / context7）查询最新文档和解决方案**，不要凭记忆猜测
- **排查复杂 bug 时，主动在关键路径添加详细的调试日志**（console.log / debug 模块），帮助定位问题根因；修复确认后再清理调试日志
- **禁止创建文档**：除非用户明确要求，否则不要创建任何 README、SUMMARY、总结、说明等文档文件。完成任务后简短回复即可，不要写一大堆文档

## 0.5. 评测体系入口（EDD 主轴）

sid-code 从 2026-05-15 起建立 9 周 5 阶段评测体系。**改动 src/ 之前先看评测分数走向**。

- 总入口：`docs/eval/07-执行顺序速查.md`（导航 + 进度表）
- 架构分析：`docs/eval/10-eval-architecture-analysis.md`（各层分工 + Promptfoo 角色）
- 当前阶段状态：`docs/eval-status.md`（5 段框架，每周五更新）
- ADR 决策记录：`docs/adr/`（必须有 rejected alternatives）
- 周报：`docs/weekly-eval-report/week-NN.md`
- case 仓库：`evals/p0-core/` `evals/p1-common/` `evals/p2-edge/` `evals/holdout/`

7 条铁律不变量（违反 = 销毁证据）见 `docs/eval/06-风险预案与启动清单.md §9.5`。

### 跑评测的正确入口（**不要绕道**）

**默认主入口：`evals/eval-runner.ts`**（自研 runner，2026-05-23 起替代 promptfoo 执行/评判层）。
跑分、回归、横向对比都走它：

```bash
# 单 case 调试
bun run evals/eval-runner.ts --cases case_002 --provider sid-code --model claude-opus-4-7 --week N

# 多 case + 多 provider
bun run evals/eval-runner.ts --cases case_002,case_005 --provider sid-code,claude-code --model claude-opus-4-7 --week N

# 全量回归（去掉 --cases 即跑全 25 个非 holdout）
bun run evals/eval-runner.ts --provider sid-code --model claude-opus-4-7 --week N
```

输出位置：
- `evals/_reports/eval-latest.json`（兼容历史 promptfoo-latest.json schema）
- `evals/_runs/<provider>.jsonl`（追加式时序数据）
- `evals/_scores/wNN/case_NNN.yaml`（按周快照）
- 自动刷新 `evals/DASHBOARD.md` + `evals/CASES.md`

### Promptfoo 现状（**保留备用，默认不用**）

`evals/promptfoo/` 是 2026-05-21 引入的旧执行/评判层，已被 `eval-runner.ts` 替代（详见
`docs/eval/10-eval-architecture-analysis.md §5.4`）。**保留目的仅为可追溯历史数据 +
紧急回滚**，不要主动调用，原因：
1. 黑盒并发/重试不可控，遇 LLM 中转商 429 会跑空 5h+
2. 评分公式重复维护（同一公式分布在 `yaml-to-tests.ts` 字符串 + `eval-judge.ts`）
3. 用户已多次明确指示用自研 runner

**禁止行为**（除非用户显式指示）：
- ❌ 跑 `bunx promptfoo eval` / `bun run eval:horizontal-run`
- ❌ 改 `evals/promptfoo/promptfooconfig.yaml`、`evals/promptfoo/lib/yaml-to-tests.ts`
- ❌ 把 `_reports/promptfoo-latest.json` 当作"最新分数"来源（应该用 `_reports/eval-latest.json` 或 `_runs/<provider>.jsonl`）

**唯一允许复用**：`evals/promptfoo/providers/sid-code-live.ts` 和 `claude-code.ts`——eval-runner
直接 spawn 这两个 wrapper（详见 `evals/eval-runner.ts:77 PROVIDER_REGISTRY`）。


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
