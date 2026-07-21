/**
 * Shell 工具（Bash）权限规则匹配
 *
 * 背景（对齐 claude-code §7 P0-1）：
 * 旧实现对 Bash 参数模式用 minimatch（文件系统 glob 匹配器），`*` 按设计**不跨越 `/`**，
 * 还带 brace/bracket/extglob 语义。而 shell 命令里路径极常见，导致规则大面积失配：
 *   - Bash(*) 「所有命令」哨兵对任何含路径的命令失效（allow 侧静默漏放）
 *   - 含 / 的用户自定义拦截规则（如匹配 secrets 目录）无声失效（deny 侧安全问题）
 *
 * 本模块移植 CC `shellRuleMatching.ts:matchWildcardPattern` 的自研正则匹配：
 *   - 处理转义 `\*`（字面星号）、`\\`（字面反斜杠），用占位符暂存
 *   - 转义正则元字符但**保留 `*`**
 *   - 未转义 `*` → `.*`（跨 `/`、跨任意字符）
 *   - 尾部 ` *`（空格+唯一通配符）特判：`git *` 同时匹配 `git add` 和裸 `git`
 *   - dotAll `s` flag：`.` 匹配换行，使通配符能匹配含内嵌换行的命令（heredoc 场景）
 *   - 支持 caseInsensitive
 *
 * 纯函数、无外部依赖，便于单测。
 */

// 空字节哨兵占位符（用于通配符转义）——模块级，使 RegExp 只编译一次而非每次权限检查都编译。
const ESCAPED_STAR_PLACEHOLDER = "\x00ESCAPED_STAR\x00";
const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00ESCAPED_BACKSLASH\x00";
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, "g");
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, "g");

/**
 * 从 legacy `:*` 语法提取前缀（如 `"npm:*"` → `"npm"`）。
 * 为向后兼容保留。返回 null 表示不是 `:*` 前缀语法。
 */
export function extractLegacyPrefix(rule: string): string | null {
  const match = rule.match(/^(.+):\*$/);
  return match?.[1] ?? null;
}

/**
 * 判断模式是否含未转义通配符（非 legacy `:*` 语法）。
 * 末尾 `:*` 视为 legacy 前缀语法，不算通配符。
 * 星号「未转义」= 其前的反斜杠数为偶数（含 0）。
 */
export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(":*")) {
    return false;
  }
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === "\\") {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 用通配符模式匹配命令。
 * 通配符 `*` 匹配任意字符序列（跨 `/`、跨换行）。
 * `\*` 匹配字面星号；`\\` 匹配字面反斜杠。
 *
 * @param pattern 权限规则模式（含通配符）
 * @param command 待匹配命令
 * @param caseInsensitive 是否大小写不敏感
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  const trimmedPattern = pattern.trim();

  // 处理转义序列 \* 和 \\，用占位符暂存
  let processed = "";
  let i = 0;
  while (i < trimmedPattern.length) {
    const char = trimmedPattern[i];
    if (char === "\\" && i + 1 < trimmedPattern.length) {
      const nextChar = trimmedPattern[i + 1];
      if (nextChar === "*") {
        processed += ESCAPED_STAR_PLACEHOLDER;
        i += 2;
        continue;
      } else if (nextChar === "\\") {
        processed += ESCAPED_BACKSLASH_PLACEHOLDER;
        i += 2;
        continue;
      }
    }
    processed += char;
    i++;
  }

  // 转义正则元字符，但保留 *
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");

  // 未转义 * → .*
  const withWildcards = escaped.replace(/\*/g, ".*");

  // 占位符还原为转义的正则字面量
  let regexPattern = withWildcards
    .replace(ESCAPED_STAR_PLACEHOLDER_RE, "\\*")
    .replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, "\\\\");

  // 尾部 ` *`（空格+唯一未转义通配符）特判：使尾随空格和参数可选，
  // 让 `git *` 同时匹配 `git add` 和裸 `git`（对齐 `git:*` 前缀语义）。
  // 多通配符模式（如 `* run *`）排除——否则末尾通配符可选会误匹配 `npm run`（无尾参）。
  const unescapedStarCount = (processed.match(/\*/g) || []).length;
  if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + "( .*)?";
  }

  // 全串匹配。dotAll `s` flag 使 `.` 匹配换行，让通配符能匹配含内嵌换行的命令。
  const flags = "s" + (caseInsensitive ? "i" : "");
  const regex = new RegExp(`^${regexPattern}$`, flags);

  return regex.test(command);
}

/**
 * 匹配 shell 命令参数模式（Bash 工具规则的参数部分）。
 * 统一入口：兼容旧的 `prefix:` 扩展语法 + legacy `:*` 前缀 + 通配符 + 精确匹配。
 *
 * @param pattern 规则括号内的参数模式，如 `"npm *"`、`"prefix:git "`、`"git:*"`、`"ls -la"`
 * @param command 待匹配的完整命令串（来自 input.command）
 */
export function matchShellRulePattern(pattern: string, command: string): boolean {
  // 兼容既有 prefix: 扩展语法（sid 自有）
  if (pattern.startsWith("prefix:")) {
    return command.startsWith(pattern.slice(7));
  }

  // legacy `:*` 前缀语法（如 `git:*` 匹配 `git` 开头的命令，含裸 `git`）
  const legacyPrefix = extractLegacyPrefix(pattern);
  if (legacyPrefix !== null) {
    // 前缀匹配：命令等于前缀，或以「前缀 + 空格」开头
    return command === legacyPrefix || command.startsWith(legacyPrefix + " ");
  }

  // 通配符或精确匹配统一走 matchWildcardPattern
  // （无通配符时正则退化为精确全串匹配，语义正确）
  return matchWildcardPattern(pattern, command);
}
