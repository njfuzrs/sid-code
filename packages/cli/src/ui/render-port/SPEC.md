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
| R11 | **已完成区（端口名 `Static`，next 上是 `History`）的项可以原地重渲**：memo 浅比较 `items` / `children` / `style` 三个引用，都不变时跳过，任一变了整块重渲；项内容变了照常 reconcile。不是上游 ink 的 print-once `<Static>`（D-3 定案 A） | `_vendor/Static.tsx:21-30`、CLI `packages/cli/src/ui/components/MainScreenLayout.tsx:49-50` | `packages/cli/tests/render-port/static-reconcile.test.tsx` R11: |
| R12 | 非 TTY 输出（`stdout.isTTY` 为假）每帧写整帧，不做增量 diff | `ink.tsx:288` | `packages/cli/tests/render-port/static-reconcile.test.tsx` R12: |
| R13 | 测试环境默认**每次提交同步出帧**（不节流），`lastFrame()` 在 rerender 之后立即可读；只有测帧调度的用例经端口 `enableFrameThrottle()` 打开真实调度（R2） | `reconciler.ts:292`、`ink.tsx:329` | `packages/cli/tests/render-port/render-instance.test.tsx` R13: |
| R14 | alt-screen 出帧用绝对定位：每帧从 `ESC[H` 出发只写变化的单元，收尾 `ESC[{rows};1H`；只画视口内的行；没变化不写；视口任一维变了先 `ESC[2J` 整帧重画；进 alt / SIGCONT 后对空白整帧画；从不记 full reset。同步输出包裹按终端能力判定（tmux 内一律不包），主屏不受影响 | `ink.tsx:715`、`ink.tsx:938`、`terminal.ts:75` | `packages/cli/tests/render-port/alt-screen.test.tsx` R14: |

## L 布局

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| L1 | Flexbox 语义与 yoga 一致，覆盖 `SURFACE.md` §2 列出的全部 props | `styles.ts`、`layout/` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` L1: |
| L2 | 布局缓存命中后子节点仍按新宽度重新定位（flex-end / center 反复 resize 不漂移） | `layout/`（纯 TS yoga 移植） | `packages/tui-renderer/tests/ink/yoga-layout-cache-positions.test.ts` yoga 多槽布局缓存不得跳过子节点定位 |
| L3 | `overflow: hidden` 裁剪子内容；单轴取值优先于 `overflow`，`scroll` 在本轴上等同 `hidden`。纵向 `scroll` 只画第一个子节点（内容盒）的子项：按「在内容盒里的位置」与视口 `[0, 内框高)` 求交，有交集就整项画；内容盒自身的背景 / 边框 / 裁剪不画；不提供 scrollTop，剔除恒按滚动位置 0 —— CLI 靠上下 spacer 与负 `marginTop` 表达滚动位置（T4.3 黑盒对拍） | `render-node-to-output.ts:626-628`、CLI `packages/cli/src/ui/components/VirtualizedList.tsx:8-19` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` L3: |
| L4 | `ResizeObserver` 轮询式：`observe` 后微任务里单独报一次当前尺寸，之后每 16ms 只比宽高、同一轮的变化合成一次回调，节点移除报 0×0，定时器 unref；`measureElement` 返回最近一次布局的宽高（已移除节点 0×0）；`getBoundingBox` 是布局树绝对坐标（累加父链，含负 margin），空参数 / 已移除节点得 `null` | `_vendor/resize-observer.ts:39`、`_vendor/resize-observer.ts:91`、`measure-element.ts:18` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` L4: |
| L5 | 交互判定只看 `stdout.isTTY`，不看 `CI` 环境变量（上游 ink 7 会看 `is-in-ci`，新底座必须关掉或在此写明行为变化） | `ink.tsx:288` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` L5: |

