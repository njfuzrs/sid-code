# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 WebSearch / WebFetch / context7 查最新文档，不要凭记忆猜
- **调试日志**：排查复杂 bug 时主动在关键路径加详细日志（console.log / debug 模块）；修复确认后清理
- **禁止创建文档**：除非用户明确要求，不要创建任何 README / SUMMARY / 总结 / 说明等文档文件
- **构建验证**：task 完成后跑 `bun test`（1137 单测）即可；改 src/ 涉及编译产物时才跑 `make build`（编译耗时长，不要每个 task 都跑）

## 0.1 战略定位（2026-05 起，长期不变）

sid-code **不是**"又一个 Coding CLI"——从 2026-05 起向"对外可交付的研发智能基座"（档位 B）演进，路线按 Sprint S0–S4 / 里程碑 M0–M3 推进。这是后续全部 task 的根背景。

- **完整战略**：`docs/eval/演进路线/智能研发基座-final.md`
- **档位选择**：B（对外可交付）；**不追求** C（跨行业平台，那是 Port/Backstage 赛道，护城河在企业销售关系而非技术）
- **产品范式**：C — 通用 Runtime + Skills（**禁止**做"N 个独立 Agent"或"单体大 Agent"）
- **核心叙事**：**"为 AI 代码兜底"**（Code Review / Security / Governance / Incident），不是"用 AI 加速编程"——前者新增需求，后者已红海
- **PR-to-Prod 主轴 5 个 Skill**：code-review → ci-self-heal → incident-rca → security-audit → code-governance
- **技术栈**：TypeScript + Bun + Ink；核心架构 Agentic While-Loop（用户输入 → LLM 流式响应 → stop_reason=tool_use 时执行工具并继续循环，end_turn 时结束）

### 五层洋葱架构（任何改动前先确认改的是哪一层）

```text
第 5 层 用户触点  CLI / SDK / Daemon / MCP Server / IDE Plugin（五形态共存，同一内核）
第 4 层 Skill 集  变现层：写 Markdown 而非代码；agentskills.io 标准
第 3 层 Context   护城河：代码图谱 / LST / 调用链 / Memory / ADR（必建，无供应商）
第 2 层 工具+集成 商品化：内置工具 + MCP；混合（核心自建 + 长尾用开源）
第 1 层 Runtime   商品化：Agent loop / Permission / Hook；海外 Buy / 国内 Build 双模
```

### 三档可拔插（违反 = 架构走样）

| 档位 | 模块 | 可拔插程度 |
| --- | --- | --- |
| **A 档** 必须可拔插 | Tool / Skill / LLM Provider / MCP Server / Storage Adapter | L3-L5（接口 + 多实现 + 第三方分发） |
| **B 档** 接口化但单实现 | Plan / Memory / Context / Permission / Hook | L1-L2（接口 + DI；替换需 ADR） |
| **C 档** 不可拔插 | Agent Loop / Eval Runner / 三组不变量 | 硬编码——产品"宪法" |

判断规则：① 需要外部生态扩展？→ A；② 是产品承诺？→ B 或 C；③ 替换会破坏 eval baseline？→ C。

### sid-code 当前位置（2026-05-25）

| 维度 | 状态 |
| --- | --- |
| **架构骨架** | ✅ 命中范式 C 约 80%——Runtime + Tools + Skill 系统 + MCP 全部就位 |
| **行业稀缺资产** | ⭐⭐⭐⭐⭐ EDD 评测主轴（30 case 含 5 holdout + 5 维 Grader + 三组不变量） |
| **三块短板** | ① Skill 仓库仅含 skill-creator 元 Skill（PR-to-Prod 5 个业务 Skill 待建，最致命）② 入口只能被主动调用（缺事件驱动）③ 缺服务化与多租户 |
| **代码体量** | ~5.2 万行 / 269 TS 文件 / 1137 单测 / Permission 7 种 PermissionMode（default / acceptEdits / dontAsk / plan / always-allow / deny-write / dangerously-skip-permissions） / LLM Provider 3 家（Anthropic / OpenAI / Ollama） |

