/**
 * heredoc 正文剥离（叶子模块，零 import）。
 *
 * ## 为什么单独一个模块、且放在 `tool/bash/` 而不是 `permission/`
 *
 * heredoc 剥离原本长在 `permission/shell-structure.ts` 里，只有权限侧用。2026-11-11 修
 * 「bash 解析器不把换行当命令分隔符」时，`tool/bash/parser.ts` 也必须**先剥离正文再拆命令**
 * ——否则 `cat > notes.md <<'EOF'`⏎`rm -rf / is dangerous`⏎`EOF` 的正文会被拆成独立命令段，
 * 撞上危险命令检测，最普通的写文件白弹/白拦。
 *
 * 但 `permission/bash-security.ts` 已经 import 了 `tool/bash/parser.ts`，反向再来一条
 * `tool/bash/ → permission/` 就是**目录级双向依赖**：模块层不成环（本文件零 import），
 * 可下一个人很容易顺手加成真环。放 `tool/bash/` 是最短的合法路径。
 *
 * ⚠️ `lint:boundary` 兜不住这一层：它只查包级 rank 与测试文件跨包相对路径，
 * `permission/` 与 `tool/bash/` 同属 core 包。目录级依赖只能靠这里的约定守。
 *
 * ## 三条必须的排除（定义在 scanHeredocMarkers 里，别在这里重写）
 *
 * 引号内的 `<<`、herestring `<<<`、算术左移 `$((1 << 2))` 都不是 heredoc。
 */

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
