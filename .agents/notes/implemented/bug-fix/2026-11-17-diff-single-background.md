---
Status: implemented
Date: 2026-11-17
---
# diff 区域去掉词级强调，改成整行单一底色 + 单一状态前景色

## 决定了什么

同一块 diff 里，**一行只有一种底色、一种文字色**。

- `packages/cli/src/ui/components/DiffRenderer.tsx`（React 路径）：删除 `renderWordDiff` 与
  `computeWordDiffPairs`，add/del 行改为整行 `color={status.success|error}`——与行首 `+`/`-`
  同色，不再有「公共词正文色 + 变化词状态色」的混排。
- `packages/cli/src/ui/components/diffAnsiLines.ts`（RawAnsi 快路径）：`renderContentSegment`
  去掉 `diffWordsWithSpace` 分词的强调分支，整段 `applyColor(内容, 状态色)`；
  `BuildDiffAnsiLinesOptions` 删除 `pairMap`。
- 主题层删除 `background.diff.addedEmphasis` / `removedEmphasis`：`themes/semantic-tokens.ts`
  的类型与全部 6 套主题色值、`themes/theme.ts` 的 `interpolateColor(...)` 派生。
- 规范 `packages/cli/src/ui/CLAUDE.md` L3.5 同步改写，代码与规范保持一致。

## 放弃了什么（以及为什么不选）

**放弃了「词级差异提示」这个信息通道。** 它原本用于指出"这一行的哪几个词变了"。

- 不选「换成别的强调通道保留词级提示」：候选是下划线（CJK 折行时下划线变形，PR #816 已否决）、
  加粗（2026-11-13 已否决，CJK 合成粗体导致字重参差）、dim 前景色（会让非变化词变淡，仍属
  "同一行文字深浅不一"，与本次诉求冲突）。
- 不选「只删 emphasis 底色、保留词级前景色差」：用户要的是「背景色和文字都统一」，只统一
  背景会把问题挪到前景上，同一行仍然是两种字色。
- 不选「配对行也走 `colorizeLine` 语法高亮」：长 diff 走 RawAnsi 快路径时没有语法高亮
  （`diffAnsiLines.ts` 是纯函数，不接 `CodeColorizer`），两条路径会长期不一致；而且用户明确
  要「文字统一」，语法高亮本身就是一行多色。

**代价说清楚**：diff 现在只靠「整行底色 + 行首 `+`/`-` + 整行状态色」区分增删，不再显示
具体哪几个词改了。这是用信息量换视觉统一，用户明确选择接受。

## 拿什么证明它生效了

1. **改前取证**（`FORCE_COLOR=3` 直接渲染 `buildDiffAnsiLines`，把 ANSI 拆成 `(文本, 前景, 背景)` 段）：

   ```
   第 1 行（add）
     bg=#215c33  " `mutations`：指向 `goal-gate.ts` …"
     bg=#357a4b  " ✅ 已断言 ⬜ **本条由 `S-goal-wait-achieved` 承担** …"
     --> 本行出现的背景色种类: #215c33 / #357a4b
   ```

   确认"两层背景色"是同一行内两块不同底色（行底色 + 词级 emphasis 底色），
   不是颜色混合（`packages/tui/src/render-background.ts` 无 alpha 混合，
   `CodeColorizer` 不给 token 加背景色）。

2. **测试锁回归**：
   - `packages/cli/tests/ui/diff-ansi-lines.test.ts`：断言 add/del 每行背景色转义**恰好 1 种**
     （用 `toBe(1)` 而不是上界，上界在"完全没有底色"时也会通过）；新增一条中文长行用例，
     复现用户报的 emoji/加粗碎片场景。
   - `packages/cli/tests/ui/components/diff-uniform-weight.test.tsx`：整帧渲染后逐行断言
     背景色种类 ≤ 1（上下文行允许 0 种），并把原先"变化词仍靠 emphasis 底色区分"的反向断言删掉。
   - 删除 `packages/cli/tests/ui/diff-word-pairs.test.ts`：被测函数 `computeWordDiffPairs` 已移除。

3. **验证命令**：`bun run affected-tests:run` + `make build`，结果见 PR 正文。
