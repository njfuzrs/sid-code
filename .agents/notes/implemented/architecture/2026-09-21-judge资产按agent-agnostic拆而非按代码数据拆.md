---
Status: implemented
Date: 2026-09-21
---
# judge 资产按 agent-agnostic 拆，不按代码/数据拆

## 决定了什么

搬 **3** 个文件（不是母文档反复说的 2 个）：

- `evals/_judge/prompt-v2.md` → `packages/eval-framework/judge/prompt-v2.md`
- `evals/_judge/calibration-set/types.ts` → `packages/eval-framework/judge/calibration-types.ts`
- `evals/_judge/calibration-set/calibrate-pairwise.test.ts` → 同目录（它 `from "./types"`，同去同留）

`prompt-v3.md` **留 `evals/_judge/`**：few-shot 写死 `src/agent/loop.ts` 与 `AgentLoopRunner`。
`prompt-v0.md` / `prompt-v1.md` 进 `evals/_archive/judge-prompts/`（本 PR 自己建 `_archive/`）。
活路径只改 `run-bench.ts:81`（v2）；v3 两处路径不变。
补 `tests/eval/judge-prompt-path.test.ts`（3 处，反向自证改错必红）。
`process-grader.ts` 那条「调用 prompt-v1.md」的错注释已修。
`affected-tests` 对 `packages/eval-framework/judge/` 选出整包（非空集）。

一个字都不改 prompt 内容。sha256：v2 `5ec595eee57c3c3bd585bc25179c89a165883878a94e27ddb8b1a1e2e08c4713` 搬家前后一致。

## 放弃了什么（以及为什么不选）

放弃「把两个 judge prompt 统一到一处」。v3 的 few-shot 写死 sid-code 结构 ——
搬进 agent-agnostic 包会让别的 agent 拿 sid-code 的文件路径当判分基准，
直接违反 `packages/eval-framework/cases/README.md` 的定位。
开源同形：promptfoo 内置 prompt 是 TS 常量，用户自己的 `rubricPrompt` 走外部文件；
`prompt-v3.md` 扮演的正是「用户自己的」那个角色。

放弃按「代码 vs 数据」拆：那会把 v3（数据、但 sid-code 特定）和 v2（数据、但 agent-agnostic）
放进同一个桶，下一个人会重提「为什么不都放 packages 里」。

放弃把 `_archive/` 留给 PR-D 再建：两个死 prompt 是「判分资产归位」这个关注点的一部分，
留给 P2 会在 main 上留下「活目录里躺着两个零读者 prompt」的中间态。

## 拿什么证明它生效了

- `shasum -a 256`：v2 搬家前后同一哈希
- `bun test tests/eval/judge-prompt-path.test.ts`：3 处存在；旧路径 `evals/_judge/prompt-v2.md` 不存在
- `bun test packages/eval-framework/judge/calibrate-pairwise.test.ts`：summarize / renderSummaryMd 绿
- `bun run affected-tests` 在只改 `packages/eval-framework/judge/` 时选出 `./packages/eval-framework/`
- `git ls-files evals | wc -l`：开工当日 147 − 3（搬走）+ 2（两个 README）= 146
