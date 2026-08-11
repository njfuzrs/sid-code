/**
 * 终端颜色的原始值类型（P2-2 分包：shared 侧）
 *
 * ## 为什么在 shared
 *
 * `src/agent/color.ts`（core）与 `src/ink/styles.ts`（tui-renderer）都要用这个类型。
 * 原先定义在 ink 里、由 agent 反向导入，形成 `core → tui-renderer` 依赖 ——
 * 方向虽合法（rank 上 tui-renderer 更低），但让 core 知道 TUI 的存在，
 * 与「core 能当库独立使用」这条价值冲突。下移到 shared 后 `core → tui-renderer` 归零。
 *
 * ## 为什么只搬 Color，不搬整个 styles.ts
 *
 * 这几个类型是**纯字符串字面量联合**，零依赖、零运行时代码。而 `styles.ts` 的其余部分
 * （`TextStyles` / `BorderStyle` / Yoga 的 `LayoutNode`）都紧贴渲染实现，
 * 搬进 shared 等于把渲染器拆散。判据是依赖闭包大小，不是"看起来相关"。
 */

export type RGBColor = `rgb(${number},${number},${number})`;
export type HexColor = `#${string}`;
export type Ansi256Color = `ansi256(${number})`;
export type AnsiColor =
  | "ansi:black"
  | "ansi:red"
  | "ansi:green"
  | "ansi:yellow"
  | "ansi:blue"
  | "ansi:magenta"
  | "ansi:cyan"
  | "ansi:white"
  | "ansi:blackBright"
  | "ansi:redBright"
  | "ansi:greenBright"
  | "ansi:yellowBright"
  | "ansi:blueBright"
  | "ansi:magentaBright"
  | "ansi:cyanBright"
  | "ansi:whiteBright";

/** Raw color value - not a theme key */
export type Color = RGBColor | HexColor | Ansi256Color | AnsiColor;
