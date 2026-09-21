# sid-code 评测体系（evals/）

> 🔴 **先读下面的「当前状态」** —— 本目录的四组旧题集**已全部删除**，新题集在 `agent-traj-bench`（两个 URL 见状态块）。
>
> **外部导航**走仓库根 `CLAUDE.md §0.5`（命令、Grader、Provider 注册、关键设计原则）。
> ⚠️ `docs/eval/TODO.md`（Sprint S0–S4 清单）**不在本仓**，且其 S0 从未执行 —— 详见文末「出处索引」。
>
> 本文专注 evals/ 内部三件事：**目录导航**、**数据资产分层与生命周期**、**case 写作要点**。

## 当前状态（2026-09-18）

> 🔴 **本目录的旧题集四组已全部删除。** `real-tasks/` 58 文件已于本次删除（27 yaml + 31 setup 脚本）。
> `capability/` 已于 PR3c 删除；`architecture/` 已于 PR3b 删除；`general/` 与 holdout 题面 yaml 已于 PR3a 删除。
> 新题集在 `agent-traj-bench`（两个 URL 见下方）。
> ⚠️ 下表每一格都能一行命令复算，⛔ 不要照抄它当事实，**自己跑一遍**。
>
> 入库数 **197 → 139**（−58：27 yaml + 31 setup 脚本）。
> ⚠️ 差值账按 `git ls-files evals | wc -l`，与 case 口径不是一回事。

| 组 | 入库 case（`*.yaml`） | 状态 |
| --- | --- | --- |
| ~~`general/`~~ | **0** | 已删（28 条 yaml；题面见 `~/Backups/sid-code-evals-legacy/`）|
| ~~`architecture/`~~ | **0** | 已删（113 yaml + 18 README；题面见 bundle）|
| ~~`capability/`~~ | **0** | 已删（54 yaml + 10 目录文件 + 2 grader + 4 报告；判据词汇表在 `agent-traj-bench` 的 `docs/eval-criteria/`）|
| ~~`real-tasks/`~~ | **0** | 已删（27 yaml + 31 setup 脚本；**从未可跑** —— 31/31 的 `REPO_URL` 是假值：30 条 TODO 占位 + 1 条 example.com）|
| `holdout/` | **0** yaml | 13 条 yaml 已删；留下 2 个 README（切分方法论）+ `holdout-sids.txt`（⛔ 一字节不许动）|

```bash
# 逐格复算（期望与上表逐一相等）
for d in architecture capability real-tasks holdout; do
  printf "%-14s %s\n" "$d" "$(git ls-files "evals/$d" | grep -c '\.yaml$')"
done                                              # → 0 / 0 / 0 / 0
git ls-files evals/general | wc -l                # → 0
git ls-files evals | wc -l                        # → 139
grep -rl "lifecycle:" evals/ --include="*.yaml" | wc -l   # → 0
```

> **口径**：上表是 **case 口径**（一条 case = 一个 yaml），⛔ 与"文件口径"不是一回事 ——
> 已删的 `capability/` 是 54 个 yaml / **64 个目录文件**（多出 5 README + 5 .gitkeep），
> 再加 `evals/` 内 2 个 grader + 4 份报告才到差值账的 **70**。
> 引用这些数字时**必须连口径一起引**，否则两处求和永远对不上。

### 四组为什么冻结（⛔ 不是"断言腐烂"这一条理由通吃）

| 组 | 死因 |
| --- | --- |
| ~~`general/`~~ ~~`architecture/`~~ ~~`real-tasks/`~~ | **环境不可重建** —— case 里的 `repo_commit` 指向已不可达的提交。三组已删。`real-tasks/` 另有 31/31 setup 脚本的 `REPO_URL` 是假值 |
| ~~`capability/`~~ | 🔴 **已删。死于实现，不死于不可重建** —— `seed` / `setup` / `fixture` / `env` / `repo_commit` 实测**全为 0**；54 条里只有 **7 条**断言真腐烂、**2 条**是故意虚构路径（测 agent 自纠）、**45 条**技术上仍可跑。停掉它是**方向裁决**（不再用"过程合规"这条论证线），⛔ 别写成技术判决。判据词汇表在 `agent-traj-bench` 的 `docs/eval-criteria/`；题面见 bundle |

