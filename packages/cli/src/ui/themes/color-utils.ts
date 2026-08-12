/**
 * 颜色工具函数
 *
 * 提供颜色解析、插值、亮度计算等功能。
 * 参考 gemini-cli/packages/cli/src/ui/themes/color-utils.ts 和 theme.ts
 */

import tinycolor from "tinycolor2";
import tinygradient from "tinygradient";
import type { AnsiColor, Color } from "@sid-code/tui-renderer/styles.ts";

// Ink 支持的命名颜色集合
export const INK_SUPPORTED_NAMES = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "cyan",
  "magenta",
  "white",
  "gray",
  "grey",
  "blackbright",
  "redbright",
  "greenbright",
  "yellowbright",
  "bluebright",
  "cyanbright",
  "magentabright",
  "whitebright",
]);

/**
 * Ink 命名色（小写，用户可能这么输入）→ ink `Color` 联合里的 `ansi:*` 形态。
 *
 * 存在的理由见 {@link resolveColor} 第 2 步：ink 的 colorize() 只认 `ansi:` 前缀，
 * 裸命名色静默不上色。键取全小写因为用户输入会先 toLowerCase；值必须保留 ink
 * `AnsiColor` 联合里的驼峰拼写（`ansi:blackBright` 而非 `ansi:blackbright`）。
 *
 * gray / grey 在 ANSI 里没有独立槽位，按终端惯例等同 bright black。
 */
const INK_NAME_TO_ANSI_MAP: Readonly<Record<string, AnsiColor>> = {
  black: "ansi:black",
  red: "ansi:red",
  green: "ansi:green",
  yellow: "ansi:yellow",
  blue: "ansi:blue",
  magenta: "ansi:magenta",
  cyan: "ansi:cyan",
  white: "ansi:white",
  gray: "ansi:blackBright",
  grey: "ansi:blackBright",
  blackbright: "ansi:blackBright",
  redbright: "ansi:redBright",
  greenbright: "ansi:greenBright",
  yellowbright: "ansi:yellowBright",
  bluebright: "ansi:blueBright",
  magentabright: "ansi:magentaBright",
  cyanbright: "ansi:cyanBright",
  whitebright: "ansi:whiteBright",
};

// ANSI 亮色到十六进制的映射
export const INK_NAME_TO_HEX_MAP: Readonly<Record<string, string>> = {
  blackbright: "#555555",
  redbright: "#ff5555",
  greenbright: "#55ff55",
  yellowbright: "#ffff55",
  bluebright: "#5555ff",
  magentabright: "#ff55ff",
  cyanbright: "#55ffff",
  whitebright: "#ffffff",
};

// CSS 颜色名到十六进制的映射（排除 Ink 已支持的）
export const CSS_NAME_TO_HEX_MAP = Object.fromEntries(
  Object.entries(tinycolor.names)
    .filter(([name]) => !INK_SUPPORTED_NAMES.has(name))
    .map(([name, hex]) => [name, `#${hex}`]),
);

/**
 * 计算颜色的相对亮度
 * 参考 WCAG 2.0 规范
 */
export function getLuminance(color: string): number {
  const resolved = color.toLowerCase();
  const hex = INK_NAME_TO_HEX_MAP[resolved] || resolved;

  const colorObj = tinycolor(hex);
  if (!colorObj.isValid()) {
    return 0;
  }

  // tinycolor 返回 0-1，转换为 0-255
  return colorObj.getLuminance() * 255;
}

/**
 * 解析 CSS 颜色值为 Ink 兼容的颜色字符串
 */
export function resolveColor(colorValue: string): Color | undefined {
  const lowerColor = colorValue.toLowerCase();

  // 1. 检查是否为十六进制代码
  if (lowerColor.startsWith("#")) {
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
      return lowerColor as Color;
    } else {
      return undefined;
    }
  }

  // 处理无 # 的十六进制代码
  if (/^[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
    return `#${lowerColor}`;
  }

  // 2. Ink 命名色 → `ansi:*` 形态。
  //
  // ⚠️ 这里必须加 `ansi:` 前缀，不能原样返回裸名。ink 的 colorize()
  // （src/ink/colorize.ts）只识别四种形态：`ansi:*` / `#hex` / `rgb()` / `ansi256()`，
  // 裸 "cyan" 会一路落到函数末尾的 `return str` —— **静默不上色，无任何报错**。
  // 实测（FORCE_COLOR=3）：`ansi:cyan` → `\e[36m`，而裸 `cyan` / `gray` /
  // `blackbright` 全部原样返回。此前 `/color cyan` 存的就是裸名，等于设了个不生效的
  // 强调色，而 tests/command/color.test.ts 还把"按原样保留"断言成了正确行为。
  const ansiName = INK_NAME_TO_ANSI_MAP[lowerColor];
  if (ansiName) {
    return ansiName;
  }

  // 3. 检查是否为已知的 CSS 颜色名
  const colorObj = tinycolor(lowerColor);
  if (colorObj.isValid()) {
    // toHexString() 的签名是 string，但实际恒为 `#rrggbb`（HexColor）。
    return colorObj.toHexString() as Color;
  }

  // 4. 无法解析
  return undefined;
}

