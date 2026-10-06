---
Status: implemented
Date: 2026-10-06
---
# 新底座布局测量与 overflowY scroll（B9 / T4.3）

## 决定了什么

- **`overflowY: scroll`（契约 L3）**：`render-node-to-output.ts` 新增 `renderScrollContent`。规则全部来自黑盒对拍 legacy 的可视帧和 TTY 首帧字节，没有读旧代码：
  - 只画**第一个子节点**（内容盒）的子项，所以首子是 Text 时什么都不画，第二个及以后的子节点也不画；
  - 内容盒自己的背景、边框、`overflow` 裁剪都不画，它只充当坐标原点；
  - 子项按「在内容盒里的 top」与视口 `[0, 内框高)` 求交，内框高 = 高度 − 上下 padding − 上下边框。有交集就整项画，交给滚动盒的裁剪；**不递归剔除**孙辈；
  - 剔除**不看内容盒的偏移**：负 `marginTop` 滚上去的行被裁掉，底部空出等高的行。这是 legacy 的现行行为，照搬。
- **overflow 取值**：单轴（`overflowX` / `overflowY`）优先于 `overflow`，所以 `overflow="hidden" overflowY="visible"` 纵向不裁剪；`scroll` 在本轴上等同 `hidden`。styles 类型加了 `'scroll'`。
- **`getBoundingBox`**（新写，`packages/tui/src/measure/`）：布局树绝对坐标，沿父链累加，含负 margin 和 absolute，不按滚动位置修正；参数为空或节点已移除时返回 `null`，不抛。
- **`ResizeObserver`**（新写）：轮询式。`observe` 后在微任务里单独报一次，排在调用方随后排的微任务之前；重复 observe 不再报；同一 tick 里又 unobserve 的不报。之后每 16ms 轮询一次，只比宽高（只挪位置不回调），同一轮里变化的目标合成一次回调；节点被移除后报一次 0×0。定时器 `unref`；参数为空时抛 TypeError。
- **`measureElement`**：上游实现外包一层，只返回 `{width, height}`（端口面是 legacy 的形状）。
- **reconciler**：移除节点时，释放 yoga 之后把整棵子树的 `yogaNode` 置空。否则 ref 会读到已释放的 WASM 节点；置空后 measure 得 0×0、getBoundingBox 得 null，与 legacy 一致。

## 放弃了什么

- **按内容盒偏移剔除 / 提供 scrollTop**：这样更「正确」，但 legacy 不这么做，CLI 的 copyMode 画面会变。行为修正不在这次对拍范围内。
- **把 ResizeObserver 挂到 layout listener 上（布局完成即回调）**：时序变成同步，VirtualizedList 的测量回灌节奏会变，L4 的时序断言会红。
- **「首子必须是 Box」的显式判断**：变异自证时这条是绿的。首子是 Text 时，它的子节点是没有 yoga 节点的文本，循环自然什么都不画，所以删掉了，没有留死代码。

## 拿什么证明它生效了

- `contracts-layout-text.test.tsx` 新增 L3 ×15、L4 ×3（期望值是在 legacy 上实测的）。两套底座 68/68 全绿，L4 原有那条在 next 上由红转绿。
- 组件级场景 **C3**：挂真实 `VirtualizedList`（双 ResizeObserver、spacer、copyMode 的 marginTop），legacy 与 next 当场差分，逐步一致。⚠️ 实测 legacy 在主屏上 scrollBy / scrollTo 不改变可见行，那几步只能证明两边一致。真正让画面变化的是「整批换数据」那一步。
- 变异自证 13 处全红：只画首子、剔除按偏移、视口扣 padding、scroll 走剔除、单轴优先、scroll 裁横轴、移除节点置空 yoga、RO 首报时机 / 只比宽高 / 同轮合并 / 重复 observe / 同 tick unobserve、getBoundingBox 返回 null。改动用 sha256 核对后已还原。
- next 上 render-port 的失败从 25 条降到 23 条，**L3 / L4 不在剩余项里**。剩下的 I1b / I1c / I5 / M5 / O5 / X4 / X7 和 S1–S14 都属于 T5–T7。
- 全量 14183 pass / 0 fail；`make build` 通过；tsc 71 → 70（少掉的是 next-switch 旧样本里那处 `new` 不可构造，没有新增）；`tui:spec`、`tui:similarity`、`lint:boundary`、`lint`、两份 vectors `--check`、`docs:gen-reference --check`、`tui:surface --check` 全部通过。

## 没做 / 移交

- S7（L3 M1）是 App 级场景，用的是 `AlternateScreen`，next 上要等 T6.1 才能跑。
- 滚动位置在主屏上不生效的问题记在 C3 注释里。VirtualizedList 实际只在 alt-screen 用，归 T6.x 一起看。
- `next-switch` 的值占位样本已经不存在（ResizeObserver 是最后一个），改为直接测 `notImplementedValue` 这个 helper。