⚠️ 跑分也早就冻了：`capability/` 最后一次 `tested_at` 是 **2026-05-27**，而当时 54 条里有 **49 条**
仍带着 `baseline_scores` ⇒ **"有分数"会让读者以为它活着**。本题组已删，那份分数不再出现在磁盘上。

🔴 **`_scores/`（228 份周快照）与 `_runs/`（4 个 jsonl）已于 2026-09-18 删除。**
它们的 `tested_at` 上界是 **2026-06-01**，对应 commit 在**删除之前就已不可达**
⇒ ⛔ 别把这次删除读成"丢了跨版本对照能力"：那个能力随 commit 不可达一起消失，
删掉的只是**看起来还能对照**的错觉。🟢 数据本身在 git 里：`git log -- evals/_scores`。
⚠️ 两者都是**运行时会重建的目录**（`packages/eval-framework/core/runner.ts:810`/`:899`
各有一次 `mkdirSync(..., {recursive:true})`）⇒ 重新跑评测会重新长出来，删的是过期数据不是写入链。

### 新题集在哪（🔴 两个 URL 都要拿，⛔ 不是二选一）

| 端 | 地址 | 里面是什么 |
| --- | --- | --- |
| GitHub | <https://github.com/njfuzrs/agent-traj-bench> | 题集本体：`tasks/` 39 个题目录 + `scripts/`（判分）+ `reports/` |
| HF dataset | <https://huggingface.co/datasets/njfuzrs/agent-traj-bench> | 快照仓：`tasks.jsonl` / `snapshots.jsonl`（**不入 git，只在 HF**）|

⚠️ **只拿一个拿不到另一半**：只有 GitHub 拿不到快照，只有 HF 拿不到题目定义与判分脚本。

🔴 **本目录题集与新集判据不兼容，分数不互比。** 两者不是同一件事的新旧两版：

| | 本目录（四组 yaml 已全部删除） | `agent-traj-bench` |
| --- | --- | --- |
| 判什么 | **过程**（"过程病态吗"）+ 5 维 rubric 打分 | **结果**（"改对了吗"）|
| 判分形态 | LLM Judge + `must_include_any_of` / `must_call_tools` 等机械断言 | `tests/{f2p,p2p}.json` + `score.py` → `reward.json` |
| 报告口径 | 0–5 分制 + `baseline_scores` 对照 | `pass@1` |

⇒ ⛔ **不许说「新集已经覆盖了这些评测能力」**，也 ⛔ **不许把两边的分数放进同一张表**。

## 目录组织

> ⚠️ 下面这张树是 **2026-09-21 PR-B/C 之后**的入库快照（`git ls-files evals`）。
> ⛔ 别照抄它当事实 —— 改动前先跑 `git ls-files evals | awk -F/ '{print $2}' | sort | uniq -c` 对账。
> 13 号收尾是 **139** @ `007bd481`；#58 加 3 个文件到 **142**；证据层清单再加到开工当日 **147**；
> 本 PR 搬走 `prompt-v2.md` / `calibration-set/types.ts` / `calibrate-pairwise.test.ts`（−3），
> 新增 `_judge/README.md` + `_archive/README.md`（+2）→ **146**。

