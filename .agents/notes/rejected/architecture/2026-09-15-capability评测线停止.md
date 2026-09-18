---
Status: rejected
Date: 2026-09-15
---
# 否决继续维护 `capability/` 评测线（54 条 case + 5 个 runner + 2 套判分器）

## 决定了什么

**停掉 `capability/` 这条评测线**，54 条 case（context 10 / harness 11 / memory 10 / plan 10 / router 13）
连同 10 类连带全删（执行记录见 `implemented/architecture/2026-09-18-evals-pr3c-capability组70文件删除.md`）。
⛔ 这是本轮 `evals/` 清理里**唯一的真裁决点**，其余三组（`general/` `architecture/` `real-tasks/`）
都是执行 —— 它们死于「环境不可重建」，**这一组不是**。

**它服务的论证线是「过程合规」** —— 用「agent 有没有按规矩走（调对工具、没空转、步数不超）」
证明 harness 变好了。这条线停止：往后「更准」用 `CLAUDE.md` 北极星那四层
（过程病态率 / 工具层成败 / eval 通过率 / 编辑一次成功率），不再用一套自建的过程合规题集。

## 放弃了什么（以及为什么不选）

**1. 放弃「过程合规」这条论证线本身，以及 45 条技术上仍可跑的 prompt 型 case。**

⛔ **不许把这次删除写成「断言腐烂了」** —— 实测不支持：

| 类 | 条数 | 实测 |
| --- | --- | --- |
| 🔴 题面指向已失效路径（真腐烂） | **7 / 54** | `case_hrn_011`（读 `src/llm/` 下 12 个文件，仓库迁 `packages/` 后全灭）、`case_mem_007`、`plan_003/005/006/008/009` |
| ⚠️ **故意**虚构路径（设计如此，⛔ 不算腐烂） | 2 / 54 | `case_hrn_007` 题面自陈「这个路径里有拼写错误」（测 agent 能否自纠）、`plan_007` |
| 🟢 题面不引仓内路径 | **45 / 54** | prompt 型能力题，与仓库结构解耦 |

⇒ **删除是方向裁决，不是技术判决。** 7/54 修得起，45/54 今天就能跑。
放弃的是「值不值得继续投入」，不是「还能不能跑」。

**2. ⚠️ 「不可重建」这条理由对 capability ⛔ 不成立 —— 别让下一个读者以为它与其余三组同因而死。**

实测它的 `seed` / `setup` / `fixture` / `env` / `repo_commit` **五个字段全部 0 命中**，
是自包含的「prompt + 机械断言 + rubric」结构 ⇒ **今天对任何 agent 都能跑**。
其余三组 case 里的 `repo_commit` 指向已不可达的提交，那才是不可重建。
**它死于实现，不死于不可重建。**

**3. 放弃的不是「无可指认」—— 三处工程缺陷是停掉它的实质依据：**

| # | 缺陷 | 实测 |
| --- | --- | --- |
| 1 | **跑分冻在 2026-05-27**，而 54 条里 49 条仍带 `baseline_scores` | `grep -rho "tested_at:.*" evals/capability/ \| sort \| tail -1` → `2026-05-27T15:46:28.332Z` ⇒ 三个半月未跑，case 里存着旧分数 —— **"有分数"会让读者以为它活着** |
| 2 | **一个子系统一个 runner，5 份近似重复** | `run-{plan,memory,context,router,harness}-capability.ts` 各 300–500 行，共享 `capability-shared.ts` 却各自维护入口 ⇒ **加第 6 个子系统要再写第 6 个 runner** |
| 3 | 🔴 **判分器分裂成两套，边界只靠一段注释维持** | `capability-shared.ts:14-16` 原文：「`capability-grader.ts`：plan 子系统专属，保留不变（ADR-013 §2.5）／`capability-shared.ts`：memory/context/router/harness 共享底座」⇒ 同一件事两套实现（本仓「伪配置 / 死功能」同族）。已量化：27 个断言键实测分裂在 **5 / 9 / 13** 三处，且 `recovery_plan_update_count_min` **两处都有** |

⚠️ 第 3 条的 5/9/13 是**按 switch 分支**数的。上游文档写 7/7/13，那是按 `grep -l` 文本命中分组
的结果 —— `plan_min_steps` 与 `recovery_plan_update_count_min` 在 `capability-shared.ts`
**只出现在文件头注释里**，实现在 `capability-grader.ts`。**判据是 switch 分支，不是文本命中。**

**4. 放弃过的替代方案：只删 7 条腐烂 case、保留这条线。**
⛔ 否决 —— 缺陷 2、3 与 case 腐烂无关，修完 7 条题面后那两条仍在，
而这条线的产出（过程合规分）已不再进任何决策。修它等于给一条不再用的论证线还债。

## 推翻条件（🔴 这一段是本 Note 的用处所在）

**若将来重新需要向企业客户证明「决策过程可审」**，不必从零重建：

1. **从 bundle 取那 45 条 prompt 型 case** —— `~/Backups/sid-code-evals-legacy/evals-222cases-20260918.bundle`
   （校验见同目录 `SHA256SUMS`）。它们的 rubric 措辞是当年「怎么给过程定判据」的唯一记录。
2. ⛔ **但别照原样恢复 5 个 runner + 2 套判分器** —— 正确形态是**一份声明式判据清单 + 一个 dispatcher**，
   判据：**加第 6 个子系统时不必再写第 6 个 runner**。这正好治掉上面缺陷 2 与 3。

## 拿什么证明它生效了

🔴 **判据词汇表已另行保全 —— 这一段是本 Note 与「纯粹的损失」的区别：删掉的是实现，判据活下来了。**

27 个机械断言键 + **64** 个 rubric 维度（**84** 条措辞）已按 PR0 提取落盘到
**独立仓** `agent-traj-bench` 的 `docs/eval-criteria/`（PR #4，merge commit `a81ba22`，
mergedAt 2026-09-17T07:38:55Z）。落在独立仓是刻意的：09 号 §4「**尺子不能长在被测物上**」。

```
$ git -C ~/Code/person/agent-traj-bench ls-tree -r --name-only origin/main -- docs/eval-criteria/
docs/eval-criteria/mechanical-assertions.md
docs/eval-criteria/rubric-dimensions.md
$ git -C ~/Code/person/agent-traj-bench merge-base --is-ancestor 0b47e8f origin/main   → ✓
```

⛔ **未落盘不许执行删除** —— 这是硬前置，上面两行就是它已解除的证据。

⚠️ **实测推翻上游三处，⛔ 别照上游数字复算**：① 断言键分裂是 **5/9/13** 不是 7/7/13（判据是
switch 分支）；② rubric 是 **64 个维度 / 84 条措辞** 不是 63 —— 上游 glob
`capability/*/*.yaml` 只有两层，漏掉 `router/mock-provider/` 那一层的 5 条，连带漏 `contract` 维度，
且「63」本身还按维度名去重压掉了 20 条同名不同措辞（`plan_completeness` 在 4 条 case 里 4 种措辞）；
③ 断言口径分母是 **49 不是 54** —— 5 条 `eval_type: integration_test` 无 `grader:` 段，
由 `packages/core/tests/llm/router-mock-integration.test.ts` 断言（**该测试仍在，不随本次删除**）。

⚠️ **本 Note 没有证明的事**：没有证明「新集已经覆盖了这些评测能力」。
`agent-traj-bench` 判**结果**（`pass@1`），这条线判**过程** ⇒ ⛔ 两边分数不互比，
也 ⛔ 不许说「新集已覆盖」。被放弃的过程判据由 `CLAUDE.md` 北极星「更准」那四层顶上。
