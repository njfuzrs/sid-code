/**
 * 二进制内容检测 + 可执行的诊断信息（read / read_many 共用）。
 *
 * ─── 2026-07-30 修复背景 ───
 *
 * 检测逻辑本身是对的（单个 NUL 字节就该拒绝——它会让下游按文本处理时静默截断），
 * 但旧实现有两个问题：
 *
 * 1. **报错信息只说「包含二进制数据」，不说在哪、有多少。**
 *    真实案例：`denial-tracking.ts` 6838 字节里只有 1 个字面 NUL（占 0.0146%），
 *    源码作者本意是写 `\x00` 转义当分隔符，却嵌进了真 NUL 字节。模型收到那句
 *    干巴巴的报错后，为定位这一个字节连烧 5+ 次工具调用（cat → file+tr 数 NUL →
 *    tr -d → python3 找偏移），而这些信息工具侧**本来就已经算出来了**，只是没说。
 *    所以这里把首个可疑字节的字节偏移 / 行列号 / 总数一并给出，并对「文本源码里
 *    掺了极少量 NUL」这个高频形态直接给出修法提示。
 *
 * 2. **同一份检测函数在 read.ts 和 read-many.ts 各抄一份。**
 *    两份逐字节相同却各自维护，改一处漏一处。统一收到本模块。
 */

/*
 * ─── 2026-10-18 修复：ANSI 转义序列不算「不可打印」 ───
 *
 * 带颜色的日志（bun / vite / npm 在 FORCE_COLOR 下的输出、`script` 录屏、CI 日志）
 * 是文本，只是夹了 SGR / 光标控制序列。旧判据把序列里的 ESC 逐个计入不可打印，
 * 短文件里占比轻易过 10%：事故样本是后台 `bun install | tail -3` 的 122 字节，
 * 17 个 ESC（13.9%）被判成二进制拒读。
 *
 * 所以这里把**结构完整**的 CSI（`ESC [ 参数* 中间* 终止`）与 OSC（`ESC ] … BEL|ESC \`）
 * 整段跳过、不计数。只认完整序列：孤立 ESC、截断的序列、其它 C0 控制字符照旧计数，
 * NUL 一票否决不变——真二进制里偶然凑出的「ESC [ … 字母」极少，且不影响 NUL 判据。
 * 不选「读取时剥掉 ANSI」：read 结果进 readFileState、是 edit 的匹配基准，剥掉会让
 * 模型看到的内容与磁盘不一致。
 */

/** 检测窗口：只看前 8192 字节，避免大文件全量扫描 */
export const BINARY_CHECK_WINDOW = 8192;

const ESC = 0x1b;
const BEL = 0x07;
/** OSC 正文上限：超长仍未终止就不当成合法序列（防真二进制里一个 `ESC ]` 吞掉整窗） */
const OSC_MAX_BODY = 2048;

/**
 * 若 `codeAt(i)` 处是一个结构完整的 CSI / OSC 序列，返回它的长度；否则返回 0。
 * 用访问器而不是 Buffer，是为了字节（read）与 UTF-16 码元（bash 输出）两种输入共用一份判定。
 */
function ansiSequenceLengthAt(length: number, codeAt: (i: number) => number, i: number): number {
  if (codeAt(i) !== ESC || i + 1 >= length) return 0;
  const kind = codeAt(i + 1);

  if (kind === 0x5b /* [ */) {
    // CSI：参数字节 0x30–0x3F、中间字节 0x20–0x2F，终止字节 0x40–0x7E（ECMA-48 §5.4）
    let j = i + 2;
    while (j < length && codeAt(j) >= 0x30 && codeAt(j) <= 0x3f) j++;
    while (j < length && codeAt(j) >= 0x20 && codeAt(j) <= 0x2f) j++;
    if (j < length && codeAt(j) >= 0x40 && codeAt(j) <= 0x7e) return j - i + 1;
    return 0;
  }

  if (kind === 0x5d /* ] */) {
    // OSC：以 BEL 或 ST（ESC \）结束；正文只允许可打印字符与 TAB，见到别的控制字符即不合法
    const limit = Math.min(length, i + 2 + OSC_MAX_BODY);
    for (let j = i + 2; j < limit; j++) {
      const c = codeAt(j);
      if (c === BEL) return j - i + 1;
      if (c === ESC) return j + 1 < length && codeAt(j + 1) === 0x5c ? j - i + 2 : 0;
      if (c < 0x20 && c !== 0x09) return 0;
    }
    return 0;
  }

  return 0;
}