```
evals/                            # 入库 146 个文件（⚠️ 运行产物被 .gitignore 挡掉，不在此列）
├── README.md                     # 本文
├── CLAUDE.md                     # 面向 agent 的规则（每条带 file:line 出处，有门禁校验）
│
├── holdout/             3  # 2 README（切分方法论，退役说明）+ holdout-sids.txt
│                          #   ⛔ holdout-sids.txt 一字节不许动：sha256 永封，pre-push.sh 会拒绝 push
│
├── _judge/             18  # ✅ 在用：prompt-v3 + calibration-v3（κ=0.921）+ gold-cases 10 + README
│                          #   prompt-v2 / types / pairwise 测试已迁 packages/eval-framework/judge/
├── _archive/            3  # 退役但要留：judge-prompts/（prompt-v0 / v1）+ README
├── _diagnoses/         12  # ✅ 在用：5 个 fix_type 归因轴的唯一实例化记录 + SCHEMA.md + runs/
├── _reports/           24  # external/（含 evidence 清单）+ .gitkeep
├── bench-runner/        8  # 大规模 bench：runner + 3 grader + 4 adapter（capability-{grader,shared} 已删）
├── providers/           4  # sid-code 特定的在线 wrapper（⛔ 不是 eval-framework/providers/）
├── scripts/             4  # archive-evidence / distill-skill-rules / run-external-baseline / self-vs-external-report
├── cross-provider/      2  # 横评报告 + 活测试
├── inspect/             6  # ⚠️ 外部引用 0，但刻意保留（路径 A 否决实证）
├── external-benchmarks/ 59 # ✅ 在用（入库脚本/子集/报告；⛔ 0 份答案）
└── raw-outputs/         1  # 只剩 .gitkeep
```

> **runner 入口约束**：`packages/eval-framework/core/runner.ts` 的默认扫描面已空
> （四组题集全部删除，`discover*` 对缺失目录返回 `[]`）。`--cases-dir` 仍可扫任意目录。
> ⚠️ **入口还在、题没了** —— 跑出来是空集，不是静默换分母。

## 三层 provider 边界（⛔ 是三层不是两层）

> 这条规则以前只活在 `packages/eval-framework/core/runner.ts:167-172` 的注释里。
> 注释拦不住另一个文件 —— 「顺手统一 providers/」会破坏包可分发性（`bun run lint:boundary` 会拦），
> 也会把「重跑」和「复算历史轨迹」合成同一个入口。CLAUDE.md 已写死「**重跑 ≠ 同一份轨迹**」。

判据是两问都要：① 在代码路径上 ② 是否 agent-agnostic。

| 层 | 目录 | 职责 | 判据 |
| --- | --- | --- | --- |
| agent-agnostic **在线** | `packages/eval-framework/providers/` | 实时调 agent，任何人可用（`_template.ts` / `aider.ts` / `mock-echo.ts`） | 在代码路径上 ∧ 零仓库依赖 |
| sid-code 特定 **在线** | `evals/providers/` | 实时调，但引仓内脚本（`sid-code-live.ts` 引 `scripts/eval/raw-jsonl-to-trace.ts`） | 在代码路径上 ∧ 依赖本仓 |
| 🔴 **离线**轨迹解析 | `evals/bench-runner/adapters/` | 从**已落盘 trajectory** 反解 agent output | **根本不调 agent** |

🔴 **`claude-code.ts` / `sid-code-live.ts` 跨层重名是刻意的，⛔ 不许合并。**
在线层 spawn 真 agent；离线层读历史轨迹。合并 ⇒「重跑」与「复算」变成同一个入口。

源码原话（`packages/eval-framework/core/runner.ts:167-172`）：

> `evals/providers/` 共性是**依赖仓库自身**…搬进包等于让包反向依赖仓库源码、
> 破坏包边界（`bun run lint:boundary` 会拦），所以它们**刻意**留在仓库侧。
> 这不是过渡态，是稳定的职责切分 —— 别为了「统一目录」把后两个搬进包。

⇒ ⛔ **不许说 `providers/` 分裂是 bug**。它的问题曾经是规则没写在 README 里，不是实现错了。

`evals/bench-runner/adapters/codex.ts` 是**预留对照位，当前无调用方**。
⛔ 不许因此删它 —— 零引用 ≠ 零价值，它是「对照 agent 可插拔」的唯一实证（同 `inspect/`）。

## 跑评测

> 🔴 **四组题集已全部删除 ⇒ 下面这些命令的默认扫描面是空集**（见顶部状态块）。
> 留着命令是为了 `--cases-dir` 仍能扫任意目录、以及从 git 取回历史现场，
> ⛔ 不是为了继续跑本目录的死题。⛔ 别拿空跑的分数做回归对照，
> 也 ⛔ 别拿它和 `agent-traj-bench` 的 `pass@1` 比。

