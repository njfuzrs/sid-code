/**
 * ANSI 输出类型定义
 *
 * 用于表示终端 ANSI 转义码解析后的结构化数据
 * 参考 gemini-cli/packages/core/src/utils/terminalSerializer.ts
 */

import type { Color } from "../../ink/styles.ts";

export interface AnsiToken {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  inverse: boolean;
  /**
   * 可选而非必填空字符串：唯一的生产方 `ToolResultDisplay.parseAnsiString` 是纯文本
   * 转 AnsiOutput 的占位 shim，从不填真实颜色（历史上写 `fg: '', bg: ''`）。
   * `''` 不是合法 `Color`，传给 ink `<Text color>` 也只是「什么都不做」——
   * 用 `undefined` 表达同样的「无色」语义，且类型诚实。
   */
  fg?: Color;
  bg?: Color;
}

export type AnsiLine = AnsiToken[];
export type AnsiOutput = AnsiLine[];
