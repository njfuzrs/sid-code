# sid-code 评测体系（evals/）

> 本目录是 sid-code 评测主战场。**外部导航**走 CLAUDE.md §0.5（命令、Grader、Provider 注册、关键设计原则）和 `docs/eval/TODO.md`（Sprint S0–S4 执行清单）。
>
> 本文专注 evals/ 内部三件事：**目录导航**、**数据资产分层与生命周期**、**case 写作要点**。

## 当前状态（2026-05-25）

- **case 仓库**：p0-core 10 + p1-common 9 + p2-edge 6 + holdout 5 = **30 条**
- **capability**：仅 `plan/` 有 10 条 yaml + runner；`memory/ context/ router/ harness/` 仅 .gitkeep（待 S0 补齐）
- **runner**：`eval-runner.ts`（自研，~1050 行，2026-05-23 起替代 promptfoo）
- **Judge**：`eval-judge.ts` 5 维 Grader，`_judge/prompt-v3.md` 已校准（κ=0.921）

## 目录组织

```
evals/
├── README.md                  # 本文
├── _template.yaml             # case 模板（cp 后填字段；不要删空字段，置 null/[]）
├── _types.ts                  # CaseYaml 类型定义（单一来源）
├── eval-runner.ts             # 主入口（~1050 行）
├── eval-judge.ts              # 5 维 Grader + aggregate（~800 行）
├── eval-runner.test.ts        # runner 单测
├── eval-judge.test.ts         # judge 单测
├── gen-cases-md.ts            # 自动生成 CASES.md
├── verify-judge-stability.ts  # judge 稳定性自检
├── DASHBOARD.md               # 自动生成（勿手编）
├── CASES.md                   # 自动生成（勿手编）
│
├── p0-core/                   # P0 必过（10 条，target 4.0）
├── p1-common/                 # P1 应过（9 条，target 3.5）
├── p2-edge/                   # P2 加分（6 条，target 3.0）
├── holdout/                   # 5 条永不参与日常调优（默认从 P0/P1/P2 流程跳过）
│
├── capability/                # 子系统能力 eval
│   ├── plan/                  # ✅ 10 条 + scripts/eval/run-plan-capability.ts
│   ├── memory/                # ❌ S0-T03 待建
│   ├── context/               # ❌ S0-T04 待建
│   ├── router/                # ❌ S0-T05 待建
│   └── harness/               # ❌ S0-T06 待建
│
├── _judge/                    # LLM Judge prompt + 校准数据
│   ├── prompt-v0.md ~ v3.md   # prompt 演进史，v3 是当前线上版本
│   ├── rubric-template.ts     # 线上 rubric 评分 prompt 模板
│   ├── calibration-v3/        # κ=0.921 校准数据（gold-cases / 标注 / 报告）
│   ├── kappa-calibration-raw.jsonl
│   ├── kappa-history.md       # κ 历史趋势
│   └── gold-cases/            # 人类标注的 gold standard
│
├── providers/                 # eval-runner 调用的 wrapper（spawn 入口）
│   ├── sid-code-live.ts       # → src/entrypoints/bootstrap.ts
│   └── claude-code.ts         # → claude CLI（只认 claude-* 前缀 model）
│
├── bench-runner/              # 大规模 bench（≠ case eval）
├── scripts/                   # evals 专用脚本
├── inspect/                   # 失败 case 现场快照
│
├── _runs/<provider>.jsonl     # 时序数据（追加式，每次 run 一行）
├── _scores/wNN/case_NNN.yaml  # 周快照（按 ISO 周）
├── _reports/                  # eval-latest.json + 历史报告（部分可清，见下文）
├── raw-outputs/               # transcript（部分调试残留可清）
└── _legacy/                   # 仅 README，promptfoo 决策档案（物理代码已删）
```

