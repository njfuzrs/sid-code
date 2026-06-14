# src/ui — TUI 设计规范：视觉语言 + 交互体验（改任何 UI 前必读）

本文件约束 `src/ui/` 下所有 TUI 组件的**视觉**与**交互**。一句话目标：**美观、简洁、大气 + 好用、顺手、不丢东西**——靠克制和一致性，不靠堆砌。

对标 claude-code 的核心不是配色丰富 / 功能花哨，而是**克制 + 体贴**：柔和不刺眼的字色、极少边框、单一品牌色点睛、留白构成节奏；同时永不丢失用户输入、中断给出路、提示渐进衰减。

> 这套语言是 2026-06 多轮重构沉淀的结果（配色地基 → 交互细节 → 结构清理 → TodoPanel → UX 规范 → 本次对照 cc 源码分层）。
> 新组件直接遵守，旧组件改到时顺手对齐。详细背景见 memory `tui-catppuccin-wiring-fix.md`。

---

## 0. 如何使用本规范（先读这段）

规范分**五层**，从下到上：每一层都建立在下一层之上，改东西前先定位你改的是**哪一层**，只读那一层 + 它依赖的下层。

```text
L5 工程约束    改完必做、渲染底座(src/ink fork)、怎么验证      ← 所有改动都受约束
L4 交互体验    输入/中断/提示/反馈/危险操作/键盘          ← "好不好用"
L3 消息流      消息语义类型、工具生命周期、折叠、流式      ← 屏幕主体
L2 组合规则    排版表达状态、布局留白、对齐成列            ← 怎么拼
L1 视觉原子    字形、颜色、主题                          ← 最小材料
```

每条规则带状态标记，先看标记再动手：

- ✅ **已落地**：代码里已实现，照着用、改到时对齐，别推翻。
- ⚠️ **待补**：方向认可但还没做全，新需求碰到了就补上，补时遵循这里的设计。

> 注：渲染底座是 vendor 进 `src/ink/` 的 claude-code 同款 ink fork（已脱离 npm 包），cc 的渲染能力基本都有，**不存在"受 ink 限制做不了"的硬边界**。遇 cc 做法默认能搬，先去 `src/ink` 找——详见 L5.3。

**元原则（贯穿五层，记不住别的就记这三条）：**

1. **同族递进** > 多样并列。状态/强度用同一字形族的填充度、同一色相的明度来表达递进（○◐● / 浅→深），不要为每个状态引入新字形、新色相。
2. **排版** > 颜色 > 边框。能用粗细/划线/缩进/留白表达的，不用颜色；能用颜色点睛的，不用边框盒子。
3. **克制点睛**，不铺满。品牌色、状态色都是"点"出来的，整屏彩色 = 没有重点。

---

## L1 · 视觉原子层：字形、颜色、主题

最小材料。所有上层都从这里取值，**严禁**在组件里硬编码字形字符或 hex 颜色。

### 1.1 字形：单色几何字形，禁用彩色 emoji ✅

彩色 emoji（✅🔄⬜📋⚙️❌🛑⏳💡 等）有三宗罪：占位宽度跨终端不一致 → 对齐漂移；色彩游离于主题之外 → 脏；与单色字形语言冲突 → 乱。**一律不用。**

- **所有行首字形从 `constants/figures.ts` 取**，不在组件里硬编码字符。
- 已有字形族，按语义选用：

  | 字形族 | 常量 | 字形 | 语义 |
  |--------|------|------|------|
  | 状态点 | `BULLET` | ⏺ (mac) / ● | assistant / 工具行首，仅靠**颜色**区分状态 |
  | checkbox | `TODO_PENDING/IN_PROGRESS/COMPLETED` | ○◐● | 清单状态，靠**填充度**递进 |
  | 成功/失败 | `SUCCESS_MARK/ERROR_MARK` | ✔/✘ | 同一对纤细字形，笔画粗细一致 |
  | 引导箭头 | `ARROW_PROMPT` | › | 标题 / hint / 命令补全 |
  | 进度 | `PROGRESS_FILLED/EMPTY` | ▰▱ | 进度条 |
  | 思考/树枝 | `THINKING_MARK` / `TREE_BRANCH` | ✻ / ⎿ | 思考标记 / 结果区缩进前缀 |
  | 用户输入 | `USER_PROMPT` | > | 用户输入行首 |

