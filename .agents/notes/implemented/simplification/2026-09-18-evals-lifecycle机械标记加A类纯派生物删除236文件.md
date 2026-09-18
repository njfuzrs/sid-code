---
Status: implemented
Date: 2026-09-18
---
# `evals/` 打 `lifecycle: frozen` 机械标记（168 条）+ 删除 A 类纯派生物（236 文件）

## 决定了什么

两件事合一个 PR，同一个关注点：**把"无独立信息、却看起来还活着"的东西清掉**。

1. **168 条 case yaml 首行插入 `lifecycle: frozen`** —— `general/` 28 + `architecture/` 113 +
   `real-tasks/` 27。⛔ **`capability/` 54 条刻意不标**：它已判删（进后续 PR 的删除队列），
   标一个 `pending-review` 之类的中间态本身就是债务 —— 实测那个状态在旧方案里挂了三个半月，
   既没标记也没裁决。
   ⚠️ **为什么删除期还要先标记**：后续删除分四批走，期间 `architecture/` / `real-tasks/`
   还在磁盘上。**没有机械标记时，任何脚本扫到它们都当活的** —— 文档层写了"已冻结"不算，
   那只有人读得到。
2. **删 236 个纯派生物**（一律 `git rm`，⛔ 没用 `rm -rf`）：

   | 物 | 数 | 删的判据（实测） |
   | --- | --- | --- |
   | `_scores/` | 228 | `tested_at` 上界 2026-06-01，对应 commit 已不可达 |
   | `_runs/` | 4 | 与 `_scores/` 同一批跑分的另一种落盘形态、同死期 ⇒ 删 228 留 4 口径不自洽 |
   | `CASES.md` | 1 | 头部自陈"自动生成，请勿手动编辑"，数据源 `_reports/promptfoo-latest.json` 已不存在 |
   | `gen-cases-md.ts` | 1 | `CASES.md` 的唯一生成器，题集冻结后没有输入 |
   | `_template.yaml` | 1 | 实测 `:3` 用法示例指向 `p0-core/`、`:18` `eval_type` / `:21` `holdout` / `:29` `repo_commit` 全是旧四组字段体系 ⇒ **它是旧体系的模板，不是通用 case schema** |
   | `_reports/eval-latest.json` | 1 | 唯一读者是同批删掉的 `gen-cases-md.ts:20`；`runner.ts:1077` 只写不读 |

3. **连带改 6 个文件的引用**，⛔ 不留悬空指向：
   - `.oxfmtrc.json`：删 `"evals/CASES.md"` 排除项（排除对象没了）；把注释里过期的
     **283 / 14** 改为复算值 **281 / 13**。
   - 4 处报错文案里的 `_template.yaml`（`scripts/eval/run-code-review-skill.ts:144` +
     3 个 skill 测试的用例名）改指仍然存在的活出处 `evals/README.md` 关键铁律 3。
   - `evals/README.md`：入库数 681 → 445、根下 `.ts` 2 → 1、`.ts` 总数 29 → 28，
     并把"第一层 baseline 锚点（必留）"这类**现在自我矛盾**的段落改成方法论 + 已删说明。

⚠️ **对姊妹方案的连带影响（必须点破，别让它执行时才发现）**：删 `_runs/` 与 `_template.yaml`
让「目录标准化方案」目标树的两行失效 —— 它原计划把 `_runs/` 搬进 `_data/runs/`、把
`_template.yaml` 留在顶层。⇒ 那两行要删掉，否则它的验收判据（顶层目录/文件数）会对不上。
🔴 且 `_data/` 这个桶因此**只剩 `raw-outputs/` 一项** —— 一个桶只装一样东西是否还值得建，
归那份方案重判，本 PR 不越界。

## 放弃了什么（以及为什么不选）

- 🔴 **放弃 `_scores/` 228 个周快照 + `_runs/` 4 个 jsonl 的跨版本对照能力。**
  ⚠️ **但必须写明：它们的 commit 在删之前就已不可达，对照能力早就没了。**
  `tested_at` 上界 2026-06-01，拿这批快照做"不回归"对照，比较的是两个不同代码基线 ——
  那不是对照，是错数。⇒ **删掉的是"看起来还能对照"的错觉，不是能力本身。**
  🟢 补偿：数据在 git 里，`git log -- evals/_scores` / `git show <commit>:evals/_runs/<p>.jsonl`。
  ⚠️ 且两者都是 runner 的**运行时落点**（`runner.ts:833`/`:923` 各有一次
  `mkdirSync(recursive:true)`）⇒ 重新跑评测会重新长出来，**删的是过期数据不是写入链**。
- **放弃给 `_scores/` 留一份"数据有效期截止 2026-06-01"的说明 README。** 上游把这格留成"或"。
  否决理由：留一个 README 又是一份要维护的东西，而它要说的那句话**已经写进 `README.md`
  状态块**了 ⇒ 重复。历史在 git 里随时可查。
