---
Status: implemented
Date: 2026-10-02
---
# /goal 评估者默认是主模型自评：只如实提示，不自动挑模型（B16 / D48）

## 决定了什么

- 评估者取值抽成单一事实源 `resolveGoalEvaluatorModel()`（`packages/core/src/goal/config.ts`），
  顺序 `goal.evaluatorModel → subAgentModels.default → 主模型`，刻意不读 `subAgentModels.verify`。
  `query/loop.ts` 的 Goal Gate 与 `/goal` 命令共用它——提示说的评估者与实际调用的评估者不会再漂移。
- `/goal <条件>` 设目标时，若解析为主模型，经新增的 `CommandContext.notify`（交互模式接状态栏瞬态通知）
  提示一次「评估者 = 主模型……建议配独立的轻量模型」；`/goal status` 新增一行「评估者: <模型>（<来源>）」。
- 修正三处与实现不一致的注释/文档：`goal/config.ts` 字段注释（原写 verify/haiku 回退）、
  `goal/evaluator.ts` 模块头（原写「独立小模型 haiku 级别」）、`website/use/plan-mode.md` 第 4 步（D48）。

## 放弃了什么（以及为什么不选）

- **未配置时自动挑一个 haiku 级模型**：模型目录随 provider / 网关而异，按模型名硬编码「轻量档」
  既不可靠也违反项目约定（禁按模型硬编码分级）；还会改变现有用户的默认行为与成本。
- **复用 `subAgentModels.verify`**：verify 是对抗验证子代理（强、慢），撞 goal 评估 25s 超时必败（20260707 P0-1/P1-4）。
- **把提示塞进 submit_prompt 的提示词**：那段文本只喂 LLM、不上屏，用户看不到；还会污染模型输入。
- **用 `type: "text"` 返回提示**：会吞掉 submit_prompt，目标不再自动开跑。

## 拿什么证明它生效了

- `bun test ./packages/cli/tests/command/goal-evaluator-hint.test.ts ./packages/core/tests/goal/` → 106 pass / 0 fail。
- 变异自证：把 `if (evaluator.source === "main") ctx.notify` 改成 `if (false)`，新测试 1 fail，复原后全绿。
- 未覆盖：状态栏通知在真实 TUI 里的渲染只按代码路径接线（`statusNotifier` 与权限模式切换提示同一通道），未截图验收。
