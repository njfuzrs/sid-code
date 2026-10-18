---
Status: implemented
Date: 2026-10-19
---
# effort 展示档改为线上实发档，删除 reconcileEffortForModel 对 runtime 的改写

## 决定了什么

- `getDisplayedEffort`（`packages/core/src/llm/effort.ts`）末尾经 `previewWireEffort` 映射成 applier 真正下发的档。Footer、`/model` 面板、`/effort` 面板、`/status` 都读它，所以「显示 = 实发」只在一处实现。覆盖排查文档 E2 展示、E7（settings / env 读入的无效档，例如 DeepSeek 上 low 显示 low 实发 high）。
- 删除 `reconcileEffortForModel`，以及 `app.ts` 里切模型（`applyPrimaryModelSwitch`）和 resume 恢复快照两处对 `runtimeEffort` 的改写。`runtimeEffort` 只存用户意图；切模型时如果所选档会被钳制，只记一条日志。
- Footer effort 列加一个 `inert` 标记：effort 被思考门控（`isEffortGatedByThinking`），且思考实际关闭（`resolveThinkingState().effective === false`）时，档位文本加划线、去掉品牌色。覆盖 E4 的 Footer 半边。
- `ModelDialog.resolveDisplayedEffort` 改为一律取实发档（此前非 auto 态取 runtime）。`EffortDialog` 在所选档被钳制时，状态行写「本模型按 X 下发」，光标落在实发档上。

## 放弃了什么（以及为什么不选）

- **保留 reconcile、再加展示层映射**：两套机制并存，用户意图照样在入口被改写。在 GLM 上把 xhigh 改成 max 后切回 Claude，xhigh 就丢了。展示层映射已经覆盖 reconcile 想修的「显示 ≠ 实发」，reconcile 只剩副作用。
- **`/effort` 设档时直接把 runtime 写成钳制后的档**：理由同上，而且 env 覆盖时 runtime 根本改不动。
- **思考关闭时隐藏 effort 列，或改用警告色**：隐藏会让用户以为模型不支持档位。警告色会扩张状态色的用途。按 `src/ui/CLAUDE.md`「排版 > 颜色」，用划线表达「不生效」。
- **展示层包含 ultrathink 提级**：提级只对单轮生效，不是 Footer 该常驻显示的状态。

## 拿什么证明它生效了

- 新测试和改过的测试：`model-effort-cycle.test.ts`（展示 = 实发不变式、env 映射、跨模型往返不丢 xhigh）、`effort.test.ts`（DeepSeek low 显示 high）、`effort-probe-wire-model.test.ts`、`status-line-effort.test.ts`（inert 派生）、`footer-effort-inert.test.tsx`（整帧渲染，`chalk.level=3`，断言 SGR 9）。五个文件 118 pass。
- 变异自证（四处，各自都变红后已恢复）：① `getDisplayedEffort` 去掉映射 → 6 fail；② Footer 不传 `strikethrough` → 1 fail（整帧）；③ `resolveDisplayedEffort` 改回优先取 runtime → 1 fail；④ `deriveEffort` 的 inert 分支短路 → 2 fail。
- 没做：真机 TUI 走查，以及发版后从轨迹 `effort_wire` 对照 Footer。
