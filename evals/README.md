# sid-code 评测体系（evals/）

> 🔴 **先读下面的「当前状态」** —— 本目录的题集**已全部冻结**，新题集在 `agent-traj-bench`（两个 URL 见状态块）。
>
> **外部导航**走仓库根 `CLAUDE.md §0.5`（命令、Grader、Provider 注册、关键设计原则）。
> ⚠️ `docs/eval/TODO.md`（Sprint S0–S4 清单）**不在本仓**，且其 S0 从未执行 —— 详见文末「出处索引」。
>
> 本文专注 evals/ 内部三件事：**目录导航**、**数据资产分层与生命周期**、**case 写作要点**。

## 当前状态（2026-09-17）

> 🔴 **本目录的四组题集已全部冻结，⛔ 不要拿它们跑回归、也不要在这里加第 223 条。**
> 上一版状态块写的是 2026-05-25 的 **30 条**（`p0-core 10 + p1-common 9 + p2-edge 6 + holdout 5`），
> 那个数字从写下之后再没更新过。⚠️ **同口径比要连 holdout 一起算**：旧值 30 是**含** holdout 的，
> 所以对得上的是磁盘上的 **235**（四组 222 + holdout 13）⇒ **差 205 条**。
> ⛔ 别用「222 − 30 = 192」—— 那是拿"不含 holdout"减"含 holdout"，两边口径不同。
> ⚠️ 下表每一格都能一行命令复算（命令附在表后），⛔ 不要照抄它当事实，**自己跑一遍**。

| 组 | 入库 case（`*.yaml`） | 状态 |
| --- | --- | --- |
| `general/` | 28 | `frozen` |
| `architecture/` | 113 | `frozen` |
| `capability/` | 54 | `frozen` → **待删除**（已裁决停止该评测线，判据词汇表另行保全；出处见维护者私有文档库 `X2-Evaluation/10-历史评测集清理方案.md` §2.2）|
| `real-tasks/` | 27 | `frozen`，且**从未可跑**：rubric **27/27** 是 TODO 占位；setup 脚本 **31/31 的 `REPO_URL` 是假值**（30 条 TODO 占位 + 1 条 `https://github.com/example/repo.git`）|
| **四组小计** | **222** | ⚠️ 这个 222 **不含 holdout** —— 上一版那个 30 里是含的（`holdout 5`），⛔ 两边口径别混 |
| `holdout/` | 13 | `frozen`（8 条在 `architecture/` 子目录下 + 5 条根级 `case_0NN.yaml`）|
| **含 holdout 合计** | **235** | |

```bash
# 逐格复算（期望与上表逐一相等，⛔ 不是求和相等 —— 见下方「口径」）
for d in general architecture capability real-tasks holdout; do
  printf "%-14s %s\n" "$d" "$(git ls-files "evals/$d" | grep -c '\.yaml$')"
done                                              # → 28 / 113 / 54 / 27 / 13
grep -rl "lifecycle:" evals/ --include="*.yaml" | wc -l   # → 0（机械冻结标记尚未落地）
```

> **口径**：上表是 **case 口径**（一条 case = 一个 yaml），⛔ 与"文件口径"不是一回事 ——
> `architecture/` 有 113 个 yaml 但 **131 个入库文件**（多出 18 个子目录 README）。
> 引用这些数字时**必须连口径一起引**，否则两处求和永远对不上。

### 四组为什么冻结（⛔ 不是"断言腐烂"这一条理由通吃）

| 组 | 死因 |
| --- | --- |
| `general/` `architecture/` `real-tasks/` | **环境不可重建** —— case 里的 `repo_commit` 指向已不可达的提交，题面依赖当时的仓库结构 |
| `capability/` | 🔴 **死于实现，不死于不可重建** —— 它的 `seed` / `setup` / `fixture` / `env` / `repo_commit` 实测**全为 0**，与仓库结构解耦；54 条里只有 **7 条**断言真腐烂、**2 条**是故意虚构路径（测 agent 自纠）、**45 条**技术上仍可跑。停掉它是**方向裁决**（不再用"过程合规"这条论证线），⛔ 别写成技术判决 |

⚠️ 跑分也早就冻了：`capability/` 最后一次 `tested_at` 是 **2026-05-27**，而 54 条里有 **49 条**
仍带着 `baseline_scores` ⇒ **"有分数"会让读者以为它活着**。`_scores/` 228 个周快照的
`tested_at` 上界是 **2026-06-01**，对应 commit 同样已不可达。

