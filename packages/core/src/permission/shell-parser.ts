/**
 * Shell 命令解析器
 * 拆分复合命令（&&, ||, ;, |, 后台 &, 换行）+ 检测重定向操作
 * 状态机实现，正确处理引号、转义、子 shell
 */

import { SAFETY_PROTECTED_PATHS } from "./safety-protected-paths.ts";

/** 重定向检测结果 */
export interface RedirectionInfo {
  hasRedirection: boolean;
  targets: string[];
}

/**
 * 拆分复合 shell 命令
 * 在 &&、||、;、|、后台 &、换行 处拆分，正确处理引号和转义
 *
 * 示例：
 * - `echo "a && b"` → `["echo \"a && b\""]`（引号内不拆分）
 * - `echo a && rm -rf /` → `["echo a", "rm -rf /"]`
 * - `cat file | grep foo` → `["cat file", "grep foo"]`
 * - `echo 'hello; world'` → `["echo 'hello; world'"]`
 * - `ls & rm -rf dir` → `["ls", "rm -rf dir"]`（后台 & 是命令分隔符）
 *
 * 为什么后台 & 和换行必须算分隔符：权限规则匹配是逐子命令做的
 * （checker.ts checkDenyRules/checkAllowRules），而 minimatch 的 `*` 不跨分隔符
 * 只在「整条被拆开」的前提下成立。漏拆时 `allow: ["Bash(ls *)"]` 会把
 * `ls & rm -rf dir` 整条吞掉放行，`deny: ["Bash(curl *)"]` 也拦不住
 * `ls &\ncurl evil.com`。对齐 CC splitCommand 把 & 与换行都当分隔符。
 *
 * 两个容易误拆的形态要排除：
 * - `&>` / `&>>` 是「全部输出重定向」，`&` 后面紧跟 `>` 不是后台符。
 * - `2>&1` / `>&2` 这类 fd 复制里的 `&` 前面是数字或 `>`，不是命令边界。
 */
