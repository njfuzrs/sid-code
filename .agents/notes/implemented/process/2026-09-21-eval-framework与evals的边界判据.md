---
Status: implemented
Date: 2026-09-21
---
# eval-framework 与 evals 的三层 provider 边界写进两处 README

## 决定了什么

把只活在 `packages/eval-framework/core/runner.ts:167-172` 注释里的边界规则
写进 `evals/README.md` **和** `packages/eval-framework/README.md`。
判据是两问都要：① 在代码路径上 ② 是否 agent-agnostic。

三层不是两层：

- `packages/eval-framework/providers/`：agent-agnostic 在线
- `evals/providers/`：sid-code 特定在线（引仓内脚本）
- `evals/bench-runner/adapters/`：离线轨迹解析，根本不调 agent

`claude-code.ts` / `sid-code-live.ts` 跨层重名是刻意的。
`adapters/codex.ts` 显式标「预留对照位，当前无调用方」，不删。
`evals/external-benchmarks/README.md` 补「入库什么 / 不入库什么」
（59 文件、0 份答案、gitignore 三处 runs/logs）。本 PR **不含任何 `_meta/` 动作**。

## 放弃了什么（以及为什么不选）

放弃「统一三个 `providers/` 目录」。合并在线与离线会把「重跑」和「复算历史轨迹」
变成同一个入口，而 CLAUDE.md 已写死「重跑 ≠ 同一份轨迹」。
搬 `evals/providers/` 进包会让包反向依赖仓库源码，`lint:boundary` 会拦。

放弃把 `pass-at-k.test.ts` 搬进 `tests/eval/`（11a 上一版 B3）。
它的两个输入源已被 13 号删掉，搬完会看起来像已归位的活测试。

## 拿什么证明它生效了

- `bun test tests/eval/evals-claude-md-citations.test.ts`：改 README 不该动出处
- 两处 README 都写了同一张三层表，并引用 `runner.ts:167-172` 原话
- `git grep -n "不许合并" evals/README.md packages/eval-framework/README.md` 两处都命中
