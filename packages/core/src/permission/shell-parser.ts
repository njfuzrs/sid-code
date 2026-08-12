/**
 * Shell 命令解析器
 * 拆分复合命令（&&, ||, ;, |）+ 检测重定向操作
 * 状态机实现，正确处理引号、转义、子 shell
 */

/** 重定向检测结果 */
export interface RedirectionInfo {
  hasRedirection: boolean;
  targets: string[];
}

/**
 * 拆分复合 shell 命令
 * 在 &&、||、;、| 处拆分，正确处理引号和转义
 *
 * 示例：
 * - `echo "a && b"` → `["echo \"a && b\""]`（引号内不拆分）
 * - `echo a && rm -rf /` → `["echo a", "rm -rf /"]`
 * - `cat file | grep foo` → `["cat file", "grep foo"]`
 * - `echo 'hello; world'` → `["echo 'hello; world'"]`
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

/** 敏感重定向目标路径 */
const SENSITIVE_REDIRECT_PATHS = [
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
  /\.bashrc$/,
  /\.zshrc$/,
  /\.profile$/,
  /\.bash_profile$/,
  /\.ssh\//,
  /\.env$/,
  /\.env\./,
  // sid-code / Claude 配置目录：拦截 `echo ... > /abs/path/.sid-code/settings.json` 这类
  // 用绝对路径重定向覆盖配置文件的写入（bash 无 file_path，不走 safetyCheck，只能在此拦）。
  // 匹配路径中任意位置的配置目录段，覆盖绝对路径、相对路径两种形态。
  /(^|\/)\.sid-code\//,
  /(^|\/)\.claude\//,
];

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
