---
title: Claude Code 源码解析（十二）· 终端 UI 渲染
description: '如何在终端这个"原始"环境中实现权限弹窗、Diff 高亮、代码着色、虚拟滚动等富交互体验？React + Ink 如何驱动 TTY 渲染？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十二章：终端 UI 渲染（Terminal UI & Ink）

> 一个基于 React + Ink 的全功能终端应用——如何在 TTY 中实现富交互体验。

## 核心问题

Claude Code 不是一个传统的 CLI 工具——它是一个运行在终端中的**全功能交互式应用**。它需要：

1. **富文本渲染**：Markdown 格式化、语法高亮、结构化 Diff、代码块、表格——这些在浏览器中用 HTML/CSS 轻松实现的东西，在终端中只有 ANSI 转义序列可用。

2. **复杂的布局系统**：消息列表、权限对话框、输入框、状态栏、Spinner 动画——这些组件需要精确的空间分配和嵌套布局，但终端没有 CSS Flexbox。

3. **高性能滚动**：一次对话可能产生数百条消息、数千行输出。终端的"滚动"本质上是重写整个屏幕——如果每帧都重绘所有内容，CPU 和 I/O 开销会让应用卡顿。

4. **丰富的输入交互**：文本编辑、Vim 模式、快捷键和弦（chord）、粘贴检测、鼠标点击、文本选择——终端的 stdin 只是一个字节流，所有这些都需要从原始字节中解析出来。

5. **跨终端兼容性**：iTerm2、Ghostty、Kitty、Windows Terminal、VS Code 内置终端、tmux——每个终端对 ANSI 序列的支持程度不同，颜色能力不同，键盘协议不同。

**核心矛盾：Web 级的交互体验 vs 终端的原始能力。**

Claude Code 的解法是构建了一个**完整的终端 UI 框架**——基于 React 的声明式编程模型，通过自定义的 React Reconciler 将虚拟 DOM 映射到终端输出。这不是简单地使用 Ink 库，而是对 Ink 进行了深度定制和扩展，形成了一个包含布局引擎、事件系统、屏幕缓冲、帧差分、文本选择等完整能力的终端渲染引擎。

---

## 12.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        React 应用层                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ REPL     │  │ Messages │  │ PromptInput│  │ PermissionDialog │  │
│  │ Screen   │  │ 消息列表  │  │ 输入框     │  │ 权限对话框       │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └────────┬─────────┘  │
│       │              │              │                  │            │
│  ┌────┴──────────────┴──────────────┴──────────────────┴─────────┐  │
│  │              设计系统 (design-system/)                          │  │
│  │  ThemedText · ThemedBox · Dialog · Pane · Tabs · FuzzyPicker  │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
│                              │                                      │
├──────────────────────────────┼──────────────────────────────────────┤
│                     定制 Ink 引擎层 (ink/)                          │
│                              │                                      │
│  ┌───────────────────────────┼───────────────────────────────────┐  │
│  │                    React Reconciler                            │  │
│  │              (reconciler.ts → dom.ts)                          │  │
│  │         React 虚拟 DOM  →  Ink DOM 树 + Yoga 节点             │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────┼───────────────────────────────────┐  │
│  │                      渲染管线                                  │  │
│  │                           │                                    │  │
│  │  renderer.ts ─→ render-node-to-output.ts ─→ screen.ts         │  │
│  │  (Yoga 布局)    (DOM 树 → 屏幕缓冲)         (Cell 数组)       │  │
│  │                           │                                    │  │
│  │  log-update.ts ──────→ terminal.ts                             │  │
│  │  (帧差分 Diff)          (ANSI 序列写入 stdout)                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │ 事件系统      │  │ 布局引擎      │  │ 终端 I/O               │    │
│  │ events/      │  │ layout/      │  │ termio/                │    │
│  │ 键盘·鼠标·焦点│  │ Yoga 适配    │  │ ANSI 解析·终端能力检测  │    │
│  └──────────────┘  └──────────────┘  └────────────────────────┘    │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        终端层                                        │
│  stdin (原始字节流)                    stdout (ANSI 转义序列)        │
│  ← 键盘输入 / 鼠标事件 / 粘贴         → 文本 / 颜色 / 布局 / 光标  │
└─────────────────────────────────────────────────────────────────────┘
```

这个架构的核心洞察是：**用 React 的声明式模型管理 UI 状态，用自定义渲染管线将 React 树高效地映射到终端输出。** 开发者写的是 JSX 组件，但最终输出的是 ANSI 转义序列。中间的转换由 Reconciler、Yoga 布局、屏幕缓冲、帧差分四个阶段完成。

让我们从渲染管线的最底层开始，逐层向上剖析。

---

## 12.2 渲染管线：从 React 树到终端像素

### 面临的问题

终端渲染的本质是：**将一棵组件树转换为一个二维字符网格，然后以最小的 I/O 开销写入 stdout。**

这个过程面临几个关键挑战：

1. **布局计算**：终端没有 CSS 引擎。如何计算每个组件的位置和尺寸？
2. **增量更新**：每次状态变化都重绘整个屏幕太昂贵。如何只更新变化的部分？
3. **宽字符处理**：Emoji 和 CJK 字符占两列，但只是一个 Unicode 码点。如何正确处理？
4. **内存效率**：一个 200 行 × 120 列的屏幕有 24000 个 Cell。如何避免为每个 Cell 分配对象？

### 解法：五阶段渲染管线

```
React 状态变化
    │
    ▼
┌─────────────────────────────────────────────────┐
│ 阶段 1: Reconciliation (reconciler.ts)           │
│ React Fiber 树 → Ink DOM 树 (DOMElement)         │
│ 每个 DOMElement 关联一个 Yoga 布局节点            │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 阶段 2: Layout (Yoga)                            │
│ Yoga 引擎计算每个节点的 (x, y, width, height)    │
│ 支持 Flexbox 布局模型                             │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 阶段 3: Paint (render-node-to-output.ts)         │
│ 遍历 DOM 树，将每个节点绘制到 Screen 缓冲区       │
│ 处理裁剪、边框、背景、文本换行、滚动偏移          │
│ Blit 优化：未变化的区域直接从上一帧复制            │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 阶段 4: Diff (log-update.ts)                     │
│ 逐 Cell 比较当前帧与上一帧                        │
│ 生成最小化的 Patch 序列（光标移动 + 样式切换 + 文本）│
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 阶段 5: Write (terminal.ts)                      │
│ 将 Patch 序列序列化为 ANSI 转义序列               │
│ 包裹在 BSU/ESU 同步输出中（防闪烁）               │
│ 写入 stdout                                      │
└─────────────────────────────────────────────────┘
```

### 阶段 1: Reconciliation — React 到 Ink DOM

Claude Code 使用 `react-reconciler` 包创建了一个自定义的 React 宿主环境。这意味着 React 的 Fiber 调度器、Hooks 系统、并发特性都可以直接使用，但渲染目标不是浏览器 DOM，而是 Ink 自己的 DOM 树。

```typescript
// reconciler.ts — 核心宿主配置（简化）

const reconciler = createReconciler({
  // 创建元素：<Box> → DOMElement('ink-box')
  createInstance(type, props) {
    const node = createNode(type);  // 创建 DOMElement
    // 为 ink-box 创建 Yoga 布局节点
    if (type === 'ink-box') {
      node.yogaNode = engine.createNode();
      applyStyles(node.yogaNode, props.style);
    }
    return node;
  },

  // 属性更新：只在值真正变化时标记 dirty
  commitUpdate(node, type, oldProps, newProps) {
    for (const key of changedKeys) {
      if (key === 'style') {
        applyStyles(node.yogaNode, newProps.style);
      }
      setAttribute(node, key, newProps[key]);
    }
    // markDirty() 会沿父链向上传播，触发重新渲染
  },

  // 文本节点：只能出现在 <Text> 内部
  createTextInstance(text) {
    return { nodeValue: text };
  },
});
```

**关键设计决策：为什么不直接操作终端，而要构建一个 DOM 层？**

因为 React 的 Reconciler 需要一个**可查询、可修改的树结构**来执行 Diff。浏览器有真实 DOM，Ink 需要一个等价物。这个 DOM 层还承担了额外职责：

- **脏标记传播**：`markDirty()` 从变化节点向上传播到根节点，让渲染器知道哪些子树需要重绘
- **滚动状态存储**：`scrollTop`、`pendingScrollDelta` 直接存在 DOM 节点上，避免 React 状态更新的开销
- **焦点管理**：`focusManager` 挂在根节点上，提供类似浏览器的 `document.activeElement` 语义

### 阶段 2: Layout — Yoga Flexbox 引擎

布局计算委托给 Yoga——Facebook 开源的跨平台 Flexbox 布局引擎。Claude Code 使用的是 Yoga 的 TypeScript 移植版本（非 WASM），通过一个适配层接入：

```typescript
// layout/engine.ts — 布局引擎抽象

interface LayoutEngine {
  createNode(): LayoutNode;
  calculateLayout(root: LayoutNode, width: number, height: number): void;
}

// layout/yoga.ts — Yoga 适配器
// 将 Ink 的样式属性映射到 Yoga 的 API
function applyStyles(yogaNode: LayoutNode, style: Styles): void {
  yogaNode.setFlexDirection(style.flexDirection ?? 'column');
  yogaNode.setAlignItems(style.alignItems ?? 'stretch');
  yogaNode.setJustifyContent(style.justifyContent ?? 'flex-start');
  yogaNode.setWidth(style.width);
  yogaNode.setHeight(style.height);
  yogaNode.setPadding(style.padding);
  yogaNode.setMargin(style.margin);
  yogaNode.setOverflow(style.overflow);  // 'visible' | 'hidden' | 'scroll'
  // ... 完整的 Flexbox 属性集
}
```

**为什么选择 Yoga 而不是自己实现布局？**

Flexbox 规范的完整实现极其复杂（数百页规范文档，数千个边界情况）。Yoga 是经过 React Native 大规模验证的实现，正确性有保障。自己实现的风险远大于引入依赖的成本。

**为什么用 TypeScript 移植版而不是 WASM 版？**

WASM 版需要加载 `.wasm` 文件，增加启动时间和打包复杂度。TypeScript 版可以直接被 Bun bundler 处理，与其他代码一起打包和优化。对于终端 UI 的布局复杂度（通常不超过几百个节点），TypeScript 版的性能完全够用。

### 阶段 3: Paint — DOM 树到屏幕缓冲

这是渲染管线中最复杂的阶段。`render-node-to-output.ts` 递归遍历 DOM 树，将每个节点"绘制"到一个二维的 `Screen` 缓冲区中。

```typescript
// render-node-to-output.ts — 核心绘制逻辑（简化）

function renderNodeToOutput(node, output, options) {
  const { left, top, width, height } = node.yogaNode.getComputedLayout();

  // Blit 优化：如果节点未变化且位置相同，直接从上一帧复制
  if (!node.dirty && positionUnchanged && prevScreen) {
    blitRegion(prevScreen, output.screen, left, top, width, height);
    return;
  }

  // 绘制边框
  if (node.style.borderStyle) {
    renderBorder(output, node, left, top, width, height);
  }

  // 绘制背景
  if (node.style.backgroundColor) {
    fillBackground(output, left, top, width, height, bgColor);
  }

  // 递归绘制子节点
  for (const child of node.children) {
    renderNodeToOutput(child, output, {
      // 裁剪区域：子节点不能超出父节点边界
      clipRect: intersect(parentClip, { left, top, width, height }),
      // 滚动偏移：overflow:scroll 的容器需要偏移子节点
      scrollOffset: node.scrollTop,
    });
  }

  // 绘制文本节点
  if (node.type === 'ink-text') {
    renderText(output, node, left, top, width);
  }

  node.dirty = false;
}
```

**Blit 优化是这个阶段最重要的性能技巧。** 在一个典型的对话场景中，用户发送一条消息后，屏幕上 90% 的内容（之前的消息）没有变化。如果每帧都重新绘制所有内容，就是 O(总面积)；有了 Blit，只需要 O(变化面积)。

Blit 的工作原理：
1. 每个 DOM 节点有一个 `dirty` 标志
2. 如果节点未 dirty 且在屏幕上的位置没变，直接从上一帧的 Screen 缓冲区复制对应区域
3. 复制是 `Int32Array` 级别的内存拷贝，极快

**Screen 缓冲区的内存布局**也值得关注：

```typescript
// screen.ts — 紧凑的 Cell 存储