- **填充度递进是字形设计的第一原则**（元原则①的具象）：表达"程度/进展"时优先用同一字形族的填充度，而不是换字形。cc 的 effort 指示 `○◐●◉`（低→中→高→满）、本项目的 todo `○◐●` 都是这个套路。需要表达强度递进 → 先想"现有字形族能不能加一档填充度"，再想新字形。
- 需要新字形 → 先加到 `figures.ts` 并注释语义，再引用。优先选**同一字形族**（靠填充度/粗细递进），不引入粗细不一的杂字形。
- **跨平台回退**：mac 下 `⏺` 垂直对齐更好，其它平台部分字体不支持 → 回退 `●`（`figures.ts` 已用 `isDarwin` 处理）。新加可能不通用的字形时，照此给回退。

### 1.2 颜色：走 `theme.*` 语义 token，三状态体系，无 info ✅

- **禁止**在组件里写死 hex（`#89b4fa`）。一律走语义 token：`theme.text.* / theme.ui.* / theme.status.* / theme.border.* / theme.background.*`。
- **token 分层**（见 `themes/semantic-tokens.ts` 的 `SemanticColors`）：
  - `text.*` — 正文/次要/暗淡文本
  - `ui.active` — **品牌蓝**（`#89b4fa` 暗 / `#1e66f5` 亮），引导、进行中、"信息蓝"都用它
  - `status.{error,success,warning}` — **只有这三个状态色**
  - `border.*` / `background.*` — 边框、背景
- **`theme.status` 没有 `info`**。需要"信息蓝"用 `theme.ui.active`。（历史踩坑：`theme.status.info` 是 undefined，会静默回退终端默认色。）这与 cc 一致——cc 也只有 success/error/warning 三状态色，"提示/信息"复用 suggestion 蓝。**保持三状态体系，不要扩张状态色。**
- **克制点睛**：颜色只在关键处点睛——品牌蓝引导、绿色完成、红色错误、黄色警告，不要整屏彩色。
- **改配色后验证实际解析值**，别只看 `semantic-tokens.ts` 的定义（定义 ≠ 生效，曾因 Theme 漏传 semanticColors 参数导致设计稿没生效）：
  ```bash
  bun -e 'import { themeManager } from "./src/ui/themes/theme-manager.ts"; console.log(themeManager.getSemanticColors())'
  ```

### 1.3 主题：暗/亮可切，配色集中在 builtin ✅

- 主题定义集中在 `themes/builtin/`，经 `theme-manager.ts` 解析为 `SemanticColors`。组件只消费 `semantic-colors.ts` 导出的 `theme` 代理对象。
- 暗色 / 亮色由 themeManager 切换，组件不感知具体主题，只认语义 token——这是暗亮两套能同时正确的前提。
- ⚠️ **dimColor 与 bold 不兼容的坑**：终端 ANSI 的 `dim` 和 `bold` 互斥，想要"灰但有权重"（次要却重要的文本）不能简单叠 `dimColor + bold`。cc 的解法是用一个专门的 `inactive` 灰色 token 替代 ANSI dim。本项目如遇此需求，优先用 `theme.text.secondary` 之类的灰色 token，而非 `dimColor` 属性叠 bold。

---

## L2 · 组合规则层：排版、布局、对齐

有了原子，怎么拼成一个组件。核心是元原则②（排版 > 颜色 > 边框）。

### 2.1 状态优先用排版表达，颜色只做点睛 ✅

不要靠"给每个状态配一种颜色"来区分。优先级：**排版 > 颜色**。

- 完成态：`strikethrough` + `dimColor`（划掉的完成感最直观）
- 进行中：`bold` + 品牌色 `theme.ui.active`
- 次要 / 已结束：`dimColor` 或 `theme.text.secondary`
- 颜色只在关键处点睛，不整屏彩色。
- **双通道原则**：状态最好同时用「字形 + 排版」两个通道表达，不要只靠颜色——色盲用户、低对比终端下颜色可能失效。如 todo 完成 = 实心字形 `●` + 划线，不是只把字变绿。