### 新题集在哪（🔴 两个 URL 都要拿，⛔ 不是二选一）

| 端 | 地址 | 里面是什么 |
| --- | --- | --- |
| GitHub | <https://github.com/njfuzrs/agent-traj-bench> | 题集本体：`tasks/` 39 个题目录 + `scripts/`（判分）+ `reports/` |
| HF dataset | <https://huggingface.co/datasets/njfuzrs/agent-traj-bench> | 快照仓：`tasks.jsonl` / `snapshots.jsonl`（**不入 git，只在 HF**）|

⚠️ **只拿一个拿不到另一半**：只有 GitHub 拿不到快照，只有 HF 拿不到题目定义与判分脚本。

🔴 **本目录题集与新集判据不兼容，分数不互比。** 两者不是同一件事的新旧两版：

| | 本目录（`general/` `architecture/` `capability/` `real-tasks/`） | `agent-traj-bench` |
| --- | --- | --- |
| 判什么 | **过程**（"过程病态吗"）+ 5 维 rubric 打分 | **结果**（"改对了吗"）|
| 判分形态 | LLM Judge + `must_include_any_of` / `must_call_tools` 等机械断言 | `tests/{f2p,p2p}.json` + `score.py` → `reward.json` |
| 报告口径 | 0–5 分制 + `baseline_scores` 对照 | `pass@1` |

⇒ ⛔ **不许说「新集已经覆盖了这些评测能力」**，也 ⛔ **不许把两边的分数放进同一张表**。

## 目录组织

> ⚠️ 下面这张树是 **2026-09-17** 的入库快照（`git ls-files evals`，**681 个文件**）。
> ⛔ 别照抄它当事实 —— 改动前先跑 `git ls-files evals | awk -F/ 'NF>2{print $2}' | sort | uniq -c` 对账。

```
evals/                            # 入库 681 个文件（⚠️ 运行产物被 .gitignore 挡掉，不在此列）
├── README.md                     # 本文
├── CLAUDE.md                     # 面向 agent 的规则（每条带 file:line 出处，有门禁校验）
├── _template.yaml                # ⚠️ 旧四组的 case 模板（:3 用法示例指向已冻结的 general/p0-core）
├── CASES.md                      # 自动生成（勿手编）；数据源 _reports/promptfoo-latest.json 已不存在
├── gen-cases-md.ts               # CASES.md 的唯一生成器
├── verify-judge-stability.ts     # judge 稳定性自检
│
├── general/            28  # frozen（p0-core 10 / p1-common 9 / p2-edge 6 / execution 3）
├── architecture/      131  # frozen（113 yaml + 18 子目录 README，18 个子目录）
├── capability/         64  # frozen → 待删除（54 yaml：plan 10 / memory 10 / context 10 / router 13 / harness 11）
├── real-tasks/         58  # frozen（27 yaml + 31 setup 脚本）
├── holdout/            16  # frozen（13 yaml + 2 README + holdout-sids.txt）
│                          #   ⛔ holdout-sids.txt 一字节不许动：sha256 永封，pre-push.sh 会拒绝 push
│
├── _judge/             22  # ✅ 在用：prompt-v0~v3 + calibration-v3（κ=0.921）+ gold-cases 10 条
│                          #   ⛔ 不许归进"历史债务"：实测 12 个代码文件在读它
│                          #   （packages/eval-framework/ 3 + scripts/eval/ 9），⚠️ 口径=代码引用
├── _diagnoses/         12  # ✅ 在用：5 个 fix_type 归因轴的唯一实例化记录 + SCHEMA.md + runs/
├── _meta/               4  # smoke-cases / critical-cases / holdout-leak-audit / pass-at-k.test.ts
├── _reports/           25  # eval-latest.json + capability-plan-w11/w12 + external/ 19（swe-bench 外部基线，活的）
├── _runs/               4  # ⚠️ 过期时序数据（与 _scores/ 同批跑分，末条 2026-06-01）
├── _scores/           228  # ⚠️ 周快照，tested_at 全部 ≤ 2026-06-01，对应 commit 已不可达
│
├── bench-runner/       10  # 大规模 bench（≠ case eval）：runner + 3 grader + 4 adapter + capability-{grader,shared}
├── providers/           4  # eval-runner 调用的 wrapper（spawn 入口）
├── scripts/             4  # evals 专用脚本
├── cross-provider/      2  # 横评报告 + 活测试
├── inspect/             6  # ⚠️ 外部引用 0，但刻意保留 —— "路径 A 已否决"那句结论的唯一实证载体
│                          #   ⛔ 零引用 ≠ 零价值，别当死目录删
├── external-benchmarks/ 56 # ✅ 在用：harbor 34 / swe-bench 15 / lib 3 / cr-samples 3（末次改动 2026-09-17）
└── raw-outputs/         1  # 只剩 .gitkeep —— 它是运行时 transcript 落点，实测 19 个文件引用这个路径
                           #   ⛔ .gitkeep 别删：它就是为那些引用而存在的
```

