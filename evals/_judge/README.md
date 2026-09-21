# `_judge/` —— sid-code 特定的判分资产

本目录与 `packages/eval-framework/judge/` 的分工按**两问**切，⛔ 不是按「代码 vs 数据」：

> ① 在代码路径上 ∧ ② agent-agnostic —— **两问都要**才进包。

| 资产 | 落点 | 为什么 |
| --- | --- | --- |
| `prompt-v2.md` | `packages/eval-framework/judge/` | 7 个 runner 直读，且 `grep -cin "sid-code\|sid_code\|packages/\|src/agent"` = **0** |
| `calibration-types.ts` + `calibrate-pairwise.test.ts` | 同上 | pairwise 汇总是框架逻辑；测试 `from "./types"`，同去同留 |
| **`prompt-v3.md`** | **本目录留下** | `:28` / `:33` few-shot 写死 `src/agent/loop.ts` 与 `AgentLoopRunner`。搬进 agent-agnostic 包会让别的 agent 拿 sid-code 的文件路径当判分基准 |
| κ 校准数据 / `gold-cases/` | 本目录留下 | 校准的是 v3；gold-cases 删除前后都必须是 10 |
| `prompt-v0.md` / `prompt-v1.md` | `evals/_archive/judge-prompts/` | 零读者 / 仅错注释提及 |

⛔ **一个字都不改 prompt 内容**：κ=0.921 校准的是 v3，趁搬家「统一格式」会让 κ 历史失去比较对象。

活着的 `promptPath` 常量（2026-09-21）：

- `scripts/eval/run-bench.ts` → v2（已迁包内）
- `scripts/eval/run-cross-baseline.ts` / `scripts/eval/calibrate-judge.ts` → v3（路径不变）

门禁：`tests/eval/judge-prompt-path.test.ts`（3 处代码常量指向的文件必须存在；改错一个必红）。
