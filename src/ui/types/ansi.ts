/**
 * ANSI 输出类型定义
 *
 * 用于表示终端 ANSI 转义码解析后的结构化数据
 * 参考 gemini-cli/packages/core/src/utils/terminalSerializer.ts
 */

export interface AnsiToken {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  inverse: boolean;
  fg: string;
  bg: string;
}

export type AnsiLine = AnsiToken[];
export type AnsiOutput = AnsiLine[];
