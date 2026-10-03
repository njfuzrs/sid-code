/** 文本宽度与着色（纯函数）。见 README.md。 */
export { stringWidth } from "@sid-code/tui-renderer/stringWidth.ts";
export { applyColor, applyTextStyles, colorize } from "@sid-code/tui-renderer/colorize.ts";
export {
  styledCharsWidth,
  toStyledCharacters,
  widestLineFromStyledChars,
  wordBreakStyledChars,
  wrapStyledChars,
} from "@sid-code/tui-renderer/_vendor/styled-chars.ts";