### 2.2 能用留白和单一容器，就不要盒子套盒子 ✅

- 消息流靠 **bullet + 树枝缩进 + 留白** 构成节奏，不用边框盒子包裹工具调用。
- 需要框时用**单个** `borderStyle="round"` 容器 + 内部一条 `borderTop` 子 Box 做分隔线；**不要**用多个 Box 拼接顶/分隔/中/底四段边框（gemini-cli sticky 遗留写法，已废弃）。
- 边框圆角统一 `round`，不混用 `single`/`double`/直角。
- 轮次/分区之间用 1 行留白区隔，**不画 `───` 分隔线**。
- **边框 vs 分隔线 vs 留白 的选择顺序**（从轻到重，优先轻的）：
  1. **留白**（1 行 gap）——区隔同级内容、轮次之间。默认选这个。
  2. **`borderTop` 分隔线**——一个容器内部分区（如 footer 与内容）。
  3. **`round` 边框盒子**——确实需要"框住一块独立区域"时（如对话框、TodoPanel）。最重，慎用。

### 2.3 缩进对齐成列 ✅

- 行首字形占位宽统一（一般 `<Box width={2}>` 包字形 + 空格），让多行字形/文本各自成列，不参差。
- 同类消息（hint/info/model 等）统一 `paddingLeft={2}`，与 bullet 行对齐。
- **宽度计算用 `stringWidth` 不用 `.length`** ✅：含 CJK / emoji / 全角字符时 `.length` 给的是码点数，不是终端列宽，会导致对齐漂移和换行错位。项目已装 `string-width@7`（`text-buffer.ts`、`streaming-viewport.ts` 已在用）。任何"算某段文本占几列 / 要不要换行 / 怎么 pad 对齐"的地方，用 `stringWidth(text)`。

---

## L3 · 消息流层：屏幕主体的渲染语义

屏幕上最大的区域是消息流。这一层规定不同语义的消息怎么区分、工具调用怎么演进、长内容怎么折叠、流式怎么渲染。

### 3.1 消息语义类型，各有专用渲染 ✅

消息按语义分类型，每类有专用组件（见 `components/messages/`），不要用一个"通用消息盒子"硬塞所有类型。现有类型与视觉手段：

| 语义 | 组件 | 视觉手段 |
|------|------|---------|
| 用户输入 | `UserMessage` | `>` 前缀，正文色 |
| assistant 文本 | `AssistantMessage` | `⏺` bullet，正文色 |
| 思考 | `ThinkingMessage` | `✻` 标记，dim |
| 工具调用 | `ToolMessage` / `ToolGroupMessage` | `⏺` bullet（颜色随状态）+ `⎿` 结果树枝 |
| 工具结果 | `ToolResultDisplay` | `⎿` 树枝缩进 |
| 错误 | `ErrorMessage` | `✘` + `theme.status.error` |
| 命令 | `CommandMessage` | 命令专用样式 |
| 计划评审 | `PlanReviewMessage` | 评审专用样式 |

- **区分手段优先级**：字形 / 缩进 > 颜色。user 与 assistant 靠 `>` vs `⏺` 字形 + 缩进区分，不是靠左右对齐或背景色。
- 新增消息语义 → 新建专用组件，定义它的字形 + 缩进 + 色彩，登记到上表。

### 3.2 工具调用生命周期：状态点颜色实时流转 ✅

工具执行是动态的，状态要**即时可见**：

- `pending`(灰) → `executing`(蓝 `theme.ui.active`) → `success`(绿 `theme.status.success`) / `error`(红 `theme.status.error`)。
- 状态点用同一个 `BULLET` 字形（⏺），**只换颜色不换字形**（元原则①）。
- 状态变化立刻重渲，不滞后；用户始终知道"现在到哪了"。
- 排队等待权限的工具显示灰态 + "等待确认"提示，不是直接 executing。

### 3.3 折叠：长内容默认折叠，给可展开提示 ⚠️

