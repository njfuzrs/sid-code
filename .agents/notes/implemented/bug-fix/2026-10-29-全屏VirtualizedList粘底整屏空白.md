---
Status: implemented
Date: 2026-10-29
---
# 全屏 VirtualizedList 滚动位置一律用内容盒负 marginTop 表达，修粘底整屏空白

## 决定了什么

`packages/cli/src/ui/components/VirtualizedList.tsx`：

1. 外层容器 `overflowY` 一律 `"hidden"`，内容盒 `marginTop = -max(0, actualScrollTop)`，普通模式与 Copy Mode 走同一条路径。
   旧实现只有 Copy Mode 设负 marginTop，普通模式 `overflowY="scroll"` 且 marginTop 恒 0；而渲染底座
   `renderScrollContent`（`packages/tui/src/render-node-to-output.ts`）按「滚动位置为 0」剔除、不看内容盒偏移，
   视口永远停在 top spacer 上：虚拟化窗口滑到末尾后 spacer 比视口高 → 粘底整屏空白（全屏「内容整个消失」）；
   条数中等时停在开头不跟随。
2. 下限钳 0：内容不满一屏时 `SCROLL_TO_ITEM_END` 算出负 scrollTop，不钳会把内容往下推。
3. 顺手修同一渲染路径上的假值跳过：`if (item)` → `item !== undefined`。泛型 `T` 为数字时 0 号项被静默不画
   （排查时 3 条数据只画出 `item-1/2`，Copy Mode 同样如此）。

term-bench `baseline/C3.json` 有意更新：旧冻结基线记录的正是这个缺陷（滚动前后网格不变、粘底停在「项 1」、漏「项 0」）。

## 放弃了什么（以及为什么不选）

- **改渲染底座 `renderScrollContent` 让它看内容盒偏移**：它是对拍冻结的 L3 契约（`contracts-layout-text.test.tsx`
  与 `alt-screen.test.tsx` R14 锁着），改它影响所有 `overflowY="scroll"` 用户；而 CLI 侧唯一使用者 VirtualizedList
  已有 Copy Mode 证明正确的表达方式，改 CLI 波及面最小。
- **保留 `overflowY="scroll"` 只补 marginTop**：scroll 分支的剔除按「位置 0」算，负 marginTop 后窗口里的项 top 为负/超视口
  会被剔掉，仍然画不出来；hidden 只裁剪，视口外剔除由组件自己的窗口化承担，性能不变。

本 PR 只修排查文档 §1（P0-1）；文档 §2 起「待补」的闪烁、溢出到 footer 下方未在本次范围内。

## 拿什么证明它生效了

- 新增 `packages/cli/tests/ui/components/virtualized-list-stick-bottom.test.tsx`（复刻文档探针，12 行视口 + FOOTER）：
  3 条从 `item-0` 起画；40 / 200 条末行为 `item-39` / `item-199`、不含 `item-0`、满 11 行；普通模式 = Copy Mode。4 pass。
- 变异自证：把 `overflowY` / `marginTop` 改回 `copyMode ? … : scroll/0`，40 条、200 条、两模式一致三条变红（1 pass 3 fail），恢复后 4 pass。
- `bun run affected-tests:run`：2704 测试，修基线前唯一失败为 C3（diff 显示粘底从「项 1…5」变为「项 35…39」等，正是预期变化）；
  更新基线后 `component.test.ts` 连跑 3 次 0 fail。