/** 控制字符扫描结果（read 的字节窗口与 bash 的字符采样共用） */
export interface ControlCharScan {
  nulCount: number;
  /** 非 \t\n\r、且不属于完整 ANSI 序列的控制字符数 */
  nonPrintableCount: number;
  /** 被跳过的完整 ANSI 序列数（仅用于诊断） */
  ansiSequenceCount: number;
  /** 首个 NUL 或首个计数的控制字符位置 */
  firstOffset: number | null;
  firstCode: number | null;
}

/**
 * 扫描前 `length` 个单元的控制字符。单元是字节还是 UTF-16 码元由 `codeAt` 决定。
 * 完整 ANSI 序列整段跳过（序列内部字节都 ≥ 0x20，跳过不会漏掉 NUL）。
 */
export function scanControlChars(length: number, codeAt: (i: number) => number): ControlCharScan {
  let nulCount = 0;
  let nonPrintableCount = 0;
  let ansiSequenceCount = 0;
  let firstOffset: number | null = null;
  let firstCode: number | null = null;

  for (let i = 0; i < length; i++) {
    const code = codeAt(i);
    if (code === ESC) {
      const seqLen = ansiSequenceLengthAt(length, codeAt, i);
      if (seqLen > 0) {
        ansiSequenceCount++;
        i += seqLen - 1;
        continue;
      }
    }
    if (code === 0) {
      nulCount++;
    } else if (!isNonPrintable(code)) {
      continue;
    } else {
      nonPrintableCount++;
    }
    if (firstOffset === null) {
      firstOffset = i;
      firstCode = code;
    }
  }

  return { nulCount, nonPrintableCount, ansiSequenceCount, firstOffset, firstCode };
}

/** 非可打印字符占比阈值：超过即判定为二进制 */
const NON_PRINTABLE_RATIO_THRESHOLD = 0.1;

/** 二进制检测结果 */
export interface BinaryDetectResult {
  /** 是否判定为二进制 */
  isBinary: boolean;
  /** 判定依据：nul = 出现 NUL 字节；ratio = 非可打印字符占比超阈值 */
  reason: "nul" | "ratio" | null;
  /** 检测窗口内的实际字节数 */
  checkSize: number;
  /** 首个触发字节的偏移（NUL 命中时是该 NUL 的位置；ratio 命中时是首个非可打印字节） */
  firstOffset: number | null;
  /** 首个触发字节的字节值 */
  firstByte: number | null;
  /** 窗口内 NUL 总数 */
  nulCount: number;
  /** 窗口内非可打印（非 \t\n\r、且不属于完整 ANSI 序列）字节总数 */
  nonPrintableCount: number;
  /** 窗口内被跳过的完整 ANSI 转义序列数 */
  ansiSequenceCount: number;
}

/**
 * 是否为不可打印字节（排除 \t=9 / \n=10 / \r=13 三个正常空白）。
 * NUL 单独判定，不走这里。
 */
function isNonPrintable(byte: number): boolean {
  return byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
}

/**
 * 检测缓冲区是否为二进制内容，并一次性收集诊断所需的全部计量。
 *
 * 判据：窗口内出现任一 NUL 即 true，否则非可打印占比 > 10% 为 true。
 * 完整的 ANSI 转义序列不计入不可打印（见文件头 2026-10-18 段）。扫完整个窗口
 * 把计数都统计出来供报错信息使用；窗口上限 8192 字节，开销可忽略。
 */
export function detectBinaryContent(buffer: Buffer): BinaryDetectResult {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_WINDOW);
  const scan = scanControlChars(checkSize, (i) => buffer[i]!);
  const { nulCount, nonPrintableCount, ansiSequenceCount, firstOffset, firstCode } = scan;

  if (nulCount > 0) {
    return {
      isBinary: true,
      reason: "nul",
      checkSize,
      firstOffset,
      firstByte: firstCode,
      nulCount,
      nonPrintableCount,
      ansiSequenceCount,
    };
  }

  const overRatio = checkSize > 0 && nonPrintableCount / checkSize > NON_PRINTABLE_RATIO_THRESHOLD;

  return {
    isBinary: overRatio,
    reason: overRatio ? "ratio" : null,
    checkSize,
    firstOffset: overRatio ? firstOffset : null,
    firstByte: overRatio ? firstCode : null,
    nulCount,
    nonPrintableCount,
    ansiSequenceCount,
  };
}

/** 兼容旧调用点的布尔封装 */
export function isBinaryContent(buffer: Buffer): boolean {
  return detectBinaryContent(buffer).isBinary;
}

/**
 * 把字节偏移换算成 1-based 行列号（按 \n 计行，用于定位可疑字节）。
 * 偏移超出缓冲区时返回 null。
 */