// 每个 Cell 用 2 个 Int32 表示（8 字节）
// cells[i*2]   = charId      (CharPool 中的索引)
// cells[i*2+1] = packed      (styleId | hyperlinkId | width)
//
// 一个 200×120 的屏幕 = 24000 个 Cell = 192KB
// 对比：如果每个 Cell 是一个 JS 对象 = 24000 个对象 ≈ 数 MB + GC 压力

type Screen = {
  cells: Int32Array;      // 紧凑的 Cell 数组
  cells64: BigInt64Array;  // 同一块内存的 64-bit 视图，用于批量清零
  damage: DamageBounds;   // 变化区域的边界框
  noSelect: Uint8Array;   // 不可选择区域的位图（行号、边框等）
  softWrap: Int32Array;   // 软换行标记（区分自动换行和源码换行）
};
```

**为什么用 `Int32Array` 而不是对象数组？**

24000 个 JS 对象意味着 24000 次内存分配和 GC 追踪。`Int32Array` 是一块连续内存，分配一次，GC 零开销。Diff 阶段需要逐 Cell 比较，连续内存的缓存局部性远优于散布在堆上的对象。

**字符串池化（Interning）** 进一步减少了内存开销：

```typescript
// CharPool：字符串 → 整数 ID 的映射
// "H" → 1, "e" → 2, "l" → 3, "😀" → 4
// Screen 中存储的是 ID，不是字符串引用
// ASCII 字符有快速路径：直接用 charCode 作为 ID

// StylePool：ANSI 样式 → 整数 ID 的映射
// [bold, red, bgWhite] → 42
// 额外能力：transition(fromId, toId) 返回预计算的 ANSI 差分序列
// 比如从 "bold+red" 到 "bold+blue" 只需要 "\x1b[34m"（改颜色），不需要重置再设置

// HyperlinkPool：OSC 8 超链接 URL → 整数 ID
```

### 阶段 4: Diff — 帧差分

`log-update.ts` 比较当前帧和上一帧的 Screen 缓冲区，生成最小化的 `Patch` 序列。

```typescript
// log-update.ts — 帧差分核心逻辑（简化）

