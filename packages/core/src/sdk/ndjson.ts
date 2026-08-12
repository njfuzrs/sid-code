/**
 * NDJSON 安全序列化/反序列化
 *
 * NDJSON（Newline-Delimited JSON）用换行符分隔每条 JSON 消息。
 * 关键陷阱：U+2028（行分隔符）和 U+2029（段落分隔符）在 JSON 中合法，
 * 但部分解析器/管道会把它们当作换行，破坏 NDJSON 的行分隔假设。
 * 序列化时必须转义。
 *
 * 实现注意：用 String.fromCharCode 构造匹配字符，避免源码里出现裸 U+2028/U+2029
 * （它们本身是 JS 行终止符，会破坏源码解析）。
 */

const LS = String.fromCharCode(0x2028); // U+2028 行分隔符
const PS = String.fromCharCode(0x2029); // U+2029 段落分隔符
const LS_RE = new RegExp(LS, "g");
const PS_RE = new RegExp(PS, "g");

/**
 * NDJSON 安全序列化
 * 转义 U+2028/U+2029，防止行分隔符误切割 JSON
 */
export function ndjsonStringify(obj: unknown): string {
  return JSON.stringify(obj).replace(LS_RE, "\\u2028").replace(PS_RE, "\\u2029");
}

/**
 * NDJSON 安全反序列化
 * 逐行解析，空行返回 null
 */
export function ndjsonParse(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

/**
 * 从 ReadableStream 创建 NDJSON 行迭代器
 *
 * 处理跨 chunk 的不完整行：缓冲未遇到换行的尾部，下一个 chunk 拼接。
 * 兼容 Node.js Readable（Buffer/string chunk）。
 */
export async function* ndjsonLines(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const lines = buffer.split("\n");
    // 最后一段可能是不完整行，留到下一个 chunk
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }
  // 处理最后一行（无换行符结尾）
  if (buffer.trim()) yield buffer.trim();
}