详见 `CLAUDE.md §0.5`。常用三条：

```bash
# 单 case 调试（默认 --sync off；仓内 yaml 已删，需 --cases-dir 指向外部题）
bun run eval:run --cases-dir <dir> --cases case_002 --provider sid-code

# "全量"回归（--skip-holdout 默认 true）
# ⚠️ PR3d 起默认扫描面为空；general / architecture / capability / real-tasks 已删
bun run eval:run --provider sid-code

# 多 provider 横评（不传 --model 时各 provider 用各自的 defaultModel）
bun run eval:run --provider sid-code,claude-code
```

> ⚠️ `claude-code` provider 只认 `claude-*` 前缀 model，传其他会直接抛错（不静默 fallback）。

## 数据资产分层与生命周期

> evals/ 下的"数据"分两类：**测试代码**（永久）和**测试结果**（按价值分层）。
> 不要把 `_runs/` `_reports/` `raw-outputs/` 当成可以"跑完就删"的临时产物——它们是 EDD 闭环的证据链。

### 测试代码（永久保留，等同源代码）

> 🔴 **这一节的"永久保留"只对下表后三行成立。** 四组题集已全部删除（见顶部状态块），
> 「case yaml 等同 `tests/*.test.ts`」这条前提对 222 条死题**不再成立** ——
> 一个跑不起来的 case 不是测试，是误导。

| 资产 | 性质 |
| --- | --- |
| ~~`general/` yaml~~ | 已删（2026-09-18）|
| ~~`architecture/` yaml~~ | 已删（2026-09-18 PR3b）|
| ~~`capability/` yaml~~ | 已删（2026-09-18 PR3c）|
| ~~`real-tasks/` 的 yaml~~ | 已删（2026-09-18 PR3d；27 yaml + 31 setup 脚本）|
| ~~holdout 题面 yaml~~ | 已删；留下 README + `holdout-sids.txt` |
| ~~`eval-runner.ts` `eval-judge.ts` `_types.ts`~~ | 🔴 **已不在本目录** —— runner 与 judge 迁到 `packages/eval-framework/core/{runner,judge}.ts`，类型定义迁到同目录 `types.ts` |
| `_judge/prompt-v3.md` `_judge/calibration-v3/` `_judge/gold-cases/` | ✅ **在用**：v3 含 sid-code 硬编码 few-shot，**留本目录**（见 `_judge/README.md`）。κ=0.921 重新校一次要数小时人工标注。agent-agnostic 的 `prompt-v2.md` 已迁 `packages/eval-framework/judge/` |
| `providers/*.ts` | ✅ 在用：sid-code 特定在线 wrapper（见上方「三层 provider 边界」） |
| `_diagnoses/` | ✅ 在用：5 个 `fix_type` 归因轴的唯一实例化记录 |

⚠️ 曾在这一层、**2026-09-18 已删**的一对：`gen-cases-md.ts` → `CASES.md`
（CASES.md 头部自陈"自动生成，请勿手动编辑"，而其数据源 `_reports/promptfoo-latest.json`
**早已不存在** ⇒ 它既不能重新生成、也不该手改 ⇒ 生成器与产物同批下线）。
`verify-judge-stability.ts` 已于 2026-09-18 随 `general/` 下线（它硬依赖 p0-core / p1-common / p2-edge / holdout）。
⚠️ 同日 PR3c 又下线一批：5 个 `scripts/eval/run-*-capability.ts`、
`bench-runner/capability-{grader,shared}.ts` 与它们的 2 个单测 ——
**它们的输入（54 条 case yaml）在同一个 PR 里删掉了**，留着就是「入口还在、题没了」。

### 测试结果按"未来用途"分四层

> 🔴 **前两层的对象已于 2026-09-18 删除**（`_scores/` 228 + `_runs/` 4）。
> 下面两小节保留的是**分层方法论**，⛔ 不再是"这里有这些资产"的现状描述 ——
> 新题集要立同类证据链时，判据仍然照这个分。

