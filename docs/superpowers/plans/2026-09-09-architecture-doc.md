# sid-code 架构导览文档实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一份面向新开发者和核心开发者的 `docs/architecture.md`，说明 sid-code 的功能边界、分层结构、请求链路、核心源码入口、扩展方式和本地验证路径。

**Architecture:** 文档采用“先建立全局认识，再进入源码入口”的两层结构。第一层用包级架构图、请求生命周期和能力地图帮助新人定位；第二层按核心子系统说明职责、关键接口和推荐阅读文件。内容只基于当前源码和已有项目文档，不复制 README 的完整安装说明，也不重复 `CLAUDE.md` 的贡献流程。

**Tech Stack:** Markdown、TypeScript、Bun workspace、Ink/React TUI、Zod、内置测试与项目现有 lint/format 工具。

## Global Constraints

- 所有回复、代码注释和文档均使用中文。
- 只新增 `docs/architecture.md` 和必要的 `docs/superpowers/plans/` 计划文件，不修改无关文件。
- 关键源码入口必须使用当前存在的路径，并在写入前以源码核对；不能把推测写成已实现能力。
- 文档定位为架构导览，不替代 `README.zh-CN.md`、`CONTRIBUTING.md`、`CLAUDE.md` 和官网文档。
- 文档不引入新的架构方案，不把分析文档写成未来功能规划。
- 完成后执行 `bun run affected-tests:run` 和 `make build`；文档改动不应新增运行时代码测试。
- Markdown 不纳入 oxfmt 自动格式化范围，需手工保持标题层级、代码块和链接格式正确。

---

### Task 1: 建立文档骨架与项目定位

**Files:**
- Create: `docs/architecture.md`
- Reference: `README.zh-CN.md`
- Reference: `package.json`
- Reference: `packages/cli/src/entrypoints/bootstrap.ts`

**Interfaces:**
- Produces: 文档标题、定位说明、阅读对象、与现有文档的边界，以及项目整体能力概览。

- [ ] **Step 1: 写入标题和文档定位**

在 `docs/architecture.md` 开头写明这是一份 sid-code 的开发者架构导览，并区分两类读者：刚接触项目的开发者，以及准备参与核心开发的开发者。明确它解释当前实现，不承担安装指南、贡献流程或产品宣传职责。

- [ ] **Step 2: 写入项目能力概览**

根据 `README.zh-CN.md` 和源码中已核对的能力，介绍终端交互、Agent Loop、工具调用、权限门控、Hook、Skill、MCP、子代理、LSP、会话和轨迹观测。使用“能力 + 一句话作用”的表格，避免只罗列目录名。

- [ ] **Step 3: 写入文档边界和导航**

增加一个简短的“如何使用本文档”段落，指向 README 的安装使用、CONTRIBUTING 的协作门禁、CLAUDE.md 的项目原则和官网参考页。不要复制这些文件的全文内容。

- [ ] **Step 4: 检查骨架可读性**

确认文档已有清晰的一级标题和后续章节占位结构，但不保留 `TODO`、`TBD` 或空章节。

---

### Task 2: 说明 workspace 分层和包职责

**Files:**
- Modify: `docs/architecture.md`
- Reference: `packages/shared/`
- Reference: `packages/tui-renderer/`
- Reference: `packages/core/`
- Reference: `packages/cli/`
- Reference: `packages/eval-framework/`
- Reference: `package.json`

**Interfaces:**
- Consumes: Task 1 的项目定位和能力概览。
- Produces: 包职责表、依赖方向、分层约束和源码定位方式。

- [ ] **Step 1: 写入包职责表**

覆盖以下 workspace 包：

```text
shared          基础类型、版本和通用工具
 tui-renderer   TUI 渲染相关的共享实现和 vendor 源码入口
core            Agent 内核、模型接入、工具、上下文、权限、扩展、会话和观测
cli             启动入口、命令系统和 Ink/React 终端界面
eval-framework  评测运行框架
```

`shared`、`tui-renderer` 的表述必须保持在源码能证明的范围内，不能把 vendor 目录描述成独立的业务层。