长工具结果 / 大段读取 / 搜索结果会淹没消息流，需要折叠。现有 `SlicingMaxSizedBox` / `VirtualizedList` 做尺寸限制，但**折叠交互规范尚不统一**，补的时候遵循：

- **默认折叠**（减少噪音），不是默认展开。
- 折叠时**显示摘要而非完全隐藏**：给出"折叠了什么、有多少"——文案用 `… +N more` / `… N 行已折叠` 这类**统一格式**，不要每处自己编。
- 展开提示文案统一（如 `(ctrl+o 展开)`），并遵循 L4-C 的渐进衰减：在子区域 / 虚拟列表内不重复显示提示。
- 行号 / 上下文截断：diff 类只显示变更前后各几行上下文（cc 用 `CONTEXT_LINES=3`），不是整文件。

### 3.4 流式渲染：逐字可见，已完成与进行中分离 ✅

> **渲染底座 = vendor 进 `src/ink` 的 claude-code 同款 ink fork**（已脱离 node_modules 的 `@jrichman/ink`）。cc 的渲染能力**本项目都有**，不是"做不了"——见 L5.3。

- **逐字输出可见** ✅，不要憋到结束才一次性吐出（`StreamingMessage.tsx`）。
- **已完成消息走 Static + blit 缓存，进行中消息重渲** ✅：`src/ink/_vendor/Static.tsx` 承载已完成消息（`MainScreenLayout.tsx` 已用），items 引用不变时 memo 跳过重渲；`src/ink/node-cache.ts` 用 WeakMap 缓存各节点 layout bounds 做 blit + 局部清除（O(dirty) 而非 O(mounted)）。新组件让"已完成区"items 引用稳定即可吃到这套缓存，不要每帧重建数组。
- **流式内容按视口高度 tail 截断** ✅：动态区流式内容若高度 ≥ 终端行数会触发全屏重打闪烁，正解是按视口高度对流式内容做 tail 截断（见 memory `main-screen-streaming-flicker-rootcause.md`，根因已随 fork 迁移更新）。
- **follow-scroll / selection** ✅：fork 的 `selection.ts` 已有 `shiftSelectionForFollow` / `captureScrolledRows`，selection 引擎在 `ink.tsx` 已完整接线，`src/ui` 的 `MouseContext` / `ScrollProvider` 也接了。需要跟随滚动到底 / 文本选中复制时，用 fork 既有能力，别自造。

### 3.5 diff 渲染：增删行靠颜色 + 符号，走 RawAnsi 快路径 ✅

- 增行 `+` 绿、删行 `-` 红、上下文行常态（`DiffRenderer.tsx` / `diffAnsiLines.ts`）。
- 语法高亮走 `CodeColorizer.tsx`。
- **RawAnsi 快路径** ✅：fork 的 `src/ink/components/RawAnsi.tsx` 接收"已按列宽换行的 ANSI 行数组"，单个 Yoga leaf + 常量 measure 直接 `output.write()`，跳过 `<Ansi>→React 树→Yoga→squash→重序列化` 的往返。长 diff / 高亮代码这类已是终端就绪的内容用它（`diffAnsiLines.ts` 生产 ANSI 行 → `DiffRenderer` 已在用）。
- ANSI 由 TS 侧（`diffAnsiLines.ts`）生产即可，不需要 cc 的 NAPI ColorDiff（Rust 模块）——RawAnsi 只关心"喂进来的是终端就绪 ANSI 行"，不关心谁生产。

---

## L4 · 交互体验层：好不好用

样式让界面好看，交互让界面好用，**交互比样式更重要**。以下从 cc 提炼 + 本项目沉淀。

### A. 永不丢失用户输入

用户敲进去的字、选到一半的状态，是他的劳动，丢了就是事故。