## T 文本

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| T1 | `stringWidth`：CJK 宽 2、emoji 与 ZWJ 序列按一个宽字符、变体选择符与组合字符宽 0、先去 ANSI | `stringWidth.ts:218` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` T1: |
| T2 | `wrap` / `truncate` / `truncate-end` / `truncate-middle` 的精确输出（省略号位置、CJK 不劈半） | `styles.ts:52`、`wrap-text.ts:56` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` T2: |
| T3 | RTL 混排按 bidi 重排后输出（只在需要的终端上做） | `bidi.ts:33`、`output.ts:627` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S4: { |
| T4 | 宽字符被布局挤到只剩 1 列时，不留下孤立的 spacer 单元 | `screen.ts:267`、`screen.ts:303` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S4: { |
| T5 | `Ansi` 解析 ANSI 文本为带样式的文本节点（按 `<Text>` 的叠加顺序重编码，暗压粗体，OSC 8 只在终端支持时保留且不保留原 id）；`RawAnsi` 接收已按列宽换行的终端就绪行，单个固定尺寸叶子节点直写，不换行不截断。字节级对拍见 `packages/tui/tests/fixtures/screen-vectors.json` 的 `Ansi *` / `RawAnsi *` 条目（T4.1） | `Ansi.tsx:32`、`components/RawAnsi.tsx:28` | `packages/cli/tests/render-port/contracts-layout-text.test.tsx` T5: |
| T6 | styled-chars 五个函数（`toStyledCharacters` / `styledCharsWidth` / `wrapStyledChars` / `wordBreakStyledChars` / `widestLineFromStyledChars`）的输入输出 | `_vendor/styled-chars.ts:69` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S5: { |

## I 输入

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| I1 | stdin 有两个读者：底座在 raw mode 打开时挂 `readable` 并循环 `read()`（驱动 `useInput`），CLI 的 KeypressContext 挂 `data`。**每块字节两边都收到，`data` 先于 `readable`**；挂着 `readable` 时流是 paused（`readableFlowing=false`）；直接 `emit('data')` 只到 `data` 读者；底座卸载后剩下的 `data` 读者继续收字节 | `components/App.tsx:280`、CLI `packages/cli/src/ui/contexts/KeypressContext.tsx:701` | `packages/cli/tests/render-port/stdin-dual-reader.test.tsx` I1: |
| I1b | `readable` 回调里抛错后，若监听被摘掉则重新挂上（Bun 下回调抛错可能永久卡住流） | `components/App.tsx:407-427` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I1b: |
| I1c | stdin 静默超过 5s（严格大于，起点是挂载或上一块输入）后的第一块输入，先重新声明终端模式（外部程序可能改过）：只在 alt-screen 且开了鼠标跟踪时重写鼠标跟踪全套，不擦屏；扩展键开着时（主屏、alt 都）先整段重申 `<u >1u >4;2m`（I4）；非 TTY 不写（细节见 `stdin-shutdown.test.tsx`） | `components/App.tsx:68`、`components/App.tsx:396`、`ink.tsx:1109` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I1c: |
| I2 | 终端探查：raw mode 引用计数每次 0 → 1、以及 Ctrl+Z 恢复时计数仍 > 0，各排一次探查，用 `setImmediate` 推迟，两次独立 `write`：`ESC[>0q`（XTVERSION）、`ESC[c`（DA1），写在首帧之后。stdout 非 TTY 也发；raw mode 不可用不发；计数 1 → 2 不发；排了就发（发出前卸载 / `detachForShutdown` / 又关掉 raw mode 都不取消）。回复由 I3 丢弃，不等回复、不超时重发、结果不交给任何人。`setSuppressTerminalProbe` 是进程级开关，**在排队时判定**：已排上的照发，抑制期间排的解除后也不补发（会话选择器这类短命实例挂载前置真、卸载后置假）（细节见 `terminal-probe.test.tsx`） | `terminal-probe.ts`、`components/App.tsx`（next） | `packages/cli/tests/render-port/terminal-probe.test.tsx` I2: |
| I3 | 探查回复与回复残片不当按键：DCS（`ESC P`）/ OSC（`ESC ]`）吞到 BEL 或 `ESC \` 为止（中间的 ESC、换行、Ctrl+C 都算内容，C1 `0x9C` 不算终止符）整个丢弃；首个参数字节是 `?` / `>` 的完整 CSI 丢弃；单独的 ST 丢弃；以上几类没收齐就被冲刷时同样丢弃。不丢的：只到 `ESC` 一个字节就冲刷（成 Esc 键）、被 ESC / 控制符截断的私有 CSI、`CSI =`、APC（`ESC _`，同样的终止规则，但原样交出）、SOS / PM（按 meta 组合）。粘贴内容里的 DCS / OSC / APC 串先整体跳过再找结束标记 | `input-parser.ts`、`parse-keypress.ts`（next） | `packages/cli/tests/render-port/stdin-response-fragment.test.tsx` I3: |
| I4 | 终端模式的开关归属见下方「I4 模式归属表」：每个模式谁开、谁关、关的时机。底座侧（T5.3a 对拍）：raw mode 计数 0 → 1 时在 `ref` + `setRawMode(true)` 之后写 `?2004h`、`?1004h`，扩展键开着再写 `>1u`、`>4;2m`，每段一次独立写入；计数归零时先写 `>4m <u ?1004l ?2004l`（扩展键开没开都写）再关 raw mode；stdout 非 TTY 也写。扩展键只看环境变量、模块加载时判定一次（规则见 `terminal/extended-keys.ts`，不看探查回复）。TTY 卸载时无条件再关一次（一次写入，相对顺序归 X3）；外部编辑器前后归 T5.3c（细节见 `terminal-modes.test.tsx`） | 见表 | `packages/cli/tests/render-port/terminal-modes.test.tsx` I4: |
| I5 | `drainStdin`：非 TTY 不动；循环 `read()` 直到返回 null，丢弃读到的字节；原本不在 raw mode 的再 `setRawMode(true/false)` 走一遍，原本在的不碰；不经 fd 直读、任何一步抛错都吞掉（细节见 `stdin-shutdown.test.tsx`） | `ink.tsx:1947` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I5: |
| I6 | `exitOnCtrlC: false` 时底座不处理 Ctrl+C，交给 `useInput` 回调 | `root.ts:31`、`hooks/use-input.ts` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` I6: |
| I7 | Ctrl+Z 挂起与恢复：解码后 `ctrl && input === 'z'` 的按键（`\x1a`、kitty / modifyOtherKeys 的 Ctrl+Z，叠加 shift / meta / super 也算；release / repeat、文本块、粘贴里的 `\x1a` 不算）不交给任何监听者，同块其余事件照常。挂起：写 `ESC[>4m ESC[<u ESC[?1004l ESC[?2004l`（stdout 非 TTY 也写），关 raw mode、`unref`、摘 `readable`，TTY 再写显示光标与关鼠标跟踪全套，挂一次性 SIGCONT 监听后 `kill(pid, 'SIGSTOP')`。恢复：alt-screen 先重进 alt 擦屏（开过鼠标跟踪的重开），`ref` + 开 raw mode + 挂 `readable`（挂起期间的缓冲字节此时交出），再同步写 `ESC[?2004h ESC[?1004h`（扩展键开着再加 `>1u >4;2m`；挂起期间计数降到 0 的不写，I4），TTY 再补 `ESC[?25l ESC[?1004h`。挂起期间卸载不碰 stdin（细节见 `stdin-suspend.test.tsx`；恢复时重发探查属 I2） | `components/App.tsx`、`ink.tsx` | `packages/cli/tests/render-port/stdin-suspend.test.tsx` I7: |
| I8 | 键位解析：同一串 stdin 字节（C0 / meta / CSI 修饰位 / `~` 键 / SS3 / rxvt / kitty CSI u / modifyOtherKeys / SGR 与 X10 鼠标 / focus / bracketed paste / 多事件同块 / 跨块与 ESC 冲刷），`useInput` 收到的 `(input, key)` 序列与旧底座逐条一致，key 的字段集合也算在内。语料 `packages/tui/tests/fixtures/input-corpus.ts`，向量 `input-vectors.json` 由 `bun run tui:input-vectors` 从旧底座生成。运行期两条也算：`useInput` 回调抛错只打 `[ink:error]`、不退出、监听保留；单独的 ESC 在 40ms 与 60ms 之间冲刷成 Esc 键（`contracts-runtime.test.tsx` 的 I8 组） | `parse-keypress.ts`、`hooks/use-input.ts` | `packages/tui/tests/input.test.ts` I8: |
| I9 | raw mode 引用计数：多个 `useInput` 与手动 `setRawMode` 共用一份计数，0→1 时同步 `ref()` + `setRawMode(true)` + 挂 `readable`，1→0 时同步 `setRawMode(false)` + `unref()` + 摘 `readable`（不经微任务）；多余的 `false` 把计数压成负数，要补回同样多次 `true` 才打开；同一提交换一个 `useInput` 组件 = 一次关→开，切换前缓冲的半截转义冲刷给新组件；卸载时同步关；stdin 非 TTY 时 `isRawModeSupported=false`、`setRawMode` 抛 `Raw mode is not supported on the stdin provided to Ink`；`useApp().exit(err)` 让 `waitUntilExit` reject | `components/App.tsx`、`hooks/use-input.ts` | `packages/cli/tests/render-port/stdin-ownership.test.tsx` I9: |
| I10 | `isActive` 切换：停用即按 I9 关 raw mode、摘 `readable`。raw mode 在 layout effect 里开、handler 在 passive effect 里挂，所以停用期间留在流里的字节在重新启用时由 `readable` 交出、但 handler 还没挂上 —— **这些字节被丢弃**；首次挂载前已缓冲的字节照常送达。同一块里某个回调抛错，这块剩下的事件与排在后面的监听者都收不到（只打 `[ink:error]`） | `hooks/use-input.ts`、`components/App.tsx` | `packages/cli/tests/render-port/stdin-ownership.test.tsx` I10: |
| I11 | `useStdin().internal_eventEmitter` 的 `input` 事件是对象：自有字段 `_didStopImmediatePropagation / keypress / key / input`，`stopImmediatePropagation()` 在原型上，调用后排在后面的监听者（含 `useInput`）都不再收到；`keypress` 的 `kind / ctrl / meta / shift / super / fn / sequence / isPasted` 与旧底座一致（`name / option / code` 新底座不提供）；监听按挂载顺序，emitter 上只有使用方挂的监听 | `input-event.ts`、`components/App.tsx` | `packages/cli/tests/render-port/stdin-ownership.test.tsx` I11: |

### I4 模式归属表

同一组终端私有模式，旧底座和 CLI 各写一遍（设计文档 §1.5）。现在能工作是因为重复写入恰好无害。
新底座不能少写、多写或改顺序，除非在这里改表并给出理由。

| 模式 | 底座：开 | 底座：关 | CLI：开 | CLI：关 |
| --- | --- | --- | --- | --- |
| bracketed paste `?2004` | next `components/App.tsx:259`（`enableInputModes`，raw mode 0 → 1 时，`:525`）；`:348` Ctrl+Z 恢复且计数 > 0 时 | next `components/App.tsx:270` 计数归零时（`releaseRawMode`）；`:362` Ctrl+Z 挂起时；`ink.tsx:988` TTY 卸载时再关一次 | `packages/cli/src/ui/utils/terminalCapabilityManager.ts:261` | 同文件 `:50`（退出清理） |
| focus reporting `?1004` | 同上；另 `components/App.tsx:352` 恢复时 TTY 再补一次 | 同上 | — | — |
| kitty 键盘 / modifyOtherKeys | 同上，`supportsExtendedKeys()`（`terminal/extended-keys.ts:114`）为真时追加；`ink.tsx:586` stdin 静默 > 5s 后整段重申（I1c） | 同上（扩展键开没开都关） | `terminalCapabilityManager.ts:254` / `:258` | 同文件 `:48` / `:49` |
| 鼠标跟踪 `?1000/1002/1006` | `components/AlternateScreen.tsx:52`（进 alt-screen）；`ink.tsx:440` / `:1127` / `:1184`（resize、SIGCONT、自愈时重开） | `ink.tsx:1743` 卸载时无条件关 | `packages/cli/src/ui/contexts/MouseContext.tsx:45`（Copy Mode 切换） | 同文件 `:50` |
| 自动换行 `?7` | — | — | `packages/cli/src/ui/fullscreen.ts:19`（关） | 同文件 `:24`（恢复） |
| 光标显示 `?25` | — | `ink.tsx:1754` 卸载时显示 | — | — |

## M 鼠标与选区（alt-screen）

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| M1 | 鼠标跟踪随 alt-screen 进出开关：挂载写 `?1049h 2J H` + 鼠标全套（`mouseTracking` 默认真），卸载逆序关鼠标再 `?1049l`；嵌套 / 并列各写各的、不计数；`mouseTracking` 变化等于退出再进入；alt 下 resize 先重开鼠标。`SID_CODE_DISABLE_MOUSE_CLICKS` 不改变底座写的字节（不响应点击由 CLI 侧决定）。字节逐段对拍见 `alt-screen.test.tsx` 的 `M1:` 用例 | `components/AlternateScreen.tsx:52`、`ink.tsx:1743`、`_vendor/fullscreen.ts:7` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S7: { |
| M2 | 拖选、双击选词、三击选行；内容滚动时选区跟着移动 | `selection.ts:738` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S13: { |
| M3 | 复制走 OSC52（`setClipboard`）；tmux / screen 下用 `wrapForMultiplexer` 包裹 | `termio/osc.ts:135`、`termio/osc.ts:35` | `packages/cli/tests/render-port/term-bench/scenarios.tsx` S13: { |
| M4 | 超链接单元可命中并打开 | `squash-text-nodes.ts:21` | ⏳ T6.2 |
| M5 | 选区高亮背景色可设置 | `ink.tsx:1361`、`screen.ts:222` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` M5: |

## O 终端集成

| ID | 行为 | 来源 | 测试 |
| --- | --- | --- | --- |
| O1 | 标题先发 OSC 2 再发 OSC 0，内容去 ANSI（孤立 ESC / DCS 原样）、空串照写、`null` 不写、同值不重写；不经 tmux / screen 包裹；Windows 不写序列、改写 `process.title`；卸载不写 | `hooks/use-terminal-title.ts:22-37` | `packages/cli/tests/render-port/terminal-title-tab.test.tsx` O1: |
| O2 | tab 状态点（`useTabStatus`，OSC 21337，按 tmux / screen 包裹）；`null` 写清除（之前没写过则不写）；`SID_DISABLE_TAB_STATUS` 非空即关闭、每次变化时读、关闭期间不记账；组件卸载不写，进程卸载时清除（X3） | `termio/osc.ts:448-455`、`ink.tsx:1758` | `packages/cli/tests/render-port/terminal-title-tab.test.tsx` O2: |
| O3 | 底座经 `TerminalWriteContext` 提供原始写入口：身份在实例内稳定、原样直写 stdout（不等帧、非 TTY 也写），CLI 用它写 BEL / OSC 777 / OSC 9;4。TTY 卸载时写 OSC 9;4 进度清除（固定 BEL 终止、不包裹）与 tab 状态清除（随终端终止、按 tmux / screen 包裹、`SID_DISABLE_TAB_STATUS` 非空不写），与之前写没写过无关；非 TTY 都不写；相对其余模式恢复的顺序归 X3 | `useTerminalNotification.ts:18`、`ink.tsx:1756` | `packages/cli/tests/render-port/terminal-progress.test.tsx` O3: |
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
| X4 | `detachForShutdown`：标记已卸载、取消待发的节流渲染、drain stdin、退出 raw mode；不经 React 卸载，不写任何终端序列；不 `unref`、不摘 `readable` / SIGCONT / resize 监听、不结算 exit promise（细节见 `stdin-shutdown.test.tsx`） | `ink.tsx:1147-1165` | `packages/cli/tests/render-port/contracts-runtime.test.tsx` X4: |
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