- [ ] **Step 2: 说明依赖方向**

用 ASCII 图或 Mermaid 之外的普通代码块表达主要依赖方向，避免引入官网渲染依赖：

```text
shared
  ↑
tui-renderer     core
       ↑          ↑
           cli
```

说明 `core` 不应依赖具体 TUI 组件，CLI 通过接口、事件和回调接入内核；`eval-framework` 复用仓内能力执行评测，但不进入普通交互请求的主路径。

- [ ] **Step 3: 增加包内阅读入口**

为每个包列出 1 至 3 个当前存在的目录入口，重点说明应该先看目录职责，再进入具体实现。不要把整个目录树复制进文档。

- [ ] **Step 4: 检查包名和路径**

核对文档中的每个包路径和包名均存在，删除无法从当前仓库确认的模块描述。

---

### Task 3: 描述一次用户请求的端到端链路

**Files:**
- Modify: `docs/architecture.md`
- Reference: `packages/cli/src/entrypoints/bootstrap.ts`
- Reference: `packages/cli/src/cli.ts`
- Reference: `packages/cli/src/ui/App.tsx`
- Reference: `packages/core/src/query/engine.ts`
- Reference: `packages/core/src/query/loop.ts`
- Reference: `packages/core/src/agent/agentic-loop.ts`
- Reference: `packages/core/src/llm/provider.ts`
- Reference: `packages/core/src/tool/registry.ts`

**Interfaces:**
- Consumes: Task 2 的分层模型。
- Produces: 从进程启动到 TUI 展示和轨迹写入的请求生命周期说明。

- [ ] **Step 1: 写入启动阶段**

说明 `bootstrap.ts` 的两阶段启动设计：`--version`、`--help`、`update`、`mcp`、`auth`、`review` 等快速路径使用动态 import，普通交互才加载完整 CLI；指出这样做的直接目的在于减少轻量命令的启动成本和副作用。

- [ ] **Step 2: 写入交互入口和会话层**

说明 CLI/TUI 接收用户输入后交给 QueryEngine，`QueryEngine.submitMessage()` 以异步事件流桥接会话状态、流式文本、思考输出、工具结果和错误状态。引用 `packages/core/src/query/engine.ts` 作为会话层入口。

- [ ] **Step 3: 写入模型与流处理阶段**

说明 Query Loop 组装上下文和工具定义，通过统一 `Provider` 接口发起流式模型请求，再由 stream processor 将模型事件转换为文本、thinking、tool call 和完成事件。区分 Provider 抽象与具体协议实现。

- [ ] **Step 4: 写入工具执行和循环推进**

说明模型产生工具调用后经过工具注册表解析、权限检查、PreToolUse/PostToolUse Hook 和实际执行，结果回到上下文，Agent Loop 决定继续请求还是结束。强调主代理和子代理共享 `agentic-loop.ts` 的循环核心。

- [ ] **Step 5: 写入收尾阶段**

说明每轮会更新会话持久化、token/cost 统计、轨迹和 UI 状态；用户可通过中断信号停止当前请求。不要承诺源码没有保证的实时顺序或持久化细节。

- [ ] **Step 6: 写入链路图并做顺序校验**

使用代码块绘制以下事实链路，并让正文与图顺序一致：

```text
用户输入
  -> CLI/TUI
  -> QueryEngine
  -> query loop / AgenticLoop
  -> ContextManager + ToolRegistry
  -> Provider 流式请求
  -> stream processor
  -> 工具执行与权限/Hook
  -> 工具结果回上下文
  -> 继续循环或结束
  -> TUI 展示、Session/Trace 写入
```

---

### Task 4: 编写核心子系统导览

**Files:**
- Modify: `docs/architecture.md`
- Reference: `packages/core/src/agent/`
- Reference: `packages/core/src/query/`
- Reference: `packages/core/src/llm/`
- Reference: `packages/core/src/context/`
- Reference: `packages/core/src/tool/`
- Reference: `packages/core/src/permission/`
- Reference: `packages/core/src/hook/`
- Reference: `packages/core/src/extension/`
- Reference: `packages/core/src/skill/`
- Reference: `packages/core/src/mcp/`
- Reference: `packages/core/src/session/`
- Reference: `packages/core/src/trace/`
- Reference: `packages/core/src/telemetry/`

