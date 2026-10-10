---
Status: implemented
Date: 2026-10-05
---
# 新底座 resize 合并、forceRedraw 与 SIGCONT，对拍旧底座逐帧字节（B9 / T3.3）

## 决定了什么

- **resize（R7）**：resize 事件不当场出帧。尺寸与上一次事件相同就直接丢掉；否则当场重算布局，出帧交给一条独立的
  `FrameScheduler(renderAfterResize, alwaysThrottle=true)`，同 tick 连发 N 次只出 leading + trailing 两帧，**测试环境也是这样**。
  旧底座的 resize 合并不受「测试环境同步出帧」（R13）影响，所以加了 `alwaysThrottle` 参数，没有复用提交那条调度。
  full reset 的判定挪到出帧时：比较的是**上一帧出帧时的视口**（`frameViewport`），不是上一帧的屏幕。
  变宽 / 变窄 / 变矮都会 full reset（原因 resize），空帧也算；只变高时照常 diff。
  布局要当场重算：同 tick 先到的提交帧或 forceRedraw 帧就已经是新宽度，之后的 resize 帧 diff 为空，不会再写第二次 reset。
- **forceRedraw（R8）**：写 `2J H`（不清 scrollback，不进同步包裹），前一帧作废，当场按首帧画。
  「上一帧出帧时的视口」**不作废**，同 tick 来了 resize 照样判 full reset，字节与旧底座一致。
  非 TTY、debug、挂起、卸载中都不做。实例上补了这个方法，CLI 的 `?.forceRedraw()` 在 next 上不再静默变成 no-op。
- **SIGCONT（R10）**：只在交互模式挂监听，卸载时摘掉。
  - 主屏：前一帧作废，但**一个字节都不写**。下一次提交走 `redrawAfterSuspend`：第一个变化行之前（只看两帧都有的行）每行只写 `\r\n`，
    从第一个变化行起按首帧写整行。新帧变矮或宽度变了，就退回首帧整帧。这条规则靠 8 组对拍扫出来。
  - `<AlternateScreen>` 挂着时：写 `?1049h 2J H`，开过鼠标的再补 `?1000/1002/1003/1006/1007h`。
    `setAltScreenActive` 只记状态，离开 alt 后下一帧 full reset（原因 resize，与旧底座一致）。
- 帧 diff 顺带补了一处：1 行收缩到空帧时，旧底座用 `\r` 而不是 `eraseLines(1)`（T3.2 的语料只有 3→0）。
- 规则全部来自黑盒对拍：`frame-corpus.ts` 新增 24 条（resize 合并 / 变矮 / 变高 / 空帧变宽、forceRedraw 4 种组合、SIGCONT 9 种），
  `bun run tui:frame-vectors` 从旧底座重新生成，共 86 条；引擎级 xterm 场景新增 E8（R7）、E9（R8）、E10（R10）。

## 放弃了什么（以及为什么不选）

- **在 `diffMainScreen` 里判视口变矮**：它只拿得到上一帧的 `Screen`，拿不到上一帧出帧时的视口；而且空帧变宽、forceRedraw 之后
  前一帧都是 undefined，照样要 reset。所以判定放在 ink.tsx 的 `diffFrame`，帧 diff 保持纯函数。
- **resize 复用提交那条调度器**：测试环境下它同步出帧，「同 tick 三次 resize」会出 3 帧、写 3 次 full reset，对不上旧底座。
- **SIGCONT 后直接清屏重画**：主屏用户看到的是一次额外的闪烁，旧底座也不这么做（R10 契约：主屏不立即写字节）。
- **把 alt-screen 的出帧（`ESC[H` + 绝对定位 + `CSI r;1H` 收尾）一起做掉**：它和 `<AlternateScreen>` 组件、视口约束是一体的，归 T6.1。
  这次只做 SIGCONT 在 alt 下的恢复序列，以及离开 alt 后的 reset 标记。

## 拿什么证明它生效了

- `packages/tui/tests/frame.test.ts`：86 条向量逐帧字节一致，含 24 条 T3.3 新增。
- 引擎级场景 E1–E10 在 legacy 和 next 上当场差分全部一致：网格、scrollback、光标、模式一致，full reset 次数与字节数不超过 legacy。
  T3.2 移交过来的 S6 字节数超标（448 > 224×1.1）已消失：同一场景差分现在为空。
- 契约测试 R10 四条在 next 上通过（原来 3 条红）。
- 变异自证 11 处全红：变矮不 reset、宽窄不 reset、resize 不合并、resize 不当场重算布局、forceRedraw 不擦屏、
  forceRedraw 清掉视口记录（第一轮是绿的，补了「resize 与 forceRedraw 同 tick」两条向量后转红）、SIGCONT 不作废前帧、
  SIGCONT 后整帧重画、alt 下不开鼠标、不摘监听、1 行收缩照常擦行。
- `tui:spec` / `lint:boundary` / `tui:similarity` / `tui:frame-vectors --check` / `lint` 全部通过；tsc 错误数与 HEAD 相同；`make build` 通过，无 undefined 警告。

## 没做 / 移交

- alt-screen 下的出帧路径、forceRedraw 在 alt 下「重置帧缓存后绝对定位重画」、alt 下 resize 时重开鼠标跟踪：归 T6.1（S7 / S9 的 alt 段）。
- X7 在 next 上仍然红：实例上还缺 `enter/exitAlternateScreen`（T6.1）、选区三个方法（T6.2）、`detachForShutdown`（T7.1）。
- 离屏暂停动画、脏区缓存归 T3.4。
