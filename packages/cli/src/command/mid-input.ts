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

/**
 * 斜杠补全的目标：查询词 + 替换起点。
 *
 * `replaceFrom === null` 表示行首命令（情况 A，整行就是命令）；
 * 数字表示中间位置 token 的 `/` 所在列（情况 B），应用补全时只替换 `[replaceFrom, cursorCol)`。
 */
export interface SlashCompletionTarget {
  query: string;
  replaceFrom: number | null;
}

/**
 * 按**光标所在行**判定斜杠补全目标（D5）。
 *
 * 修复前调用方固定传第 1 行，光标不在第 1 行时把列钳成 `firstLine.length`
 * ——「假装光标在第一行末尾」，于是用户在第 2 行打字时补全仍按第 1 行结尾的 `/xxx` 弹出，
 * 上下键被补全列表吃掉，误按 Enter 还会落进 D4 的整行替换。同一组件里 @ 补全早就按当前行。
 *
 * 行首命令只在第 1 行成立（命令必须是整条输入的开头）；其它行只认中间位置 token。
 */
export function resolveSlashCompletionTarget(
  lines: readonly string[],
  cursorRow: number,
  cursorCol: number,
): SlashCompletionTarget | null {
  const line = lines[cursorRow] ?? "";
  if (cursorRow === 0 && line.startsWith("/")) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx !== -1 && cursorCol > spaceIdx) return null;
    return { query: line.slice(1, cursorCol), replaceFrom: null };
  }
  const mid = findMidInputSlashCommand(line, cursorCol);
  if (!mid) return null;
  return { query: mid.partialCommand, replaceFrom: mid.startPos };
}

/**
 * 把选中的斜杠补全写回缓冲区（D4），返回新的行数组与光标。
 *
 * 修复前应用侧一律 `home + killLine` 整行替换，把检测侧特意算好的 `startPos` 丢掉：
 * `帮我看下 /com` → Tab → `/compact `，前面那句话被静默删除。
 * 中间位置时只替换 token，前缀与光标后的内容都保留（与 @ 补全同口径）。
 */
export function applySlashCompletion(
  lines: readonly string[],
  cursorRow: number,
  cursorCol: number,
  replaceFrom: number | null,
  value: string,
): { lines: string[]; cursorRow: number; cursorCol: number } {
  const next = [...lines];
  const line = next[cursorRow] ?? "";
  if (replaceFrom === null) {
    next[cursorRow] = value;
    return { lines: next, cursorRow, cursorCol: value.length };
  }
  const from = Math.max(0, Math.min(replaceFrom, cursorCol));
  next[cursorRow] = line.slice(0, from) + value + line.slice(cursorCol);
  return { lines: next, cursorRow, cursorCol: from + value.length };
}

/**
 * 补全列表里按 Enter 能否直接提交命令（D4）。
 *
 * 直接提交会丢弃输入框里除命令名以外的全部内容，所以只在「整条输入就是这一个命令 token」
 * 时成立：行首命令 + 单行 + 无其它词。中间位置 / 多行 / 已带其它内容时一律只回填。
 */
export function canSubmitSlashCompletionDirectly(
  lines: readonly string[],
  replaceFrom: number | null,
  requiresArgs: boolean | undefined,
): boolean {
  if (requiresArgs) return false;
  if (replaceFrom !== null) return false;
  if (lines.length !== 1) return false;
  return !/\s/.test((lines[0] ?? "").trim());
}
