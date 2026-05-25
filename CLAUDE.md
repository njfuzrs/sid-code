# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 0. 核心约束

- **语言要求：所有回复、代码注释、文档均使用中文**
- 每个 task 完成后运行 `make build` 和 `make test`
- **遇到不熟悉的 API、库用法、报错信息时，主动使用联网工具（WebSearch / WebFetch / context7）查询最新文档和解决方案**，不要凭记忆猜测
- **排查复杂 bug 时，主动在关键路径添加详细的调试日志**（console.log / debug 模块），帮助定位问题根因；修复确认后再清理调试日志
- **禁止创建文档**：除非用户明确要求，否则不要创建任何 README、SUMMARY、总结、说明等文档文件。完成任务后简短回复即可，不要写一大堆文档

## 0.1 战略定位（2026-05 起，长期不变）

sid-code **不是**"又一个 Coding CLI"——从 2026-05 起向"对外可交付的研发智能基座"（档位 B）演进，路线按 Sprint S0–S4 / 里程碑 M0–M3 推进（详见 docs/eval/TODO.md）。这是后续全部 task 的根背景。

- **完整战略**：`docs/eval/演进路线/智能研发基座-final.md`（DeepSeek + Claude 对比融合的最终采纳方案）
- **档位选择**：B（对外可交付的研发智能基座）；**不追求** C（跨行业平台，那是 Port/Backstage 赛道，护城河在企业销售关系而非技术）
- **产品范式**：C — 通用 Runtime + Skills（**禁止**做"N 个独立 Agent"或"单体大 Agent"）
- **核心叙事**：**"为 AI 代码兜底"**（Code Review / Security / Governance / Incident），不是"用 AI 加速编程"——前者是新增需求，后者已红海
- **PR-to-Prod 主轴 5 个 Skill**：code-review → ci-self-heal → incident-rca → security-audit → code-governance

### 五层洋葱架构（任何改动前先确认改的是哪一层）

```text
第 5 层 用户触点  CLI / SDK / Daemon / MCP Server / IDE Plugin（五形态共存，同一内核）
第 4 层 Skill 集  变现层：写 Markdown 而非代码；agentskills.io 标准
第 3 层 Context   护城河：代码图谱 / LST / 调用链 / Memory / ADR（必建，无供应商）
第 2 层 工具+集成 商品化：内置工具 + MCP；混合（核心自建 + 长尾用开源）
第 1 层 Runtime   商品化：Agent loop / Permission / Hook；海外 Buy / 国内 Build 双模
```

### 三档可拔插（违反 = 架构走样，08 §1 / final §14）

| 档位 | 模块 | 可拔插程度 |
| --- | --- | --- |
| **A 档** 必须可拔插 | Tool / Skill / LLM Provider / MCP Server / Storage Adapter | L3-L5（接口 + 多实现 + 第三方分发） |
| **B 档** 接口化但单实现 | Plan / Memory / Context / Permission / Hook | L1-L2（接口 + DI；替换需 ADR） |
| **C 档** 不可拔插 | Agent Loop / Eval Runner / 三组不变量（见 §0.2） | 硬编码——这是产品"宪法" |

判断规则：① 是否需要外部生态扩展？是→A；② 是否是产品承诺？是→B 或 C；③ 替换会破坏 eval baseline？是→C。

### sid-code 当前位置（2026-05-25）

| 维度 | 状态 |
| --- | --- |
| **架构骨架** | ✅ 命中范式 C 约 80%——Runtime + Tools + Skill 系统 + MCP 全部就位 |
| **行业稀缺资产** | ⭐⭐⭐⭐⭐ EDD 评测主轴（30 case 含 5 holdout + 5 维 Grader + 7 铁律） |
| **三块短板** | ① Skill 仓库仅含 skill-creator 元 Skill（PR-to-Prod 5 个业务 Skill 待建，最致命）② 入口只能被主动调用（缺事件驱动）③ 缺服务化与多租户 |
| **代码体量** | ~5.2 万行 / 269 TS 文件 / 1137 单测 / Permission 7 模式 / 30 case（含 5 holdout） |

## 0.2 执行入口（唯一）

**`docs/eval/TODO.md`** —— 唯一的 task 清单。任何时候问"现在该做什么"都回到这里。

