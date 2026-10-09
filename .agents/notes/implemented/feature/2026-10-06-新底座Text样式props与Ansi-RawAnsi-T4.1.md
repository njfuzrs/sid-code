---
Status: implemented
Date: 2026-10-06
---
# 新底座 Text 样式 props 补齐、Ansi / RawAnsi 新写（B9 / T4.1）

## 决定了什么

- **验收口径沿用 T3.1 的屏幕首帧对拍**：`screen-corpus.ts` 的 DSL 加了 `{ansi}` / `{raw}` 两种节点，
  新增 107 条语料（Text 样式组合与嵌套、Ansi 解析边角、RawAnsi 尺寸边界、SURFACE.md §2 里还没进字节级语料的 Box props），
  另开一组 `hyperlinks` 环境（`TERM_PROGRAM=iTerm.app`）看终端支持超链接时 Ansi 的 OSC 8。
  `bun run tui:screen-vectors` 从旧底座生成，共 197 条；新底座逐字节一致。没有读旧代码。
- **Text**：样式叠加改走 T2.2 的 `applyTextStyles`，顺序由内到外 inverse → strikethrough → underline → italic → bold → dim → 前景 → 背景。
  新增 `dim`；`dimColor` 保留名字但**不出任何 SGR**（旧底座就是这样，CLI 里 `dimColor` 已经被注释标成「不是 Text 的 prop」）。
  嵌套 `<Text>` 经 context 继承外层样式，内层把合并后的整套样式重新编码。只靠外层 transform 包住内层，
  `<Text inverse>a<Text underline>b</Text></Text>` 的关闭顺序是 `24m 27m`，旧底座是 `27m 24m`。
- **Ansi**：先把 ANSI 解析成片段，再按 Text 的叠加顺序重新编码，所以样式相同、写法不同的输入产出相同字节。
  对拍得出的规则：只认 0–9 / 21–29 / 30–49 / 90–107 和 38·48 扩展色（含 `38:5:n`、`38:2::r:g:b`、`4:n`），
  其余码（闪烁、隐藏、上划线）丢弃；参数不够的 38 / 48 只跳过本身，后面的参数照常当独立的码；
  `22` 同时关粗体与暗；**暗开着时粗体不出 SGR**；`dimColor` 整段变暗；
  OSC 8 只在终端支持超链接时保留，统一写成 `OSC 8 ;; url BEL`（原 id / 参数丢掉，再由屏幕层改写成 hash id）；`ESC[0m` 不关链接。
- **RawAnsi**：一个 `ink-text` 叶子，尺寸固定 `width × lines.length`、`flexShrink: 0`，带 `internal_raw`，
  渲染时不换行不截断；`lines` 为空不渲染。行比 `width` 宽时照写，被同一行后面的兄弟盖住（旧底座同样如此）。
- 端口 next 的 `Ansi` / `RawAnsi` 接上，不再是占位。

## 放弃了什么（以及为什么不选）

- **Ansi 把原始 SGR 直接塞进一个 `<Text>`**（只做 sanitize）：屏幕层会照原写法编码，复合码、冒号码、reset 的字节都对不上，
  `38;2;1` 这类不完整序列的解释也不同。解析再重编码是唯一能和向量逐字节一致的做法。
- **Ansi 每个片段生成一个 `<Text>` 节点**：节点数随样式切换次数增长，Markdown 长回答会多出成百上千个 reconciler 节点。
  拼成一个字符串放进单个 `<Text>`，字节一致，节点只有一个。
- **RawAnsi 新增一个 `ink-raw` 宿主类型**：reconciler、dom、测量、输出缓存都要加分支。复用 `ink-text` 加一个属性，
  只在换行那一处判断，T3.4 的脏区缓存自动生效。
- **`dimColor` 映射成 dim**：看起来更「合理」，但会让现在所有 `<Text dimColor>` 的输出变样，违反 TUI 零回退。

## 拿什么证明它生效了

- `packages/tui/tests/screen.test.ts`：197 条向量全部逐字节一致（`tui:screen-vectors --check` 通过）。
- 端口契约 T5 两条在 next 上由红转绿；next 上 render-port 的失败集合从 30 条降到 28 条，**只少了这两条，没有新增**
  （L4 / Static / 输入 / alt-screen / 生命周期等，分别属于 T4.2–T7）。
- 变异自证 12 处全红：暗不压粗体、38;5 少吃参数、不判超链接支持、reset 清掉链接、不认 `4:n`、`22` 不关暗、
  RawAnsi 可收缩、空 lines 也渲染、RawAnsi 被换行、Text 丢 dim、嵌套不继承、叠加顺序换位。
  **「reset 清掉链接」第一轮是绿的**，补了一条「链接中途 reset」语料才转红。改动用 sha256 核对后已还原。
- `tui:spec`（58 条，55 条已测）/ `tui:similarity` / `lint:boundary` / `lint` 全过；tsc 错误数与 HEAD 相同（71）；`make build` 通过，无 undefined 警告；`docs:gen-reference --check` 通过。
- 全量 14123 pass / 1 fail：失败的是 `contracts-termio` 的 O6（linux 全失败后不再试），全量负载下子进程超时，单独跑 3/3 通过；这次没碰 termio，T3.4 时也是同一条。

## 没做 / 移交

- Box 的 `ref` / `overflowY: scroll` / 测量归 T4.3；`Static` 归 T4.2。
- RawAnsi 用 `createElement` 而不是 JSX：根 tsconfig 下两套底座的 `global.d.ts` 都在声明 `ink-text`，legacy 那份不认识 `internal_raw`。T9 删旧底座后可以改回 JSX。