## 0.2 执行入口（唯一）

**`docs/eval/TODO.md`** —— 唯一的 task 清单。任何时候问"现在该做什么"都回到这里。

- 5 阶段：S0 capability 夯实 → S1 M0 P0-tier1 → S2 M1 P0-tier2 → S3 M2 P1 + code-review Skill → S4 M3 Go/No-Go
- 当前：**Sprint S0 启动中**——补齐 memory/context/router/harness capability 子系统 + 跑五子系统 baseline，全部 ≥ GA（锚点 3.5 / 归一化 0.70）
- 铁律：上一阶段任一 task 未完成 = 不开下一阶段；30 条 general case 全程守护，任何 src/ 改动后不允许回归

### 三组不变量（语义统一，08 §1）

| 不变量类型 | 含义 | 违反代价 |
| --- | --- | --- |
| **评测纪律不变量（7 条）** | transcript 必落盘 / holdout 不参与调优 / ADR 必有 rejected alternatives / 每 Sprint 末跑 eval / 自家 bench 偏向防护 / ... | 销毁证据，无法根因诊断（06 §9.5） |
| **七大输出红线（RL-001~007）** | 不删用户代码 / 不泄露凭证 / 不绕过 Permission / 不无限循环 / 不跨租户泄露 / 不改测试断言 / 不编造问题 | **一票否决**，企业级不可交付（09 G 类） |
| **架构不变量（6 条）** | 5 层架构 / Build-Buy 矩阵 / Skill 不自演化 / 阶段 1 不做在线 RL / Context Engine 必建 / 中文一等公民 | 全部返工（final §4–§7） |

### 三档通过线（0-5 锚点分制；归一化 = 锚点/5）

| 档位 | 锚点 / 归一化 | 非功能要求 | 毕业条件 |
| --- | --- | --- | --- |
| **baseline** | ≥ 2.5 / 0.50 | 无硬性要求 | — |
| **GA** | ≥ 3.5 / 0.70 | P95 < 60s / 无 crash | 连续 4 Sprint ≥ GA → `graduated_at` |
| **卓越** | ≥ 4.25 / 0.85 | P95 < 30s / recall ≥ 90% | — |

### M3 Go/No-Go 7 个量化条件（08 §9.3，所有 task 隐性服务于这个）

1. Layer 1 红线全 pass
2. Layer 3 能力平均 ≥ 0.60（归一化）
3. 架构 holdout baseline 偏差 ≤ 0.5
4. ≥ 1 个 Skill 完成完整三轴螺旋（08 §12.2 八步流程）+ SLA 达标
5. **M0–M1 阶段产生 ≥ 3 条底座加固 ADR**（双轮驱动验证：垂直暴露底座问题）
6. P0 每条 case 至少跑过 3 次（3 Sprint × 1 次/Sprint）
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
- **src 子目录归属（哪个目录对应五层洋葱哪一层）**：Agent 用 `ls src/` 自查；五层归属规则见 §0.1 + `docs/eval/演进路线/智能研发基座-final.md §4`，**不在 CLAUDE.md 维护静态目录树**（避免与代码漂移）

## 0.3.1 Grader 冻结期约束（2026-05-26 起，到 S1 解冻）

> 触发原因：12 个月 11 次 grader 改动（cost v1→v6、权重反复调）证明"在错的架构里做局部补丁"是病根。
> 完整诊断：`docs/eval/investigations/eval-rubric-industry-survey.md`。
> 与 §0.3 fix_type 审批层级**同级**——以下任一改动**直接打回**，不走任何审批流程：

- `evals/eval-judge.ts` 的 `DEFAULT_WEIGHTS`（anchor / rubric / tool / negative_anchor / efficiency / cost 权重）
- `evals/eval-judge.ts` 的 `gradeCost` / `gradeEfficiency` / `gradeAnchorHit` / `gradeRubric` / `gradeToolCompliance` 阈值常量与公式
- `evals/eval-judge.ts` 的 `aggregate` 加权逻辑（含 weight=0 / score=null 跳过判定）