> **runner 入口约束**：`packages/eval-framework/core/runner.ts:51` 的 `CASE_DIRS` 只扫
> `general/{p0-core,p1-common,p2-edge,execution}`；`architecture/` 的 18 个子目录由
> `discoverArchitectureSubDirs()` 动态发现，`holdout/` `real-tasks/` 各有独立常量。
> ⚠️ **题集已冻结 ⇒ 这些入口现在扫到的都是死题**，跑出来的分数不代表当前能力。

## 跑评测

> 🔴 **题集已冻结 ⇒ 下面这些命令现在跑的是死题**（见顶部状态块）。
> 它们**仍然能跑、也仍然会打出分数**，而那个分数不代表当前能力 —— ⛔ 别拿它做回归对照、
> 也 ⛔ 别拿它和 `agent-traj-bench` 的 `pass@1` 比。留着命令是为了**还能取回历史现场**，
> 不是为了继续跑。

详见 `CLAUDE.md §0.5`。常用三条：

```bash
# 单 case 调试（默认 --sync off，不污染 case yaml 的 baseline_scores）
bun run eval:run --cases case_002 --provider sid-code

# "全量"回归（--skip-holdout 默认 true）
# ⚠️ 上一版这里写「25 条非 holdout」—— 实测 eval:run 扫到 168 条
#    （general 28 + architecture 113 + real-tasks 27；⛔ capability 54 不在 CASE_DIRS 里，
#     它走 scripts/eval/run-{plan,memory,context,router,harness}-capability.ts 五个独立入口）
bun run eval:run --provider sid-code

# 多 provider 横评（不传 --model 时各 provider 用各自的 defaultModel）
bun run eval:run --provider sid-code,claude-code
```

> ⚠️ `claude-code` provider 只认 `claude-*` 前缀 model，传其他会直接抛错（不静默 fallback）。

## 数据资产分层与生命周期

> evals/ 下的"数据"分两类：**测试代码**（永久）和**测试结果**（按价值分层）。
> 不要把 `_runs/` `_reports/` `raw-outputs/` 当成可以"跑完就删"的临时产物——它们是 EDD 闭环的证据链。

### 测试代码（永久保留，等同源代码）

> 🔴 **这一节的"永久保留"只对下表后三行成立。** 题集本身已冻结（见顶部状态块），
> 「case yaml 等同 `tests/*.test.ts`」这条前提对 222 条死题**不再成立** ——
> 一个跑不起来的 case 不是测试，是误导。

| 资产 | 性质 |
| --- | --- |
| ~~`general/ architecture/ capability/ real-tasks/ holdout/` 的 yaml~~ | ⚠️ **已冻结，不再是"永久保留"** —— 环境不可重建 / 实现已停（顶部状态块） |
| ~~`eval-runner.ts` `eval-judge.ts` `_types.ts`~~ | 🔴 **已不在本目录** —— runner 与 judge 迁到 `packages/eval-framework/core/{runner,judge}.ts`，类型定义迁到同目录 `types.ts` |
| `_judge/prompt-v3.md` `_judge/calibration-v3/` `_judge/gold-cases/` | ✅ **在用**：LLM Judge 校准成本极高（κ=0.921 重新校一次要数小时人工标注），删了等于推倒重来。⚠️ 它与题集无关，⛔ 别跟着题集一起清 |
| `providers/*.ts` | ✅ 在用：`tests/eval/` 有活 import 与出处断言指向它 |
| `_diagnoses/` | ✅ 在用：5 个 `fix_type` 归因轴的唯一实例化记录 |

⚠️ 另有两个曾在这一层、现在**只剩生成关系**的：`gen-cases-md.ts` → `CASES.md`
（CASES.md 头部自陈"自动生成，请勿手动编辑"，而其数据源 `_reports/promptfoo-latest.json`
**已不存在** ⇒ 它现在既不能重新生成、也不该手改）；`verify-judge-stability.ts` 拿旧四组
case 跑 judge 自检，⇒ **题集冻结后它没有输入**。

