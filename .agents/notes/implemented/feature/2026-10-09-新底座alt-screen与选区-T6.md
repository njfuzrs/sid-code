---
Status: implemented
Date: 2026-10-09
---
# 阶段 6 收口：新底座 alt-screen 与选区（B9 / T6.2c）

## 决定了什么

阶段 6（T6.1a–b、T6.2a–c）全部完成。本任务没改底座和 CLI 源码，只做收口验证与归属判定：

- next 上 S7（L3 M1）、S9（R8）、S13（M2 M3）与 legacy 基线一致，M1–M5 契约两套底座都绿。S13 在 T6.2b 时已经转绿，本任务只确认全量下没有退回去。
- **T6.2a 移交的「ScrollBox 滚动时选区跟随」判为不适用，不实现**。依据有三条：① `packages/cli/src` 里没有任何地方使用 `ScrollBox`（`grep -rnw ScrollBox` 只命中 `VirtualizedList.tsx` 文件头那条说明它无效的注释）；② 端口按 L3 契约不提供 `scrollTop`，剔除恒按滚动位置 0；③ CLI 靠上下 spacer 和负 `marginTop` 表达滚动位置，这条路径和普通重渲染一样，选区是屏幕坐标、不跟内容，与 T6.2a 实测的 `scroll-down-1` / `content-change` 规则一致。legacy 里的 `captureScrolledRows` / `shiftSelectionForFollow` 只作用于 ScrollBox，所以这条行为在端口表面上不存在。
- `packages/tui/src/selection.ts` 文件头的移交说明改成上面的结论，免得下一个人再去找它。

## 放弃了什么（以及为什么不选）

- **在 next 上补一个 ScrollBox 和滚动跟随**：CLI 没有调用方，补了就是零调用的死接线，而且它不在端口表面里，没有对拍对象。哪天 CLI 真的要用 ScrollBox，应当先把它加进 `SURFACE.md` 再立项。
- **只跑 render-port 不跑全量**：阶段出口要求全量无新增失败，T6.2b 也把全量双跑明确留给了本任务。

## 拿什么证明它生效了

- 全量 `bun test` 串行双跑，基线是 `3b330b2b`：legacy 15393 pass / 1 fail，next 15392 pass / 2 fail。`changelog-curated` 两边都红，原因是分支缺 v0.1.607 的 curated 文件，与 T7.2a / T6.1b 记录的原因相同。K1 `ShortcutsHelp` 只在 next 上红，T5.2c 起就已记录。没有新增失败。
- render-port 全目录 legacy、next 都是 431 pass / 8 skip / 0 fail。8 条 skip 是 `selection-runtime` 里只在子进程跑的点击用例，外层另有一条断言检查子进程 8 pass / 0 fail。junit 报告里 S7 / S9 / S13 都真实执行并通过。
- `tsc` 87 个错误，与 T6.2b worktree 逐条 diff 为空。新 worktree 在 `make build` 之前是 88 个，多出的那条是不入库的 `vendor/model-catalog-snapshot.json` 还没生成，属于环境产物。
- `make build` 通过，没有 `will always be undefined`。`lint`、`lint:boundary`、`format:check`、`tui:spec` 都通过。