/**
 * 在两个颜色之间插值。
 *
 * 两个重载表达同一件事：**入参多窄，出参就多窄**（同 {@link MixedColor} 的理由）。
 * 传两个 `Color` 必得 `Color`——四条返回路径分别是原样返回 `color1` / `color2`、
 * `toHexString()`（`#rrggbb`）、以及 catch 里的 `color1`，在两参均为 `Color` 时全部
 * 仍是 `Color`。唯一的例外 `return ""` 要求某个入参为空串，而 `Color` 联合的每个成员
 * （`#${string}` / `rgb(…)` / `ansi256(…)` / `ansi:*`）都是非空模板字面量，静态不可达。
 *
 * 宽 `string` 重载保留给 `ColorsTheme` 之外的调用方（如 HalfLinePaddedBox 传的是
 * `resolveColor(...) || 原值`，原值可能是任意字符串）。
 */
export function interpolateColor(color1: Color, color2: Color, factor: number): Color;
export function interpolateColor(color1: string, color2: string, factor: number): string;
export function interpolateColor(color1: string, color2: string, factor: number): string {
  if (factor <= 0 && color1) {
    return color1;
  }
  if (factor >= 1 && color2) {
    return color2;
  }
  if (!color1 || !color2) {
    return "";
  }
  try {
    const gradient = tinygradient(color1, color2);
    const color = gradient.rgbAt(factor);
    return color.toHexString();
  } catch (_e) {
    return color1;
  }
}

/** mixToContrast 结果缓存：惰性取色会在每次 render 调用，二分求解不该每帧重算。 */
const mixToContrastCache = new Map<string, string>();

/**
 * 颜色计算函数的返回类型：**入参多窄，出参就多窄**。
 *
 * 这类函数（`mixToContrast` 及同族）只有两种返回路径：① 原样返回入参 `color`（输入非法、
 * 或已经足够弱时的短路）；② 返回 `tinycolor(...).toHexString()`，也就是 `#rrggbb`。
 * 两条路径在 `C extends Color` 时都仍是 `Color`，所以传 `Color` 进去必得 `Color` 出来 ——
 * 而这正是调用方需要的：结果直接喂给 `<Box borderColor=…>` / `<Text color=…>`。
 *
 * 为什么用泛型而不是把签名直接写成 `(color: Color, …) => Color`：非法输入原样返回是
 * **刻意的契约**（`tests/ui/input-border-color.test.ts:66` 锁了 `"not-a-color"` 原样返回），
 * 把入参收紧成 `Color` 会让那个测试连编译都过不了。泛型两头都保住。
 */
type MixedColor<C extends string> = C extends Color ? Color : string;

/**
 * 把 `color` 朝 `background` 方向混淡，直到与背景的对比度**刚好不高于** `targetRatio`。
 *
 * 用途：需要"同一个色相、但退到结构层"的弱化色（如输入框边框相对提示符）。
 * 直接写死混合比例（`mix(brand, bg, 60%)`）在不同主题下效果不一致——各主题背景亮度不同，
 * 同一比例算出的对比度能差一倍。按目标对比度反解比例，才能让所有主题观感一致。
 *
 * 若 `color` 本身对比度已 ≤ 目标（即已经足够弱），原样返回，不会反向加强。
 *
 * @param targetRatio WCAG 对比度目标（1 = 与背景同色不可见）。装饰性边框取 2~3 之间：
 *                    低于 ~2 会糊进背景，高于 ~3.5 开始与正文抢视觉重心。
 */
export function mixToContrast<C extends string>(
  color: C,
  background: string,
  targetRatio: number,
): MixedColor<C> {
  const cacheKey = `${color}|${background}|${targetRatio}`;
  const cached = mixToContrastCache.get(cacheKey);
  if (cached !== undefined) return cached as MixedColor<C>;

  const fg = tinycolor(color);
  const bg = tinycolor(background);
  if (!fg.isValid() || !bg.isValid()) return color as MixedColor<C>;

  // 显式标注 string 而非让它推断成 C：下面会赋一个 toHexString() 的结果进去，
  // 那是 `#rrggbb` 但静态上只是 string，不能冒充调用方传进来的具体 C。
  // 两种取值在 C extends Color 时都仍是 Color，所以最终 as MixedColor<C> 成立。
  let result: string = color;
  if (tinycolor.readability(color, background) > targetRatio) {
    // 二分求解混合比例：比例越大越靠近背景、对比度越低（单调），可二分。
    let lo = 0; // 纯 color，对比度最高
    let hi = 100; // 纯 background，对比度 = 1
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const candidate = tinycolor.mix(fg, bg, mid).toHexString();
      if (tinycolor.readability(candidate, background) > targetRatio) {
        lo = mid; // 还太强，继续朝背景混
      } else {
        hi = mid;
      }
    }
    result = tinycolor.mix(fg, bg, hi).toHexString();
  }

  mixToContrastCache.set(cacheKey, result);
  return result as MixedColor<C>;
}