### 测试结果按"未来用途"分四层

#### ⭐ 第一层 baseline 锚点（必留）

`_scores/wNN/case_NNN.yaml`（最新周）+ `_runs/<provider>.jsonl` 中**全量 25 case 的 run**。

**用途**：S0-S4 全程作为"不回归"对照系。任何 src/ 改动后跑 25 case，对比这一层判断降幅是否 ≤ 0.3（08 §13.4）。

#### ⭐ 第二层 追责证据（归档保留）

`_runs/<provider>.jsonl` 全量历史 + `_scores/wNN/` 历史周快照。

**用途**：M3 Go/No-Go 条件 6 "P0 每条 case 至少跑过 3 次" 的**唯一证据**——直接 grep `_runs/*.jsonl` 统计。删了到 M3 评审时拿不出证据。

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
- **保留**（`_reports/` 现存 5 个 + `.gitkeep`）：`eval-latest.json`（`gen-cases-md.ts:20` 仍读取）、
  `capability-plan-w11.md` / `-after.json` / `-baseline.json`（`capability/plan/README.md:64` 明确的持续追踪机制）、
  `capability-plan-w12-d3-preview.md`（同一追踪机制的中期工件，尚无 w12 正式版取代它）
- **`raw-outputs/` 保留 17 个**：`CASES.md` 引用的 12 个 `case_00N_<ts>.jsonl` transcript + `capability-plan-w11/w12` 系列 5 个（`_reports/capability-plan-w11.md`、`capability-plan-w12-d3-preview.md` 正文引用）
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

> 🔴 **⛔ 不要在本目录写新 case。** 四组已冻结（见顶部状态块）—— 在这里加第 223 条，
> 就是往一个不再跑的题集里投入工时。新题目去 `agent-traj-bench`，
> 它的 case 形态是 `tasks/<id>/` + `tests/{f2p,p2p}.json` + `score.py`，
> 与下面这套 yaml + rubric **零交集**。
>
> ⚠️ `_template.yaml` 也是**旧四组的模板，不是通用 case schema**：它 `:3` 的用法示例
> 指向 `p0-core/`，`:18` `eval_type` / `:21` `holdout` / `:29` `repo_commit` 全是旧四组的字段体系。
>
> 🟢 **这一节留着的理由是"判据怎么定"这件事仍然有用** —— 下面 5 条坑是踩出来的，
> 写新集的判分脚本时同样适用。⛔ 但别照着它的命令建 case。

详见 `_template.yaml` 内联注释（~110 行，8 段）。**5 个最容易踩的坑**：

1. ❌ `must_include_any_of` 关键词没 grep 验证 → case_001 教训（写出来发现仓库里根本没这个字符串）
2. ❌ 写 `must_call_tools_in_order`（agent 找替代工具序列就 fail，规则太脆）—— 用 `must_call_tools`（不卡顺序）+ `must_not_call_tools`（反向卡禁区）
3. ❌ 让 LLM 一次性生成 25 条 case（产出同质化，分布失真）
4. ❌ `holdout: true` 的 case 出现在日常 eval 里（runner `--skip-holdout` 默认 true 已防护，但人工手动跑也别绕过）
5. ❌ `expected.reference_answer` 写死唯一答案（多种正确写法都会被判错）—— `reference_answer` 是给 Judge 参考的描述，不是模板比对

**~~新建 case 流程~~**（⛔ **已停用** —— 题集冻结，这套流程只作历史记录）：

```bash
# ⛔ 不要跑这一段。留在这里是为了说明"当年 case 是怎么建的"，不是为了照着建第 223 条。
cp evals/_template.yaml evals/general/<priority>/case_NNN.yaml   # 手动复制模板命名
# → 编辑 yaml 填字段
bun run eval:list              # 验证识别
bun run eval:run --cases case_NNN --provider sid-code   # 单跑验证
```

## 目录边界：`evals/` 与 `scripts/eval/` 的分工

这一节是 P2-4（2026-08-12）立的，治的是一个反复被问的问题：**为什么 `evals/` 里有代码？**

先说结论：**`evals/` 是「评测这件事」的整体归属地，它可以有代码，这不是历史欠债。**
实测本目录有 **29 个 `.ts`**（`bench-runner/` 10、`external-benchmarks/` 5、`scripts/` 4、
`providers/` 4、`_judge/` 2、根下 2、`_meta/` 1、`cross-provider/` 1），
`scripts/eval/` 有 **37 个文件**。两边各放什么，判据如下：