- **放弃删 `raw-outputs/`**（只剩 `.gitkeep`）。它有 15+ 处引用，`.gitkeep` 存在就是为了那些引用。
- **放弃把 `_runs/` 搬进新桶而不是删掉**（姊妹方案原方案）。否决理由：
  **搬一批已过期的数据到新桶里，是把债务换了个位置**，而不是还掉它。
- **放弃在本 PR 动 `capability/` 或任何 case 本体。** 那是后续 PR 的事，且 `capability/`
  的判据词汇表必须先落盘才允许删 —— 本 PR 只做标记与派生物。

## 拿什么证明它生效了

**判据不是"文件删了"，是三件事：① 数量双向闭合 ② 删的东西没有活读者 ③ 门禁绿。** 逐条实跑：

```
① 数量闭合（⛔ 不许改期望值，对不上就找差在哪一项）
$ git ls-files evals | wc -l                          → 445   （681 − 236，期望值精确命中）
$ git diff --cached --name-only --diff-filter=D | wc -l → 236
$ ... | awk -F/ '{...}' | sort | uniq -c
  228 _scores/   4 _runs/   1 _reports/   1 CASES.md   1 gen-cases-md.ts   1 _template.yaml
                                                       ← 逐项与计划表相等
$ 树两侧闭合：目录合计 442 + 顶层 3 = 445 ✅
$ README .ts 分布求和 10+5+4+4+2+1+1+1 = 28 = 实测 git ls-files evals | grep -c '\.ts$'

② lifecycle 标记（分组逐格，⛔ 不是只看总数）
$ grep -rl "lifecycle:" evals/ --include="*.yaml" | wc -l  → 168（改前 0）
$ 分组：general 28 / architecture 113 / real-tasks 27 / capability 0 / holdout 0
$ grep -rc "lifecycle: frozen" ... | awk -F: '$2!=1'       → 非 1 次的文件数 0（无重复插入）

③ 删的东西没有活读者 —— 逐个核 fail-loud/fail-quiet，⛔ 不是"grep 完没引用"
   _runs/ 的 5 个读者全部 existsSync 守卫、缺数据即空集：
     cross-provider-report.ts:74 → []      run-smoke.ts:83 → null
     yaml-loader.ts:389 → 空 Map           pass-at-k.ts:65 → warn 后继续（已知第二处 fail-quiet）
     check-skill-holdout-regression.ts:217 → return 1（fail-loud，且它先跑 runner 重建）
   eval-latest.json 唯一读者 gen-cases-md.ts:20 同批删除；runner.ts:1077 只写不读

④ 门禁（实跑，⛔ 非"应该能过"）
$ bun run affected-tests        → 判定 full（仓库级文件 .oxfmtrc.json）
$ bun test ./tests/eval/        → 738 pass / 0 fail / 1791 expect（3.10s）
$ bun test ./packages/core/tests/skill/code-review.test.ts \
         ./packages/core/tests/skill/code-review-chaos.test.ts \
         ./packages/core/tests/skill/ci-self-heal-chaos.test.ts \
         ./tests/eval/check-holdout-real-tasks-sealed.test.ts \
         ./tests/eval/evals-claude-md-citations.test.ts
                                 → 208 pass / 0 fail
$ make build                    → 编译产物自检 4 项全 ✓「自检通过」
$ bun run format:check          → All matched files use the correct format（1927 files）
$ bun run lint                  → 无输出（oxlint correctness 零告警）
$ bun run lint:boundary         → 越界依赖 0 处
$ bun run docs:gen-reference --check → 参考页与源码一致
$ bun run verify:agent-note     → 形态合规
$ sh scripts/eval/check-holdout-real-tasks-sealed.sh → rc=0
$ 判据 14（oxfmtrc 排除路径存在性）→ missing []
```

⚠️ **全量 `bun test` 报 226 fail / 1 error 不能读成本次回归。**
同一批失败文件单跑全绿（`harbor-agent-contract` 41/0、`runner.test` 22/0、
`grep+glob+ripgrep` 60/0、`tests/eval` 738/0）。形态是并行污染（tmpdir fixture
「未找到匹配」/ 空 stdout），不是 yaml 内容或删除导致的断言失败。
⛔ 按 CLAUDE.md 三条证据，我**没有**在干净 main 上复跑全量，所以不把它们报成「既存失败」——
只报「改动面单跑绿 + 全量失败在单跑下消失」。补偿是 CI 在合并前跑全量。

🔴 **一处推翻上游的实测**：上游写「`_runs/` 的唯一读者是 `pass-at-k.ts`」，
**实测有 5 个读者**（上列）。结论不变（全部 existsSync 守卫 ⇒ 删除安全），
但**理由要说准**：不是"没人读它"，而是**"读它的人都能正确处理数据不存在"** ——
前者是运气，后者才是判据。⛔ 别把两者说成一回事。

⛔ **本次没有证明的事**（别读成已完成）：`capability/` 64 个文件一个没动、
222 条 case 一条没删、污染扫描链未动。⛔ 不许说"评测集已清理完成"。
