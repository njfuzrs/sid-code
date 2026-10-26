/**
 * shell 命令的结构化拆分：heredoc 剥离 + 管道分组。
 *
 * ## 为什么需要它
 *
 * `shell-parser.ts` 的 `splitCompoundCommand` 只返回**扁平**的子命令列表，且把换行
 * 一律当作命令分隔符。两个后果都在危险命令检测里变成了真 bug（2026-10-26 实测）：
 *
 * 1. **heredoc 正文被当成命令**。`cat > notes.md <<'EOF'`⏎`rm -rf / is dangerous`⏎`EOF`
 *    会拆出 `{ program: "rm", args: ["-rf", "/"] }`，于是一段文档正文被判成 critical
 *    硬拒（无出口）。正文是**数据**，是否当代码取决于接收者：`bash <<EOF` 才是脚本。
 * 2. **管道关系丢失**。`curl x | sh` 拆成 `["curl x", "sh"]` 后就分不清「这两段是同一个
 *    管道」还是「两条顺序执行的命令」，而「下载并执行」正是关于管道结构的判断。
 *
 * 本模块提供 `extractHeredocBlocks`（剥离正文并保留块）与 `splitCommandStructure`
 * （按管道分组）。扁平拆分仍由 `splitCompoundCommand` 提供，它内部复用本模块的剥离逻辑。
 *
 * ## 分隔符口径必须与 `splitCompoundCommand` 完全一致
 *
 * 两份实现共用一个事实源：`splitCommandStructure` 的拆分口径就是 `splitCompoundCommand`
 * 的口径，只是多保留了「哪几段属于同一管道」。测试 `shell-parser.test.ts` 里有一条
 * 「扁平结果与 splitCommandStructure 一致」的一致性断言，改一处漏另一处会红。
 */

/** 管道的分隔符类型：`|` 连接同一管道的两段，其余分隔符开启新管道 */
type BoundaryKind = "pipe" | "break";

/** 一条管道：`a | b | c` 的 stages 是 `["a", "b", "c"]` */
export interface CommandPipeline {
  stages: string[];
}

/** heredoc 块：`<<DELIM` 与结尾 DELIM 行之间的正文 */
export interface HeredocBlock {
  /** 块序号 */
  id: number;
  /** 原文 delimiter（已去引号 / 去反斜杠转义） */
  delimiter: string;
  /** 正文（不含结尾 delimiter 行；`<<-` 已去掉每行前导 tab） */
  body: string;
  /** 剥离后文本里代表这个块的 token（`__SID_HD_<id>__`） */
  placeholder: string;
}

/** heredoc 剥离结果 */
export interface HeredocExtraction {
  /** `<<DELIM` 换成 `<<__SID_HD_n__`、正文整段删除之后的命令文本 */
  stripped: string;
  blocks: HeredocBlock[];
}

interface HeredocMarker {
  /** `<<` 起始偏移 */
  start: number;
  /** delimiter 结束偏移（含 `<<-` 与引号） */
  end: number;
  delimiter: string;
  stripTabs: boolean;
  /** 正文起始偏移（记号所在行的换行之后） */
  bodyStart: number;
  /** 正文结束偏移（结尾 delimiter 行之后；未闭合时是命令末尾） */
  bodyEnd: number;
  /** 正文行（已按 `<<-` 去前导 tab） */
  lines: string[];
  /** 是否找到了结尾 delimiter 行 */
  closed: boolean;
}

/** 读 heredoc delimiter：可带引号（`'EOF'` / `"EOF"`）与反斜杠转义 */
function readHeredocDelimiter(
  cmd: string,
  from: number,
): { delimiter: string; end: number } | null {
  let i = from;
  let delimiter = "";
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, i + 1);
      if (close < 0) return null;
      delimiter += cmd.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      delimiter += cmd[i + 1];
      i += 2;
      continue;
    }
    // shell 元字符结束 delimiter（`<<EOF; cmd`、`<<EOF)`）
    if (/[\s;&|<>()]/.test(ch)) break;
    delimiter += ch;
    i++;
  }
  return delimiter ? { delimiter, end: i } : null;
}

/** 从 from 开始逐行读，直到 delimiter 行；返回正文行与正文结束偏移 */
function readHeredocBody(
  cmd: string,
  from: number,
  delimiter: string,
  stripTabs: boolean,
): { lines: string[]; end: number; closed: boolean } {
  const lines: string[] = [];
  let pos = from;
  while (pos <= cmd.length) {
    const nl = cmd.indexOf("\n", pos);
    const lineEnd = nl < 0 ? cmd.length : nl;
    const raw = cmd.slice(pos, lineEnd);
    const line = stripTabs ? raw.replace(/^\t+/, "") : raw;
    if (line === delimiter) {
      return { lines, end: nl < 0 ? cmd.length : nl + 1, closed: true };
    }
    lines.push(line);
    if (nl < 0) return { lines, end: cmd.length, closed: false };
    pos = nl + 1;
  }
  return { lines, end: cmd.length, closed: false };
}