- 5 阶段：S0 capability 夯实 → S1 M0 P0-tier1（30 条）→ S2 M1 P0-tier2（25 条）→ S3 M2 P1 + code-review Skill → S4 M3 Go/No-Go
- 当前：**Sprint S0 启动中**——补齐 memory/context/router/harness capability 子系统 + 跑五子系统 baseline，全部 ≥ GA (0.70)
- 铁律：上一阶段任一 task 未完成 = 不开下一阶段；30 条 general case 全程守护，任何 src/ 改动后不允许回归

### 三组不变量（语义已统一，08 §1）

旧文档混用过"7 铁律"指代下面任意一组——**以后全文统一**：

| 不变量类型 | 含义 | 违反代价 |
| --- | --- | --- |
| **评测纪律不变量（7 条）** | transcript 必落盘 / holdout 不参与调优 / ADR 必有 rejected alternatives / 每周五跑 eval / 自家 bench 偏向防护 / ... | 销毁证据，无法根因诊断（详见 06 §9.5） |
| **七大输出红线（RL-001~007）** | 不删用户代码 / 不泄露凭证 / 不绕过 Permission / 不无限循环 / 不跨租户泄露 / 不改测试断言 / 不编造问题 | **一票否决**，企业级不可交付（详见 09 G 类） |
| **架构不变量（6 条）** | 5 层架构 / Build-Buy 矩阵 / Skill 不自演化 / 阶段 1 不做在线 RL / Context Engine 必建 / 中文一等公民 | 全部返工（详见 final §4–§7） |

### 三档通过线（08 §9.1）

| 档位 | capability 分数 | 非功能要求 | 毕业条件 |
| --- | --- | --- | --- |
| **baseline** | ≥ 0.50 | 无硬性要求 | — |
| **GA** | ≥ 0.70 | P95 < 60s / 无 crash | 连续 4 周 ≥ GA → `graduated_at: w-NN` |
| **卓越** | ≥ 0.85 | P95 < 30s / recall ≥ 90% | — |

### M3 Go/No-Go 7 个量化条件（08 §9.3，所有 task 隐性服务于这个）

1. Layer 1 红线全 pass
2. Layer 3 能力平均 ≥ 0.60
3. 架构 holdout baseline 偏差 ≤ 0.5
4. ≥ 1 个 Skill 完成完整三轴螺旋（08 §12.2 八步流程）+ SLA 达标
5. **M0–M1 阶段产生 ≥ 3 条底座加固 ADR**（双轮驱动验证：垂直暴露底座问题）
6. P0 每条 case 至少跑过 3 次（3 周 × 1 次/周）
7. code-review Skill baseline ≥ 0.60（单点真信号验证抓手）

## 0.3 改 src/ 前必读（fix_type 审批层级，08 §10）

任何 task 涉及改代码时，按 fix_type 走对应审批层级——**违反 = 直接打回**：

| fix_type | 改的对象 | 审批层级 |
| --- | --- | --- |
| `case_design` | 改 case yaml 的断言/rubric | L1 自动执行（**禁止删 `must_not_include`** 反例字段） |
| `skill_prompt` | 改 SKILL.md Markdown | L1 自动执行 |
| `infra_bug` | 改 evals/ 脚本 | L1 自动执行 |
| `entry_code` | 改 src/cli.ts / src/ui/ 等入口 | L2 展示 diff 后默认批准 |
| `core_code` | 改 src/agent/ / src/tool/ 等内核 | **L3 必须人审 diff** |
| `new_module` | 新增 src/ 子目录或 capability/ 类别 | **L≥3 spec→ADR→骨架PR→单测→eval case 同步就位**（缺一不可） |

补充约束：

- **底座加固 ADR 必须标注"垂直场景需求来源"**（E-01 / E-02 lint）—— 不是"Context Engine 应该支持 LST 解析"，而是"Code Review Skill 处理 1000+ 行 PR 时上下文超限，需要 LST 解析"
- **不要重写**——5.2 万行重写至少 6 个月，得不偿失。沿现有架构加层，不要"内核解耦"

## 0.4 三轴权重迁移（08 §14）

sid-code 用 **SDD + EDD + TDD 三轴螺旋**，权重随阶段迁移：

| 期 | SDD | TDD | EDD |
| --- | --- | --- | --- |
| **内核期**（已完成，2026-05-15 ~ 2026-05-23） | 50% | 30% | 20% |
| **过渡期**（M0–M3，**当前**） | 30% | 30% | 40% |
| **平台期**（M4–M6） | 20% | 30% | 50% |

### 每轴"内化 → 外化"翻转