/**
 * 根据背景色判断主题类型
 */
export function getThemeTypeFromBackgroundColor(
  backgroundColor: string | undefined,
): "light" | "dark" | undefined {
  if (!backgroundColor) {
    return undefined;
  }

  const resolvedColor = resolveColor(backgroundColor);
  if (!resolvedColor) {
    return undefined;
  }

  const luminance = getLuminance(resolvedColor);
  // 亮度阈值：128（0-255 的中点）
  return luminance > 128 ? "light" : "dark";
}

/**
 * 检查颜色字符串是否有效。
 *
 * 需要同时接受**两侧口径**，因为两个调用点喂进来的东西不同源：
 *   - `/color <arg>`（command/commands/color/color.ts:59）传的是**用户原始输入**
 *     （`cyan` / `#89b4fa` / `rebeccapurple`）；
 *   - `themeManager.setAccentOverride()`（themes/theme-manager.ts:59）传的可能是
 *     **已被 resolveColor 归一化过的值**（`ansi:cyan`），也可能是 settings.json 里
 *     用户手改的任意字符串。
 * 漏掉 `ansi:` 一侧会导致 `/color cyan` 归一化成 `ansi:cyan` 后又被这里判为非法、
 * 静默回落 undefined —— 即「设了色但没生效」。
 */
export function isValidColor(color: string): boolean {
  const lowerColor = color.toLowerCase();

  // 1. 检查是否为十六进制代码
  if (lowerColor.startsWith("#")) {
    return /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(color);
  }

  // 2. ink Color 联合里的三种带前缀形态（resolveColor 的输出 + 主题里可直接书写的值）。
  //    大小写不敏感地比对 ansi 名（Color 联合用驼峰 `ansi:blackBright`）。
  if (lowerColor.startsWith("ansi:")) {
    return Object.values(INK_NAME_TO_ANSI_MAP).some((v) => v.toLowerCase() === lowerColor);
  }
  if (lowerColor.startsWith("ansi256(")) {
    const m = /^ansi256\(\s*(\d+)\s*\)$/.exec(lowerColor);
    return m !== null && Number(m[1]) <= 255;
  }
  if (lowerColor.startsWith("rgb(")) {
    const m = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(lowerColor);
    return m !== null && [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
  }

  // 3. 检查是否为 Ink 支持的命名颜色（用户原始输入的裸名，如 `cyan`）
  if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return true;
  }

  // 4. 检查是否为已知的 CSS 颜色名
  if (CSS_NAME_TO_HEX_MAP[lowerColor]) {
    return true;
  }

  // 5. 不是有效颜色
  return false;
}

/**
 * 检测终端是否为低色深模式
 * 低色深终端（如 8 色、16 色）不支持 24-bit 真彩色
 */
export function isLowColorDepth(): boolean {
  // NO_COLOR 环境变量表示禁用颜色
  if (process.env["NO_COLOR"]) return true;

  // COLORTERM=truecolor 或 24bit 表示支持真彩色
  const colorTerm = process.env["COLORTERM"]?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return false;

  // TERM_PROGRAM 检测常见终端
  const termProgram = process.env["TERM_PROGRAM"]?.toLowerCase();
  if (termProgram === "iterm.app" || termProgram === "hyper" || termProgram === "wezterm")
    return false;

  // TERM 检测
  const term = process.env["TERM"]?.toLowerCase() || "";
  if (term.includes("256color")) return false;

  // 默认认为是低色深
  return true;
}

/**
 * 为低色深终端返回安全的背景色
 */
export function getSafeLowColorBackground(terminalBg: string): Color | undefined {
  const resolvedTerminalBg = resolveColor(terminalBg) || terminalBg;
  if (
    resolvedTerminalBg === "black" ||
    resolvedTerminalBg === "#000000" ||
    resolvedTerminalBg === "#000"
  ) {
    return "#1c1c1c";
  }
  if (
    resolvedTerminalBg === "white" ||
    resolvedTerminalBg === "#ffffff" ||
    resolvedTerminalBg === "#fff"
  ) {
    return "#eeeeee";
  }
  return undefined;
}
