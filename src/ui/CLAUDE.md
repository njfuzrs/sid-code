# src/ui — TUI 设计规范：视觉语言 + 交互体验（改任何 UI 前必读）

本文件约束 `src/ui/` 下所有 TUI 组件的**视觉**与**交互**。目标：**美观、简洁、大气 + 好用、顺手、不丢东西**——靠克制和一致性，不靠堆砌。
对标 claude-code 的核心不是配色丰富 / 功能花哨，而是**克制 + 体贴**：柔和不刺眼的字色、极少边框、单一品牌色点睛、留白构成节奏；同时永不丢失用户输入、中断给出路、提示渐进衰减。

> 两套铁律：**样式铁律**（1-5，决定好不好看）+ **交互铁律**（A-G，决定好不好用）。
> 这套语言是 2026-06 多轮重构沉淀的结果（配色地基 → 交互细节 → 结构清理 → TodoPanel → UX 规范）。
> 详细背景见 memory `tui-catppuccin-wiring-fix.md`。新组件直接遵守，旧组件改到时顺手对齐。

---

## 铁律（不可违反）

### 1. 禁用彩色 emoji，状态/图标一律用单色几何字形

彩色 emoji（✅🔄⬜📋⚙️❌🛑⏳💡 等）有三宗罪：占位宽度跨终端不一致 → 对齐漂移；色彩游离于主题之外 → 脏；与单色字形语言冲突 → 乱。

- **所有行首字形从 `constants/figures.ts` 取**，不在组件里硬编码字符。
- 已有字形族，按语义选用：
  - `BULLET`（⏺）— assistant / 工具行首状态点，仅靠**颜色**区分状态
  - `TODO_PENDING/IN_PROGRESS/COMPLETED`（○◐●）— 清单 checkbox，填充度表达状态递进
  - `SUCCESS_MARK/ERROR_MARK`（✔/✘）— 成功 / 失败
  - `ARROW_PROMPT`（›）— 引导箭头（标题、hint、命令补全）
  - `PROGRESS_FILLED/EMPTY`（▰▱）— 进度条
  - `THINKING_MARK`（✻）、`TREE_BRANCH`（⎿）— 思考标记 / 结果树枝缩进
- 需要新字形 → 先加到 `figures.ts` 并注释语义，再引用。优先选**同一字形族**（靠填充度/粗细递进），不要引入粗细不一的杂字形。

### 2. 状态优先用排版表达，颜色只做点睛

不要靠"给每个状态配一种颜色"来区分。优先级：**排版 > 颜色**。

- 完成态：`strikethrough` + `dimColor`（划掉的完成感最直观）
- 进行中：`bold` + 品牌色 `theme.ui.active`
- 次要 / 已结束：`dimColor` 或 `theme.text.secondary`
- 颜色只在关键处点睛（品牌蓝引导、绿色完成、红色错误、黄色警告），不要整屏彩色。

### 3. 颜色一律走 `theme.*` 语义 token，且改前验证实际输出

- **禁止**在组件里写死 hex（`#89b4fa`）。一律 `theme.text.* / theme.ui.* / theme.status.* / theme.background.*`。
- `theme.status` **只有** `error / success / warning`——**没有 `info`**。需要"信息蓝"用 `theme.ui.active`。（历史踩坑：`theme.status.info` 是 undefined，会静默回退终端默认色。）
- 改配色后，用脚本验证**实际解析出的值**，别只看 `semantic-tokens.ts` 的定义（定义 ≠ 生效，曾因 Theme 漏传 semanticColors 参数导致设计稿没生效）：
  ```bash
  bun -e 'import { themeManager } from "./src/ui/themes/theme-manager.ts"; console.log(themeManager.getSemanticColors())'
  ```

### 4. 能用留白和单一容器，就不要盒子套盒子

- 消息流靠 **bullet + 树枝缩进 + 留白** 构成节奏，不用边框盒子包裹工具调用。
- 需要框时用**单个** `borderStyle="round"` 容器 + 内部一条 `borderTop` 子 Box 做分隔线；**不要**用多个 Box 拼接顶/分隔/中/底四段边框（gemini-cli sticky 遗留写法，已废弃）。
- 边框圆角统一 `round`，不混用 `single`/`double`/直角。
- 轮次/分区之间用 1 行留白区隔，不画 `───` 分隔线。

### 5. 缩进对齐成列

- 行首字形占位宽统一（一般 `<Box width={2}>` 包字形 + 空格），让多行字形/文本各自成列，不参差。
- 同类消息（hint/info/model 等）统一 `paddingLeft={2}`，与 bullet 行对齐。

---

## 交互与体验铁律（决定"用起来爽不爽"，比样式更重要）

样式让界面好看，交互让界面好用。以下是从 claude-code 提炼 + 本项目已有沉淀的 UX 原则。

### A. 永不丢失用户输入

用户敲进去的字、选到一半的状态，是他的劳动，丢了就是事故。

- **ESC 取消流式 → 自动回填刚才的输入**（本项目已实现，见 `InputArea.tsx` 的 markForRestore / consumePendingRestore）。任何会清空输入的操作，都要先想"取消后能不能恢复"。
- **流式进行中用户又输入 → 排队，不丢弃、不打断**。对标 cc 的优先级队列（`now > next > later`）：当前回合没结束时，新输入进队列，回合结束后自动接续。绝不出现"正在生成时按了回车结果丢了"。
- 输入历史跨会话持久化（已实现，`useInputHistoryStore` → `~/.sid-code/input-history.json`），↑↓ 可召回。