> **入口约束**：runner 只扫 `p0-core/ p1-common/ p2-edge/ holdout/` 四个目录。S1 起新增的 `architecture/` 子目录需要扩展 runner 的 `CASE_DIRS`（这是 S1-T01 的范围）。

## 跑评测

详见 `CLAUDE.md §0.5`。常用三条：

```bash
# 单 case 调试（默认 --sync off，不污染 case yaml 的 baseline_scores）
bun run eval:run --cases case_002 --provider sid-code

# 全量回归（25 条非 holdout；--skip-holdout 默认 true）
bun run eval:run --provider sid-code

# 多 provider 横评（不传 --model 时各 provider 用各自的 defaultModel）
bun run eval:run --provider sid-code,claude-code
```

> ⚠️ `claude-code` provider 只认 `claude-*` 前缀 model，传其他会直接抛错（不静默 fallback）。

## 数据资产分层与生命周期

> evals/ 下的"数据"分两类：**测试代码**（永久）和**测试结果**（按价值分层）。
> 不要把 `_runs/` `_reports/` `raw-outputs/` 当成可以"跑完就删"的临时产物——它们是 EDD 闭环的证据链。

### 测试代码（永久保留，等同源代码）

| 资产 | 性质 |
| --- | --- |
| `p0-core/ p1-common/ p2-edge/ holdout/ capability/<sub>/` 的 yaml | 题目 + 判分标准，等同 `tests/*.test.ts` |
| `eval-runner.ts` `eval-judge.ts` `_types.ts` `_template.yaml` | runner + grader + 模板，是评测引擎 |
| `_judge/prompt-v3.md` `_judge/calibration-v3/` `_judge/gold-cases/` | LLM Judge 校准成本极高（κ=0.921 重新校一次要数小时人工标注），删了等于推倒重来 |
| `providers/*.ts` `gen-cases-md.ts` `verify-judge-stability.ts` | wrapper 和工具脚本 |
| `DASHBOARD.md` `CASES.md` | 自动生成但被外部链接引用，不要手删（重跑 runner 会覆盖） |

**这一层任何文件都不能删**。

### 测试结果按"未来用途"分四层

#### ⭐ 第一层 baseline 锚点（必留）

`_scores/wNN/case_NNN.yaml`（最新周）+ `_runs/<provider>.jsonl` 中**全量 25 case 的 run**。

**用途**：S0-S4 全程作为"不回归"对照系。任何 src/ 改动后跑 25 case，对比这一层判断降幅是否 ≤ 0.3（08 §13.4）。

#### ⭐ 第二层 追责证据（归档保留）

`_runs/<provider>.jsonl` 全量历史 + `_scores/wNN/` 历史周快照。

**用途**：M3 Go/No-Go 条件 6 "P0 每条 case 至少跑过 3 次" 的**唯一证据**——直接 grep `_runs/*.jsonl` 统计。删了到 M3 评审时拿不出证据。

#### ⚠️ 第三层 沉没成本（可归档可删）

- `_reports/promptfoo-*.{json,csv}` —— promptfoo 已废弃，git history 留着就够
- `_reports/round1-5.json baseline-w1-raw.json eval-after-fix*.json` —— 早期手动调试
- `_reports/smoke-*-w9/w10.md horizontal-comparison-v1.md` —— 过渡期实验
- 老周快照（被新周覆盖、且对应 provider 已不在主力序列）

**用途**：基本只用于"溯源 EDD 演进史"，对当前 Sprint 的 fix/verify 没用。

#### 🗑️ 第四层 调试残留（可直接删）

- `raw-outputs/_single-T0001.txt`、`raw-outputs/bench-results-178*.jsonl` —— 单 case 调试残留
- `_legacy/` 物理目录（README 留着，但 README 只指 git history，目录本身可空）

**用途**：无。

### 清理 trigger（什么时候动手）

**默认：什么都不删**。原因：所有数据共 ~10M，git 不需要 LFS，删错的成本（重跑 baseline 要 1-2 小时 LLM 调用 + 真金白银 token 钱）远大于留着的成本。

