---
Status: implemented
Date: 2026-10-02
---
# 计划对齐度（fidelity）接进 `/insights`：执行阶段记调用 → `PlanFidelity` 事件 → digest L0 一行

## 决定了什么

`PlanModeManager.getFidelityReport()` 曾经生产零调用（`recordActualToolCall` 也是），官网却写「`/trace` 能看到」。本次把整条链接通：

- `app.ts` `handlePlanModeTransitions`：**批开始时**已处于执行阶段（approve 之后）的每次工具调用都 `recordActualToolCall`（失败的也算，规划态两个工具除外）；批准时和每批之后落一条 `PlanFidelity` **累计快照**事件（`plan_file / plan_step_count / actual_tool_call_count / off_plan_count`）。
- `digest.ts`：`aggregatePlanFidelity` 每份计划取末条快照，`buildDigest` 产出 `plan_fidelity` L0 事实：「计划 N 步 / 实际 M 次调用 / 偏离 K 次」。`/insights`、`/debug`、`trace-digest.ts` 共用这份渲染，所以三处同时能看到。
- `plan/state.ts`：① `enter()` 清 `planSteps / actualToolCalls`，fidelity 按一份计划计（不清就会把上一份计划执行期的调用算进下一份）；② `anchorScore` 分词加 `*` —— 真实会话里模型把步骤写成 `1. **读取 package.json**`，token 带着 `**`，严格按计划的 2 次 read 被记成 2 次偏离。
- 官网 `use/plan-mode.md`：「`/trace` 能看到」改成「`/insights` 的 L0 事实层有一行 `plan_fidelity`」，并说明偏离数是文本匹配、宁漏不虚报。

## 放弃了什么（以及为什么不选）

- **写进 `metadata`（清单原方案 ①的字面写法）**：metadata 是会话级单值，一个会话可以批准多份计划；事件天然有时间序和出处，digest 的 L0 层本来就要求带 provenance。
- **事件里写 `stepRatio / matchedRatio`**：计划 0 步时是 NaN，进不了 JSON；比值可由计数重算，不落冗余字段。
- **每次调用落一条事件、digest 里累加**：事件量翻倍且累加口径一旦和快照混用就是 N 倍误差；快照 + 取末条更简单。
- **在 digest 里对偏离数下判断（标黄 / 阈值）**：偏离多是「计划写得粗」还是「执行跑偏」，轨迹里没有真值，只报计数，放 L0、severity=low。
- **只删官网那句（方案 ②）**：接线成本小，且这是「采集在、消费方无」死接线的又一例，修比删更符合可观测方向。

## 拿什么证明它生效了

- 单测 `packages/core/tests/trace/plan-fidelity-digest.test.ts` 8 条：快照取末条不累加、多计划按首次出现排序、无事件不出行、renderHuman 文本含该行、第二次 enter 清零、加粗描述能锚定。
  变异自证：去掉 `enter()` 里清零两行 → 1 fail；去掉分词里的 `*` → 1 fail；恢复后全绿。
- 真实会话（`make build` 后的本地二进制，`--permission-mode plan -p` 让它写两步计划→批准→执行）：
  - 修分词前：`20261002-205529-9c7b535d` 末条快照 `steps=2 actual=2 off_plan=2` —— 严格按计划执行却记 2 次偏离，暴露了加粗 bug。
  - 修分词后：`20261002-205640-d1e8c106` 末条快照 `steps=2 actual=2 off_plan=0`；对该会话调 `/insights` 命令实现输出 `[低] plan_fidelity: 计划 2 步 / 实际 2 次调用 / 偏离 0 次`。
- 未验证：交互 TUI 里手点批准的路径（与 headless 共用 `handlePlanApproval` 之后的同一段 `fidelityTouched` 逻辑，但没有真人点过）。