/**
 * 扫描 heredoc 记号并消费正文。
 *
 * 三条必须的排除：
 * - 引号内的 `<<` 是字面量（`grep '<<EOF' f`），不是 heredoc。
 * - `<<<` 是 herestring（`cat <<< "here"`），不是 heredoc。
 * - `$((1 << 2))` 是算术左移：delimiter 会是 `2`，且**找不到结尾行**。
 *   这类未闭合的记号一律不剥离（回退成原文），否则会把后续整条命令当成正文吞掉。
 *
 * 同一行可能有多个 heredoc（`cat <<A <<B`）：正文按记号顺序依次紧跟，所以记号先攒在
 * `pending` 里，等这一行的换行到了再依次消费——不能见到记号就跳正文，否则 B 的记号
 * 会被 A 的正文吞掉。
 *
 * 正文里的 `<<` 不再扫描（`i` 直接跳到正文末尾），它是数据。
 */
function scanHeredocMarkers(cmd: string): HeredocMarker[] {
  const markers: HeredocMarker[] = [];
  let pending: HeredocMarker[] = [];
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\" && !inSingle) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      i++;
      continue;
    }

    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (cmd[j] === "-") {
        stripTabs = true;
        j++;
      }
      while (cmd[j] === " " || cmd[j] === "\t") j++;
      const d = readHeredocDelimiter(cmd, j);
      if (d) {
        // 已经是我们自己插入的占位符：幂等跳过（extractHeredocBlocks 会被多层调用）
        if (!/^__SID_HD_\d+__$/.test(d.delimiter)) {
          pending.push({
            start: i,
            end: d.end,
            delimiter: d.delimiter,
            stripTabs,
            bodyStart: 0,
            bodyEnd: 0,
            lines: [],
            closed: false,
          });
        }
        i = d.end;
        continue;
      }
    }

    if (ch === "\n" && pending.length > 0) {
      // bodyStart 从**换行本身**开始：剥离时把这个换行一起删掉，否则 stripped 末尾
      // 会留一个空行（`cat > f <<EOF\n正文\nEOF` → `cat > f <<__SID_HD_0__\n`），
      // 下游的换行注入检测就会把它当成「还有一条命令」。
      let bodyStart = i;
      let from = i + 1;
      const batch: HeredocMarker[] = [];
      for (const m of pending) {
        const r = readHeredocBody(cmd, from, m.delimiter, m.stripTabs);
        m.bodyStart = bodyStart;
        m.bodyEnd = r.end;
        m.lines = r.lines;
        m.closed = r.closed;
        bodyStart = r.end;
        from = r.end;
        batch.push(m);
      }
      pending = [];
      // 整批都闭合才剥离：只要有一个找不到结尾行，说明不是真 heredoc
      // （算术左移、命令没写完），整批回退，避免把后面的命令吞成正文。
      if (batch.every((m) => m.closed)) markers.push(...batch);
      i = from;
      continue;
    }

    i++;
  }
  return markers;
}

/**
 * 提取 heredoc 块，并把它们从命令文本里剥离。
 *
 * 返回的 `stripped` 里每个块只剩一个 `<<__SID_HD_<id>__` 记号，正文在 `blocks[id].body`。
 * 调用方按**接收者**决定正文的归属：
 * - `cat > f <<EOF` / `tee f <<EOF` → 正文是数据，不参与任何匹配；
 * - `bash <<EOF` / `sh <<EOF` → 正文是脚本，要递归展开判危险；
 * - `cat <<EOF | bash` → 正文经管道进了 shell，同样按脚本处理。
 */
