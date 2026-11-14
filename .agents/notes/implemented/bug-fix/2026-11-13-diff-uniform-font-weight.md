---
Status: implemented
Date: 2026-11-13
---
# diff 区域取消全部 bold，字重全区域统一

## 决定了什么

`edit`/`write` 工具结果里的 diff 区域**任何一段都不再加粗**（`SGR 1` 全部去掉），
并新增回归用例锁住「整帧不含 `\x1b[1m`」。

改动点（两条渲染管线各两处）：

- `packages/cli/src/ui/components/DiffRenderer.tsx`
  - `renderWordDiff()` 的词级变化段：去掉 `bold`，只保留 `color` + emphasis `backgroundColor`
  - add/del 行首 `+`/`-` 前缀符号：去掉 `bold`，只保留状态色
- `packages/cli/src/ui/components/diffAnsiLines.ts`（RawAnsi 快路径，>80 行长 diff）
  - 词级强调段：`applyTextStyles(colored, { bold: true })` → 直接输出带 emphasis 底色的串
  - 前缀符号：同上
- `packages/cli/src/ui/CLAUDE.md` L3.5 增一条规范：字重全区域统一，任何一段都不加粗
- 测试：`tests/ui/diff-ansi-lines.test.ts` 原「强调段加粗」断言反转为「无 bold」；
  新增 `tests/ui/components/diff-uniform-weight.test.tsx` 三条整帧用例（React 路径）

诱发原因（实测，不是推测）：旧实现对「词级变化词」加 bold。

1. `diffWordsWithSpace` 对 CJK 没有词边界，退化成**按字切分** —— 一行中文里会散落
   个别加粗单字（如 `const 定义 = ⟨B:一⟩个中文标识符`）。
2. 中文字体普遍没有真 bold，终端用合成粗体顶替：笔画加宽、字形变糊，观感像「字号变了」。
3. 配对行走 `renderWordDiff`（bold，绕过语法高亮）、未配对行走 `colorizeLine`（语法高亮，
   无 bold）。连续 del 块与 add 块按行序一一配对，两行内容差异越大被判成「变化」的段越多
   —— del 是代码、add 是中文注释时几乎整行加粗，而紧邻的其它 add 行完全不加粗，
   同一块 diff 里粗细参差。

第 3 条是最刺眼的一条：它不是「某几个词粗一点」，而是**整行粗、隔壁行不粗**。

## 放弃了什么（以及为什么不选）

- **保留词级加粗、只对 CJK 段禁用**（否决）：拉丁文与中文混排时字重仍然不一致
  （`const 定义 = 两个…` 这种行会一半粗一半不粗），而且实现要判字符范围，比去掉更复杂。
- **整块取消词级 diff 强调**（否决）：会丢掉「哪几个词改了」这一信息。变化词仍有
  emphasis 底色 + 状态前景色，定位能力不必牺牲。
- **用下划线 / italic 替代 bold**（否决）：终端下划线在 CJK 上会压到笔画，italic
  在多数等宽字体里是合成斜体，同样有「字形变形」问题；且 diff 已有底色通道，
  再加一个字形通道只会更花。
- **保留行首 `+`/`-` 符号的加粗**（否决）：单字符影响小，但它是「全区域统一字重」的
  唯一例外；符号本身已有绿/红状态色 + 字形两个通道，不靠加粗也能辨。

代价（点破）：色盲友好的「双通道」从「加粗 + 符号」变成「状态色 + 符号 + emphasis 底色」。
变化词与未变化词之间仍有底色差异，符号通道未受影响，所以信息通道没有净损失。

## 拿什么证明它生效了

1. **改前实证定位**（探针脚本，用完即删）：用 `render()` + `FORCE_COLOR=3` 渲染与
   用户截图同结构的 diff，逐字符标注 `SGR 1` 状态，确认旧实现下
   `359 -`/`359 +` 两行正文几乎整行处于 bold，而 `360 +`~`365 +` 只有符号 bold。
2. **变异自证**（两次，均先注入再恢复）：
   - 给 `diffAnsiLines.ts` 词级强调加回 `bold` → `diff-ansi-lines.test.ts` 的
     「强调段只用底色，全区域无 bold 转义」变红（7 pass / 1 fail）。
   - 给 `DiffRenderer.tsx` 前缀符号加回 `bold` → `diff-uniform-weight.test.tsx`
     两条整帧断言变红（1 pass / 2 fail）。
   - 恢复后重跑两文件：**11 pass / 0 fail**。
3. 门禁：`bun run format`、`bun run lint`、`bun run affected-tests:run`、`make build`
   （结果见 PR 正文）。
