# 渲染底座行为契约（B9 / T0.3）

新底座要「表现成什么样」的唯一规格。来源列指向旧底座位置，**只供写契约的任务使用**；
实现任务只读本文件、测试、上游 ink 和公开规范，不打开 `.vendor-src/`（设计文档 D-5）。

`bun run tui:spec` 校验本文件（`scripts/verify-tui-spec.ts`）。表格格式是机器可读的，改格式先改脚本。

## 格式

每条契约一行：`| ID | 行为 | 来源 | 测试 |`

- **ID**：分组字母 + 序号（`R1`、`I1b`），全文唯一。分组是闭集：R 渲染管线 / L 布局 / T 文本 / I 输入 / M 鼠标与选区 / O 终端集成 / E 错误护栏 / X 生命周期 / P 性能。
- **来源**：旧底座或 CLI 的 `文件:行`（路径相对 `packages/tui-renderer/src`，CLI 文件写全路径）。说不出来源的契约不许写。
- **测试**，三种之一：
  - `` `测试文件` 片段 `` —— 已有测试。脚本检查文件存在且包含该片段。新写的端口测试统一用 `"<ID>: "` 作测试名前缀，片段就写 `ID:`。
  - 差分测试台场景：`` `packages/cli/tests/render-port/term-bench/scenarios.tsx` S3: { ``。场景的 `covers` 与这一列必须双向一致（`term-bench/bench.test.ts` 校验）。
  - `⏳ T<x.y>` —— 无头终端测不了、要等后续任务的（如 CPU / RSS 要真实 PTY，见设计文档 §3 L4）。

测试名带 ID 前缀的端口测试（`packages/cli/tests/render-port/`），其 ID 必须在本文件里存在，脚本反向检查。

---

## R 渲染管线

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| R1 | TTY 下每帧包在 DEC 2026 同步输出里（`ESC[?2026h … ESC[?2026l`），开始与结束成对。**主屏总是包**；只有 alt-screen 且终端不支持同步输出（如 tmux）时才省掉 | `terminal.ts:219-231`、`ink.tsx:938` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S1: { |
| R2 | 帧调度：16ms 节流 + microtask 合并同一 tick 内的多次提交 | `constants.ts:2`、`ink.tsx:301` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` R2: |
| R3 | cell 级 diff：未变化的行零写入；样式切换走 style pool 最小化 SGR | `screen.ts:103`、`log-update.ts` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S1: { |
| R4 | 主屏纯增长帧走增量追加，旧行自然进 scrollback，不 full reset | `log-update.ts` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S1: { |
| R5 | 变化落在已进 scrollback 的行上 → full reset（原因 `offscreen`） | `frame.ts:98`、`log-update.ts:137` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S3: { |
| R6 | 动态区从超出视口收缩回来 → full reset 恰好一次 | `frame.ts:102` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S2: { |
| R7 | 视口变矮或变宽窄 → full reset（原因 `resize`）并重排；连续多次 resize 合并；**不发 `?1049h`**（iTerm2 会当清屏） | `log-update.ts:133-137`、`ink.tsx:229` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S6: { |
| R8 | `forceRedraw`：主屏重绘并标记前帧作废；alt-screen 重置帧缓存 | `ink.tsx:1038` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S9: { |
| R9 | 宽字符宽度补偿：终端对某些宽字符算宽不一致时补光标位置 | `log-update.ts:583`、`log-update.ts:648` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S4: { |
| R10 | SIGCONT 恢复：alt-screen 下内容视为过期，整屏重绘并重新打开鼠标跟踪 | `ink.tsx:218` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` R10: |
| R11 | **已完成区（现名 `Static`）的项可以原地重渲**：items 引用不变时 memo 跳过；项内容变了照常 reconcile。不是上游 ink 的 print-once `<Static>`（D-3 定案 A） | `_vendor/Static.tsx:21-30`、CLI `packages/cli/src/ui/components/MainScreenLayout.tsx:49-50` | `packages/cli/tests/render-port/static-reconcile.test.tsx` R11: |
| R12 | 非 TTY 输出（`stdout.isTTY` 为假）每帧写整帧，不做增量 diff | `ink.tsx:288` | `packages/cli/tests/render-port/static-reconcile.test.tsx` R12: |
| R13 | 测试环境默认**每次提交同步出帧**（不节流），`lastFrame()` 在 rerender 之后立即可读；只有测帧调度的用例经端口 `enableFrameThrottle()` 打开真实调度（R2） | `reconciler.ts:292`、`ink.tsx:329` | `packages/cli/tests/render-port/render-instance.test.tsx` R13: |

## L 布局

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| L1 | Flexbox 语义与 yoga 一致，覆盖 `SURFACE.md` §2 列出的全部 props | `styles.ts`、`layout/` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` L1: |
| L2 | 布局缓存命中后子节点仍按新宽度重新定位（flex-end / center 反复 resize 不漂移） | `layout/`（纯 TS yoga 移植） | `packages/tui-renderer/tests/ink/yoga-layout-cache-positions.test.ts` yoga 多槽布局缓存不得跳过子节点定位 |
| L3 | `overflow: hidden` 裁剪子内容；`overflowY: scroll` 只裁剪，不提供 scrollTop —— CLI 靠上下 spacer 与负 `marginTop` 表达滚动位置 | `render-node-to-output.ts:626-628`、CLI `packages/cli/src/ui/components/VirtualizedList.tsx:8-19` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S7: { |
| L4 | `ResizeObserver` 轮询式触发：首帧回调拿到的高度可能为 0，之后尺寸变化才回调；`measureElement` 返回最近一次布局的宽高 | `_vendor/resize-observer.ts:39`、`_vendor/resize-observer.ts:91`、`measure-element.ts:18` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` L4: |
| L5 | 交互判定只看 `stdout.isTTY`，不看 `CI` 环境变量（上游 ink 7 会看 `is-in-ci`，新底座必须关掉或在此写明行为变化） | `ink.tsx:288` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` L5: |

## T 文本

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| T1 | `stringWidth`：CJK 宽 2、emoji 与 ZWJ 序列按一个宽字符、变体选择符与组合字符宽 0、先去 ANSI | `stringWidth.ts:218` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` T1: |
| T2 | `wrap` / `truncate` / `truncate-end` / `truncate-middle` 的精确输出（省略号位置、CJK 不劈半） | `styles.ts:52`、`wrap-text.ts:56` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` T2: |
| T3 | RTL 混排按 bidi 重排后输出（只在需要的终端上做） | `bidi.ts:33`、`output.ts:627` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S4: { |
| T4 | 宽字符被布局挤到只剩 1 列时，不留下孤立的 spacer 单元 | `screen.ts:267`、`screen.ts:303` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S4: { |
| T5 | `Ansi` 解析 ANSI 文本为带样式的文本节点；`RawAnsi` 接收已按列宽换行的终端就绪行，单个叶子节点直写，不二次解析 | `Ansi.tsx:32`、`components/RawAnsi.tsx:28` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` T5: |
| T6 | styled-chars 五个函数（`toStyledCharacters` / `styledCharsWidth` / `wrapStyledChars` / `wordBreakStyledChars` / `widestLineFromStyledChars`）的输入输出 | `_vendor/styled-chars.ts:69` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S5: { |

## I 输入

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| I1 | stdin 有两个读者：底座在 raw mode 打开时挂 `readable` 并循环 `read()`（驱动 `useInput`），CLI 的 KeypressContext 挂 `data`。**每块字节两边都收到，`data` 先于 `readable`**；挂着 `readable` 时流是 paused（`readableFlowing=false`）；直接 `emit('data')` 只到 `data` 读者；底座卸载后剩下的 `data` 读者继续收字节 | `components/App.tsx:280`、CLI `packages/cli/src/ui/contexts/KeypressContext.tsx:701` | `packages/cli/tests/render-port/stdin-dual-reader.test.tsx` I1: |
| I1b | `readable` 回调里抛错后，若监听被摘掉则重新挂上（Bun 下回调抛错可能永久卡住流） | `components/App.tsx:407-427` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I1b: |
| I1c | stdin 静默超过 5s 后的第一次输入，先重新声明终端模式（外部程序可能改过） | `components/App.tsx:68`、`components/App.tsx:396`、`ink.tsx:1109` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I1c: |
| I2 | 启动时发终端探查（XTVERSION、DA1）；`setSuppressTerminalProbe(true)` 时不探查（会话选择器这类短命实例） | `terminal-querier.ts:103`、`terminal.ts:158` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S11: { |
| I3 | 探查回复分片到达时，带 DCS / OSC / CSI-private / CSI-secondary / 单独 ST 前缀的残片当 `responseFragment` 丢弃，不当按键 | `parse-keypress.ts:117`、`parse-keypress.ts:134` | `packages/tui-renderer/tests/ink/terminal-response-fragment.test.ts` 端末応答フラグメントの漏洩根絶 |
| I4 | 终端模式的开关归属见下方「I4 模式归属表」：每个模式谁开、谁关、关的时机 | 见表 | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S8: { |
| I5 | `drainStdin`：fd 保持 blocking，循环 `read()` 直到返回 null，丢弃读到的字节 | `ink.tsx:1947` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I5: |
| I6 | `exitOnCtrlC: false` 时底座不处理 Ctrl+C，交给 `useInput` 回调 | `root.ts:31`、`hooks/use-input.ts` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I6: |

### I4 模式归属表

同一组终端私有模式，旧底座和 CLI 各写一遍（设计文档 §1.5）。现在能工作是因为重复写入恰好无害。
新底座不能少写、多写或改顺序，除非在这里改表并给出理由。

| 模式 | 底座：开 | 底座：关 | CLI：开 | CLI：关 |
| --- | --- | --- | --- | --- |
| bracketed paste `?2004` | `components/App.tsx:282` raw mode 打开时 | `components/App.tsx:330` 最后一个 raw mode 使用者释放时；`ink.tsx:1752` 卸载时再关一次 | `packages/cli/src/ui/utils/terminalCapabilityManager.ts:261` | 同文件 `:50`（退出清理） |
| focus reporting `?1004` | `components/App.tsx:284` | `components/App.tsx:328`；`ink.tsx:1750` 再关一次 | — | — |
| kitty 键盘 / modifyOtherKeys | `components/App.tsx:285-292`（`supportsExtendedKeys()` 为真时） | `components/App.tsx:325-326`；`ink.tsx:1747-1748` 再关一次 | `terminalCapabilityManager.ts:254` / `:258` | 同文件 `:48` / `:49` |
| 鼠标跟踪 `?1000/1002/1006` | `components/AlternateScreen.tsx:52`（进 alt-screen）；`ink.tsx:440` / `:1127` / `:1184`（resize、SIGCONT、自愈时重开） | `ink.tsx:1743` 卸载时无条件关 | `packages/cli/src/ui/contexts/MouseContext.tsx:45`（Copy Mode 切换） | 同文件 `:50` |
| 自动换行 `?7` | — | — | `packages/cli/src/ui/fullscreen.ts:19`（关） | 同文件 `:24`（恢复） |
| 光标显示 `?25` | — | `ink.tsx:1754` 卸载时显示 | — | — |

## M 鼠标与选区（alt-screen）

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| M1 | 鼠标跟踪随 alt-screen 进出开关；`SID_CODE_DISABLE_MOUSE_CLICKS` 为真时不响应点击 | `components/AlternateScreen.tsx:52`、`ink.tsx:1743`、`_vendor/fullscreen.ts:7` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S7: { |
| M2 | 拖选、双击选词、三击选行；内容滚动时选区跟着移动 | `selection.ts:738` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S13: { |
| M3 | 复制走 OSC52（`setClipboard`）；tmux / screen 下用 `wrapForMultiplexer` 包裹 | `termio/osc.ts:135`、`termio/osc.ts:35` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S13: { |
| M4 | 超链接单元可命中并打开 | `squash-text-nodes.ts:21` | ⏳ T6.2 |
| M5 | 选区高亮背景色可设置 | `ink.tsx:1361`、`screen.ts:222` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` M5: |

## O 终端集成

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| O1 | 标题先发 OSC 2 再发 OSC 0，内容去 ANSI；Windows 改写 `process.title` | `hooks/use-terminal-title.ts:22-37` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S14: { |
| O2 | tab 状态点（`useTabStatus`）；`SID_DISABLE_TAB_STATUS` 关闭；卸载时清除 | `termio/osc.ts:448-455`、`ink.tsx:1758` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S14: { |
| O3 | OSC 9;4 进度条；卸载时清除 | `useTerminalNotification.ts:18`、`ink.tsx:1756` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S14: { |
| O4 | OSC 8 超链接只在 `supportsHyperlinks()` 为真时输出 | `supports-hyperlinks.ts:26` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` O4: |
| O5 | 终端识别读取的环境变量全集见 `SURFACE.md` §3。`CLAUDE_CODE_*` 调试变量在新底座改名或删除（D125）；`CLAUDE_CODE_ACCESSIBILITY` 控制无障碍模式下隐藏光标，改名时保留功能 | `SURFACE.md` §3、`components/App.tsx:230`、`components/App.tsx:488` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` O5: |
| O6 | termio 端口面（`OSC` 表、`osc`、`wrapForMultiplexer`、`setClipboard`、`supportsHyperlinks`）在两套底座上逐字节一致：OSC 终止符 kitty 用 ST、其余 BEL，加载时判定；`TMUX` 优先于 `STY` 包裹 DCS；剪贴板跳过 SSH、linux 依次试 wl-copy / xclip / xsel 并记住结果、tmux 等 `load-buffer`（2s，`LC_TERMINAL=iTerm2` 不带 `-w`）成功才包裹且里层固定 BEL | `termio/osc.ts:18`、`termio/osc.ts:35`、`termio/osc.ts:135`、`supports-hyperlinks.ts:26` | `packages/cli/tests/render-port/contracts-termio.test.ts` O6: |

## E 错误与输出护栏

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| E1 | `patchStderr` 与 `patchConsole` 解耦，前者无条件生效：吞掉裸 `process.stderr.write` → 进 debug 日志 → alt-screen 下强制全量重绘 | `ink.tsx:251-262` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S10: { |
| E2 | 拦截路径有重入守卫：`logForDebugging → 写 stderr → 拦截` 不得无限递归 | `ink.tsx:1893` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S10: { |
| E3 | stdout EIO / EPIPE 不抛 uncaughtException（底座不处理，靠 CLI 在 render 之前注册的处理器） | CLI `packages/cli/src/ui/fullscreen.ts:55-57` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` E3: |

## X 生命周期

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| X1 | `render` 是 async，返回 `{ rerender, unmount, waitUntilExit, cleanup }`；`renderSync` 同步返回同样的对象 | `root.ts:46-120` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S12: { |
| X2 | 经端口 `render` 拿到的 `unmount` **不透传参数**：`unmount(error)` 与 `unmount()` 一样，`waitUntilExit` 都 resolve（T0.4 S12 实测）。底座内部 `Ink.unmount(error)` 才会 reject，CLI 没有用到 | `root.ts:96-98`、`ink.tsx:1780-1784` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S12: { |
| X3 | TTY 卸载时同步写 fd 1（**进程被信号结束、React 卸载来不及跑时的兜底**；正常卸载时 raw mode 释放已经先关过一遍键盘 / focus / bracketed paste，见 I4 表，所以这几项是重复写入），顺序固定：先退 alt-screen（若在其中）→ 关鼠标跟踪（无条件）→ drain stdin → 关 modifyOtherKeys 与 kitty 键盘 → 关 focus reporting → 关 bracketed paste → 显示光标 → 清 iTerm2 进度 → 清 tab 状态 | `ink.tsx:1734-1758` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S12: { |
| X4 | `detachForShutdown`：标记已卸载、取消待发的节流渲染、drain stdin、退出 raw mode；不经 React 卸载，不写任何终端序列 | `ink.tsx:1147-1165` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` X4: |
| X5 | `enterAlternateScreen` / `exitAlternateScreen`（外部编辑器前后）：退出后终端模式与进入前一致 | `ink.tsx:509`、`ink.tsx:546` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S8: { |
| X6 | 实例按 stdout 注册（`instances`），卸载时移除；同一 stdout 上前一个实例卸载后新实例能接手 | `root.ts:100`、`root.ts:147` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S11: { |
| X7 | 端口 `getRenderInstance(stdout)` 返回的实例提供 `RENDER_INSTANCE_METHODS` 列出的全部方法（`RenderInstance` 类型）；CLI 与测试拿实例只走这一个入口 | CLI `packages/cli/src/ui/render-port/runtime.ts` | `packages/cli/tests/render-port/render-instance.test.tsx` X7: |

## P 性能

阈值是初始提案，T0.4 在旧底座上实测基线后再定。

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| P1 | idle 时 0% CPU：没有空转定时器。已知例外：`ResizeObserver` 有观察目标时轮询 | `_vendor/resize-observer.ts:42`、`_vendor/resize-observer.ts:91` | ⏳ T8.1 |
| P2 | 流式期间帧耗时 p95、每 token 写入字节数不高于旧底座 1.1 倍 | — （差分测试台基线） | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S1: { |
| P3 | 历史 ≥ 500 项时帧耗时不随历史线性增长（旧底座靠节点布局缓存 blit 做到 O(dirty)）。新底座口径：只改底部一行时，每帧真正遍历的节点数与历史长度无关；缓存命中的输出与冷渲染逐字节一致 | `dom.ts:6`、`dom.ts:219` | `packages/tui/tests/render-cache.test.tsx` P3: |
| P5 | `useAnimationFrame` 离屏暂停：帧高 p > 视口 H 时，动画盒底边落在帧的最后 H - 1 行之外（`y + h - 1 < p - H + 1`）就停止订阅时钟；判定只在组件重渲时做、读上一次提交的布局，所以回到视口后要再来一次父级重渲才恢复，`React.memo` 包住的则一直停着 | `hooks/use-animation-frame.ts:34`、`hooks/use-terminal-viewport.ts` | `packages/cli/tests/render-port/contracts-animation.test.tsx` P5: |
| P4 | 长会话 RSS 不高于旧底座 1.2 倍 | — （差分测试台基线） | ⏳ T8.1 |