**不限范围（冻结期内仍可正常动）**：

- `evals/capability/<sub>/` 独立 runner（plan/memory/context/router/harness 不走 5 维 grader）
- case yaml 内容（must_include / must_not_include / max_steps / baseline_scores）
- 新增 case
- 修 wrapper bug（不影响 grader 语义）

**解冻条件**：S1 引入第一条红线 case 或架构 case 时——按 task-specific scorer 架构整体升级（`docs/eval/investigations/eval-rubric-industry-survey.md §3.2 / §6.3 T-10`），并 bump `GRADER_VERSION`（如 `5d-v2` → `5d-v3` 或 `task-specific-v1`）。**不允许**单独再调 5 维权重或阈值。

**违反代价**：当前 sprint baseline 失效（`evals/_runs/*.jsonl` + `_scores/wNN/` 的数据视为不可信），sprint 报告作废，必须重跑全量。已 sync 到 case yaml 的 baseline_scores 须按 `_formula_version` 字段回滚。

## 0.4 评测体系入口（EDD 主轴）

sid-code 从 2026-05-15 起建立评测体系，当前进入 Sprint S0。**改动 src/ 之前先看评测分数走向**。

> **完整评测系统文档**：`evals/README.md`（目录约定 / 命令 / 数据资产分层与生命周期 / case 写作要点 / 关键铁律）。CLAUDE.md 只保留 4 条设计原则 + 入口指针，避免与 README 漂移。

### 核心入口指针

| 信息 | 文件 |
| --- | --- |
| Sprint 执行清单 | `docs/eval/TODO.md` |
| 战略蓝本 | `docs/eval/演进路线/智能研发基座-final.md` |
| eval 总纲（178 约束 → ~169 case） | `docs/eval/08-研发智能基座-eval总纲.md` |
| eval 详细清单（逐条 case 映射） | `docs/eval/09-研发智能基座-eval详细清单.md` |
| EDD 5 步迭代手册 | `docs/eval/edd-iteration-playbook.md` |
| 当前阶段状态（每 Sprint 末更新） | `docs/eval-status.md` |
| 评测架构分析（promptfoo 决策） | `docs/eval/10-eval-architecture-analysis.md` |
| 三轴螺旋 8 步 / 三轴权重迁移 | `docs/eval/08-研发智能基座-eval总纲.md §12.2 / §14`（S3 写 Skill 时再读，S0/S1/S2 不用） |
| ADR | `docs/adr/`（必须有 rejected alternatives；当前 9 条） |
| Sprint 报告 | `docs/weekly-eval-report/sprint-SN.md`（S0 起；旧 week-00..11.md 为历史档案） |

### 当前 case 仓库（2026-05-25 实际盘点）

- 现有：`evals/p0-core/`（10）+ `evals/p1-common/`（9）+ `evals/p2-edge/`（6）+ `evals/holdout/`（5）= 30 条
- capability：`evals/capability/{plan,memory,context,router,harness}/`（**5 子系统全部就位**：plan 10 + memory 10 + context 10 + router 8 + harness 10 = 48 条 case；S0-T11 N=3 中位数 baseline 已落盘，27 graduated + 21 known_limitation）
- S0 起新增（与 p0-core 平级）：`evals/architecture/{redline,form,pluggable,kernel,platform,discipline,context-engine,orchestration,chinese,durable-exec,notification,ux,nonfunctional,outcome,meta,milestone}/` + `evals/holdout/architecture/`

### 跑评测（细节见 evals/README.md）

```bash
# 单 case 调试（默认 --sync off，不污染 baseline_scores）
bun run eval:run --cases case_002 --provider sid-code

# 全量回归（25 条非 holdout；--skip-holdout 默认 true）
bun run eval:run --provider sid-code

# 横评（不传 --model，各 provider 用各自 defaultModel）
bun run eval:run --provider sid-code,claude-code
```

⚠️ `claude-code` provider 只认 `claude-*` 前缀 model，传其他直接抛错（不静默 fallback）。