| 轴 | 内化产物（当前） | 外化形态（目标） |
| --- | --- | --- |
| **SDD** | 内部 Spec + failure-modes.md | 公开 RFC + API Contract + Known Limitations + Changelog |
| **TDD** | 1137 单测 | 单测 + 契约 + 集成 + 混沌 + 性能基准 |
| **EDD** | 30 case + 三层 Grader | 公开 Benchmark + 客户 POC 报告 + Skill 级 SLA |

外化 Checkpoint：M3 首个 Skill RFC 外发 / M6 公开 Benchmark 面板 / M9 Skill Marketplace。

### 单 Skill 三轴螺旋（强制 8 步，08 §12.2）

```text
Step 1  SDD: RFC → SKILL.md → Known Limitations 初稿
Step 2  EDD: 定义 baseline ≥ 10 条 case → 跑分 → 设 SLA 阈值
Step 3  TDD: 写集成 + 契约测试 → CI 绿
Step 4  实现: 写 Skill 代码
Step 5  EDD: 跑 after baseline → 与 before 对比 → 真信号验证
Step 6  SDD: 偏差回写 → 更新 Known Limitations
Step 7  TDD: 补充边界 case + 混沌测试
Step 8  发布: 附带 SLA + baseline 分数 + Known Limitations
循环:    任一 Step 失败 → 退回 Step 1/2/3，**禁止跳过**
```

**铁律**：写 case 必须在写 SKILL.md 之前；P0 case 必须在 P2 case 之前。

## 0.5 评测体系入口（EDD 主轴）

sid-code 从 2026-05-15 起建立评测体系，当前进入 Sprint S0。**改动 src/ 之前先看评测分数走向**。

- **执行 TODO**：`docs/eval/TODO.md`（唯一执行入口，详见 §0.2）
- **战略蓝本**：`docs/eval/演进路线/智能研发基座-final.md`（详见 §0.1）
- **eval 总纲**：`docs/eval/08-研发智能基座-eval总纲.md`（178 约束 → ~169 case 的设计）
- **eval 详细清单**：`docs/eval/09-研发智能基座-eval详细清单.md`（每条 case 的 ID + grader + 前置能力 + 模板）
- **EDD 迭代手册**：`docs/eval/edd-iteration-playbook.md`（5 步：MEASURE → DIAGNOSE → PLAN → FIX → VERIFY）
- **当前阶段状态**：`docs/eval-status.md`（每周五更新）
- **历史档案**：`docs/eval/_archive/07-执行顺序速查.md`（W1–W12 路线图，已封存，不再维护）
- **架构分析**：`docs/eval/10-eval-architecture-analysis.md`（各层分工 + Promptfoo 角色）
- **ADR**：`docs/adr/`（必须有 rejected alternatives）
- **Sprint 报告**：`docs/weekly-eval-report/sprint-SN.md`（旧 week-NN.md 为历史档案）
- **case 仓库**（2026-05-25 实际盘点，与 `docs/eval/TODO.md` 保持一致）：
  - 现有：`evals/p0-core/`（10 条）+ `evals/p1-common/`（9 条）+ `evals/p2-edge/`（6 条）+ `evals/holdout/`（5 条）= 30 条
  - capability：`evals/capability/{plan,memory,context,router,harness}/`（**仅 plan 有 10 条 case + runner**，其余 4 个子系统仅 .gitkeep，待 S0 补齐）
  - S0 起新增（与 p0-core 平级）：`evals/architecture/{redline,form,pluggable,kernel,platform,discipline,context-engine,orchestration,chinese,durable-exec,notification,ux,nonfunctional,outcome,meta,milestone}/` + `evals/holdout/architecture/`

### 跑评测的正确入口（**不要绕道**）

**默认主入口：`evals/eval-runner.ts`**（自研 runner，2026-05-23 起替代 promptfoo 执行/评判层）。
跑分、回归、横向对比都走它：

```bash
# 单 case 调试（推荐用 package.json 脚本别名）
# runner 默认按 ISO 日历周自动写 _runs / _scores，不需要手动传 --week
bun run eval:run --cases case_002 --provider sid-code --model deepseek-v4-pro

# 多 case + 多 provider（claude-code 只认 claude-* 前缀 model）
bun run eval:run --cases case_002,case_005 --provider sid-code,claude-code

# 全量回归（去掉 --cases 即跑全 25 条非 holdout；holdout 单独 --include-holdout）
bun run eval:run --provider sid-code --model deepseek-v4-pro
```

输出位置：

- `evals/_reports/eval-latest.json`（兼容历史 promptfoo-latest.json schema）
- `evals/_runs/<provider>.jsonl`（追加式时序数据）
- `evals/_scores/wNN/case_NNN.yaml`（按周快照）
- 自动刷新 `evals/DASHBOARD.md` + `evals/CASES.md`