#### ~~⭐ 第一层 baseline 锚点（必留）~~ → **对象已删**

原文：`_scores/wNN/case_NNN.yaml`（最新周）+ `_runs/<provider>.jsonl` 中全量 25 case 的 run。

🔴 **"必留"这条判断的前提是"对照系仍然可用"，而该前提在删除之前就已不成立**：
这批快照的 `tested_at` 上界 2026-06-01，对应 commit 已不可达 ⇒ 拿它做"不回归"对照，
比较的是两个不同代码基线 —— 那不是对照，是错数。⛔ 别把删除读成"丢了对照能力"。

#### ~~⭐ 第二层 追责证据（归档保留）~~ → **对象已删**

原文用途：M3 Go/No-Go 条件 6「P0 每条 case 至少跑过 3 次」的唯一证据。
🟢 **证据本身在 git 里**：`git log -- evals/_runs` / `git show <commit>:evals/_runs/<provider>.jsonl`。
⚠️ 而该 Go/No-Go 评审针对的是**已冻结的旧题集** ⇒ 它不会再发生。

#### ⚠️ 第三层 沉没成本（**2026-08-12 已清理**，见下方"清理记录"）

以下均已 `git rm` 且工作区一并删除（git history 留着就够，溯源走 `git log -- <path>`）：

- `_reports/promptfoo-*.{json,csv}` —— promptfoo 已废弃
- `_reports/round1-5.json baseline-w1(-raw).md/json eval-after-fix*.json` —— 早期手动调试
- `_reports/smoke-*-w9/w10.md horizontal-comparison-v1.md` —— 过渡期实验
- `_reports/M5-gate-review-result-2026-05-31.md agent-eval-first-report-2026-05-31.md known-limitation-roster-2026-05-31.txt sprint-S5-eval-report.md` —— Sprint/Gate 阶段性评审记录，无代码/文档引用
- 老周快照（被新周覆盖、且对应 provider 已不在主力序列）——本次未发现符合此项的文件，暂无操作

**用途**：基本只用于"溯源 EDD 演进史"，对当前 Sprint 的 fix/verify 没用。

#### 🗑️ 第四层 调试残留（**2026-08-12 已清理**）

以下均已从磁盘删除（未追踪文件，无需 `git rm`）：

- `raw-outputs/` 下 76 个带毫秒时间戳的单次运行 jsonl/txt（`_single-T0001.txt`、`bench-results-*.jsonl`、`capability-*-<ts>.jsonl`、`skill-*-<ts>.jsonl` 等）
- `_reports/promptfoo-*.{json,csv}` 磁盘残留（当时已不被 git 追踪，只是本机文件仍在）
- `_legacy/` 当时未清（仍只有一个 README）。**2026-08-12 P2-4 已处理**：README 内容并入本文
  「历史：promptfoo 时期的实现」一节，目录删除 —— 一个只含 README 的目录不该占顶层位置。

**用途**：无。

### 清理记录（2026-08-12）

对应方案是「仓库文件入库与目录规范」P0-2（维护者私有文档库，不在本仓），
以及本文档上方两层的分层政策。执行细节：

- **P0-2（63 个时间戳转储）**：`git rm --cached` → 改为直接 `git rm`（工作区文件本次判断为可删，非"只出库"）
- **第三层沉没成本（7 个 + 4 个 Sprint 评审记录，共 11 个已追踪文件）**：同样 `git rm`
- **第四层调试残留（`raw-outputs/` 76 个 + `_reports/` 下 11 个未追踪 `promptfoo-*` 磁盘文件）**：直接 `rm`（本就不在 git 索引里）
- **保留**（`_reports/` 当时 5 个 + `.gitkeep`）：~~`eval-latest.json`（`gen-cases-md.ts:20` 仍读取）~~
  —— ⚠️ **2026-09-18 已删**：它的唯一读者 `gen-cases-md.ts` 同批下线，理由随之失效；
  ~~`capability-plan-w11.md` / `-after.json` / `-baseline.json`~~（原留存理由是
  `capability/plan/README.md:64` 那套持续追踪机制）、~~`capability-plan-w12-d3-preview.md`~~
  —— ⚠️ **2026-09-18 PR3c 已删**：该 README 与 plan capability 题组同批下线，
  「持续追踪」这个理由随追踪对象一起消失
