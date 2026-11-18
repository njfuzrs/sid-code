---
Status: rejected
Date: 2026-11-18
Source: /context 面板取数不准与信息缺失 — 修复与验收方案（2026-11-17）R4
---
# 不让 footer 改用 `breakdown.total`（对齐方向只能是面板向 footer）

## 决定了什么

`/context` 面板的 `total` 改成与 footer 的 `getContextUsageForDisplay().used` 同一个表达式的返回值：
`sendTokensFrom(estimateTokens(toolCount))`。**面板向 footer 对齐**，不是反过来。

## 放弃了什么（以及为什么不选）

**放弃的方案**：让 footer 改读 `getTokenBreakdown().total`，这样只要改一处，
「同源」也成立，看起来更省事。

**否决理由三条，任何一条都足以否决**：

1. **方向上 footer 是事实源**。footer 的 `used` 与压缩决策 `getCompactionLevel` 早已同源，
   而压缩决策直接决定「什么时候开始摘要」，是整条上下文管理链的输入。让事实源去对齐一个
   展示层聚合结果，等于把「用户看到的数」提升为「系统据此决策的数」——一旦面板归类有偏差
   （本次缺陷正是面板漏算 thinking），压缩时机会跟着错。
2. **`getTokenBreakdown` 在热路径上是被禁止调用的**。它要遍历全部消息、构造分类数组、
   跑最大余数法分配，还要读 `tokenFreedTracker.getRecords()`。footer 每帧重渲都会调
   `getContextUsageForDisplay`，换成 `getTokenBreakdown` 会把每帧一次 O(消息数) 的分配
   变成每帧一次「分配 + 排序 + 数组构造」。
3. **对账方向反了会掩盖缺陷**。面板与 footer 不一致时，正确处置是查面板为什么漏算
   （本次就查出了 thinking 整类缺失）；如果让 footer 跟着面板算，漏算会被「两个数一致」
   掩盖，压缩时机静默偏移，且没有任何断言能发现。

## 拿什么证明它生效了

- `packages/core/tests/context/breakdown-same-source.test.ts` 第一条断言就是
  `expect(bd.total).toBe(usage.used)`，五个状态下都严格相等——同源由「都调同一个 helper」
  保证，而不是靠两处各自实现后碰巧相等。
- 该文件顶部注释写明了这个方向性判断（「footer 与决策同源，是事实源；面板应该向它对齐」），
  以及 `getTokenBreakdown` 不可进热路径的理由，避免后来者重新提议。