export function extractHeredocBlocks(cmd: string): HeredocExtraction {
  const markers = scanHeredocMarkers(cmd);
  if (markers.length === 0) return { stripped: cmd, blocks: [] };

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const blocks: HeredocBlock[] = [];
  // 同一行多个 heredoc 时，前一个的正文末尾就是后一个正文的开头——那种情况不能补换行，
  // 否则会在两个占位符之间插进一个假的命令分隔符。
  const bodyStarts = new Set(markers.map((m) => m.bodyStart));
  for (const m of markers) {
    const id = blocks.length;
    const placeholder = `__SID_HD_${id}__`;
    blocks.push({ id, delimiter: m.delimiter, body: m.lines.join("\n"), placeholder });
    edits.push({ start: m.start, end: m.end, text: `<<${placeholder}` });
    // 正文连同它前面的换行一起删（否则 stripped 末尾留空行）。但**后面还有其它命令时**
    // 必须补回一个换行，否则 `cat <<EOF`⏎…⏎`EOF`⏎`ls` 会粘成 `…<<__SID_HD_0__ls`，
    // 第二条命令直接消失——那会让 `rm -rf /` 这类真命令漏判。
    const followedByHeredocBody = bodyStarts.has(m.bodyEnd);
    const hasMore = !followedByHeredocBody && cmd.slice(m.bodyEnd).trim() !== "";
    edits.push({ start: m.bodyStart, end: m.bodyEnd, text: hasMore ? "\n" : "" });
  }
  edits.sort((a, b) => a.start - b.start);

  let stripped = "";
  let pos = 0;
  for (const e of edits) {
    // 区间重叠保护：多 heredoc 同一行时正文区间与下一个记号区间不会重叠，这里只是兜底
    if (e.start < pos) continue;
    stripped += cmd.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  stripped += cmd.slice(pos);
  return { stripped, blocks };
}

/**
 * 按「管道」分组拆分复合命令。
 *
 * 分隔符口径与 splitCompoundCommand 完全一致（后者就是本函数的扁平化），差别只在归类：
 * `|` 是同一管道的下一段，`&&` / `||` / `;` / 后台 `&` / 换行开启新管道。
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
 *
 * heredoc 正文在进入状态机前已被剥离（见 extractHeredocBlocks）：正文是数据，不是子命令。
 */
export function splitCommandStructure(cmd: string): CommandPipeline[] {
  const { stripped } = extractHeredocBlocks(cmd);
  const pipelines: string[][] = [];
  let stages: string[] = [];
  let current = "";

  const emit = (kind: BoundaryKind) => {
    const trimmed = current.trim();
    if (trimmed) stages.push(trimmed);
    current = "";
    if (kind === "break" && stages.length > 0) {
      pipelines.push(stages);
      stages = [];
    }
  };

  let i = 0;
  // 引号/转义状态
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  // 子 shell 嵌套深度：$(...) 和 (...)
  let parenDepth = 0;
  // 花括号嵌套深度：${...}
  let braceDepth = 0;

  while (i < stripped.length) {
    const ch = stripped[i];
    const next = i + 1 < stripped.length ? stripped[i + 1] : "";

    // 反斜杠转义：跳过下一个字符
    if (ch === "\\" && !inSingleQuote) {
      current += ch + next;
      i += 2;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

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

    if (ch === "$" && next === "(") {
      parenDepth++;
      current += ch + next;
      i += 2;
      continue;
    }

    if (ch === "$" && next === "{") {
      braceDepth++;
      current += ch + next;
      i += 2;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }

    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      current += ch;
      i++;
      continue;
    }

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

    if (ch === "&" && next === "&") {
      emit("break");
      i += 2;
      continue;
    }

    if (ch === "|" && next === "|") {
      emit("break");
      i += 2;
      continue;
    }

    // 单管道：同一管道的下一段
    if (ch === "|") {
      emit("pipe");
      i++;
      continue;
    }

    if (ch === ";") {
      emit("break");
      i++;
      continue;
    }

    // 后台 &（`&&` 已在上面处理）。`&>` / `&>>` 是输出重定向，
    // N>&M / >&N 是 fd 复制，都不能当命令边界。
    // 必须看「前一个字符」而不是「前一个非空白字符」：2>&1 & other 里第二个 &
    // 前面是空格，它是真后台符；若跳过空白去看，会看到 1 而把它误判成 fd 复制。
    if (ch === "&" && next !== ">") {
      const prevCh = i > 0 ? stripped[i - 1] : "";
      const prevIsDigit = prevCh >= "0" && prevCh <= "9";
      if (!prevIsDigit && prevCh !== ">") {
        emit("break");
        i++;
        continue;
      }
    }

    // 换行：shell 里等价于 `;`。引号 / 子 shell 内的换行已在上面被原样保留。
    if (ch === "\n") {
      emit("break");
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  emit("break");
  return pipelines.map((s) => ({ stages: s }));
}

/**
 * 这个程序名是不是「会把 stdin 当代码执行」的解释器。
 *
 * heredoc 的接收者判定要用它：`bash <<EOF` 的正文是脚本（要递归判危险），
 * `cat > f <<EOF` 的正文是数据（不参与匹配）。
 */
const SHELL_LIKE_PROGRAMS =
  /^(sh|bash|zsh|dash|ksh|fish|ash|mksh|python[23]?(\.\d+)?|perl|ruby|node|nodejs)$/;

export function isShellLikeProgram(program: string): boolean {
  return SHELL_LIKE_PROGRAMS.test(program);
}