### Promptfoo 现状（**已废弃，禁止使用**）

2026-05-23 起评测层切换到自研 `eval-runner.ts`。原 `evals/promptfoo/` 实现已废弃，仅保留 `evals/_legacy/README.md` 作为决策档案（不再保留代码副本，紧急回滚靠 git history）。决策详情见 `docs/eval/10-eval-architecture-analysis.md §3 / §5`。

**禁止行为**（除非用户显式指示）：

- ❌ 跑 `bunx promptfoo eval`（package.json 已无 `eval:horizontal-*` 脚本）
- ❌ 改 `evals/_legacy/` 下任何文件
- ❌ 把 `_reports/promptfoo-*.json` 当作"最新分数"来源（属历史产物；最新分数走 `_reports/eval-latest.json` 或 `_runs/<provider>.jsonl`）

**唯一 wrapper 入口**：`evals/providers/sid-code-live.ts` 和
`evals/providers/claude-code.ts`——eval-runner 直接 spawn（详见
`evals/eval-runner.ts` PROVIDER_REGISTRY）。

> **注意**：sid-code-live wrapper 调用的不是 `src/cli.ts`，而是 `src/entrypoints/bootstrap.ts`（评估模式下无头启动 sid-code 的统一入口）。

### 评测系统核心组件（勿绕道，勿引用旧实现）

| 组件 | 文件 | 说明 |
| --- | --- | --- |
| **主入口** | `evals/eval-runner.ts` (~1050 行) | 自研 runner，CASE_DIRS = p0-core/p1-common/p2-edge |
| **5 维 Grader** | `evals/eval-judge.ts` (~800 行) | anchor_hit(1.5) + rubric_score(4.0) + tool_compliance(1.5) + efficiency(0.3) + cost(0.5) |
| **case 模板** | `evals/_template.yaml` (~110 行) | 8 段：元信息/EDD类型/输入/期望/Rubric/Grader/Baseline/元数据 |
| **类型定义** | `evals/_types.ts` | CaseYaml 单一来源（之前在三处漂移过） |
| **rubric prompt** | `evals/_judge/rubric-template.ts` | 线上 rubric 评分 prompt 模板 |
| **calibration** | `evals/_judge/prompt-v3.md` | κ=0.921，temperature=0，max_tokens=2048 |

**关键设计原则**（写/改 case 时必须遵守）：

1. **null vs 0 严格区分**：null = 数据缺失/judge 不可用（aggregate 跳过），0 = 测了但全错。
2. **echo 排除**：userQuery 中出现的自然语言锚点不计入命中（防复读得分）；代码标识符/路径豁免。
3. **Cost 公式 v5**：`billable = input + output + cache_creation + cache_read × 0.1`，阈值 50k/150k/500k。
4. **--sync 默认 off**：调试单 case 不污染 baseline_scores。

**package.json 脚本**（≈ eval:run 等 8 个有效入口）：

```bash
bun run eval:run              # 主入口 → evals/eval-runner.ts
bun run eval:list             # 列 case → scripts/eval/list-evals.ts
bun run eval:tally            # 统计基线 → scripts/eval/tally-baseline.ts
bun run eval:new-case         # 新建 case → scripts/eval/new-case.ts
bun run eval:bench            # bench 跑分 → scripts/eval/run-bench.ts
bun run eval:bench-report     # bench 报告 → scripts/eval/bench-report.ts
bun run eval:plan-capability  # plan capability → scripts/eval/run-plan-capability.ts
bun run eval:dashboard        # 刷新仪表盘 → scripts/eval/dashboard.ts
```

**Provider 注册**（`eval-runner.ts` PROVIDER_REGISTRY）：

| provider | defaultModel | wrapper |
| --- | --- | --- |
| `sid-code` | `deepseek-v4-pro` | `evals/providers/sid-code-live.ts` |
| `claude-code` | `claude-opus-4-7` | `evals/providers/claude-code.ts` |

⚠️ **重要约束**：claude-code provider 只认 `claude-*` 前缀 model，传其他 model 会直接抛错（不静默 fallback）。

## 0.6 关键反向检验（如果走不下去怎么办）

战略不是只能赢——以下三种情况已有退路（final §5.6 / 08 §11）：