**Interfaces:**
- Consumes: Task 3 的请求生命周期。
- Produces: 按职责组织的核心模块表和源码阅读入口。

- [ ] **Step 1: 描述 Agent Loop 与 Query Loop**

说明 QueryEngine 负责会话编排，Query Loop 负责单轮推进，AgenticLoop 提供主代理和子代理共享的循环实现。指出循环检测、重试、上下文压缩和中断是循环周边的控制能力。

- [ ] **Step 2: 描述 LLM Provider 和韧性机制**

以 `packages/core/src/llm/provider.ts` 的 `Provider` 接口为事实依据，说明流式发送、能力声明和可选非流式降级；再简述 Anthropic/OpenAI/Ollama 协议适配、fallback、retry、quota、cache 和 usage 统计。

- [ ] **Step 3: 描述上下文管理**

说明 ContextManager 维护发送给模型的上下文，工具结果存储/掩码控制上下文体积，自动压缩和 reactive compact 应对窗口压力。只描述已有模块，不设计新的压缩策略。

- [ ] **Step 4: 描述工具注册和工具执行**

说明 Registry 负责工具登记、动态裁剪、MCP 工具合并、schema 转换和按需激活；执行层负责输入校验、权限检查、Hook 和结果回传。说明工具 schema 优先从 Zod 生成，避免运行时校验器与模型描述漂移。

- [ ] **Step 5: 描述权限、Hook 和扩展系统**

分别说明 permission 的命令/路径分类、规则匹配、模式策略、sandbox 和审计；Hook 的事件注册、运行和企业策略；extension/skill/mcp 的加载与运行时接入。避免把 Skill、Extension 和 MCP 混写成同一种插件机制。

- [ ] **Step 6: 描述会话、记忆、任务和工作区能力**

说明 session 负责会话状态和持久化，memory/session-memory 用于记忆提取与召回，task/todo 用于任务状态，worktree 提供隔离工作区操作。重点写它们在请求链路中的接入点。

- [ ] **Step 7: 描述轨迹、Telemetry 和评测**

说明 trace 记录流阶段、延迟、成本、缓存和工具事件；telemetry/analytics 负责指标与事件；eval-framework 和 `evals/` 用于回归验证。明确轨迹是本地可观测数据来源，评测是发布前验证手段，两者职责不同。

- [ ] **Step 8: 汇总核心模块表**

为每个子系统给出“职责 / 主要入口 / 修改时先读什么”三列，确保新人能从文档跳到源码。

---

### Task 5: 说明扩展方式与源码阅读路线

**Files:**
- Modify: `docs/architecture.md`
- Reference: `packages/core/src/tool/`
- Reference: `packages/core/src/hook/`
- Reference: `packages/core/src/skill/`
- Reference: `packages/core/src/mcp/`
- Reference: `packages/core/src/agent/sub-agent.ts`
- Reference: `packages/core/src/permission/`
- Reference: `packages/cli/src/command/`

**Interfaces:**
- Consumes: Task 4 的模块职责和入口。
- Produces: 按开发任务查找代码的指南，以及扩展边界说明。

- [ ] **Step 1: 写入按任务查找入口表**

至少覆盖以下问题：

```text
修改启动/命令行为       packages/cli/src/entrypoints/ 与 packages/cli/src/command/
修改会话循环             packages/core/src/query/ 与 packages/core/src/agent/
接入模型                 packages/core/src/llm/
新增或修改工具           packages/core/src/tool/
修改安全策略             packages/core/src/permission/
增加 Hook                packages/core/src/hook/
增加 Skill/子代理/MCP    packages/core/src/skill/、agent/、mcp/
修改可观测性             packages/core/src/trace/、telemetry/、analytics/
```

- [ ] **Step 2: 写入扩展路径**