- **~~`raw-outputs/` 保留 17 个~~**：原是 `CASES.md` 引用的 12 个 `case_00N_<ts>.jsonl` transcript
  + `capability-plan-w11/w12` 系列 5 个（由 `_reports/capability-plan-w11.md`、
  `capability-plan-w12-d3-preview.md` 正文引用）。⚠️ **两个引用方分别随 PR3a / PR3c 删除** ⇒
  该目录现在入库只剩 `.gitkeep`（`git ls-files evals/raw-outputs` 复算），
  磁盘上的转储本就被 `.gitignore` 挡在索引外
- **文档同步**：`evals/inspect/README.md:121` 对 `horizontal-comparison-v1.md` 的引用已改为指向 git 历史，不再假装文件还在磁盘上

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

> 🔴 **⛔ 不要在本目录写新 case。** 四组已全部删除（见顶部状态块）—— 在这里加第 223 条，
> 就是往一个不再跑的题集里投入工时。新题目去 `agent-traj-bench`，
> 它的 case 形态是 `tasks/<id>/` + `tests/{f2p,p2p}.json` + `score.py`，
> 与下面这套 yaml + rubric **零交集**。
>
> 🔴 **`_template.yaml` 已于 2026-09-18 删除**，理由是它**不是通用 case schema，而是旧四组的模板**：
> `:3` 的用法示例指向 `p0-core/`，`:18` `eval_type` / `:21` `holdout` / `:29` `repo_commit`
> 全是旧四组的字段体系 ⇒ 题集删完后留着它，就是邀请别人照它写第 223 条。
> 🟢 要看原文：`git show HEAD~1:evals/_template.yaml`（~110 行，8 段内联注释）。
>
> 🟢 **这一节留着的理由是"判据怎么定"这件事仍然有用** —— 下面 5 条坑是踩出来的，
> 写新集的判分脚本时同样适用。⛔ 但别照着它的命令建 case。

**5 个最容易踩的坑**：

1. ❌ `must_include_any_of` 关键词没 grep 验证 → case_001 教训（写出来发现仓库里根本没这个字符串）
2. ❌ 写 `must_call_tools_in_order`（agent 找替代工具序列就 fail，规则太脆）—— 用 `must_call_tools`（不卡顺序）+ `must_not_call_tools`（反向卡禁区）
3. ❌ 让 LLM 一次性生成 25 条 case（产出同质化，分布失真）
4. ❌ `holdout: true` 的 case 出现在日常 eval 里（runner `--skip-holdout` 默认 true 已防护，但人工手动跑也别绕过）
5. ❌ `expected.reference_answer` 写死唯一答案（多种正确写法都会被判错）—— `reference_answer` 是给 Judge 参考的描述，不是模板比对

**~~新建 case 流程~~**（⛔ **已停用** —— 题集冻结，这套流程只作历史记录）：

```bash
# ⛔ 不要跑这一段。留在这里是为了说明"当年 case 是怎么建的"，不是为了照着建第 223 条。
# ⚠️ 第一行已跑不通：_template.yaml 于 2026-09-18 删除（见上方说明）。
cp evals/_template.yaml evals/general/<priority>/case_NNN.yaml   # 手动复制模板命名
# → 编辑 yaml 填字段
bun run eval:list              # 验证识别
bun run eval:run --cases case_NNN --provider sid-code   # 单跑验证
```

## 目录边界：`evals/` 与 `scripts/eval/` 的分工

这一节是 P2-4（2026-08-12）立的，治的是一个反复被问的问题：**为什么 `evals/` 里有代码？**