| 时机 | 动作 | 原因 |
| --- | --- | --- |
| **S0 跑完后** | 清第四层 | T01 重新刷出 baseline 后，老调试残留没用了 |
| **S2 末** | 清第三层 | promptfoo 已废弃满 60 天，w12 周快照已被多个新周覆盖 |
| **M3 评审通过后** | 第二层归档到独立分支 `eval-archive` | 主分支只留近 3 个月时序数据，避免 evals/ 越长越大 |
| **任何时候** | ❌ 不要清第一、二层（在 trigger 之外） | 是 baseline + 证据链，删了无法复盘 |

> **关键认知**：测试结果不是"分数上涨就可以扔的副产物"。在 EDD 5 步循环（MEASURE → DIAGNOSE → PLAN → FIX → VERIFY）里，旧分数是 VERIFY 步的对照系。当前进度仅完成 MEASURE 初步基建，FIX → VERIFY 还没走过——历史数据正等着这两步用，不是已经用完。

## case 写作要点

详见 `_template.yaml` 内联注释（~110 行，8 段）。**5 个最容易踩的坑**：

1. ❌ `must_include_any_of` 关键词没 grep 验证 → case_001 教训（写出来发现仓库里根本没这个字符串）
2. ❌ 写 `must_call_tools_in_order`（agent 找替代工具序列就 fail，规则太脆）—— 用 `must_call_tools`（不卡顺序）+ `must_not_call_tools`（反向卡禁区）
3. ❌ 让 LLM 一次性生成 25 条 case（产出同质化，分布失真）
4. ❌ `holdout: true` 的 case 出现在日常 eval 里（runner `--skip-holdout` 默认 true 已防护，但人工手动跑也别绕过）
5. ❌ `expected.reference_answer` 写死唯一答案（多种正确写法都会被判错）—— `reference_answer` 是给 Judge 参考的描述，不是模板比对

**新建 case 流程**：

```bash
cp evals/_template.yaml evals/general/<priority>/case_NNN.yaml   # 手动复制模板命名
# → 编辑 yaml 填字段
bun run eval:list              # 验证识别
bun run eval:run --cases case_NNN --provider sid-code   # 单跑验证
```

## 关键铁律

来自 `docs/eval/_archive/06-风险预案与启动清单.md §9.5`，**违反 = 销毁证据**：

1. **Transcript 必落盘** —— 每次 eval 跑分都要落 `_runs/` + `raw-outputs/`，否则分数变化无法根因诊断
2. **holdout 永不参与日常调优** —— `--skip-holdout` 默认开；只有写 case 时才 `--include-holdout` 抽检
3. **`must_not_include` 反例字段不能删** —— 没有反例 = agent "硬找问题"也能高分（CLAUDE.md §0.3）
4. **每周（每 Sprint 结束）跑 eval + 写 sprint 报告** —— 落到 `docs/weekly-eval-report/sprint-SN.md`
5. **bench 版本化锁定** —— 每个里程碑末 git tag

## 出处索引

| 文件 | 角色 |
| --- | --- |
| `CLAUDE.md §0.5` | 命令、Grader 公式、Provider 注册、4 条关键设计原则 |
| `docs/eval/TODO.md` | Sprint S0–S4 执行清单（任何时候问"现在做什么"回到这里） |
| `docs/eval/08-研发智能基座-eval总纲.md` | 战略 + Go/No-Go 条件 + 三档通过线 |
| `docs/eval/09-研发智能基座-eval详细清单.md` | 178 约束 → ~169 case 的逐条映射 |
| `docs/eval/edd-iteration-playbook.md` | 5 步迭代循环（MEASURE → DIAGNOSE → PLAN → FIX → VERIFY） |
| `_template.yaml` | case 模板（写新 case 必读） |
| `_legacy/README.md` | promptfoo 废弃决策档案（紧急回滚指引） |