| 如果… | 则… |
| --- | --- |
| 阶段 1（M0–M3）的 5 个 Skill 跑不通 | 退回"高级 Coding CLI + Skill 工厂"，沉没成本仅 case + SKILL.md |
| Anthropic Managed Agents 推中国版 | 转为"Managed Agents 的 Skill 编排层"，EDD + Context 仍无法购买 |
| Cursor / Augment 开源 Context Engine | 直接用，退守"Skill 集 + 评测 + 中文一等公民"差异化 |

**禁止做的事**：

- ❌ 暂停所有场景开发花半年做完美底座（会做出无人使用的玩具）
- ❌ 内核解耦重构（5.2 万行重写至少 6 个月，得不偿失）
- ❌ 跑去和 Anthropic Managed Agents / AWS AgentCore 竞争 Runtime（"水电煤"，应该 Buy）
- ❌ 引入 LangChain / CrewAI 作为编排核心（sid-code Agent Loop + Sub-agent 已是等价物）

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
├── entrypoints/        # 无头入口：bootstrap.ts（评估模式 spawn 入口）+ deferred-prefetch.ts
├── agent/              # 第 1 层 Runtime：子代理（loop.ts / sub-agent.ts / tool.ts / custom.ts）
├── llm/                # 第 1 层 Runtime：Provider 接口 + anthropic/openai/ollama + registry + quota（A 档可拔插）
├── tool/               # 第 2 层 工具：6 个内置工具（read/write/edit/bash/grep/glob）+ registry（A 档）
├── mcp/                # 第 2 层 工具：MCP 协议客户端（transport/client/manager）（A 档）
├── ui/                 # 第 5 层 入口：Ink TUI（App.tsx / VirtualizedList / InputArea / ToolStatus）
│   ├── contexts/       # KeypressContext + ScrollProvider
│   ├── components/     # VirtualizedList / MessageItemRenderer / StreamingMessage / DialogManager / SlicingMaxSizedBox / CodeColorizer
│   ├── stores/         # MessageDataStore
│   └── renderer/       # RenderController + ScreenRenderer + Rasterizer（双缓冲差分输出）
├── config/             # 配置加载 + 规则文件 + 系统提示词构建 + 附件系统
├── context/            # 第 3 层 Context：上下文管理 + 智能截断 + 增量压缩（B 档单实现）
├── checkpoint/         # 文件快照系统（LCS diff + gzip + /undo 回滚）
├── memory/             # 第 3 层 Context：双层记忆系统（全局/项目 + 注入系统提示词）（B 档）
├── plan/               # Plan Mode 状态机（inactive → planning → awaiting_approval；prompt + state）
├── debug/              # 调试日志系统
├── permission/         # 第 1 层 Runtime：6 模式 + 1 unsafe + 规则 + 审计（B 档）
├── hook/               # 第 1 层 Runtime：14 种事件 + command/url + blocking（B 档）
├── session/            # 会话持久化（store.ts）+ 状态管理（state.ts）
├── command/            # 斜杠命令系统 + 自定义命令
├── trace/              # 轨迹采集 + .traj 构建 + 上传（builder/collector/uploader/writer）
├── telemetry/          # 事件总线 + 指标 + 上下文（bus/exporters/metrics/hook-probe）
├── skill/              # 第 4 层 Skills 系统（提示词模板注册为工具）（A 档；builtin 仅含 skill-creator 元 Skill）
└── extension/          # 三层扩展共享基础设施（扫描 + frontmatter + 缓存）
```

模块依赖：`cli` → `app` → `agent` / `llm` / `tool` / `context` / `permission` / `hook` / `session` / `command` / `mcp` / `ui` / `plan` / `trace` / `telemetry` / `debug`

## 4. 编码约定

- TypeScript strict 模式
- 接口驱动设计：Provider, Tool, Checker, Command 均为接口
- 错误处理：`new Error("xxx", { cause: err })` 或直接 throw
- Go → TS 映射：`<-chan` → `AsyncIterable`，`context.Context` → `AbortSignal`，`sync.Mutex` → 不需要
- 测试：`tests/` 目录，`bun:test`
- **禁止做的事**（违反 §0 / §0.3 / §0.6）：
  - ❌ 在 src/ 内核层（agent / tool / llm）做"顺手"改动——必须走 L3 审批
  - ❌ 删 case yaml 的 `must_not_include` 反例字段
  - ❌ 让 Skill 绕过 Permission（OpenClaw 7+ CVE 教训）
  - ❌ 让 Agent 在运行时修改自身 SKILL.md（RL-008 禁止 Skill 自演化）
  - ❌ 单一 LLM Provider 锁定（RL-011 必须 ≥ 3 家）