class LogUpdate {
  render(nextFrame: Frame, prevFrame: Frame): Diff {
    const patches: Patch[] = [];

    // 如果终端尺寸变化，必须全屏重绘
    if (resized || scrollbackCorrupted) {
      return fullReset(nextFrame);
    }

    // 逐行、逐 Cell 比较
    for (let row = damage.top; row <= damage.bottom; row++) {
      for (let col = damage.left; col <= damage.right; col++) {
        const prevCell = getCell(prevScreen, row, col);
        const nextCell = getCell(nextScreen, row, col);

        if (cellsEqual(prevCell, nextCell)) continue;

        // 移动光标到变化位置
        patches.push({ type: 'cursorMove', row, col });
        // 切换样式（使用 StylePool 的预计算差分）
        patches.push({ type: 'style', transition: stylePool.transition(prev, next) });
        // 写入字符
        patches.push({ type: 'stdout', text: charPool.get(nextCell.charId) });
      }
    }

    return patches;
  }
}
```

**关键优化：**

- **Damage 区域限制**：只比较 Paint 阶段标记的变化区域，跳过未变化的行
- **相对光标移动**：使用相对移动（`\x1b[nC` 右移 n 列）而非绝对定位（`\x1b[row;colH`），因为在主屏幕模式下，绝对定位会受到 scrollback 的影响
- **样式差分**：`StylePool.transition(fromId, toId)` 返回预计算的最小 ANSI 序列，避免每次都 reset + 重新设置
- **空白跳过**：行尾的空白 Cell 不写入（终端默认就是空白），减少 I/O 量
- **宽字符补偿**：检测 Emoji 在不同终端中的宽度差异（某些终端的 wcwidth 表过时），自动补偿

### 阶段 5: Write — 终端输出

```typescript
// terminal.ts — 最终输出

function writeDiffToTerminal(stdout: Writable, diff: Diff): void {
  let output = '';

  // 同步输出包裹：防止终端在帧中间刷新导致闪烁
  if (isSynchronizedOutputSupported()) {
    output += '\x1b[?2026h';  // BSU (Begin Synchronized Update)
  }

  for (const patch of diff) {
    switch (patch.type) {
      case 'cursorMove':
        output += `\x1b[${patch.row};${patch.col}H`;
        break;
      case 'style':
        output += patch.ansi;  // 预计算的 ANSI 序列
        break;
      case 'stdout':
        output += patch.text;
        break;
      // ... 其他 patch 类型
    }
  }

  if (isSynchronizedOutputSupported()) {
    output += '\x1b[?2026l';  // ESU (End Synchronized Update)
  }

  stdout.write(output);
}
```

**同步输出（DEC 2026）** 是一个重要的终端特性：它告诉终端"在 BSU 和 ESU 之间的所有输出是一个原子帧，请等收到 ESU 后再刷新屏幕"。没有它，终端可能在帧写入到一半时刷新，导致用户看到半完成的画面（闪烁）。

### 设计决策讨论：为什么要自己 fork Ink？

标准 Ink 库提供了基本的终端 React 渲染能力，但 Claude Code 的需求远超其能力范围：

| 能力 | 标准 Ink | Claude Code 定制版 |
|------|---------|-------------------|
| 屏幕模式 | 仅主屏幕 | 主屏幕 + 备用屏幕（AlternateScreen） |
| 滚动 | 无 | ScrollBox + 硬件滚动（DECSTBM） |
| 文本选择 | 无 | 完整的鼠标选择 + 复制 |
| 鼠标事件 | 无 | SGR 鼠标追踪（点击、拖拽、滚轮） |
| 键盘协议 | 基础 | Kitty 键盘协议 + xterm modifyOtherKeys |
| 性能优化 | 基础 Diff | Blit + Damage + 池化 + 同步输出 |
| 事件系统 | 简单回调 | 捕获/冒泡两阶段分发 |
| 焦点管理 | 简单 Tab 循环 | 焦点栈 + 自动焦点 + 点击聚焦 |

**trade-off**：fork 意味着需要自己维护整个渲染引擎，无法直接享受上游更新。但 Claude Code 的终端 UI 复杂度已经远超 Ink 的设计目标（Ink 面向简单的 CLI 工具），继续在 Ink 上打补丁的维护成本可能更高。

这是一个典型的 **"当框架的抽象边界与你的需求不匹配时，fork 比 hack 更可持续"** 的工程决策。

---

## 12.3 屏幕与页面系统：从 main.tsx 到 REPL

### 面临的问题

渲染管线解决了"如何把 React 树画到终端上"的问题。但还有一个更上层的问题：**整个应用的 UI 结构是什么？用户看到的"屏幕"是如何组织的？**

Claude Code 有多个"屏幕"：主交互界面（REPL）、诊断界面（Doctor）、会话恢复界面（ResumeConversation）。这些屏幕如何挂载？如何切换？它们与底层渲染引擎的关系是什么？

### 解法：App 壳 + 屏幕组件 + 延迟加载

```
main.tsx
  │
  │ await import('../replLauncher.js')
  ▼
replLauncher.tsx
  │
  │ renderAndRun(root, <App {...}><REPL {...} /></App>)
  ▼
┌─────────────────────────────────────────────────────┐
│  App.tsx (ink/components/App.tsx)                     │
│  ┌─────────────────────────────────────────────────┐ │
│  │  终端模式管理                                    │ │
│  │  • Raw Mode (引用计数)                           │ │
│  │  • 括号粘贴模式 (Bracketed Paste)                │ │
│  │  • 焦点报告 (DECSET 1004)                        │ │
│  │  • 扩展键报告 (Kitty / modifyOtherKeys)          │ │
│  │  • 鼠标追踪 (SGR 模式)                           │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │  输入解析                                        │ │
│  │  stdin → parseMultipleKeypresses()               │ │
│  │  → InputEvent / MouseEvent / TerminalResponse    │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Context Providers                               │ │
│  │  FpsMetrics · Stats · AppState · Theme           │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  children ──→ REPL / Doctor / ResumeConversation     │
└─────────────────────────────────────────────────────┘
```

**`App.tsx`（`ink/components/App.tsx`）** 是整个 UI 树的根节点。它不是业务组件，而是**终端环境的管理者**。它的职责是：

1. **终端模式生命周期**：进入时启用 Raw Mode、括号粘贴、焦点报告等；退出时恢复原始状态
2. **输入解析中枢**：从 stdin 读取原始字节，解析为结构化的 InputEvent，分发给事件系统
3. **鼠标事件处理**：多击检测（双击选词、三击选行）、拖拽选择、超链接点击
4. **终端自愈**：在 SIGCONT（从 Ctrl+Z 恢复）、tmux attach、SSH 重连后重新设置终端模式

**`replLauncher.tsx`** 是一个薄薄的胶水层：

```typescript
// replLauncher.tsx — 简化

export async function launchRepl(root, props) {
  const { default: App } = await import('./components/App.js');
  const { default: REPL } = await import('./screens/REPL.js');

  return renderAndRun(root, (
    <App {...appProps}>
      <REPL {...replProps} />
    </App>
  ));
}
```

**为什么要通过 `replLauncher.tsx` 间接加载，而不是在 `main.tsx` 中直接 import？**

因为 `REPL.tsx` 是一个 ~875KB 的巨型组件文件，它的 import 链会拉入几乎所有的 UI 组件、Hooks、工具渲染器。通过动态 `import()`，这些模块的加载被推迟到真正需要渲染 REPL 时，而不是在 `main.tsx` 的模块求值阶段。这与第一章讨论的"两阶段启动"策略一脉相承。

### 三个屏幕

| 屏幕 | 文件 | 职责 | 何时显示 |
|------|------|------|---------|
| REPL | `screens/REPL.tsx` | 主交互界面：消息列表 + 输入框 + 权限对话框 + Spinner | 默认 |
| Doctor | `screens/Doctor.tsx` | 诊断界面：检查安装、配置、连接状态 | `claude doctor` |
| ResumeConversation | `screens/ResumeConversation.tsx` | 会话恢复：列出历史会话，选择恢复 | `claude --resume` |

`ResumeConversation` 有一个有趣的模式：它本身是一个选择界面，用户选择会话后，它会**内部切换到 REPL 屏幕**，将选中的会话数据传递给 REPL。这不是路由切换，而是组件内部的条件渲染。

### REPL 屏幕的内部结构

REPL 是整个应用最复杂的组件（~875KB），它编排了几乎所有的 UI 子系统：

```
REPL.tsx
├── 状态管理
│   ├── 100+ React Hooks
│   ├── 消息列表 (messages state)
│   ├── 工具/命令注册表
│   ├── MCP 连接管理
│   └── 权限/分类器状态
│
├── 布局
│   └── FullscreenLayout
│       ├── 消息区域 (Messages / VirtualMessageList)
│       │   ├── MessageRow × N
│       │   │   └── Message (类型分发)
│       │   │       ├── AssistantTextMessage
│       │   │       ├── AssistantToolUseMessage
│       │   │       ├── UserTextMessage
│       │   │       └── ...
│       │   └── OffscreenFreeze (视口外冻结)
│       │
│       ├── Spinner 区域
│       │   └── SpinnerAnimationRow
│       │
│       ├── 权限对话框区域
│       │   └── PermissionRequest → 工具专属 UI
│       │
│       └── 输入区域
│           └── PromptInput
│               ├── TextInput / VimTextInput
│               ├── PromptInputFooter
│               ├── Notifications
│               └── 各种 Overlay (搜索、历史、建议)
│
└── 生命周期
    ├── SessionStart Hook
    ├── 延迟预取 (startDeferredPrefetches)
    ├── 成本追踪
    └── 会话持久化
```

**REPL 为什么这么大？**

这是一个值得讨论的架构问题。875KB 的单文件组件显然不是理想的代码组织方式。但 REPL 的复杂性来自于它是**所有子系统的汇聚点**——消息渲染、工具执行、权限检查、MCP 连接、输入处理、会话管理……这些子系统之间存在大量的交互和共享状态。

将 REPL 拆分成更小的组件是可能的，但会引入大量的 props drilling 或 Context 传递。当前的"大组件 + 提取 Hooks"模式是一个务实的折中：核心编排逻辑集中在一个文件中（便于理解整体流程），具体的子行为通过自定义 Hooks 提取到独立文件中（便于复用和测试）。

---

## 12.4 全屏布局与滚动系统

### 面临的问题

终端有两种屏幕模式：

1. **主屏幕（Main Screen）**：输出追加到终端的 scrollback buffer 中，用户可以用终端自带的滚动条回看历史。但应用无法控制 scrollback 中的内容——一旦写入就不可修改。

2. **备用屏幕（Alternate Screen，DEC 1049）**：应用接管整个终端窗口，可以在任意位置绘制内容。没有 scrollback，滚动需要应用自己实现。退出时恢复原始屏幕内容。

Claude Code 面临的选择：**用主屏幕还是备用屏幕？**

- 主屏幕的优势：用户可以用终端原生滚动回看历史，退出后历史仍然可见
- 主屏幕的劣势：无法实现固定位置的 UI 元素（输入框、状态栏），无法实现鼠标交互，无法精确控制布局
- 备用屏幕的优势：完全控制屏幕，可以实现任意布局和交互
- 备用屏幕的劣势：退出后历史消失，需要自己实现滚动

### 解法：双模式支持 + AlternateScreen 组件

Claude Code 同时支持两种模式，通过 `FullscreenLayout` 组件在备用屏幕模式下提供完整的布局管理：

```typescript
// components/FullscreenLayout.tsx — 简化结构

function FullscreenLayout({ children, promptInput, spinner, permissionRequest }) {
  return (
    <AlternateScreen mouseTracking={true}>
      {/* 主内容区：可滚动的消息列表 */}
      <ScrollBox
        ref={scrollBoxRef}
        stickyScroll={true}
        flexGrow={1}
      >
        {children}  {/* Messages */}

        {/* 粘性提示头：当前轮次的用户输入固定在视口顶部 */}
        <StickyPromptHeader />
      </ScrollBox>

      {/* "N 条新消息" 提示药丸 */}
      <NewMessagesPill count={unseenCount} />

      {/* 底部固定区域 */}
      <Box flexDirection="column">
        {spinner}
        {permissionRequest}
        {promptInput}
        <StatusLine />
      </Box>
    </AlternateScreen>
  );
}
```

**`AlternateScreen` 组件**是进入全屏模式的关键：

```typescript
// ink/components/AlternateScreen.tsx — 简化

function AlternateScreen({ children, mouseTracking }) {
  useEffect(() => {
    // 进入备用屏幕
    stdout.write('\x1b[?1049h');  // DECSET 1049
    stdout.write('\x1b[2J\x1b[H');  // 清屏 + 光标归位

    if (mouseTracking) {
      // 启用 SGR 鼠标追踪（支持点击、拖拽、滚轮）
      stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    }

    // 通知 Ink 实例：现在在备用屏幕中
    ink.setAltScreenActive(true);

    return () => {
      // 退出时恢复
      stdout.write('\x1b[?1049l');
      ink.setAltScreenActive(false);
    };
  }, []);

  // 约束高度为终端行数（备用屏幕没有 scrollback）
  return (
    <Box height={terminalRows} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  );
}
```

### ScrollBox：终端中的滚动容器

`ScrollBox` 是全屏模式下最核心的组件——它在一个固定高度的区域内实现了内容滚动。

```
┌─────────────────────────────────────────┐
│  ScrollBox (height = terminalRows - N)   │
│  ┌─────────────────────────────────────┐ │
│  │  ← 视口（用户可见区域）              │ │
│  │                                      │ │
│  │  Message 1 (已滚出视口上方)          │ │  ← 不渲染（视口裁剪）
│  │  Message 2 (已滚出视口上方)          │ │  ← 不渲染
│  │  ─────── 视口顶部 ───────           │ │
│  │  Message 3                           │ │  ← 渲染
│  │  Message 4                           │ │  ← 渲染
│  │  Message 5 (正在流式输出...)          │ │  ← 渲染
│  │  ─────── 视口底部 ───────           │ │
│  │  (stickyScroll: 新内容自动滚到底)    │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

ScrollBox 的关键特性：

**1. 视口裁剪（Viewport Culling）**

只有在视口内的子节点才会被绘制到 Screen 缓冲区。视口外的节点虽然参与 Yoga 布局计算（需要知道它们的高度来确定滚动范围），但不会被 `renderNodeToOutput` 绘制。这是 O(可见内容) 而非 O(全部内容) 的关键。

**2. 粘性滚动（Sticky Scroll）**

当 `stickyScroll=true` 时，新内容追加到底部会自动滚动到最新位置——就像浏览器中 `scrollTop = scrollHeight` 的效果。这对于流式输出的 AI 响应至关重要：用户希望看到最新的输出，而不是手动滚动。

但粘性滚动有一个微妙的交互问题：**如果用户主动向上滚动查看历史，新内容不应该把他们拉回底部。** ScrollBox 通过检测用户是否在底部来决定是否自动滚动：

```typescript
// 只有当用户已经在底部时，才自动跟随新内容
if (isAtBottom && contentGrew) {
  scrollToBottom();
}
```

**3. 硬件滚动优化（DECSTBM）**

当内容只是简单地向上滚动（最常见的场景：新消息追加到底部），ScrollBox 可以利用终端的硬件滚动能力：

```
DECSTBM (Set Top and Bottom Margins):
  \x1b[top;bottomr    — 设置滚动区域
  \x1b[nS             — 向上滚动 n 行（硬件操作，极快）

优化效果：
  普通方式：重绘整个视口（200行 × 120列 = 24000 个 Cell）
  DECSTBM：硬件滚动 + 只绘制新出现的底部几行
```

这个优化在流式输出场景下效果显著——AI 每输出一个 token，屏幕只需要更新最后几行，而不是重绘整个消息列表。

**4. 命令式 API**

ScrollBox 暴露了一组命令式方法，供外部组件控制滚动：

```typescript
interface ScrollBoxHandle {
  scrollTo(y: number): void;
  scrollBy(delta: number): void;
  scrollToBottom(): void;
  scrollToElement(element: DOMElement): void;
  subscribe(callback: () => void): () => void;
}
```

`scrollToElement` 特别有用——当用户点击搜索结果时，需要滚动到对应的消息位置。它通过读取目标元素的 Yoga 布局位置来计算滚动偏移。

### "N 条新消息" 提示药丸

全屏模式下有一个精巧的 UX 细节：当用户向上滚动查看历史时，如果有新消息到达，屏幕底部会显示一个 "N new messages" 的提示药丸。

```typescript
// FullscreenLayout.tsx — 未读消息追踪（简化）

function useUnseenDivider(messages, scrollBoxRef) {
  const dividerYRef = useRef(0);
  const [unseenCount, setUnseenCount] = useState(0);

  // 当用户首次滚离底部时，记录当前位置作为"分界线"
  // 之后新增的 assistant 消息计入 unseenCount

  // 使用 useSyncExternalStore 订阅 ScrollBox 的滚动事件
  // 只在 "是否可见分界线" 这个布尔值变化时触发重渲染
  // 而不是每次滚动都重渲染
  const pillVisible = useSyncExternalStore(
    scrollBoxRef.current.subscribe,
    () => scrollTop < dividerYRef.current  // 快照函数
  );

  return { pillVisible, unseenCount };
}
```

**为什么用 `useSyncExternalStore` 而不是 `useState` + `onScroll`？**

滚动事件的频率极高（每帧都可能触发）。如果每次滚动都 `setState`，React 会为每次状态变化安排一次重渲染——即使 pill 的可见性没有变化。`useSyncExternalStore` 的快照函数只在返回值变化时触发重渲染，将 O(滚动事件数) 的重渲染降低到 O(可见性切换次数)。

### 粘性提示头（Sticky Prompt Header）

另一个全屏模式的 UX 细节：当消息列表很长时，用户可能看不到当前轮次的原始提问。`StickyPromptHeader` 将当前轮次的用户输入固定在视口顶部，类似于 Excel 的冻结行：

```
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │ 📌 > 请帮我重构 auth 模块          │ │  ← 粘性头：当前轮次的提问
│ └─────────────────────────────────────┘ │
│                                          │
│ 好的，我来分析一下 auth 模块的结构...    │
│ [读取文件 src/auth/index.ts]             │
│ [读取文件 src/auth/oauth.ts]             │
│ ...（很长的输出）...                     │
│ 基于分析，我建议以下重构方案：           │
└─────────────────────────────────────────┘
```

实现上，`StickyTracker` 组件以细粒度订阅 ScrollBox 的滚动事件（不使用量化的 SCROLL_QUANTUM），向后遍历已挂载的消息范围，找到视口顶部对应的用户消息，并通过 `ScrollChromeContext` 将其文本传递给粘性头组件。

```typescript
// VirtualMessageList.tsx — StickyTracker（简化）

function StickyTracker({ scrollBox, messages }) {
  // 用 WeakMap 缓存消息文本（消息是 append-only 的，不会变化）
  const promptCache = useRef(new WeakMap());

  // 细粒度滚动订阅
  useEffect(() => {
    return scrollBox.subscribe(() => {
      // 从视口顶部向后遍历，找到第一个用户消息
      const stickyMessage = findPromptAtViewportTop(messages, scrollBox);
      if (stickyMessage) {
        scrollChrome.setStickyPrompt(promptCache.get(stickyMessage));
      }
    });
  }, []);
}
```

**抑制状态机**：为了避免粘性头在快速滚动时频繁闪烁，`StickyTracker` 使用了一个三态状态机（`'none' | 'armed' | 'force'`）来去重更新——只有当粘性消息的索引真正变化时才更新 UI。

### 设计决策讨论

**为什么默认使用全屏模式而不是主屏幕模式？**

Claude Code 最初使用主屏幕模式（输出追加到 scrollback）。但随着功能复杂度增长，主屏幕模式的局限性越来越明显：

1. **无法实现固定输入框**：在主屏幕模式下，输入框会随着输出被推上去。每次需要重绘输入框时，都要先清除旧位置再在新位置绘制，导致闪烁。
2. **无法实现鼠标交互**：主屏幕模式下的鼠标坐标会受到 scrollback 偏移的影响，难以准确映射到 UI 元素。
3. **无法实现精确的权限对话框布局**：权限对话框需要在消息和输入框之间插入，主屏幕模式下这种布局很难实现。

全屏模式的代价是退出后历史消失。Claude Code 通过 `/export` 命令和会话持久化来弥补这个缺陷。

**为什么 ScrollBox 的滚动状态存在 DOM 节点上而不是 React 状态中？**

```typescript
// 滚动状态直接存在 DOMElement 上
node.scrollTop = newScrollTop;
node.pendingScrollDelta = delta;
node.scrollAnchor = { element, offset };
```

因为滚动是一个**高频操作**（鼠标滚轮每帧都可能触发），如果每次滚动都通过 `setState` 触发 React 重渲染，开销太大。将滚动状态存在 DOM 节点上，可以在渲染管线的 Paint 阶段直接读取，跳过 React 的调度和 Reconciliation 阶段。

这是一个 **"绕过 React 的声明式模型以获取性能"** 的决策。代价是滚动逻辑变成了命令式的，更难理解和调试。但对于滚动这种性能敏感的操作，这个 trade-off 是值得的。

---

## 12.5 事件系统：从原始字节到结构化交互

### 面临的问题

终端的输入是一个**无结构的字节流**。当用户按下 `Ctrl+A`，stdin 收到的是字节 `0x01`；按下方向键 `↑`，收到的是转义序列 `\x1b[A`；按下 `Shift+Enter`（在支持 Kitty 协议的终端中），收到的是 `\x1b[13;2u`。

更复杂的是：

1. **转义序列可能不完整**：网络延迟或终端缓冲可能导致一个转义序列被分成多次 `data` 事件到达
2. **粘贴内容混在按键中**：用户粘贴一段文本时，终端会发送括号粘贴标记（`\x1b[200~` ... `\x1b[201~`），但中间的内容可能包含看起来像转义序列的字节
3. **终端响应混在输入中**：终端对查询的响应（如设备属性 DA1、光标位置 CPR）也通过 stdin 到达，需要与用户输入区分
4. **不同终端的键盘协议不同**：Kitty 用 CSI u 编码，xterm 用 modifyOtherKeys，传统终端用 legacy 转义序列

Claude Code 需要将这些原始字节解析为结构化的事件，然后通过一个类似浏览器 DOM 的事件分发系统路由到正确的处理器。

### 解法：四层事件处理架构

```
stdin (原始字节流)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 层 1: 字节解析 (parse-keypress.ts)                    │
│ 原始字节 → Token → ParsedKey                         │
│ • 转义序列分词器 (tokenizer)                          │
│ • 多协议键盘解析 (CSI u / modifyOtherKeys / legacy)   │
│ • 终端响应识别 (DA1, DECRPM, XTVERSION)               │
│ • 括号粘贴检测 (isPasted 标记)                        │
│ • 不完整序列超时处理                                   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 层 2: 事件创建 (events/input-event.ts)                │
│ ParsedKey → InputEvent / KeyboardEvent / MouseEvent  │
│ • 修饰键标准化 (ctrl, shift, meta, fn, super)         │
│ • 特殊键映射 (arrow, home, end, pageUp/Down)          │
│ • 鼠标事件坐标解析                                    │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 层 3: 事件分发 (events/dispatcher.ts)                 │
│ 类浏览器的捕获/冒泡两阶段分发                          │
│ • 从目标节点到根节点收集监听器                         │
│ • 捕获阶段：根 → 目标（从外到内）                      │
│ • 冒泡阶段：目标 → 根（从内到外）                      │
│ • stopPropagation / stopImmediatePropagation          │
│ • React 调度优先级集成 (discrete / continuous)         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 层 4: 快捷键解析 (keybindings/)                       │
│ InputEvent → Action                                   │
│ • 和弦序列 (chord) 支持：Ctrl+K → Ctrl+C             │
│ • 上下文感知：不同 UI 状态下同一按键触发不同动作       │
│ • 优先级解析：最后注册的绑定优先（用户覆盖）           │
└─────────────────────────────────────────────────────┘
```

### 层 1: 字节解析 — 从 stdin 到 ParsedKey

`parse-keypress.ts` 是整个输入系统的基础。它将 stdin 的原始字节流解析为结构化的 `ParsedKey` 对象。

```typescript
// parse-keypress.ts — 核心类型

type ParsedKey = {
  name: string;        // 'a', 'return', 'up', 'f1', ...
  sequence: string;    // 原始转义序列
  ctrl: boolean;
  shift: boolean;
  meta: boolean;       // Alt/Option
  fn: boolean;
  superKey: boolean;
  isPasted: boolean;   // 是否来自括号粘贴
};
```

解析过程分两步：

**第一步：分词（Tokenization）**

将字节流切分为独立的 token。每个 token 要么是一个完整的转义序列，要么是一个普通字符。

```
输入字节: \x1b [ 1 ; 2 A h e l l o
分词结果: [\x1b[1;2A] [h] [e] [l] [l] [o]
           ↑ Shift+Up   ↑ 普通字符
```

**第二步：协议解析**

根据 token 的格式识别键盘协议并解析：

```typescript
// CSI u (Kitty 键盘协议): \x1b[<keycode>;<modifiers>u
// 例: \x1b[13;2u = Shift+Enter (keycode=13, modifiers=2=shift)

// modifyOtherKeys (xterm): \x1b[27;<modifiers>;<keycode>~
// 例: \x1b[27;5;99~ = Ctrl+C (modifiers=5=ctrl, keycode=99='c')

// Legacy: \x1b[A = Up, \x1b[1;2A = Shift+Up
// 修饰键编码在参数中: 2=shift, 3=alt, 5=ctrl, ...

// SGR 鼠标: \x1b[<button;col;row M/m
// 例: \x1b[0;42;15M = 左键按下 at (42, 15)
```

**不完整序列的处理**是一个微妙的问题：

```typescript
// App.tsx — 不完整转义序列处理

function handleReadable() {
  const { keys, remaining } = parseMultipleKeypresses(data, parseState);

  if (remaining) {
    // 有未完成的转义序列，设置超时
    // 正常按键：50ms 超时（区分 Esc 键和转义序列前缀）
    // 粘贴模式：500ms 超时（粘贴内容可能很大，分多次到达）
    parseState.timeout = setTimeout(() => {
      // 超时后，将剩余字节作为独立按键处理
      flushRemaining(remaining);
    }, isPasting ? 500 : 50);
  }
}
```

**为什么需要超时？** 因为 `Esc` 键本身的编码就是 `\x1b`，而所有转义序列也以 `\x1b` 开头。当收到一个孤立的 `\x1b` 时，无法立即判断它是 Esc 键还是转义序列的开头。解决方案是等待一小段时间：如果后续字节到达，说明是转义序列；如果超时，说明是 Esc 键。50ms 的超时在实践中足够区分这两种情况。

### 层 2: 事件创建

`ParsedKey` 被转换为更高层的事件对象：

```typescript
// events/input-event.ts

type Key = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  fn: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
};

type InputEvent = {
  input: string;          // 要插入的字符（如 'a', '你'）
  key: Key;               // 结构化的修饰键/特殊键标志
  keypress: ParsedKey;    // 原始解析结果（包含 isPasted）
};
```

这个转换层的意义在于**抽象掉协议差异**。无论底层是 Kitty 协议还是 legacy 转义序列，上层代码看到的都是统一的 `Key` 结构。

### 层 3: 事件分发 — 类浏览器的捕获/冒泡模型

这是 Claude Code 对 Ink 最重要的扩展之一。标准 Ink 的事件处理是简单的回调注册，没有事件传播的概念。Claude Code 实现了一个完整的 DOM 事件分发系统：

```typescript
// events/dispatcher.ts — 两阶段分发（简化）

function dispatch(event: TerminalEvent, target: DOMElement): void {
  // 收集从目标到根的路径
  const path: DOMElement[] = [];
  let node = target;
  while (node) {
    path.push(node);
    node = node.parentNode;
  }

  // 阶段 1: 捕获（从根到目标）
  for (let i = path.length - 1; i >= 0; i--) {
    event._prepareForTarget(path[i]);
    const handlers = path[i].captureHandlers[event.type];
    for (const handler of handlers) {
      handler(event);
      if (event.immediatePropagationStopped) return;
    }
    if (event.propagationStopped) break;
  }

  // 阶段 2: 冒泡（从目标到根）
  for (let i = 0; i < path.length; i++) {
    event._prepareForTarget(path[i]);
    const handlers = path[i].bubbleHandlers[event.type];
    for (const handler of handlers) {
      handler(event);
      if (event.immediatePropagationStopped) return;
    }
    if (event.propagationStopped) break;
  }
}
```

**为什么需要捕获/冒泡模型？**

考虑这个场景：用户在权限对话框中按下 `Enter`。这个按键应该被对话框的"确认"按钮处理，而不是被底层的输入框处理。在简单的回调模型中，需要手动管理"谁应该处理这个事件"的逻辑。而在捕获/冒泡模型中，对话框可以在冒泡阶段拦截事件并调用 `stopPropagation()`，自然地阻止事件到达输入框。

**事件优先级与 React 调度集成**：

```typescript
// 不同事件类型映射到不同的 React 调度优先级
const eventPriorities = {
  // 离散事件：立即处理（用户期望即时响应）
  keyboard: DiscreteEventPriority,
  click: DiscreteEventPriority,
  focus: DiscreteEventPriority,
  paste: DiscreteEventPriority,

  // 连续事件：可以合并（高频，不需要每次都响应）
  resize: ContinuousEventPriority,
  scroll: ContinuousEventPriority,
  mousemove: ContinuousEventPriority,
};
```

这确保了键盘输入总是以最高优先级处理（用户打字时不应该感到延迟），而滚动和鼠标移动可以被合并（跳过中间帧，只处理最新状态）。

### 层 4: 快捷键系统 — 和弦、上下文与优先级

快捷键系统是输入处理的最上层，它将 `InputEvent` 映射为应用级的 `Action`。

```
按键事件
    │
    ▼
ChordInterceptor (拦截所有按键)
    │
    ├─ 是否是和弦的第一个键？
    │   ├─ YES → 进入和弦等待状态（1000ms 超时）
    │   │         等待第二个键...
    │   │         ├─ 第二个键匹配 → 触发和弦动作
    │   │         ├─ 第二个键不匹配 → 取消和弦，正常处理
    │   │         └─ 超时 → 取消和弦
    │   └─ NO  ↓
    │
    ▼
resolveKey (单键解析)
    │
    ├─ 遍历活跃上下文（优先级从高到低）
    │   ├─ 当前组件上下文（如 HistorySearch）
    │   ├─ 注册的活跃上下文
    │   └─ Global 上下文（兜底）
    │
    ├─ 在每个上下文中查找匹配的绑定
    │   └─ 最后注册的绑定优先（用户覆盖内置）
    │
    └─ 返回: 'match' + action | 'none' | 'unbound'
```

**和弦（Chord）** 是一个重要的交互模式。例如 `Ctrl+K, Ctrl+C` 是一个两键和弦——用户先按 `Ctrl+K`，然后在 1 秒内按 `Ctrl+C`，触发一个特定动作。

```typescript
// keybindings/KeybindingProviderSetup.tsx — 和弦处理（简化）

function ChordInterceptor({ children }) {
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null);
  const chordTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useInput((input, key, event) => {
    const result = resolveKeyWithChordState(
      input, key, activeContexts, bindings, pendingChordRef.current
    );

    switch (result.type) {
      case 'chord_started':
        // 第一个键匹配了某个和弦的前缀
        pendingChordRef.current = result.pending;
        chordTimeoutRef.current = setTimeout(() => {
          // 1000ms 超时，取消和弦
          pendingChordRef.current = null;
        }, 1000);
        event.stopImmediatePropagation();  // 阻止其他处理器
        break;

      case 'match':
        // 找到匹配的动作（单键或和弦完成）
        pendingChordRef.current = null;
        invokeAction(result.action);
        event.stopImmediatePropagation();
        break;

      case 'none':
        // 没有匹配，让事件继续传播
        break;
    }
  });

  return children;
}
```

**上下文感知**是快捷键系统的另一个关键特性。同一个按键在不同的 UI 状态下可能触发不同的动作：

```typescript
// 在全局上下文中，Ctrl+R 触发历史搜索
useKeybinding('history:search', handleStartSearch, {
  context: 'Global',
  isActive: !isSearching,
});

// 在历史搜索上下文中，Ctrl+R 触发"下一个匹配"
useKeybindings({
  'historySearch:next': handleNextMatch,
  'historySearch:accept': handleAccept,
  'historySearch:cancel': handleCancel,
}, {
  context: 'HistorySearch',
  isActive: isSearching,
});
```

当 `isSearching` 为 true 时，`HistorySearch` 上下文被激活，它的优先级高于 `Global`，所以 `Ctrl+R` 会触发 `historySearch:next` 而不是 `history:search`。

**为什么和弦状态用 `useRef` 而不是 `useState`？**

因为和弦状态需要在**同一个事件处理周期内**被读取和修改。`useState` 的更新是异步的（React 会批处理），在当前事件处理器中读到的仍然是旧值。`useRef` 提供同步的读写，确保和弦状态机的转换是即时的。

### 焦点管理

Claude Code 实现了一个类似浏览器的焦点管理系统：

```typescript
// ink/focus.ts — 焦点管理器

class FocusManager {
  activeElement: DOMElement | null = null;
  focusStack: DOMElement[] = [];  // 最大 32 层

  focus(element: DOMElement): void {
    const prev = this.activeElement;
    if (prev === element) return;

    // 触发 blur 事件
    if (prev) dispatch(new FocusEvent('blur', prev));

    // 更新焦点
    this.activeElement = element;
    this.focusStack.push(element);

    // 触发 focus 事件
    dispatch(new FocusEvent('focus', element));
  }

  // 当节点被移除时，从焦点栈中清除并恢复上一个焦点
  handleNodeRemoval(node: DOMElement): void {
    this.focusStack = this.focusStack.filter(n => n !== node);
    if (this.activeElement === node) {
      this.activeElement = this.focusStack[this.focusStack.length - 1] ?? null;
    }
  }

  // Tab 键循环
  focusNext(): void {
    const tabbable = collectTabbableElements(this.root);
    const currentIndex = tabbable.indexOf(this.activeElement);
    this.focus(tabbable[(currentIndex + 1) % tabbable.length]);
  }
}
```

**焦点栈**解决了一个常见的 UI 问题：当一个模态对话框（如权限确认）打开时，焦点移到对话框上；当对话框关闭时，焦点应该恢复到之前的元素（输入框）。焦点栈自动管理这个恢复过程。

### 文本选择

全屏模式下，Claude Code 支持鼠标拖拽选择文本并复制——这在终端应用中是罕见的能力。

```typescript
// ink/selection.ts — 文本选择状态

type SelectionState = {
  anchor: Point;           // 选择起点（鼠标按下位置）
  focus: Point;            // 选择终点（当前鼠标位置）
  mode: 'char' | 'word' | 'line';  // 选择粒度
  anchorSpan?: [Point, Point];      // word/line 模式下的锚点范围

  // 拖拽滚动时的累积文本
  scrolledOffAbove: string[];  // 向上滚出视口的已选文本行
  scrolledOffBelow: string[];  // 向下滚出视口的已选文本行
};
```

选择模式通过多击检测确定：
- **单击**：字符级选择（`mode: 'char'`）
- **双击**：词级选择（`mode: 'word'`），使用 iTerm2 兼容的词边界定义
- **三击**：行级选择（`mode: 'line'`）

**拖拽滚动**是一个特别复杂的场景：当用户拖拽选择到视口边缘时，内容需要自动滚动，同时已经滚出视口的选中文本需要被保存（因为它们不再在屏幕上可见，无法从 Screen 缓冲区读取）。`scrolledOffAbove` 和 `scrolledOffBelow` 数组就是用来存储这些"滚出视口的选中文本"的。

**选择覆盖层**在渲染管线的最后阶段应用：

```typescript
// ink.tsx — onRender() 中的选择覆盖

// 在 Screen 缓冲区生成后、帧差分之前，应用选择高亮
if (selection.hasSelection()) {
  for (const [row, colStart, colEnd] of selection.getSelectedRanges()) {
    for (let col = colStart; col <= colEnd; col++) {
      // 将选中 Cell 的样式替换为反色（保留前景色，替换背景色）
      screen.cells[row * width + col].styleId =
        stylePool.withSelectionBg(originalStyleId, selectionBgColor);
    }
  }
}
```

**`noSelect` 位图**标记了不应该被选中的区域（如行号、边框、Diff 标记符）。当用户复制选中文本时，这些区域会被跳过，确保复制的内容是纯文本而不包含 UI 装饰。

### 设计决策讨论

**为什么要实现自己的事件系统，而不是用 Node.js 的 EventEmitter？**

`EventEmitter` 是一个扁平的发布/订阅模型——所有监听器平等地接收事件，没有传播控制。但终端 UI 有**层次结构**：对话框在输入框之上，搜索框在消息列表之上。事件需要按照这个层次结构传播，内层组件需要能够拦截事件阻止外层处理。

捕获/冒泡模型是浏览器 DOM 事件的标准模型，经过数十年的验证，是处理层次化 UI 事件的最佳实践。Claude Code 将这个模型移植到终端环境中，是一个**"将成熟的 Web 模式应用到终端"**的决策。

**为什么文本选择需要 `softWrap` 标记？**

当用户复制选中的文本时，需要区分"源码中的换行"和"终端自动换行"。如果一行文本因为太长被终端自动换行成两行，复制时应该合并为一行（因为源码中它就是一行）。`softWrap` 标记记录了哪些行是自动换行的结果，复制逻辑据此决定是否插入换行符。

---

## 12.6 核心 UI 组件：消息渲染与虚拟化

### 面临的问题

一次 Claude Code 对话可能产生数百条消息——用户输入、AI 文本回复、工具调用、工具结果、思考过程、系统消息、附件……每条消息的渲染复杂度各不相同：纯文本只需要 Markdown 格式化，而工具调用需要展示工具名称、输入参数、执行进度、权限状态。

这带来两个核心挑战：

1. **类型多样性**：十几种消息类型，每种有不同的渲染逻辑。如何组织这些渲染器？
2. **性能**：数百条消息全部渲染会导致 React 树巨大，Yoga 布局计算缓慢，Screen 缓冲区绘制耗时。如何只渲染用户能看到的部分？

### 解法：分发器模式 + 双层虚拟化

#### 消息渲染的分发器模式

消息渲染采用三层结构：编排层 → 行包装层 → 类型分发层 → 专用渲染器。

```
Messages.tsx (编排层)
  │  规范化、过滤、分组消息列表
  │  管理虚拟滚动
  ▼
MessageRow.tsx (行包装层)
  │  时间戳、模型信息、进度查找
  │  条件性静态渲染
  ▼
Message.tsx (类型分发层)
  │  switch(message.type)
  ├─→ AssistantTextMessage      (AI 文本回复)
  ├─→ AssistantThinkingMessage  (思考过程)
  ├─→ AssistantToolUseMessage   (工具调用)
  ├─→ UserTextMessage           (用户输入)
  ├─→ UserToolResultMessage     (工具结果)
  ├─→ SystemTextMessage         (系统消息)
  ├─→ AttachmentMessage         (附件)
  └─→ GroupedToolUseContent     (折叠的工具调用组)
```

`Message.tsx` 是核心分发器——它接收一个规范化的消息对象，根据 `message.type` 路由到对应的专用渲染组件：

```typescript
// components/Message.tsx — 类型分发（简化）

function Message({ message, tools, commands, isStatic }) {
  switch (message.type) {
    case 'assistant_text':
      return <AssistantTextMessage block={message} />;

    case 'assistant_thinking':
      return <AssistantThinkingMessage block={message} />;

    case 'assistant_tool_use':
      // 动态查找工具元数据，解析输入，计算进度状态
      const tool = findToolByName(message.toolName, tools);
      return <AssistantToolUseMessage
        block={message}
        tool={tool}
        progress={lookupProgress(message.id)}
      />;

    case 'user_text':
      return <UserTextMessage message={message} />;

    // ... 其他类型
  }
}
```

**为什么用分发器模式而不是继承或策略模式？**

因为每种消息类型的渲染逻辑差异巨大——`AssistantTextMessage` 需要 Markdown 渲染和错误类型检测，`AssistantToolUseMessage` 需要工具注册表查找和权限状态集成，`UserToolResultMessage` 需要展示 Diff 或代码高亮。这些差异不适合用继承抽象（没有有意义的公共基类），分发器 + 独立组件是最直接的组织方式。

这个模式的扩展性也很好：新增一种消息类型只需要添加一个 `case` 分支和一个新的渲染组件，不影响其他类型。

#### 双层虚拟化：VirtualMessageList + OffscreenFreeze

消息列表的性能优化分为两层：

**第一层：VirtualMessageList — React 级虚拟化**

`VirtualMessageList` 只挂载视口内（加上 overscan 缓冲区）的消息组件到 React 树中。视口外的消息不创建 React 元素，不参与 Reconciliation，不占用 Fiber 节点。

```typescript
// components/VirtualMessageList.tsx — 核心虚拟化逻辑（简化）

function VirtualMessageList({ messages }) {
  // useVirtualScroll 管理可见范围
  const { range, topSpacer, bottomSpacer } = useVirtualScroll({
    itemCount: messages.length,
    overscan: 80,  // 视口外额外挂载 80 行的缓冲区
  });

  return (
    <>
      {/* 顶部占位：用空 Box 撑出未挂载消息的高度 */}
      <Box height={topSpacer} />

      {/* 只渲染可见范围内的消息 */}
      {messages.slice(range.start, range.end).map((msg, i) => (
        <VirtualItem key={keys[range.start + i]} index={range.start + i}>
          <MessageRow message={msg} />
        </VirtualItem>
      ))}

      {/* 底部占位 */}
      <Box height={bottomSpacer} />
    </>
  );
}
```

**增量 key 数组**是一个值得注意的优化：每次新消息追加时，只 push 新的 key，而不是重新生成整个 key 数组。这避免了 O(n) 的数组分配。

**滚动量化（Scroll Quantum）**：`useVirtualScroll` 不会在每次滚动时都重新计算可见范围。它将滚动位置量化到 40 行的 bin 中——只有当滚动跨越 bin 边界时才触发 React 重渲染。这将滚动引起的 React commit 次数从 O(滚动像素数) 降低到 O(滚动像素数 / 40)。

**第二层：OffscreenFreeze — 渲染级冻结**

即使在虚拟化的可见范围内，也可能有消息虽然在 React 树中但已经滚出了终端视口（因为 overscan 缓冲区）。`OffscreenFreeze` 冻结这些组件的渲染输出：

```typescript
// components/OffscreenFreeze.tsx

export function OffscreenFreeze({ children }: Props): React.ReactNode {
  'use no memo';  // 禁用 React Compiler 的自动 memo

  const inVirtualList = useContext(InVirtualListContext);
  const [ref, { isVisible }] = useTerminalViewport();
  const cached = useRef(children);

  // 只有当组件在终端视口内可见时，才更新缓存
  if (isVisible || inVirtualList) {
    cached.current = children;
  }

  // 返回缓存的 children——如果不可见，返回的是旧的 ReactElement
  // React 的 Reconciler 对相同引用的 ReactElement 会跳过 Diff
  return <Box ref={ref}>{cached.current}</Box>;
}
```

**为什么需要 `'use no memo'`？**

React Compiler（React 19）会自动为组件添加 memoization。但 `OffscreenFreeze` 的核心机制恰恰依赖于**不** memo——它需要在不可见时返回**旧的** children 引用（而不是 memo 后的新引用），这样 React 才会跳过 Diff。`'use no memo'` 指令告诉 React Compiler 不要优化这个组件。

**两层虚拟化的协作关系：**

```
全部消息 (可能数百条)
    │
    ▼ VirtualMessageList 过滤
可见范围 + overscan (约 20-50 条)
    │  这些消息被挂载到 React 树
    │
    ▼ OffscreenFreeze 冻结
实际绘制 (约 10-20 条)
    │  只有终端视口内可见的消息会更新渲染输出
    │  视口外但已挂载的消息返回缓存的旧输出
    │
    ▼ ScrollBox 视口裁剪
最终输出 (终端可见行数)
    │  只有视口内的像素被写入 Screen 缓冲区
```

**为什么需要两层而不是一层？**

单纯的 React 级虚拟化（VirtualMessageList）解决了"不创建不需要的 React 元素"的问题，但已挂载的元素在状态变化时仍然会重新渲染。`OffscreenFreeze` 解决了"已挂载但不可见的元素不需要更新"的问题。

一个典型的场景：AI 正在流式输出回复，最新的消息在屏幕底部不断更新。此时屏幕上方的旧消息虽然在 React 树中（因为 overscan），但它们的内容不会变化。`OffscreenFreeze` 确保这些旧消息不会因为 React 的重渲染而被重新绘制。

#### 搜索与导航

`VirtualMessageList` 还集成了全文搜索功能，这在虚拟化列表中是一个特别棘手的问题——搜索目标可能在未挂载的消息中。

解决方案是**两阶段跳转**：

```
用户搜索 "foo"
    │
    ▼
阶段 1: 粗粒度跳转
  scrollToIndex(targetMessageIndex)
  → 触发 VirtualMessageList 挂载目标消息
  → 等待一帧让 React 渲染完成
    │
    ▼
阶段 2: 精确定位
  scanElement(targetMessage) → 找到匹配位置的行/列
  scrollTo(精确像素位置)
  setPositions(高亮坐标)
```

**幻影突发上限（Phantom-burst cap）**：搜索匹配可能出现在渲染后才可见的内容中（比如折叠的工具输出展开后）。为了防止自动跳转陷入无限循环，系统设置了 20 次的幻影突发上限——超过后停止自动前进。

---

## 12.7 输入组件：从按键到文本编辑

### 面临的问题

Claude Code 的输入框不是一个简单的 `readline`——它是一个功能完整的文本编辑器：

1. **多行编辑**：用户可以输入多行文本（Shift+Enter 换行）
2. **Emacs 快捷键**：Ctrl+A/E（行首/行尾）、Ctrl+W（删词）、Ctrl+K（删到行尾）等
3. **Vim 模式**：完整的 Normal/Insert 模式切换、motion、operator、text object
4. **粘贴检测**：区分用户打字和粘贴操作，粘贴时跳过逐字符处理
5. **历史搜索**：Ctrl+R 反向搜索历史命令
6. **自动补全**：斜杠命令、文件路径的 typeahead 补全
7. **图片粘贴**：检测剪贴板中的图片并作为附件处理

终端没有 `<textarea>` 或 `contenteditable`，所有这些都需要从原始按键事件手动实现。

### 解法：分层输入处理管线

```
InputEvent (来自事件系统)
    │
    ▼
┌─────────────────────────────────────────────┐
│ PromptInput.tsx (编排层)                      │
│ 决定使用哪种输入模式、管理 overlay 状态       │
│ ┌─────────────┐  ┌──────────────┐           │
│ │ TextInput   │  │ VimTextInput │           │
│ │ (Emacs 模式) │  │ (Vim 模式)   │           │
│ └──────┬──────┘  └──────┬───────┘           │
└────────┼────────────────┼───────────────────┘
         │                │
         ▼                ▼
┌─────────────────────────────────────────────┐
│ BaseTextInput.tsx (渲染层)                    │
│ 将文本状态渲染为终端输出                      │
│ 集成 usePasteHandler                         │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ useTextInput.ts (文本编辑逻辑)                │
│ Cursor 抽象：文本 + 偏移量 + 编辑操作         │
│ Emacs 快捷键映射                              │
└─────────────────────────────────────────────┘
         │
         ▼ (Vim 模式额外包装)
┌─────────────────────────────────────────────┐
│ useVimInput.ts (Vim 状态机)                   │
│ Normal/Insert 模式切换                        │
│ Motion + Operator + Count 组合                │
│ Text Object 支持                              │
└─────────────────────────────────────────────┘
```

### useTextInput：Cursor 抽象与 Emacs 快捷键

`useTextInput` 是文本编辑的核心 Hook。它围绕一个 `Cursor` 抽象构建——`Cursor` 封装了"文本内容 + 光标偏移量"，并提供所有编辑操作：

```typescript
// hooks/useTextInput.ts — 核心输入处理（简化）

function useTextInput({ onChange, onSubmit }) {
  const [cursor, setCursor] = useState(new Cursor('', 0));

  function onInput(input: string, key: Key) {
    let nextCursor: Cursor;

    // Ctrl 组合键 → Emacs 快捷键
    if (key.ctrl) {
      switch (input) {
        case 'a': nextCursor = cursor.startOfLine(); break;
        case 'e': nextCursor = cursor.endOfLine(); break;
        case 'b': nextCursor = cursor.left(); break;
        case 'f': nextCursor = cursor.right(); break;
        case 'w': nextCursor = cursor.deleteWordBackward(); break;
        case 'k': nextCursor = cursor.deleteToEnd(); break;
        case 'u': nextCursor = cursor.deleteToStart(); break;
        // ...
      }
    }
    // 特殊键
    else if (key.backspace) { nextCursor = cursor.backspace(); }
    else if (key.delete)    { nextCursor = cursor.deleteForward(); }
    else if (key.leftArrow && key.ctrl) { nextCursor = cursor.prevWord(); }
    else if (key.rightArrow && key.ctrl) { nextCursor = cursor.nextWord(); }
    // 普通字符 → 插入
    else { nextCursor = cursor.insert(input); }

    if (nextCursor && !cursor.equals(nextCursor)) {
      setCursor(nextCursor);
      onChange(nextCursor.text);
    }
  }

  return { onInput, cursor };
}
```

`Cursor` 是一个**不可变值对象**——每次编辑操作返回一个新的 `Cursor` 实例，而不是修改原有实例。这与 React 的不可变状态模型完美契合，也使得撤销/重做（如果需要）变得简单。

### usePasteHandler：粘贴检测

粘贴检测是一个看似简单但实际复杂的问题。用户粘贴一段文本时，终端会快速发送大量字符——如果逐字符处理，每个字符都会触发一次状态更新和重渲染，导致严重的性能问题。

```typescript
// hooks/usePasteHandler.ts — 多策略粘贴检测（简化）

function usePasteHandler({ onInput, onPaste }) {
  const [pasteChunks, setPasteChunks] = useState<string[]>([]);

  function wrappedOnInput(input: string, key: Key, event: InputEvent) {
    const isFromPaste = event.keypress.isPasted;  // 括号粘贴模式标记

    // 检测策略（优先级从高到低）：
    // 1. 括号粘贴模式：终端发送 \x1b[200~ ... \x1b[201~ 包裹
    // 2. 大块输入：单次 input 超过 512 字符
    // 3. 图片文件路径：macOS 拖拽图片到终端
    // 4. 空粘贴：macOS 剪贴板中是图片时的空输入

    if (isFromPaste || input.length > PASTE_THRESHOLD) {
      // 累积粘贴块，设置超时
      setPasteChunks(prev => [...prev, input]);
      resetPasteTimeout(() => {
        // 超时后，将所有累积的块合并为一次粘贴
        const fullText = pasteChunks.join('');
        onPaste(fullText);
        setPasteChunks([]);
      });
      return;  // 不调用 onInput
    }

    // 非粘贴：正常处理
    onInput(input, key);
  }

  return { wrappedOnInput, isPasting: pasteChunks.length > 0 };
}
```

**为什么需要多策略检测？**

- **括号粘贴模式**是最可靠的检测方式，但不是所有终端都支持
- **大块输入检测**是兜底策略——人类不可能在一次 stdin read 中输入 512 个字符
- **图片检测**处理 macOS 特有的拖拽图片到终端的场景

### useVimInput：完整的 Vim 状态机

Vim 模式是 Claude Code 的一个差异化特性。`useVimInput` 在 `useTextInput` 之上包装了一个完整的 Vim 状态机：

```typescript
// hooks/useVimInput.ts — Vim 状态机类型

type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState };

type CommandState =
  | { type: 'idle' }                    // 等待输入
  | { type: 'count'; digits: string }   // 正在输入数字前缀 (3dw)
  | { type: 'operator'; op: Operator }  // 等待 motion (d_)
  | { type: 'find'; find: FindType }    // 等待字符 (f_)
  | { type: 'g'; count: number }        // g 前缀命令
  | { type: 'replace'; count: number }  // r 命令等待替换字符
  | { type: 'indent'; dir: '>' | '<' }  // 缩进命令
  // ... 更多状态
```

这是一个经典的**有限状态机**设计。Vim 的命令语法是 `[count] operator [count] motion`（如 `3dw` = 删除 3 个词），这种组合式语法天然适合用状态机建模：

```
NORMAL/idle
  │
  ├─ 数字 → NORMAL/count (累积数字)
  │           ├─ operator → NORMAL/operatorCount
  │           └─ motion → 执行 count × motion
  │
  ├─ d/c/y → NORMAL/operator (等待 motion)
  │           ├─ w/e/b/$ → 执行 operator + motion
  │           ├─ d/c/y → 执行 operator + 整行 (dd/cc/yy)
  │           └─ i/a → NORMAL/operatorTextObj (等待 text object)
  │
  ├─ i/a/o/A/I/O → INSERT 模式
  │
  ├─ h/j/k/l/w/e/b → 执行 motion
  │
  └─ f/F/t/T → NORMAL/find (等待目标字符)
```

**为什么要实现完整的 Vim 而不是简单的 vi 子集？**

Claude Code 的目标用户是开发者，其中相当比例是 Vim 用户。一个半吊子的 Vim 实现（只支持 hjkl 和 i/Esc）比没有 Vim 更糟糕——它会不断违反用户的肌肉记忆。要么不做，要么做到足够完整。

### PromptInput：输入区域的编排中枢

`PromptInput` 不只是一个输入框——它是整个 REPL 底部区域的编排中枢，集成了大量子功能：

```
PromptInput.tsx
├── 输入模式选择
│   ├── TextInput (Emacs 模式)
│   └── VimTextInput (Vim 模式)
│
├── 底部信息栏 (PromptInputFooter)
│   ├── 左侧：模型名称 · 权限模式 · 成本
│   ├── 右侧：快捷键提示
│   └── 建议行 (PromptInputFooterSuggestions)
│
├── 通知区域 (Notifications)
│   └── 临时通知消息
│
├── Overlay 层
│   ├── 历史搜索 (Ctrl+R)
│   ├── 全局搜索 (Ctrl+F)
│   ├── 快速打开 (Ctrl+O)
│   ├── 后台任务导航
│   └── 团队/Swarm 面板
│
├── 粘贴处理
│   ├── 文本粘贴 → 插入输入框
│   └── 图片粘贴 → 创建附件
│
└── 输入截断 (useMaybeTruncateInput)
    └── 超长输入的安全截断
```

**为什么 PromptInput 这么大？**

因为它是**用户交互的汇聚点**。用户的所有操作——打字、粘贴、快捷键、命令选择、模式切换——都通过这个组件路由。将这些功能拆分到独立组件中是可能的，但它们之间的交互非常紧密（比如历史搜索需要访问输入状态，粘贴需要知道当前是否在搜索模式中），拆分后的 props 传递会非常复杂。

当前的做法是**大组件 + 小 Hooks**：核心编排逻辑在 `PromptInput.tsx` 中，具体的子行为通过 Hooks 提取：

- `usePromptInputPlaceholder`：占位符文本逻辑
- `useMaybeTruncateInput`：输入截断逻辑
- `useShowFastIconHint`：快速模式提示
- `useSwarmBanner`：Swarm 模式横幅

---

## 12.8 样式与主题系统：终端中的设计语言

### 面临的问题

终端的样式能力远不如浏览器。浏览器有 CSS 的数千个属性，终端只有 ANSI SGR（Select Graphic Rendition）序列提供的有限能力：前景色、背景色、粗体、斜体、下划线、删除线、反色。

但 Claude Code 需要一个**一致的视觉语言**：

1. **语义化颜色**：错误用红色、成功用绿色、权限请求用特定颜色——这些不应该硬编码在每个组件中
2. **多主题支持**：深色终端和浅色终端需要不同的配色方案
3. **无障碍**：色觉障碍用户需要专门的配色（daltonized 主题）
4. **终端兼容性**：有些终端支持 24-bit 真彩色，有些只支持 256 色，有些只支持 16 色 ANSI

### 解法：语义化主题 + 多层颜色解析

```
组件代码                    主题层                    终端层
─────────                  ─────                    ─────
<ThemedText               ThemeProvider             ink/colorize.ts
  color="warning">        resolves "warning"        converts rgb(...)
  ⚠ 注意                  → rgb(234,179,8)          → ANSI escape
</ThemedText>                                        \x1b[38;2;234;179;8m
```

#### 主题定义：语义化 Token

`utils/theme.ts` 定义了完整的语义化颜色 Token 体系：

```typescript
// utils/theme.ts — Theme 类型（简化）

type Theme = {
  // 通用 UI
  text: string;           // 主文本色
  background: string;     // 背景色
  inactive: string;       // 非活跃元素
  subtle: string;         // 次要信息

  // 语义状态
  success: string;        // 成功（绿色系）
  error: string;          // 错误（红色系）
  warning: string;        // 警告（黄色系）

  // 产品语义
  claude: string;         // Claude 品牌色
  permission: string;     // 权限请求
  planMode: string;       // Plan 模式

  // Diff 颜色
  diffAdded: string;      // 新增行背景
  diffRemoved: string;    // 删除行背景
  diffAddedWord: string;  // 新增词高亮
  diffRemovedWord: string; // 删除词高亮

  // 动画/微光
  claudeShimmer: string;
  permissionShimmer: string;
  promptBorderShimmer: string;

  // 消息表面
  userMessageBackground: string;
  bashMessageBackgroundColor: string;
  selectionBg: string;
  // ... 更多 token
};
```

**为什么用语义化 Token 而不是直接用颜色值？**

因为同一个"含义"在不同主题下需要不同的颜色。比如"成功"在深色主题下是亮绿色（在深色背景上可读），在浅色主题下是深绿色（在浅色背景上可读）。语义化 Token 将"含义"和"颜色值"解耦，让主题切换只需要替换 Token 到颜色的映射。

#### 可用主题

```typescript
const THEME_NAMES = [
  'dark',              // 深色（默认）
  'light',             // 浅色
  'dark-daltonized',   // 深色无障碍（色觉障碍友好）
  'light-daltonized',  // 浅色无障碍
  'dark-ansi',         // 深色 ANSI（仅 16 色，兼容性最好）
  'light-ansi',        // 浅色 ANSI
];
```

Daltonized 主题的关键差异：将绿色系替换为蓝色系。比如 Diff 中的"新增行"，普通主题用绿色背景，daltonized 主题用蓝色背景——因为红绿色盲用户无法区分红色（删除）和绿色（新增），但可以区分红色和蓝色。

ANSI 主题只使用终端的 16 色调色板，不使用 RGB 颜色。这确保了在不支持真彩色的终端（如某些 SSH 环境）中也能正常显示。

#### 颜色解析管线

从语义 Token 到终端输出，颜色经过三层解析：

```
"warning"                          (语义 Token)
    │
    ▼ ThemeProvider / ThemedText
"rgb(234,179,8)"                   (原始颜色值)
    │
    ▼ ink/colorize.ts
"\x1b[38;2;234;179;8m"             (ANSI 转义序列)
    │
    ▼ 终端能力适配
    ├─ 真彩色终端 → 直接使用
    ├─ 256 色终端 → ansi256 近似
    └─ 16 色终端 → ANSI 名称映射
```

`ink/colorize.ts` 中有两个重要的终端适配逻辑：

```typescript
// 1. VS Code / xterm.js 环境：提升 chalk 颜色级别到真彩色
//    chalk 可能检测为 256 色，但 xterm.js 实际支持真彩色
function boostChalkLevelForXtermJs(): void {
  if (isXtermJs() && chalk.level < 3) {
    chalk.level = 3;  // truecolor
  }
}

// 2. tmux 环境：降级到 256 色
//    tmux 的颜色透传不总是可靠的
function clampChalkLevelForTmux(): void {
  if (isTmux() && !process.env.CLAUDE_CODE_FORCE_TRUECOLOR) {
    chalk.level = Math.min(chalk.level, 2);  // 256 color
  }
}
```

这体现了一个重要原则：**不信任自动检测，根据已知的终端行为主动适配。**

#### ANSI 作为交换格式

Claude Code 中有一个有趣的架构模式：**ANSI 不仅是输出格式，也是内部交换格式。**

多个子系统产生 ANSI 格式的字符串，然后通过 `<Ansi>` 组件解析回 Ink 的结构化文本：

```
Markdown 渲染器 ──→ ANSI 字符串 ──→ <Ansi> ──→ Ink Text 树
状态栏 Hook    ──→ ANSI 字符串 ──→ <Ansi> ──→ Ink Text 树
语法高亮器     ──→ ANSI 字符串 ──→ <Ansi> ──→ Ink Text 树
Diff 渲染器    ──→ ANSI 字符串 ──→ <RawAnsi> ──→ 直接写入 Screen
```

`<Ansi>` 组件使用 `ink/termio.ts` 中的流式 ANSI 解析器，将 ANSI 转义序列转换回结构化的 `<Text>` 和 `<Link>` 节点。

**为什么不直接生成 Ink 组件，而要绕一圈 ANSI？**

因为某些渲染器（如 Markdown 格式化器、语法高亮器）是独立的库或模块，它们的输出格式是 ANSI 字符串（这是终端生态的通用格式）。强制它们输出 Ink 组件会增加耦合度。ANSI 作为交换格式，让这些模块保持独立。

`<RawAnsi>` 是一个更激进的优化：它跳过 Ink 的文本渲染管线，将预格式化的 ANSI 字符串直接写入 Screen 缓冲区。这用于 Diff 渲染等性能敏感的场景——Diff 输出已经包含了精确的颜色和布局信息，不需要 Ink 再次处理。

#### Markdown 渲染

Markdown 是 Claude Code 中最常见的文本格式——AI 的回复几乎都是 Markdown。渲染管线：

```
AI 回复文本
    │
    ▼ utils/markdown.ts
marked.lexer() → Token 数组
    │
    ▼ formatTokens()
    ├─ 标题 → chalk.bold(text)
    ├─ 粗体 → chalk.bold(text)
    ├─ 斜体 → chalk.italic(text)
    ├─ 行内代码 → color('permission', theme)(text)
    ├─ 引用块 → dim(BLOCKQUOTE_BAR) + chalk.italic(text)
    ├─ 代码块 → 语法高亮（如果可用）
    └─ 表格 → <MarkdownTable> React 组件
    │
    ▼ components/Markdown.tsx
    ├─ 大部分内容 → <Ansi>{formattedText}</Ansi>
    └─ 表格 → <MarkdownTable> (专用 React 组件渲染)
```

**性能优化**：

- **模块级 Token 缓存**：LRU 缓存（上限 500 条），避免重复解析相同的 Markdown 文本
- **纯文本快速路径**：如果文本不包含任何 Markdown 语法标记，跳过 `marked.lexer()` 直接输出
- **懒加载语法高亮**：语法高亮器通过 `React.Suspense` + `use()` 懒加载，不阻塞首次渲染

一个有趣的细节：Markdown 解析器**禁用了删除线语法**（`~~text~~`）。原因是 AI 模型经常使用 `~100` 表示"大约 100"，如果启用删除线解析，`~100~` 会被错误地渲染为删除线文本。

#### Diff 与语法高亮

`native-ts/color-diff/index.ts` 是一个自包含的终端 Diff 渲染器，提供：

1. **语法高亮**：使用 `highlight.js`（懒加载），支持 Monokai（深色）和 GitHub（浅色）配色
2. **行级 Diff 着色**：新增行绿色背景、删除行红色背景
3. **词级 Diff 高亮**：在行内标记具体变化的词（只有当变化比例低于 40% 时才启用，避免噪音）
4. **终端颜色模式适配**：自动检测 truecolor / 256 色 / 16 色并适配

词级 Diff 的阈值设计值得注意：

```typescript
const CHANGE_THRESHOLD = 0.4;

// 如果一行中超过 40% 的内容都变了，
// 词级高亮会让整行几乎全部高亮，失去了"标记变化"的意义。
// 此时退回到行级着色更清晰。
```

#### 设计系统：终端 UI 的原子组件

`components/design-system/` 提供了一套终端 UI 的原子组件，类似于 Web 开发中的 UI 组件库：

| 组件 | 职责 | Web 类比 |
|------|------|---------|
| `ThemedText` | 语义化颜色文本 | `<span className="text-warning">` |
| `ThemedBox` | 语义化颜色容器 | `<div className="bg-surface">` |
| `Dialog` | 确认/取消对话框 | `<dialog>` / Modal |
| `Pane` | 带标题的面板 | Card / Panel |
| `Tabs` | 标签页导航 | Tab 组件 |
| `ListItem` | 可选择的列表项 | `<li>` with selection |
| `FuzzyPicker` | 模糊搜索选择器 | Combobox / Autocomplete |
| `Divider` | 分隔线 | `<hr>` |
| `ProgressBar` | 进度条 | `<progress>` |
| `StatusIcon` | 状态图标 | Icon badge |
| `Byline` | 元数据行（中点分隔） | Metadata row |

**为什么需要设计系统？**

没有设计系统，每个组件都会自己处理颜色、边框、间距——导致视觉不一致和代码重复。设计系统将终端 UI 的常见模式（带边框的面板、可选择的列表、模态对话框）封装为可复用的原子组件，确保整个应用的视觉一致性。

更重要的是，设计系统组件**内置了键盘交互语义**。比如 `Dialog` 自动处理 Enter（确认）和 Escape（取消）的快捷键绑定，`Tabs` 自动处理左右箭头切换。这些交互逻辑不需要每个使用者重复实现。

---

## 12.9 Spinner 与动画系统

### 面临的问题

当 Claude Code 等待 API 响应或执行工具时，用户需要视觉反馈——"系统还在工作，没有卡死"。在 Web 应用中，这通常是一个 CSS 动画的 loading spinner。但在终端中：

1. **没有 CSS 动画**：终端的"动画"只能通过不断重写字符实现
2. **性能敏感**：动画意味着高频重渲染（每 50ms 一帧），如果每帧都触发完整的 React 渲染管线，CPU 开销会很大
3. **多任务并发**：Claude Code 可能同时运行多个子代理（Agent），每个都有自己的 Spinner 状态，需要在一个紧凑的区域内展示

### 解法：共享时钟 + 隔离的动画热路径

#### 共享时钟（ClockContext）

所有动画共享一个全局时钟，而不是每个动画组件各自维护 `setInterval`：

```typescript
// ink/components/ClockContext.tsx — 共享动画时钟

// 所有需要动画的组件订阅同一个 ClockContext
// 时钟以固定频率 tick，订阅者在 tick 时更新自己的状态
// 好处：
// 1. 只有一个 interval，不会因为 N 个动画创建 N 个 interval
// 2. 所有动画同步更新，视觉上更协调
// 3. 当没有动画订阅者时，时钟自动停止
```

#### SpinnerAnimationRow：隔离的动画热路径

`SpinnerAnimationRow` 是 Spinner 子系统中最性能敏感的组件。它的设计原则是：**将动画更新限制在最小的 React 子树中，避免触发父组件的重渲染。**

```typescript
// components/Spinner/SpinnerAnimationRow.tsx — 设计要点

// 1. 拥有自己的 50ms 动画循环（请求中）或 200ms（其他状态）
// 2. 父组件（REPL）被排除在动画热路径之外
// 3. 队友/任务/token/计时信息的派生计算在此组件内完成
// 4. 冗余的动画订阅者已被消除
```

这意味着当 Spinner 以 20fps（50ms 间隔）动画时，只有 `SpinnerAnimationRow` 这个小组件在重渲染，REPL 的其他部分（消息列表、输入框等）不受影响。

#### 微光动画（Shimmer）

Claude Code 的 Spinner 不是简单的旋转字符（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`），而是一个**微光扫描效果**——一个高亮区域从左到右扫过文本，类似于 Web 中的 skeleton loading 效果。

```typescript
// components/Spinner/useShimmerAnimation.ts — 微光动画

function useShimmerAnimation(width: number, mode: 'requesting' | 'other') {
  const speed = mode === 'requesting' ? 50 : 200;  // ms per frame

  // 计算微光位置：一个高亮窗口在文本宽度上循环移动
  const glimmerPosition = useAnimationFrame(speed, (frame) => {
    return frame % width;  // 循环
  });

  // 当动画停滞时（比如等待时间过长），自动取消订阅以节省 CPU
  // 恢复活动时重新订阅
}
```

微光颜色来自主题系统——每个语义角色都有对应的微光色：

```typescript
// theme.ts 中的微光色定义
{
  claudeShimmer: 'rgb(...)';       // Claude 回复时的微光
  permissionShimmer: 'rgb(...)';   // 等待权限确认时的微光
  warningShimmer: 'rgb(...)';      // 警告状态的微光
  inactiveShimmer: 'rgb(...)';     // 非活跃状态的微光
}
```

#### 多代理 Spinner 树

当多个子代理并发运行时，Spinner 区域会展示一个树形结构：

```
⠋ Claude is working...                    ← 主代理
  ├─ ⠙ Agent "explore-codebase" (12s)     ← 子代理 1
  │   └─ Reading src/utils/theme.ts        ← 当前工具
  └─ ⠹ Agent "run-tests" (8s)             ← 子代理 2
      └─ Running npm test                  ← 当前工具
```

`TeammateSpinnerTree` 和 `TeammateSpinnerLine` 组件负责渲染这个树形结构。每个子代理的 Spinner 独立动画，但共享同一个时钟源。

### 设计决策讨论

**为什么 Spinner 的动画频率区分 "requesting"（50ms）和 "other"（200ms）？**

50ms（20fps）的动画在视觉上足够流畅，能给用户"系统正在积极工作"的感觉。但 20fps 意味着每秒 20 次 React 重渲染——如果系统处于非关键等待状态（比如等待用户输入），这个开销是不必要的。200ms（5fps）在非关键状态下足够提供"系统还活着"的视觉反馈，同时将 CPU 开销降低 4 倍。

---

## 12.10 终端兼容性与自愈机制

### 面临的问题

Claude Code 需要在各种终端环境中运行：

- **现代终端**：iTerm2、Ghostty、Kitty、Warp——支持真彩色、Kitty 键盘协议、OSC 52 剪贴板、同步输出
- **IDE 内置终端**：VS Code（xterm.js）、Cursor、Windsurf——支持大部分现代特性，但有些行为与原生终端不同
- **终端复用器**：tmux、screen——在终端和应用之间增加了一层，可能过滤或修改某些转义序列
- **远程环境**：SSH、容器——网络延迟可能导致转义序列被截断
- **传统终端**：Apple Terminal——不支持真彩色，键盘协议有限

每个环境的能力不同，Claude Code 需要**检测能力并适配**，而不是假设所有终端都一样。

### 解法：能力探测 + 主动适配 + 自愈

#### 终端能力探测

```typescript
// ink/terminal.ts — 终端能力检测

// 同步输出（DEC 2026）：防止帧撕裂
function isSynchronizedOutputSupported(): boolean {
  // ConEmu、Ghostty 1.2+、iTerm2 3.6.6+ 支持
  // 通过 TERM_PROGRAM 和版本号判断
}

// 扩展键报告：区分 Ctrl+I 和 Tab
function supportsExtendedKeys(): boolean {
  // Kitty 键盘协议 或 xterm modifyOtherKeys
}

// 超链接（OSC 8）
function supportsHyperlinks(): boolean {
  // 大部分现代终端支持，Apple Terminal 不支持
}

// 进度报告（OSC 9;4）：在终端标题栏显示进度
function isProgressReportingAvailable(): boolean {
  // ConEmu、Ghostty 1.2+、iTerm2 3.6.6+
}

// XTVERSION 探测：异步检测 xterm.js 环境
// 发送 \x1b[>0q，等待终端响应
// 用于识别 VS Code / Cursor / Windsurf 的内置终端
```

#### 主动适配

基于检测到的能力，Claude Code 主动调整行为：

```typescript
// 颜色适配
if (isAppleTerminal()) {
  // Apple Terminal 不支持 24-bit 色，降级到 256 色
  chalk.level = 2;
}
if (isXtermJs() && chalk.level < 3) {
  // xterm.js 支持真彩色，但 chalk 可能误检测为 256 色
  chalk.level = 3;
}
if (isTmux()) {
  // tmux 的颜色透传不总是可靠
  chalk.level = Math.min(chalk.level, 2);
}

// 键盘协议适配
if (supportsExtendedKeys()) {
  // 启用 Kitty 键盘协议或 modifyOtherKeys
  stdout.write('\x1b[>1u');  // Kitty: disambiguate
} else {
  // 回退到 legacy 转义序列解析
}

// 宽字符补偿
if (hasCursorUpViewportYankBug()) {
  // Windows Terminal 的光标上移 bug 补偿
}
```

#### 终端模式自愈

终端模式（Raw Mode、括号粘贴、鼠标追踪等）可能在以下场景中被意外重置：

- **Ctrl+Z → fg**：SIGSTOP/SIGCONT 后，终端模式可能被 shell 重置
- **tmux attach**：重新连接 tmux 会话后，终端模式需要重新设置
- **SSH 重连**：SSH 连接断开重连后，终端状态丢失
- **系统休眠/唤醒**：某些终端在唤醒后重置模式

Claude Code 的 `App.tsx` 实现了**终端模式自愈**：

```typescript
// ink/components/App.tsx — 终端自愈

// SIGCONT 处理：从 Ctrl+Z 恢复
process.on('SIGCONT', () => {
  // 重新设置所有终端模式
  reassertTerminalModes();
});

// stdin resume gap 检测：
// 当 stdin 在一段时间内没有数据后突然恢复，
// 可能意味着 tmux attach 或 SSH 重连
function reassertTerminalModes(): void {
  // 重新启用 Raw Mode
  stdin.setRawMode(true);
  // 重新启用括号粘贴
  stdout.write('\x1b[?2004h');
  // 重新启用焦点报告
  stdout.write('\x1b[?1004h');
  // 重新启用扩展键报告
  if (supportsExtendedKeys()) {
    stdout.write('\x1b[>1u');
  }
  // 重新启用鼠标追踪（如果在全屏模式）
  if (altScreenActive) {
    stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  }
}
```

**为什么需要自愈而不是假设模式始终有效？**

因为终端模式是**全局可变状态**——任何外部事件（信号、shell、终端复用器）都可能修改它。在一个长时间运行的交互式应用中（Claude Code 的会话可能持续数小时），假设模式始终有效是不现实的。自愈机制确保了即使模式被意外重置，应用也能自动恢复正常工作。

---

## 12.11 总结：终端 UI 的工程哲学

回顾整个终端 UI 系统，可以提炼出几个核心的工程哲学：

### 1. 将 Web 的成熟模式移植到终端

Claude Code 没有从零发明终端 UI 的范式，而是系统性地将 Web 前端的成熟模式移植到终端环境：

- **React 声明式 UI** → 自定义 React Reconciler
- **Flexbox 布局** → Yoga 引擎
- **DOM 事件模型** → 捕获/冒泡分发器
- **虚拟滚动** → VirtualMessageList
- **设计系统** → 终端原子组件库
- **CSS 主题** → 语义化 Token 主题

这个策略的好处是：Web 前端社区数十年积累的最佳实践可以直接复用，开发者的 Web 经验可以迁移到终端开发中。

### 2. 性能优化的分层策略

性能优化不是一个单点技巧，而是贯穿整个渲染管线的分层策略：

```
React 层:    OffscreenFreeze (冻结不可见组件)
             VirtualMessageList (只挂载可见消息)
             滚动量化 (减少 React commit)

布局层:      Yoga 缓存 (避免重复布局计算)

绘制层:      Blit 优化 (复制未变化区域)
             视口裁剪 (只绘制可见内容)
             DECSTBM 硬件滚动

缓冲层:      Int32Array 紧凑存储 (减少内存和 GC)
             字符串/样式/超链接池化 (减少分配)

差分层:      Damage 区域限制 (只比较变化区域)
             样式差分预计算 (StylePool.transition)
             空白跳过

输出层:      同步输出 BSU/ESU (防闪烁)
             相对光标移动 (减少序列长度)
```

每一层都在减少下一层的工作量。这种**级联优化**的效果是乘法而非加法——如果每层减少 50% 的工作量，7 层叠加后总工作量只有原来的 0.8%。

### 3. 在声明式和命令式之间务实选择

React 的声明式模型适合大部分 UI 逻辑，但在性能关键路径上，Claude Code 务实地选择了命令式：

- **滚动状态**存在 DOM 节点上而非 React 状态中
- **和弦状态**用 `useRef` 而非 `useState`
- **选择覆盖**直接修改 Screen 缓冲区
- **RawAnsi** 跳过 Ink 文本管线直接写入缓冲区

这不是对 React 的否定，而是对**"正确的工具用在正确的地方"**原则的践行。声明式模型的价值在于降低复杂度，但当性能成为瓶颈时，复杂度可以通过良好的封装来管理。

### 4. 终端生态的现实主义

Claude Code 没有假设一个理想的终端环境，而是面对终端生态的碎片化现实：

- 不信任自动检测，主动适配已知终端
- 多策略粘贴检测，覆盖各种终端行为
- 终端模式自愈，应对意外重置
- 多级颜色降级（真彩色 → 256 色 → 16 色）
- 宽字符补偿，处理不同终端的 wcwidth 差异

这种**防御性工程**的代价是更多的代码和更复杂的逻辑，但换来的是在真实世界中的可靠运行。

### 关键源码索引

| 模块 | 路径 | 职责 |
|------|------|------|
| Ink 引擎入口 | `src/ink/ink.tsx` | 渲染循环、双缓冲、帧管理 |
| React Reconciler | `src/ink/reconciler.ts` | React → Ink DOM 桥接 |
| DOM 抽象 | `src/ink/dom.ts` | Ink DOM 树、脏标记、滚动状态 |
| 屏幕缓冲 | `src/ink/screen.ts` | Cell 数组、池化、Blit |
| 渲染器 | `src/ink/renderer.ts` | Yoga 布局 → Screen 缓冲 |
| 节点绘制 | `src/ink/render-node-to-output.ts` | DOM 树遍历、裁剪、Blit 优化 |
| 帧差分 | `src/ink/log-update.ts` | 逐 Cell Diff、Patch 生成 |
| 终端输出 | `src/ink/terminal.ts` | ANSI 序列写入、能力检测 |
| 事件分发 | `src/ink/events/dispatcher.ts` | 捕获/冒泡两阶段分发 |
| 按键解析 | `src/ink/parse-keypress.ts` | stdin → ParsedKey |
| 焦点管理 | `src/ink/focus.ts` | 焦点栈、Tab 循环 |
| 文本选择 | `src/ink/selection.ts` | 鼠标选择、拖拽滚动 |
| 布局引擎 | `src/ink/layout/` | Yoga 适配层 |
| 终端 I/O | `src/ink/termio/` | ANSI 解析器 |
| ScrollBox | `src/ink/components/ScrollBox.tsx` | 滚动容器、DECSTBM |
| AlternateScreen | `src/ink/components/AlternateScreen.tsx` | 全屏模式 |
| App 根组件 | `src/ink/components/App.tsx` | 终端模式、输入解析、自愈 |
| REPL 屏幕 | `src/screens/REPL.tsx` | 主交互界面编排 |
| 全屏布局 | `src/components/FullscreenLayout.tsx` | 布局管理、粘性头 |
| 虚拟消息列表 | `src/components/VirtualMessageList.tsx` | 消息虚拟化、搜索 |
| 离屏冻结 | `src/components/OffscreenFreeze.tsx` | 渲染级冻结优化 |
| 消息分发 | `src/components/Message.tsx` | 消息类型路由 |
| 消息渲染器 | `src/components/messages/` | 各类消息专用渲染 |
| 输入组件 | `src/components/PromptInput/` | 输入编排中枢 |
| 权限对话框 | `src/components/permissions/` | 权限 UI |
| 设计系统 | `src/components/design-system/` | 终端原子组件 |
| Spinner | `src/components/Spinner/` | 动画系统 |
| Markdown | `src/components/Markdown.tsx` | Markdown 渲染 |
| 代码高亮 | `src/components/HighlightedCode/` | 语法高亮 |
| Diff 渲染 | `src/native-ts/color-diff/` | 结构化 Diff |
| 主题 | `src/utils/theme.ts` | 主题定义 |
| 快捷键 | `src/keybindings/` | 和弦、上下文、解析 |
| 文本输入 | `src/hooks/useTextInput.ts` | Emacs 编辑 |
| Vim 输入 | `src/hooks/useVimInput.ts` | Vim 状态机 |
| 粘贴处理 | `src/hooks/usePasteHandler.ts` | 粘贴检测 |
| 虚拟滚动 | `src/hooks/useVirtualScroll.ts` | 滚动虚拟化 |
