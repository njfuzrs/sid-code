/**
 * 中间位置命令补全检测
 *
 * 支持在输入中间位置触发命令补全，如 "help me /com" 中的 "/com"。
 * 开头的 "/" 由主补全逻辑（行首斜杠命令）处理，这里只处理非行首的情况。
 */

export interface MidInputSlashCommand {
  /** 完整 token，如 "/com" */
  token: string;
  /** "/" 在输入中的位置 */
  startPos: number;
  /** 去掉 "/" 的部分命令名，如 "com" */
  partialCommand: string;
}

export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  if (input.startsWith("/")) return null; // 行首 / 由主逻辑处理

  const beforeCursor = input.slice(0, cursorOffset);
  // 匹配：空白符 + / + 命令名字符，直到光标
  // 避免 lookbehind（在部分 JS 引擎中会导致 JIT 失败）
  const match = beforeCursor.match(/\s(\/[a-zA-Z0-9_:-]*)$/);
  if (!match) return null;

  const token = match[1];
  const slashPos = beforeCursor.length - token.length;

  return {
    token,
    startPos: slashPos,
    partialCommand: token.slice(1),
  };
}
