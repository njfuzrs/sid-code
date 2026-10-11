/**
 * 文本宽度与着色（纯函数）。实现在 `next/text.ts`（底座 `packages/tui`），见 README.md。
 */
export {
  stringWidth,
  applyColor,
  applyTextStyles,
  colorize,
  styledCharsWidth,
  toStyledCharacters,
  widestLineFromStyledChars,
  wordBreakStyledChars,
  wrapStyledChars,
} from "./next/text.ts";