> sid-code-live wrapper 调用的不是 `src/cli.ts`，而是 `src/entrypoints/bootstrap.ts`（评估模式无头启动入口）。

### 4 条关键设计原则（写/改 case 必须遵守）

1. **null vs 0 严格区分**：null = 数据缺失/judge 不可用（aggregate 跳过），0 = 测了但全错
2. **echo 排除**：userQuery 中出现的自然语言锚点不计入命中（防复读得分）；代码标识符/路径豁免
3. **Cost 维度降权为诊断**（2026-05-26 起）：不进总分（DEFAULT_WEIGHTS.cost = 0），仅 reason / meta 落 jsonl 供事后分析。理由：绝对阈值让 case 难度直接决定 cost 分（case_001 类锚点查询谁都满分 / case_028 类重构谁都低分），cost 跨 case 均值是"复杂度反指标"而非"agent 节俭度"。公式 v6（billable = input + output + cache_creation + cache_read × 0.1，阈值 30k/80k/200k）保留——若后续做 provider 横评，按此公式排名打分另写脚本
4. **--sync 默认 off**：调试单 case 不污染 baseline_scores

### 评测数据保留

`_runs/` `_scores/` `_reports/` 是 EDD 闭环的证据链与 baseline 锚点，不是跑完即弃的临时产物。**默认什么都不删**，详见 `evals/README.md` "数据资产分层与生命周期" 节。

### Promptfoo 已废弃（2026-05-23 起）

- ❌ 跑 `bunx promptfoo eval`
- ❌ 改 `evals/_legacy/` 下任何文件
- ❌ 把 `_reports/promptfoo-*.json` 当作"最新分数"来源（最新分数走 `_reports/eval-latest.json` 或 `_runs/<provider>.jsonl`）

## 0.5 禁止做的事（合并集）

### 战略禁区

- ❌ 暂停所有场景开发花半年做完美底座（会做出无人使用的玩具）
- ❌ 内核解耦重构（5.2 万行重写至少 6 个月，得不偿失）
- ❌ 跑去和 Anthropic Managed Agents / AWS AgentCore 竞争 Runtime（"水电煤"，应该 Buy）
- ❌ 引入 LangChain / CrewAI 作为编排核心（sid-code Agent Loop + Sub-agent 已是等价物）

### 内核禁区

- ❌ 在 src/ 内核层（agent / tool / llm）做"顺手"改动——必须走 §0.3 L3 审批
- ❌ 删 case yaml 的 `must_not_include` 反例字段
- ❌ 让 Skill 绕过 Permission（OpenClaw 7+ CVE 教训）
- ❌ 让 Agent 在运行时修改自身 SKILL.md（RL-008 禁止 Skill 自演化）
- ❌ 单一 LLM Provider 锁定（RL-011 必须 ≥ 3 家；当前已有 Anthropic/OpenAI/Ollama）

## 0.6 反向检验（如果走不下去怎么办）

战略不是只能赢——以下三种情况已有退路（final §5.6 / 08 §11）：

| 如果… | 则… |
| --- | --- |
| 阶段 1（M0–M3）的 5 个 Skill 跑不通 | 退回"高级 Coding CLI + Skill 工厂"，沉没成本仅 case + SKILL.md |
| Anthropic Managed Agents 推中国版 | 转为"Managed Agents 的 Skill 编排层"，EDD + Context 仍无法购买 |
| Cursor / Augment 开源 Context Engine | 直接用，退守"Skill 集 + 评测 + 中文一等公民"差异化 |

## 0.7 工程约定（短）

- TypeScript strict 模式 / 接口驱动（Provider / Tool / Checker / Command 均为接口）
- 错误处理：`new Error("xxx", { cause: err })` 或直接 throw
- 测试：1137 单测分布在 `tests/` 和模块内同位 `.test.ts`；`bun test` 跑全量
- 目录结构：用 `ls src/` 自查；不在 CLAUDE.md 维护静态目录树（与代码易漂移）