- **ESC 取消流式 → 自动回填刚才的输入** ✅（`pending-input.ts` 的 stash/markForRestore/consumePendingRestore；数据流：提交时 stash → ESC 且过守卫则 markForRestore → loading→idle 边沿 consume 回填）。任何会清空输入的操作，先想"取消后能不能恢复"。
- **流式进行中用户又输入 → 排队，不丢弃、不打断** ⚠️：cc 用三优先级队列 `now > next > later`（`now`=中断类立即处理，`next`=用户输入，`later`=系统通知不抢占用户输入），回合结束后自动接续，并支持 ↑ 弹回队列编辑。本项目目前只有 ESC 回填（单条）+ 键盘事件优先级（`KeypressContext` 的 `KeypressPriority`），**没有"流式中多条输入排队接续"**。补这块时对标 cc 三优先级，且系统通知不能抢占用户输入。
- **输入历史跨会话持久化** ✅（`useInputHistoryStore` → `~/.sid-code/input-history.json`），↑↓ 召回。

### B. 中断要给出路，不是死胡同

- 中断 / 取消后**引导下一步**而非只报"已中断"。cc 中断后显示 `Interrupted · What should Claude do instead?`——把中断变成"重新给指令"的机会。⚠️ 本项目中断后的引导文案可加强。
- **中断优先级递减**（cc 模式，⚠️ 可对齐）：① 有正在跑的任务 → 中断任务；② 无任务但队列有命令 → 弹回编辑器；③ 空闲 → 无操作。让 ESC / Ctrl+C 永远有明确语义。
- 错误消息同理：除了"错在哪"，尽量给"怎么办"（重试？换参数？看日志？）。

### C. 提示渐进衰减——教过一次就别唠叨

新手需要引导，老手嫌烦。同一条 onboarding 提示**不要每次都显示**。

- cc 用持久化计数器/布尔位：`queuedCommandUpHintCount < 3` 才显示某提示，`hasSeenXxxHint` 标记一次性提示已读，存在 `~/.claude/claude.json`。
- ⚠️ 本项目可复用 `app-config.ts` 存这类 `hasSeen*` / `*HintCount` 标志（计数器型用 `< N` 上限，一次性型用 boolean）。
- **占位符 / footer hint 按场景切换** ✅，不是固定一句：空输入时给示例，查看 teammate 时给 `Message @x…`，有队列时给"按 ↑ 编辑"。上下文感知 > 一成不变。

### D. 反馈要"活"但不吵

- **等待文案随机不重复** ✅：`spinnerVerbs.ts` 的 `pickSpinnerVerb(previous)` 避免连续重复同一词。挂载时选一次、整轮保持稳定（cc 同款），不要每帧换词。
- spinner 行带 `(esc 取消, 12s)`——**同时给出口和进度**，让用户知道"能停"且"等了多久"。终端窄时按优先级渐进隐藏：动词 > 计时 > token 数。
- **长任务给可视进度**：TodoPanel 的 `▰▱` 进度条 / 多步进度，不要只有转圈。多 agent / 嵌套任务可用树枝（`⎿`）+ 缩进表达层级，后台任务降级为一行文字提示、不占主视图。
- **无障碍模式（a11y）关掉动画** ✅：`accessibility/detect.ts` 经 `SID_ACCESSIBILITY` / `SID_SCREEN_READER` 等环境变量判定（终端无 `prefers-reduced-motion`，靠 env 显式开启）。a11y 下 spinner 用静态字符、token 计数直接跳终值——**完全关动画，不是降速**（屏幕阅读器会把每帧字符变化读成噪声）。任何新动画都要想 a11y 退路。

### E. 危险操作要"挡一下"，安全默认

- **破坏性命令额外标红警告** ⚠️：`rm -rf`、`git reset --hard`、批量删除等，在确认框里额外标红（cc 的 `destructiveCommandWarning`），不能和普通确认长一个样。项目已有命令危险性检测能力（`src/permission/`、`src/tool/bash/read-only-validation.ts`），但 **UI 层的差异化警示尚未接全**，补确认框时接上。
- **安全默认聚焦** ⚠️：危险操作的确认框**默认聚焦"拒绝/取消"**，让手滑回车不造成破坏（cc 的 `defaultFocusValue` 指向 No）。危险确认按钮文案要有仪式感（"Yes, I accept" 而非 "OK"）。
- **权限按键语义用颜色区分** ✅：y 绿 / n 红 / a 蓝，高频决策一眼可辨（`PermissionPrompt.tsx`）。
- **批量销毁类操作两击确认** ⚠️：如"杀掉所有 agent / 清空队列"，cc 用两击确认——第一击提示"再按一次"（3 秒窗口），第二击才执行。本项目如有此类操作可对齐。