```bash
# 复算（⚠️ 上一版这里写 25，实测 29 —— 那个数从 2026-08-12 起没再更新过）
git ls-files evals | grep -c '\.ts$'                                    # → 29
git ls-files evals | grep '\.ts$' | awk -F/ 'NF==2{print "根下"} NF>2{print $2}' | sort | uniq -c
git ls-files scripts/eval | wc -l                                       # → 37
```

| 目录 | 放什么 | 判据 |
| --- | --- | --- |
| **`evals/`** | 评测**体系本身**：case 数据（`general/` `architecture/` `capability/` `real-tasks/` `holdout/`）、judge 与诊断资产（`_judge/` `_diagnoses/` `_meta/`）、基线与报告（`_runs/` `_scores/` `_reports/`），以及**与 case 数据强耦合的执行代码**（`bench-runner/` `providers/` `scripts/`） | **改一个 case 就要跟着改的代码，放这里** |
| **`scripts/eval/`** | 评测的**工具与门禁**：跑批入口、聚合、泄漏检查、门禁脚本 | **与具体 case 无关、对整个评测集通用的，放这里** |

根下两个 `.ts` 按此判据属前者，保持原位：`gen-cases-md.ts`（遍历全部 case 生成
`CASES.md`）、`verify-judge-stability.ts`（拿 case 跑 judge 自检）。

> ⚠️ **不要"顺手"把 `evals/` 下的代码迁去 `scripts/eval/`。**
> 曾有一版方案提议只迁根下那 2 个文件、理由是「`evals/` 应该只放数据」。
> 那条原则与现状冲突：迁完之后这里仍有 **27** 个代码文件，但**看起来像已经治理过了** ——
> 把不一致从「明显」变成「隐蔽」，下一个人更难发现这里其实没有统一规则。
> 而且 `tests/eval/` 有 **11 个测试文件**直接 `import ../../evals/...`（共 **12** 条 import 路径：
> `bench-runner/` 的 capability-grader / capability-shared / runner / trajectory-grader / 2 个 adapter，
> `external-benchmarks/swe-bench/` 的 grade / mini-adapt / preflight / runner，
> `providers/sid-code-live`，`scripts/distill-skill-rules`），迁移要连带改它们。
>
> ```bash
> # 复算（⚠️ 上一版写「6 处」，实测 11 个文件 / 12 条路径）
> grep -rlE 'from "(\.\./)+evals/' --include='*.ts' tests/ packages/ | wc -l   # → 11
> grep -rhoE 'from "(\.\./)+evals/[^"]*"' tests/eval/*.ts | sort -u            # → 12 行
> ```
>
> 有先例：gemini-cli 的 `evals/` 里同样是 `.eval.ts` 代码 + helper，不是纯数据目录。
>
> 若哪天真要统一，那是一次**独立改造**（29 个文件 + 11 个测试文件的 import +
> `pkg-boundary-scan` 的扫描范围），不要塞进"入库与位置清理"这类任务里。

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
| `_template.yaml` | ✅ | ⚠️ **旧四组的 case 模板** —— 上一版这里写「写新 case 必读」，题集冻结后**不再适用**（见「case 写作要点」）|
| 本文「历史：promptfoo 时期的实现」 | ✅ | promptfoo 废弃决策档案 + 紧急回滚指引（原 `_legacy/README.md`，2026-08-12 并入）|
| `docs/eval/TODO.md` | ❌ 仓外 | Sprint S0–S4 执行清单。⚠️ **S0 从未执行**（实测 `lifecycle:` 零命中）⇒ ⛔ 别把它当"当前在做什么"的事实源 |
| `docs/eval/08-研发智能基座-eval总纲.md` | ❌ 仓外 | 战略 + Go/No-Go 条件 + 三档通过线 |
| `docs/eval/09-研发智能基座-eval详细清单.md` | ❌ 仓外 | 178 约束 → ~169 case 的逐条映射（⚠️ 那批 case 即本次冻结的四组）|
| `docs/eval/edd-iteration-playbook.md` | ❌ 仓外 | 5 步迭代循环（MEASURE → DIAGNOSE → PLAN → FIX → VERIFY）|
| `X2-Evaluation/10-历史评测集清理方案.md` | ❌ 仓外 | 本次冻结与后续删除的裁决依据（判"删什么、为什么"）|
