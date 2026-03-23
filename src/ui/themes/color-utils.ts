/**
 * 颜色工具函数
 *
 * 提供颜色解析、插值、亮度计算等功能。
 * 参考 gemini-cli/packages/cli/src/ui/themes/color-utils.ts 和 theme.ts
 */

import tinycolor from "tinycolor2";
import tinygradient from "tinygradient";

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
export function resolveColor(colorValue: string): string | undefined {
  const lowerColor = colorValue.toLowerCase();

  // 1. 检查是否为十六进制代码
  if (lowerColor.startsWith("#")) {
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
      return lowerColor;
    } else {
      return undefined;
    }
  }

  // 处理无 # 的十六进制代码
  if (/^[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
    return `#${lowerColor}`;
  }

  // 2. 检查是否为 Ink 支持的命名颜色
  if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return lowerColor;
  }

  // 3. 检查是否为已知的 CSS 颜色名
  const colorObj = tinycolor(lowerColor);
  if (colorObj.isValid()) {
    return colorObj.toHexString();
  }

  // 4. 无法解析
  return undefined;
}

/**
 * 在两个颜色之间插值
 */
export function interpolateColor(
  color1: string,
  color2: string,
  factor: number,
): string {
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
 * 检查颜色字符串是否有效
 */
export function isValidColor(color: string): boolean {
  const lowerColor = color.toLowerCase();

  // 1. 检查是否为十六进制代码
  if (lowerColor.startsWith("#")) {
    return /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(color);
  }

  // 2. 检查是否为 Ink 支持的命名颜色
  if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return true;
  }

  // 3. 检查是否为已知的 CSS 颜色名
  if (CSS_NAME_TO_HEX_MAP[lowerColor]) {
    return true;
  }

  // 4. 不是有效颜色
  return false;
}

/**
 * 为低色深终端返回安全的背景色
 */
export function getSafeLowColorBackground(
  terminalBg: string,
): string | undefined {
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