### F. 键盘可达 + 一致

- 所有交互**键盘可完成**，不依赖鼠标。补全 ↑↓ 选择、Enter 确认、ESC 退出，是肌肉记忆，别改语义。
- **键位集中在 `keybindings/`** ✅，不在组件里散落硬编码。现有分层：`defaultBindings.ts`(默认绑定) / `loadUserBindings.ts`(用户 `keybindings.json` 加载) / `reservedShortcuts.ts`(保留键) / `chord.ts`(和弦) / `validate.ts`(校验)。
- **保留键不可覆盖** ✅：`reservedShortcuts.ts` 的 `RESERVED_STROKES` 保护 Ctrl+C（中断/退出）、Enter（提交）、裸 Tab（补全）等终端基础语义，用户在 `keybindings.json` 里改不动（`isReservedStroke` 拦截）。新增"绝不能被改"的键 → 加进 `RESERVED_STROKES`。
- **用户自定义走合并而非替换** ✅：用户绑定与默认绑定合并，校验语法 / 重复键 / 保留键冲突后生效。
- **和弦键超时取消** ✅：多键序列（如前缀键 + 第二键）1.5s 未按第二键则丢弃前缀（`chord.ts`），防止前缀键误触。

### G. 即时性——状态变化立刻可见

- 工具执行状态点颜色实时流转（见 L3.2），用户始终知道进度。
- 流式输出逐字可见（见 L3.4）。
- 列表/清单更新（TodoPanel）随状态实时重渲，不滞后。

---

## L5 · 工程约束层：怎么验证、渲染底座

### 5.1 改完必做（CLAUDE.md §0 同款，不可跳过）

1. `bunx tsc --noEmit` 确认改动文件无类型错误（JSX runtime 的 "React is declared but never read" 是误报，可忽略）。
2. `bun test`（全量单测，以实际输出为准）。
3. `make build` 验证构建成功。
4. 临时预览脚本用完即删。

### 5.2 验证视觉改动的正确姿势

本项目 ink 是 fork（`src/ink/`，render 入口在 `render-to-screen.ts` / `root.ts`，非标准 `index.js`），一次性脚本难拼全 context provider 链来渲染组件预览。**验证视觉改动改用 `bun -e` 打印**，比拼渲染环境可靠：

- 字形：打印 `figures.ts` 的常量，确认字符对。
- 颜色：`themeManager.getSemanticColors()` 看**实际解析出的值**（定义 ≠ 生效）。
- 关键计算：进度条 0/1 边界、`stringWidth` 对齐、tail 截断行数等纯函数直接打印验证。

### 5.3 渲染底座：vendor 进 `src/ink` 的 claude-code 同款 ink fork ✅

**现状（2026-06，已脱离 node_modules）**：组件 import 的不是 npm 包，而是本地 `src/ink/`——把 claude-code 自研 ink 整套 vendor 进了仓库（import 路径形如 `"../../ink/components/Box.js"`，`node_modules` 已无 ink / @jrichman）。**cc 的渲染能力本项目基本都有**，遇到 cc 做法默认"能搬"，先去 `src/ink` 找对应文件，别假设做不了：

| 能力 | 位置 | 状态 |
|------|------|------|
| RawAnsi 快路径（终端就绪 ANSI 行直写） | `src/ink/components/RawAnsi.tsx` | ✅ `DiffRenderer` 已用 |
| Static 已完成区 + memo 跳重渲 | `src/ink/_vendor/Static.tsx` | ✅ `MainScreenLayout` 已用 |
| blit / 节点 layout 缓存（WeakMap，O(dirty)） | `src/ink/node-cache.ts` | ✅ renderer 已驱动 |
| selection 引擎（选中 / 复制 / 高亮） | `src/ink/selection.ts` + `ink.tsx` | ✅ 已接线，`MouseContext`/`ScrollProvider` 已接 |
| follow-scroll（跟随滚动到底） | `src/ink/selection.ts` `shiftSelectionForFollow` / `captureScrolledRows` | ✅ 引擎已具备 |
| hyperlink（OSC 8 检测） | `src/ink/supports-hyperlinks.ts` | ✅ |
| 行级 diff / 同步输出 / focus / measure | `log-update.ts` / `focus.ts` / `measure-*.ts` | ✅ |