先说结论：**`evals/` 是「评测这件事」的整体归属地，它可以有代码，这不是历史欠债。**
实测本目录有 **22 个 `.ts`**（`bench-runner/` 8、`external-benchmarks/` 5、`scripts/` 4、
`providers/` 4、`cross-provider/` 1；`_judge/` 的 2 个 `.ts` 已迁 `packages/eval-framework/judge/`，
根下与 `_meta/` 的 `.ts` 已随 PR3a 下线，`bench-runner/capability-{grader,shared}.ts` 随 PR3c 下线）。
`scripts/eval/` 文件数以 `git ls-files scripts/eval | wc -l` 为准。

```bash
git ls-files evals | grep -c '\.ts$'                                    # → 22
git ls-files evals | grep '\.ts$' | awk -F/ 'NF==2{print "根下"} NF>2{print $2}' | sort | uniq -c
git ls-files scripts/eval | wc -l
```

| 目录 | 放什么 | 判据 |
| --- | --- | --- |
| **`evals/`** | 评测**体系本身**：四组 case yaml 已全部删除；`holdout/` 只剩 README + 永封 sids、judge 与诊断资产（`_judge/` `_diagnoses/`）、报告（`_reports/`），以及**与 case 数据强耦合的执行代码**（`bench-runner/` `providers/` `scripts/`） | **改一个 case 就要跟着改的代码，放这里** |
| **`scripts/eval/`** | 评测的**工具与门禁**：跑批入口、聚合、门禁脚本 | **与具体 case 无关、对整个评测集通用的，放这里** |

根下 `.ts` 已清零（`verify-judge-stability.ts` 随 general 下线；`gen-cases-md.ts` 随 CASES.md 下线）。
`_meta/` 四个文件全删 ⇒ 该目录消失。

> ⚠️ **不要"顺手"把 `evals/` 下的代码迁去 `scripts/eval/`。**
> 曾有一版方案提议只迁根下那 2 个文件、理由是「`evals/` 应该只放数据」。
> 那条原则与现状冲突：迁完之后这里仍有 **22** 个代码文件，但**看起来像已经治理过了** ——
> 把不一致从「明显」变成「隐蔽」，下一个人更难发现这里其实没有统一规则。
> 而且 `tests/eval/` 有 **9 个测试文件**直接 `import ../../evals/...`（共 **10** 条 import 路径：
> `bench-runner/` 的 runner / trajectory-grader / 2 个 adapter，
> `external-benchmarks/swe-bench/` 的 grade / mini-adapt / preflight / runner，
> `providers/sid-code-live`，`scripts/distill-skill-rules`），迁移要连带改它们。
>
> ```bash
> # 复算（⚠️ 更早一版写「6 处」；PR3c 删掉 2 个 capability 单测后是 9 个文件 / 10 条路径）
> grep -rlE 'from "(\.\./)+evals/' --include='*.ts' tests/ packages/ | wc -l   # → 9
> grep -rhoE 'from "(\.\./)+evals/[^"]*"' tests/eval/*.ts | sort -u            # → 10 行
> ```
>
> 有先例：gemini-cli 的 `evals/` 里同样是 `.eval.ts` 代码 + helper，不是纯数据目录。
>
> 若哪天真要统一，那是一次**独立改造**，不要塞进"入库与位置清理"这类任务里。

## 历史：promptfoo 时期的实现（原 `_legacy/README.md`）

**所有 promptfoo 相关代码已于 2026-05-24 删除。** 这一节保留回查线索 ——
物理文件删了，但「怎么找回旧实现」这件事本身有价值，所以留档。
（原先它是 `evals/_legacy/README.md`，一个只含 README 的目录不该占顶层位置，
P2-4 把内容并到这里、目录删掉。）

看旧的 promptfoo 实现（配置 / wrapper / yaml-to-tests 转换脚本 / promptfoo-sync）：

```bash
# 看最后一次完整状态（在删除 _legacy 物理文件之前）
git log --oneline --all -- 'evals/promptfoo/**' 'evals/_legacy/promptfoo/**' | head

# 恢复某个文件查看
git show <commit>:evals/promptfoo/promptfooconfig.yaml
git show <commit>:evals/promptfoo/lib/yaml-to-tests.ts
git show <commit>:evals/promptfoo/providers/sid-code-live.ts
git show <commit>:scripts/eval/promptfoo-sync.ts
```