export function splitCompoundCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;

  // 引号/转义状态
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  // 子 shell 嵌套深度：$(...) 和 (...)
  let parenDepth = 0;
  // 花括号嵌套深度：${...}
  let braceDepth = 0;

  while (i < cmd.length) {
    const ch = cmd[i];
    const next = i + 1 < cmd.length ? cmd[i + 1] : "";

    // 反斜杠转义：跳过下一个字符
    if (ch === "\\" && !inSingleQuote) {
      current += ch + next;
      i += 2;
      continue;
    }

    // 单引号状态切换（双引号内不切换）
    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }

    // 双引号状态切换（单引号内不切换）
    if (ch === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    // 反引号状态切换
    if (ch === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += ch;
      i++;
      continue;
    }

    // 在任何引号内，直接追加
    if (inSingleQuote || inDoubleQuote || inBacktick) {
      current += ch;
      i++;
      continue;
    }

    // $( 开始子 shell
    if (ch === "$" && next === "(") {
      parenDepth++;
      current += ch + next;
      i += 2;
      continue;
    }

    // ${ 开始变量展开
    if (ch === "$" && next === "{") {
      braceDepth++;
      current += ch + next;
      i += 2;
      continue;
    }

    // ( 普通子 shell
    if (ch === "(") {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }

    // ) 关闭子 shell
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      current += ch;
      i++;
      continue;
    }

    // } 关闭变量展开
    if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
      current += ch;
      i++;
      continue;
    }

    // 在子 shell 或变量展开内，不拆分
    if (parenDepth > 0 || braceDepth > 0) {
      current += ch;
      i++;
      continue;
    }

    // 分隔符检测：&&
    if (ch === "&" && next === "&") {
      pushPart(parts, current);
      current = "";
      i += 2;
      continue;
    }

    // 分隔符检测：||
    if (ch === "|" && next === "|") {
      pushPart(parts, current);
      current = "";
      i += 2;
      continue;
    }

    // 分隔符检测：| （单管道）
    if (ch === "|") {
      pushPart(parts, current);
      current = "";
      i++;
      continue;
    }

    // 分隔符检测：;
    if (ch === ";") {
      pushPart(parts, current);
      current = "";
      i++;
      continue;
    }

    // 分隔符检测：后台 &（单个 &，&& 已在上面处理）
    //
    // &> 与 &>> 是「全部输出重定向」不是后台符：& 后面紧跟 > 时整段留给
    // detectRedirections 去判，这里不拆。
    //
    // N>&M / >&N 是 fd 复制（2>&1、>&2）：& 紧跟在数字或 > 后面时同样不是
    // 命令边界。用「前一个非空白字符」判断，空白隔开的 `cmd & cmd` 不受影响。
    //
    // 必须看「前一个字符」而不是「前一个非空白字符」：2>&1 & other 里第二个 &
    // 前面是空格，它是真后台符；若跳过空白去看，会看到 1 而把它误判成 fd 复制。
    if (ch === "&" && next !== ">") {
      const prevCh = i > 0 ? cmd[i - 1] : "";
      const prevIsDigit = prevCh >= "0" && prevCh <= "9";
      if (!prevIsDigit && prevCh !== ">") {
        pushPart(parts, current);
        current = "";
        i++;
        continue;
      }
    }

    // 分隔符检测：换行。shell 里换行就是命令分隔符（等价于 ;），
    // `ls &\ncurl x` 与 `cmd1\ncmd2` 都是两条命令。引号 / 子 shell 内的
    // 换行已在上面的状态分支里被原样保留，到不了这里。
    if (ch === "\n") {
      pushPart(parts, current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  pushPart(parts, current);
  return parts;
}

/** 将非空部分加入数组 */
function pushPart(parts: string[], part: string): void {
  const trimmed = part.trim();
  if (trimmed) parts.push(trimmed);
}

/**
 * 敏感重定向目标路径。
 *
 * 前半：系统目录 / 家目录 dotfiles / 凭证文件（bash 无 file_path，不走 safetyCheck）。
 * 后半：safetyCheck 名单转成路径段正则——单一事实源，修 write 漏 bash 的洞不会再开（P1-4）。
 */
const SENSITIVE_REDIRECT_PATHS: RegExp[] = [
  /^\/etc\//,
  /^\/usr\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/boot\//,
  /^\/var\/log\//,
  /^\/System\//,
  /^\/Library\//,
  /^~\/\./, // 家目录下的 dotfiles
  /^\$HOME\/\./, // $HOME 下的 dotfiles
  /\.env$/,
  /\.env\./,
  ...SAFETY_PROTECTED_PATHS.map(safetyPatternToRedirectRegex),
];

/** `.git/hooks/` → `(^|/)\.git/hooks/`；`.bashrc` → `(^|/)\.bashrc$` */
function safetyPatternToRedirectRegex(sp: { pattern: string }): RegExp {
  const escaped = sp.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (sp.pattern.endsWith("/")) {
    return new RegExp(`(^|/)${escaped}`);
  }
  return new RegExp(`(^|/)${escaped}$`);
}

/**
 * 检测命令中的重定向操作
 * 识别 >、>>、2>、2>>、&>、&>> 操作符并提取目标路径
 */
export function detectRedirections(cmd: string): RedirectionInfo {
  const targets: string[] = [];

  // 重定向正则：匹配 >、>>、2>、2>>、&>、&>> 后面的路径
  // 注意：不匹配引号内的内容（简化处理，先去除引号内容）
  const stripped = stripQuotedStrings(cmd);

  // 匹配重定向操作符 + 目标路径
  const redirectPattern = /(?:&>>|&>|2>>|2>|>>|>)\s*(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = redirectPattern.exec(stripped)) !== null) {
    const target = match[1];
    if (target) targets.push(target);
  }

  return {
    hasRedirection: targets.length > 0,
    targets,
  };
}

/**
 * 检查重定向目标是否指向敏感路径
 */
export function hasSensitiveRedirection(cmd: string): { sensitive: boolean; targets: string[] } {
  const { hasRedirection, targets } = detectRedirections(cmd);
  if (!hasRedirection) return { sensitive: false, targets: [] };

  const sensitiveTargets = targets.filter((target) =>
    SENSITIVE_REDIRECT_PATHS.some((pattern) => pattern.test(target)),
  );

  return {
    sensitive: sensitiveTargets.length > 0,
    targets: sensitiveTargets,
  };
}

/**
 * 去除字符串中引号包裹的内容（用于安全地做正则匹配）
 * 将引号内容替换为等长的空格，保持位置不变
 */
function stripQuotedStrings(cmd: string): string {
  const chars = [...cmd];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < chars.length; i++) {
    if (escaped) {
      if (inSingle || inDouble) chars[i] = " ";
      escaped = false;
      continue;
    }

    if (chars[i] === "\\") {
      escaped = true;
      if (inSingle || inDouble) chars[i] = " ";
      continue;
    }

    if (chars[i] === "'" && !inDouble) {
      inSingle = !inSingle;
      chars[i] = " ";
      continue;
    }

    if (chars[i] === '"' && !inSingle) {
      inDouble = !inDouble;
      chars[i] = " ";
      continue;
    }

    if (inSingle || inDouble) {
      chars[i] = " ";
    }
  }

  return chars.join("");
}
