# `_archive/` —— 死了但要留

桶定义：不是 case、不是 agent 输入；退役 / 否决后仍要能被后来人查到论证载体。
⛔ 不许留一个没说明的子目录。对照 terminal-bench：归档目录的文档覆盖率 ≥ 活目录。

当前分母是 **2**（`judge-prompts/` + `inspect-spike/`）。
⛔ 不是 5 —— `_diagnoses/` / `cross-provider/` 是活的，不进这个桶；
判据词汇表落在 `agent-traj-bench/docs/eval-criteria/`，不落这里。

| 子目录 | 为什么留 | 谁可能来查 |
| --- | --- | --- |
| `judge-prompts/` | `prompt-v0.md`（零读者占位稿）+ `prompt-v1.md`（仅 `process-grader.ts` 一条**已修**的错注释曾提及）。κ 历史写过 v1→v2 的 Spearman 对照，原文必须可取回 | 重做 judge 校准、核对「v1 系统性低估」那次决策的人 |
| `inspect-spike/` | 路径 A（Inspect AI）否决的**唯一实证载体**。外部引用 0 不是可删依据；spike 的 `run_spike.py` + `tasks/` + `lib/` 是「已过 spike 验证」那句话的落点。原路径 `evals/inspect/`，2026-09-21 PR-D 迁入 | 想核验「当年 spike 到底验到什么程度」、或想重开路径 A 的人 |

`prompt-v2.md` **不在这里** —— 它是活资产，在 `packages/eval-framework/judge/`。