关键 commit 参考：`43bd3d6 fix: 彻底清除promtfoo引用` —— 删除前最后一次完整快照；
更早的 commit 在 master 历史里完整保留。

**为什么不留着物理文件**：2026-05-24 明确指示删除 —— 保留只会让新人 grep
`promptfoo` 撞到死代码、造成误导。git history 已经是足够的"博物馆"。

**紧急回滚**（`runner` 完全不可用、必须临时回到 promptfoo 的极端情况）：
按上面的 `git checkout <commit> -- evals/promptfoo/` 取回整个目录 + `promptfoo-sync.ts`
+ `package.json` 的 `eval:horizontal-*` 脚本。但更推荐直接修
`packages/eval-framework/core/runner.ts` —— promptfoo 时代的双套 wrapper /
黑盒并发 / 评分公式重复等问题不值得重启。

## 关键铁律

来自 `docs/eval/_archive/06-风险预案与启动清单.md §9.5`，**违反 = 销毁证据**：

1. **Transcript 必落盘** —— 每次 eval 跑分都要落 `_runs/` + `raw-outputs/`，否则分数变化无法根因诊断
2. **holdout 永不参与日常调优** —— `--skip-holdout` 默认开；只有写 case 时才 `--include-holdout` 抽检
3. **`must_not_include` 反例字段不能删** —— 没有反例 = agent "硬找问题"也能高分（CLAUDE.md §0.3）
4. **每周（每 Sprint 结束）跑 eval + 写 sprint 报告** —— 落到 `docs/weekly-eval-report/sprint-SN.md`
5. **bench 版本化锁定** —— 每个里程碑末 git tag

## 出处索引

> ⚠️ **`docs/eval/` 不在本仓** —— 它是维护者的私有文档库，不开源（见 `CONTRIBUTING.md`
> 「注释里的 `docs/xxx.md` 路径指向仓外」）。下表保留这些路径是因为它们标明结论**出自哪次论证**，
> ⛔ 别当断链去修、也别批量删。**读不到路径不影响读本文** —— 结论本身已写在正文里。

| 文件 | 在本仓？ | 角色 |
| --- | --- | --- |
| `evals/CLAUDE.md` | ✅ | 面向 agent 的规则，每条带 `file:line` 出处（有门禁 `tests/eval/evals-claude-md-citations.test.ts` 校验行号漂移）|
| `CLAUDE.md §0.5`（仓库根）| ✅ | 命令、Grader 公式、Provider 注册、关键设计原则 |
| ~~`_template.yaml`~~ | ❌ **已删** | ⚠️ 旧四组的 case 模板（**不是**通用 schema）—— 2026-09-18 随题集冻结一起下线，原文见 `git show HEAD~1:evals/_template.yaml`（见「case 写作要点」）|
| 本文「历史：promptfoo 时期的实现」 | ✅ | promptfoo 废弃决策档案 + 紧急回滚指引（原 `_legacy/README.md`，2026-08-12 并入）|
| `docs/eval/TODO.md` | ❌ 仓外 | Sprint S0–S4 执行清单。⚠️ **S0 的机械标记直到 2026-09-18 才落地**（`lifecycle: frozen` 曾标 168 条，四组现已全部删除）⇒ ⛔ 别把它当"当前在做什么"的事实源 |
| `docs/eval/08-研发智能基座-eval总纲.md` | ❌ 仓外 | 战略 + Go/No-Go 条件 + 三档通过线 |
| `docs/eval/09-研发智能基座-eval详细清单.md` | ❌ 仓外 | 178 约束 → ~169 case 的逐条映射（⚠️ 那批 case 即本次冻结的四组）|
| `docs/eval/edd-iteration-playbook.md` | ❌ 仓外 | 5 步迭代循环（MEASURE → DIAGNOSE → PLAN → FIX → VERIFY）|
| `X2-Evaluation/10-历史评测集清理方案.md` | ❌ 仓外 | 本次冻结与后续删除的裁决依据（判"删什么、为什么"）|