分别给出新增内置工具、Provider、Hook、Skill、子代理和 MCP 的最短阅读路径。每条路径包含“先读接口/注册点，再读执行点，最后读对应测试”的顺序。

- [ ] **Step 3: 写入关键不变量**

记录以下源码阅读时必须保留的边界：权限检查不能因子代理路径缺省而绕过；主代理和子代理不要各维护一套循环或压缩逻辑；工具定义和输入校验尽量保持同源；模型、路由和延迟指标不能随意跨语义聚合。

- [ ] **Step 4: 写入新人推荐阅读顺序**

推荐顺序为：README 中文入口 → bootstrap → CLI/App → QueryEngine → query loop/AgenticLoop → Provider → Tool Registry/permission → Context → hook/skill/mcp → trace/eval。每一步说明读者要回答的问题，而不是只列文件。

---

### Task 6: 写入本地验证和维护说明

**Files:**
- Modify: `docs/architecture.md`
- Reference: `README.zh-CN.md`
- Reference: `CONTRIBUTING.md`
- Reference: `CLAUDE.md`
- Reference: `package.json`

**Interfaces:**
- Consumes: Task 5 的源码阅读路线。
- Produces: 可执行的开发验证清单和文档维护边界。

- [ ] **Step 1: 写入最小本地启动流程**

记录新克隆后的最小命令序列：`bun install`、`bun run vendor:fetch`、`make build`、`sc-dev`。说明 `sc` 是线上构建，不能用来验证本地修改。

- [ ] **Step 2: 写入按改动范围选测流程**

记录 `bun run affected-tests` 先查看判定、`bun run affected-tests:run` 执行选测；提 PR 前按项目要求执行完整门禁。不要把文档写成建议跳过全量验证。

- [ ] **Step 3: 写入构建和质量检查入口**

列出 `make build`、`bun run lint`、`bun run format:check`、`bun run lint:boundary` 及文档生成检查的适用场景。贡献流程细节只链接 `CONTRIBUTING.md`，不在此重复完整规则。

- [ ] **Step 4: 写入维护规则**

说明当包名、核心入口、请求链路、能力数量或验证命令发生变化时，应同步更新本架构文档，并以源码和项目门禁为准。

---

### Task 7: 完成文档自检与项目验证

**Files:**
- Modify: `docs/architecture.md`（仅在检查发现问题时）
- Test: 文档链接、路径和格式检查

**Interfaces:**
- Consumes: Tasks 1-6 的完整文档。
- Produces: 无占位符、路径可定位、结构一致并通过项目要求的文档。

- [ ] **Step 1: 做事实和路径检查**

逐项检查文档中出现的源码路径、目录名、接口名和命令。对每个核心入口至少用 `Read` 或目录列表核对一次；删除无法确认的精确数字和行为承诺。

- [ ] **Step 2: 做内容边界检查**

确认文档没有复制 README 的完整安装段落，没有重复 CLAUDE.md/CONTRIBUTING.md 的全部流程，也没有加入当前尚未实现的未来设计。确保每一节都增加新的架构信息。

- [ ] **Step 3: 做 Markdown 结构检查**

检查标题层级、代码围栏、表格列数、相对链接和中文标点。全文搜索并清除 `TODO`、`TBD`、空列表和“稍后补充”等占位内容。

- [ ] **Step 4: 执行受影响测试**

运行：

```bash
bun run affected-tests:run
```

预期：命令成功完成；若脚本判定为文档不影响测试，记录其实际输出，不人为扩大测试范围。

- [ ] **Step 5: 执行构建验证**

运行：

```bash
make build
```

预期：构建和产物自检成功。文档本身不应改变编译结果。

- [ ] **Step 6: 检查最终 diff**

运行：

```bash
git diff --check -- docs/architecture.md
git status --short
```

预期：无空白错误；工作区只包含本任务创建或修改的文档文件，不处理其他在途改动。

- [ ] **Step 7: 仅在用户明确要求时提交**

如果用户要求提交，使用符合仓库约定的 Conventional Commit，例如：

```bash
git add docs/architecture.md
git commit -m "docs: 新增项目架构导览"
```

未明确要求提交时，不创建 commit。