function offsetToLineCol(buffer: Buffer, offset: number): { line: number; column: number } | null {
  if (offset < 0 || offset >= buffer.length) return null;
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (buffer[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** 字节值 → 可读名称（只覆盖常见控制字符，其余给十六进制） */
function byteLabel(byte: number): string {
  if (byte === 0) return "NUL (0x00)";
  const names: Record<number, string> = {
    0x01: "SOH",
    0x02: "STX",
    0x03: "ETX",
    0x04: "EOT",
    0x07: "BEL",
    0x08: "BS",
    0x0b: "VT",
    0x0c: "FF",
    0x1a: "SUB",
    0x1b: "ESC",
  };
  const name = names[byte];
  const hex = `0x${byte.toString(16).padStart(2, "0")}`;
  return name ? `${name} (${hex})` : hex;
}

/**
 * 构建带可执行诊断的二进制拒绝信息。
 *
 * 相比旧的一句话报错，这里补齐三样让模型能一步定位的信息：
 * - 首个可疑字节的**字节偏移 + 行列号 + 字节名**（省掉 hexdump/python 摸索）
 * - 窗口内该类字节的**总数**（1 个 vs 上千个，指向完全不同的处置方式）
 * - 「极少量 NUL 混在文本里」时**直接给修法**（改 `\x00` 转义），这是源码文件
 *   触发本拒绝的绝对主因，也是模型最容易误判成「文件损坏」的形态
 *
 * @param filePath 触发拒绝的文件路径
 * @param result   detectBinaryContent 的结果
 * @param buffer   参与检测的缓冲区（用于换算行列号）
 * @param totalBytes 文件总字节数（可选，仅用于展示）
 */
export function formatBinaryRejection(
  filePath: string,
  result: BinaryDetectResult,
  buffer: Buffer,
  totalBytes?: number,
): string {
  const lines: string[] = [`错误: 文件内容包含二进制数据，无法以文本形式读取: ${filePath}`];

  const sizeNote =
    totalBytes !== undefined && totalBytes > result.checkSize
      ? `文件共 ${totalBytes} 字节，仅检测前 ${result.checkSize} 字节。`
      : `检测范围: 前 ${result.checkSize} 字节。`;

  if (result.reason === "nul") {
    const pos = result.firstOffset !== null ? offsetToLineCol(buffer, result.firstOffset) : null;
    const where =
      result.firstOffset !== null
        ? `字节偏移 ${result.firstOffset}` + (pos ? `（第 ${pos.line} 行第 ${pos.column} 列）` : "")
        : "位置未知";
    lines.push(
      `判定依据: 检出 NUL 字节（0x00）——首个位于 ${where}，检测范围内共 ${result.nulCount} 个。`,
    );
    lines.push(sizeNote);

    // 极少量 NUL 掺在文本里 → 几乎必然是源码把 \x00 写成了真字节，而非文件损坏。
    // 这是本拒绝在源码文件上的主因，直接给修法，避免模型误判为"文件坏了"。
    if (result.nulCount <= 3) {
      lines.push(
        `提示: 仅 ${result.nulCount} 个 NUL 混在文本内容里，通常不是文件损坏，而是源码里把分隔符/哨兵写成了**真实 NUL 字节**` +
          `而非转义序列。若确实需要 NUL 语义，把该字节改写为字符串字面量中的 \\x00 转义（运行时等价，但文件不再含二进制字节）。` +
          `可用 \`rg -c $'\\x00' <file>\` 或 \`tr -cd '\\0' < <file> | wc -c\` 复核，改完本工具即可正常读取。`,
      );
    } else {
      lines.push(
        "提示: NUL 数量较多，大概率确实是二进制文件——请改用适合该格式的工具处理，不要按文本读取。",
      );
    }
  } else {
    const pos = result.firstOffset !== null ? offsetToLineCol(buffer, result.firstOffset) : null;
    const ratio = result.checkSize > 0 ? (result.nonPrintableCount / result.checkSize) * 100 : 0;
    const where =
      result.firstOffset !== null
        ? `首个位于字节偏移 ${result.firstOffset}` +
          (pos ? `（第 ${pos.line} 行第 ${pos.column} 列）` : "") +
          (result.firstByte !== null ? `，字节值 ${byteLabel(result.firstByte)}` : "")
        : "位置未知";
    lines.push(
      `判定依据: 不可打印控制字符占比 ${ratio.toFixed(1)}%（${result.nonPrintableCount}/${result.checkSize}），超过 ${NON_PRINTABLE_RATIO_THRESHOLD * 100}% 阈值——${where}。`,
    );
    lines.push(sizeNote);
    lines.push(
      "提示: 若这是文本文件被异常编码/损坏，可先用 grep 或 ls 确认；若确为二进制格式，请改用适合该格式的工具。",
    );
  }

  return lines.join("\n");
}