### B. 中断要给出路，不是死胡同

- 中断 / 取消后，**引导下一步**而非只报"已中断"。cc 的做法是中断后显示 `Interrupted · What should Claude do instead?`——把中断变成"重新给指令"的机会。
- 错误消息同理：除了说"错在哪"，尽量给"怎么办"（重试？换参数？看日志？）。

### C. 提示渐进衰减——教过一次就别唠叨

新手需要引导，老手嫌烦。同一条 onboarding 提示**不要每次都显示**。

- cc 用持久化计数器：`queuedCommandUpHintCount < 3` 才显示"按 ↑ 编辑队列"，`hasSeenXxxHint` 布尔位标记一次性提示已读。
- 本项目可复用 `app-config.ts` 存这类 `hasSeen*` / `*HintCount` 标志。
- **占位符 / footer hint 按场景切换**，不是固定一句：空输入时给示例，查看 teammate 时给 `Message @x…`，有队列时给"按 ↑ 编辑"。上下文感知 > 一成不变。

### D. 反馈要"活"但不吵

- **等待文案随机不重复**：`spinnerVerbs.ts` 的 `pickSpinnerVerb(previous)` 已做"避免连续重复同一词"。等待时的动词要有变化，但别浮夸。
- spinner 行带 `(esc 取消, 12s)`——**同时给出口和进度**，让用户知道"能停"且"等了多久"。
- 无障碍模式（a11y）下**关掉动画**，spinner 用静态字符（屏幕阅读器会把每帧字符变化读成噪声）。任何动画都要想 a11y 退路。
- 长任务给可视进度（TodoPanel 的 `▰▱` 进度条），不要只有转圈。

### E. 危险操作要"挡一下"，安全默认

- 破坏性命令（`rm -rf`、`git reset --hard`、批量删除等）在确认框里**额外标红警告**（对标 cc 的 `destructiveCommandWarning`），不能和普通确认长一个样。
- 确认框的**默认聚焦项**对危险操作应是"拒绝/取消"，让手滑回车不会造成破坏。
- 权限确认按键语义用颜色区分（y 绿 / n 红 / a 蓝），高频决策一眼可辨（`PermissionPrompt.tsx` 已实现）。

### F. 键盘可达 + 一致

- 所有交互**键盘可完成**，不依赖鼠标。补全 ↑↓ 选择、Enter 确认、ESC 退出，是肌肉记忆，别改语义。
- 和弦键（多键序列）要有**超时取消**（本项目 1.5s 未按第二键则丢弃前缀，见 `InputArea.tsx` K5），并防止前缀键误触。
- 键位集中在 `keybindings/`，不在组件里散落硬编码。

### G. 即时性——状态变化立刻可见

- 工具执行：`pending`(灰) → `executing`(蓝) → `success`(绿)/`error`(红)，状态点颜色实时流转，用户始终知道"现在到哪了"。
- 流式输出逐字可见，不要憋到结束才一次性吐出。
- 列表/清单更新（如 TodoPanel）随状态实时重渲染，不滞后。

---

## 改完必做（CLAUDE.md §0 同款，不可跳过）

1. `bunx tsc --noEmit` 确认改动文件无类型错误（JSX runtime 的 "React is declared but never read" 是误报，可忽略）。
2. `bun test`（全量单测，以实际输出为准）。
3. `make build` 验证构建成功。
4. 临时预览脚本用完即删。注：本项目 ink 是 fork（`src/ink/`，render 入口在 `render-to-screen.ts`/`root.ts`，非标准 `index.js`），一次性脚本难拼全 context provider 链来渲染组件预览——验证视觉改动改用 `bun -e` 打印字形 + `getSemanticColors()` 颜色映射 + 关键计算（如进度条 0/1 边界），比拼渲染环境可靠。

---

## 反例 → 正例对照

| ❌ 反例 | ✅ 正例 |
|--------|--------|
| `<Text>{"✅ "}{item.content}</Text>` | `<Text color={theme.status.success}>{TODO_COMPLETED}</Text>` + `strikethrough` |
| `icon = isError ? "✕" : "✓"`（散落各处、字形不一） | 从 `figures.ts` 取 `ERROR_MARK`/`SUCCESS_MARK` |
| `color={theme.status.info}`（undefined） | `color={theme.ui.active}` |
| `borderColor="#f9e2af"` | `borderColor={theme.status.warning}` |
| 顶/分隔/中/底 四个 Box 拼边框 | 单个 `borderStyle="round"` 容器 + 内部 `borderTop` 分隔 |
| `📁📄⌘` 补全图标 | `▸ · ›` 单列字形 |

---

## 写提示词的人看这里

要继续这类优化，对 Claude 说一句就够：

> **「XXX 组件现在很丑/很乱/不好用，参照 src/ui/CLAUDE.md 的规范重做一遍。」**

Claude 会自动按两套铁律走：
- **样式**：诊断彩色 emoji / 盒子套盒子 / 配色 bug / 对齐漂移 → 按 1-5 改
- **交互**：检查会不会丢输入、中断有没有出路、提示是否唠叨、危险操作有没有挡 → 按 A-G 改
- 最后跑 test + build 验证

按场景选措辞：
- 只想动外观 → 「按样式铁律(1-5)优化 XXX 的视觉」
- 重点是好不好用 → 「按交互铁律(A-G)审一遍 XXX 的体验，列问题给我」
- 说不清哪里别扭 → 「先按 src/ui/CLAUDE.md 诊断 XXX，列优化点给我选」