- 唯一确实没有的是 cc 的 **NAPI ColorDiff（Rust 模块）**——但不需要：RawAnsi 只吃"终端就绪 ANSI 行"，由 TS 侧 `diffAnsiLines.ts` 生产即可。
- 改渲染相关代码时，**直接读 `src/ink/` 对应源码**（fork 全在仓库里，可改可读），而不是把它当黑盒 npm 包绕开。需要新渲染能力 → 先看 fork 有没有，再考虑加层。
- 历史包袱提醒：早期 memory / 文档可能仍说"用 `@jrichman/ink`、搬不了 cc fork"——**那是迁移前的旧状态，已失效**，以本节为准。

---

## 反例 → 正例对照

| 层 | ❌ 反例 | ✅ 正例 |
|----|--------|--------|
| L1 字形 | `<Text>{"✅ "}{item.content}</Text>` | `<Text color={theme.status.success}>{TODO_COMPLETED}</Text>` + `strikethrough` |
| L1 字形 | `icon = isError ? "✕" : "✓"`（散落、字形不一） | 从 `figures.ts` 取 `ERROR_MARK`/`SUCCESS_MARK` |
| L1 颜色 | `color={theme.status.info}`（undefined） | `color={theme.ui.active}` |
| L1 颜色 | `borderColor="#f9e2af"` | `borderColor={theme.status.warning}` |
| L2 布局 | 顶/分隔/中/底 四个 Box 拼边框 | 单个 `borderStyle="round"` 容器 + 内部 `borderTop` 分隔 |
| L2 对齐 | `text.length` 算列宽（CJK 漂移） | `stringWidth(text)` |
| L2 状态 | 完成态只把字变绿 | 实心字形 `●` + `strikethrough`（字形+排版双通道） |
| L3 折叠 | 每处自编 "还有很多…" | 统一 `… +N more` + `(ctrl+o 展开)` |
| L4 危险 | 删除确认默认聚焦"确定" | 默认聚焦"取消" + 标红警告 |
| L4 提示 | 每次都显示同一条 onboarding | `hasSeen*` / `*HintCount < N` 衰减 |
| L5 渲染 | 把 `src/ink` 当黑盒 npm 包绕开、以为搬不了 cc 能力 | 直接读改 `src/ink` fork 源码，复用其 RawAnsi/Static/blit/selection |

---

## 写提示词的人看这里

要继续这类优化，对 Claude 说一句就够：

> **「XXX 组件现在很丑/很乱/不好用，参照 src/ui/CLAUDE.md 的规范重做一遍。」**

Claude 会按五层定位问题：

- **L1 视觉原子**：彩色 emoji？硬编码 hex？`status.info`？→ 按 1.1-1.3 改
- **L2 组合**：盒子套盒子？`.length` 算宽？只靠颜色区分状态？→ 按 2.1-2.3 改
- **L3 消息流**：消息语义混渲？工具状态不流转？长内容不折叠？→ 按 3.1-3.5 改
- **L4 交互**：会丢输入？中断没出路？提示唠叨？危险操作没挡？→ 按 A-G 改
- **L5**：跑 test + build；渲染相关先读 `src/ink` fork 源码、复用既有能力（5.3）

按场景选措辞：

- 只想动外观 → 「按 L1/L2 优化 XXX 的视觉」
- 重点是好不好用 → 「按 L4 交互层审一遍 XXX 的体验，列问题给我」
- 说不清哪里别扭 → 「先按 src/ui/CLAUDE.md 五层诊断 XXX，列优化点给我选」
- 想补能力 → 「XXX 是 ⚠️ 待补项，按规范里对标 cc 的方向实现」
