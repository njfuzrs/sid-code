---
Status: implemented
Date: 2026-10-08
---
# 新底座 stdin 所有权与 raw mode 引用计数（B9 / T5.1c）

## 决定了什么

规则全部来自对拍 legacy 的黑盒探针（`_probe_raw / raw2 / u / v / x / y / s / t`，以及本次补的 `v2 / u2`），没有读旧底座代码（D-5）。

- **raw mode 计数（新契约 I9）**：计数是普通整数，0→1 同步 `ref` + `setRawMode(true)` + 挂 `readable`；1→0 同步关，去掉了上游放在微任务里的延迟关闭。多余的 `false` 会把计数压成负数，要补回同样多次 `true` 才真正打开。计数归零只关 raw mode、摘 `readable`，不清解析器、不取消 ESC 冲刷，所以同一提交里换一个 `useInput` 组件时，切换前缓冲的半截转义会冲刷给新组件。退出和卸载才清。
- **effect 时序（新契约 I10）**：`useInput` 的 raw mode 租约放进 layout effect，handler 订阅留在 passive effect。可观察的后果是停用期间留在流里的字节，在重新启用时由 `readable` 交出，而 handler 这时还没订阅上，于是被丢弃。legacy 就是这样，照搬。
- **回调抛错（I1b / I10）**：`readable` 回调整体 try/catch，打 `[ink:error]`，同一块里剩下的事件作废；监听被摘掉时重新挂上。`useInput` 里不再就地吞错。
- **事件形状（新契约 I11）**：新增 `src/input-event.ts`。`internal_eventEmitter` 的 `input` 事件是 `InputEvent` 对象，自有字段为 `_didStopImmediatePropagation / keypress / key / input`，原型上有 `stopImmediatePropagation()`。解码挪到 App 里做一次，逐个调监听者，以支持中途停止传播。Tab 焦点导航不再挂在 emitter 上，因为 legacy 的 emitter 上只有使用方自己挂的监听。
- **解析补一处（I8）**：块尾的 `ESC` + 中间字节（0x20–0x2F）或 `ESC _` 先挂起，等冲刷超时再交出。

## 放弃了什么

- **保留上游的延迟关闭（同一提交换组件时不关不开）**：对终端更省事，但 legacy 是同步关、再开一次，探针里 `ref/unref/setRawMode` 序列逐个可见。不照搬会让 I9 的三条断言红掉。
- **修掉「停用期间缓冲的字节被丢弃」**：这才是更「正确」的行为，但这次的任务是对拍，不是修正。CLI 里有没有依赖这一点没有核过，改它要另立任务。
- **`keypress` 仿造 `name / option / code`**：CLI 侧零读者（grep `internal_eventEmitter` 在 CLI 源码零命中），仿造只会多出一份要维护的 legacy 私有语义。宁缺不错。
- **`ESC P` / `ESC ]` 冲刷时丢弃**：这是终端回复的残片，归 T5.2 的 I3，这次不做。`_probe_u` 里只剩这两条差异。

## 拿什么证明它生效了

- 新增 `packages/cli/tests/render-port/stdin-ownership.test.tsx`（I9 ×6、I10 ×14、I11 ×14），期望值都是 legacy 实测。两套底座都是 34/34。
- next 上 `contracts-runtime` + `stdin-dual-reader` 的失败从 8 降到 7：I1b 转绿；剩下的 I1c / I5 ×2 / X4 归 T5.1d，M5 ×2 归 T6.2，O5 归 T7.2。legacy 上全绿。
- 探针重跑对比：`raw / raw2 / x / y` 与 legacy 逐字节一致；`v / v2` 在约定字段上一致；`u` 只剩 `ESC P` / `ESC ]` 两条，归 T5.2。
- 变异自证 4 处全部转红：layout effect 改回 passive（I10 ×10 红）、去掉 `stopImmediatePropagation` 检查（I11 红）、去掉重挂（I1b 红）、关闭延迟到微任务（I9 ×4 + I10 红）。改动后用 sha1 核对已还原。
- `tui:similarity` 第一次报了 `use-input.ts` 和 legacy 有 27 行重复，把租约和订阅抽成两个小函数后归 0。
