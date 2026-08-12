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

/** 检测窗口：只看前 8192 字节，避免大文件全量扫描 */
export const BINARY_CHECK_WINDOW = 8192;

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
  /** 窗口内非可打印（非 \t\n\r）字节总数 */
  nonPrintableCount: number;
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
 * 与旧实现的行为等价性：判据完全不变——窗口内出现任一 NUL 即 true，否则
 * 非可打印占比 > 10% 为 true。差别只在于**不再提前 return**，而是扫完整个
 * 窗口把 nulCount / nonPrintableCount 都统计出来，供报错信息使用。
 * 窗口上限 8192 字节，多扫这一趟的开销可忽略。
 */
export function detectBinaryContent(buffer: Buffer): BinaryDetectResult {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_WINDOW);
  let nulCount = 0;
  let nonPrintableCount = 0;
  let firstOffset: number | null = null;
  let firstByte: number | null = null;

  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!;
    if (byte === 0) {
      nulCount++;
      if (firstOffset === null) {
        firstOffset = i;
        firstByte = byte;
      }
      continue;
    }
    if (isNonPrintable(byte)) {
      nonPrintableCount++;
      if (firstOffset === null) {
        firstOffset = i;
        firstByte = byte;
      }
    }
  }

  if (nulCount > 0) {
    return {
      isBinary: true,
      reason: "nul",
      checkSize,
      firstOffset,
      firstByte,
      nulCount,
      nonPrintableCount,
    };
  }

  const overRatio = checkSize > 0 && nonPrintableCount / checkSize > NON_PRINTABLE_RATIO_THRESHOLD;

  return {
    isBinary: overRatio,
    reason: overRatio ? "ratio" : null,
    checkSize,
    firstOffset: overRatio ? firstOffset : null,
    firstByte: overRatio ? firstByte : null,
    nulCount,
    nonPrintableCount,
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
