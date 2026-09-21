# `_archive/` —— 死了但要留

桶定义：不是 case、不是 agent 输入；退役 / 否决后仍要能被后来人查到论证载体。
⛔ 不许留一个没说明的子目录。对照 terminal-bench：归档目录的文档覆盖率 ≥ 活目录。

当前分母是 **1**（本 PR 建 `judge-prompts/`）。PR-D 会再加 `inspect-spike/`，那时分母变成 2。
⛔ 不是 5 —— `_diagnoses/` / `cross-provider/` 是活的，不进这个桶。

| 子目录 | 为什么留 | 谁可能来查 |
| --- | --- | --- |
| `judge-prompts/` | `prompt-v0.md`（零读者占位稿）+ `prompt-v1.md`（仅 `process-grader.ts` 一条**已修**的错注释曾提及）。κ 历史写过 v1→v2 的 Spearman 对照，原文必须可取回 | 重做 judge 校准、核对「v1 系统性低估」那次决策的人 |

`prompt-v2.md` **不在这里** —— 它是活资产，在 `packages/eval-framework/judge/`。
