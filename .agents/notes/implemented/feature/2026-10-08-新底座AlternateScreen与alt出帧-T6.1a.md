---
Status: implemented
Date: 2026-10-08
---
# 新底座 AlternateScreen 组件与 alt-screen 出帧（B9 / T6.1a）

## 决定了什么

规则全部来自对 legacy 的黑盒探针，没读旧底座代码（D-5）。探针用例和 legacy 结果备份在 `~/Backups/sid-code-t67-probe-results-20261008/T6.1a/`。

- **组件（M1）**：`packages/tui/src/components/AlternateScreen.tsx`。insertion effect 里直写 `?1049h 2J H`，`mouseTracking`（默认真）再写鼠标全套 `?1000/1002/1003/1006/1007h`。卸载时逆序关鼠标（开过才关），再写 `?1049l`。这些字节不走帧输出，非 TTY 也照写。子树包进一个纵向 Box，高等于视口行数。嵌套和并列的组件各写各的进出字节，不做计数，`setAltScreenActive` 以最后一次调用为准。`mouseTracking` 改变等于退出再进入。`SID_CODE_DISABLE_MOUSE_CLICKS` 不改变底座写出的字节。
- **alt 出帧（新契约 R14）**：`src/frame/alt-screen.ts`，纯函数，用绝对定位。每帧从 `ESC[H` 出发，只写变化的单元，写完停在 `ESC[{rows};1H`。只画视口里的行，没有变化就一个字节都不写。视口任一维变化时先写 `2J`，整帧重画。进入 alt 或收到 SIGCONT 后，对空白屏整帧画。`onFrame` 的 flickers 恒为空。
- **同步输出（R14）**：`src/terminal/sync-output.ts`。alt 帧只在终端支持 DEC 2026 时才包 `?2026h/l`，主屏照旧一律包。规则用 `env -i` 单变量探针逐个测出：`TMUX` 非空时一律不包；`TERM_PROGRAM` 按精确名单；`KITTY_WINDOW_ID` / `WT_SESSION` / `ZED_TERM` 非空时包；`VTE_VERSION` 取 parseInt，≥6800 时包；`TERM` 含 kitty / alacritty、以 foot 开头或等于 xterm-ghostty 时包。
- **alt 下 resize**：当场重开鼠标跟踪，出帧仍走 resize 调度。
- 序列常量收进 `src/terminal/modes.ts`，`ink.tsx` 的 SIGCONT / 静默自愈和组件共用这一份。

## 有意的不同

- legacy 的组件只通知 `process.stdout` 上的实例。渲染到其他流时，alt 状态没人知道，出帧仍走主屏 diff。探针里 PassThrough 和真实 stdout 两条路径的字节不一样，就是这个原因。next 改为通知**同一 stdout** 上的实例。CLI 只用 `process.stdout`，生产上看不出差别。也因为这一点，契约测试必须在子进程里渲染到 `process.stdout`（见 `fixtures/alt-screen-app.tsx`），不能用 `tty-streams.ts` 的 PassThrough。

## 放弃了什么

- **卸载段对齐**：卸载时恢复终端模式、清 OSC 9;4 / 21337 属于 X 组（T7.1b）和 O 组（T7.2），所以契约测试只比到 `unmount` 标记之前。
- **S9 alt 半边（forceRedraw 在 alt 下）**、`enter/exitAlternateScreen`：归 T6.1b。
- **S10（alt 下 stderr 护栏）**：归 T7.1a。

## 拿什么证明它生效了

- `packages/cli/tests/render-port/alt-screen.test.tsx` 17 条（M1 ×8、R14 ×9）。每条先断言 legacy 等于写死的字节，再断言 next 与 legacy 逐段一致，两套底座都绿。`packages/tui/tests/sync-output.test.ts` 61 条。
- 变异自证 10 处全红：关鼠标顺序、`mouseTracking` 默认值、视口高度约束、视口裁剪、视口变化擦屏、同步包裹按能力判定、resize 重开鼠标、SIGCONT 作废前帧、tmux 优先级、alt 出帧分支。改完都按 sha1 核对还原。
- rebase 到 `d7c63246`（含 T5.2b / T7.2b）后，next 上 render-port + tui 的结果是 981 pass / 10 fail。父提交上是 963 / 28，减少的 18 条就是本任务的 17 条契约加 S7。没有新增失败。剩下的 10 条：M5 ×2（T6.2b）、O5（T7.2c）、X7（缺 `enter/exitAlternateScreen` 等，T6.1b / T6.2 / T7.1）、S8（T6.1b / T5.3c）、S9（T6.1b）、S10（T7.1a）、S11（T5.3a）、S12（T7.1b）、S13（T6.2c）。legacy 991/991。
- **S7 在 next 上与基线完全一致**。卸载段的 OSC 由 T7.2b 补齐。
- 坑：oxfmt 会把 JSX 文本里的连续空格压成一个（`<Text>x  y</Text>` → `x y`），用例因此悄悄失去意义。fixture 里需要连续空格的地方一律写成 `{"x  y"}`。
