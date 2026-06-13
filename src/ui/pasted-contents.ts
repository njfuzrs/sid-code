/**
 * 粘贴内容跟踪（IN3）
 *
 * 对标 claude-code 的 pastedContents 机制：大块粘贴（多行/长文本）不直接灌入
 * 输入缓冲区——那样会撑爆输入框、淹没光标。改为：
 *   1. 粘贴大块时登记一条 PastedContent，分配自增 id；
 *   2. 缓冲区只插入一个精简占位引用，如 `[粘贴 #1 +42 行]`；
 *   3. 提交时把占位引用还原为真实内容（expandPastedRefs）。
 *
 * 元数据（类型/行数/字符数/序号）保留在登记表中，便于回溯与未来扩展
 * （图片/文件粘贴可复用同一登记表，type 区分）。
 *
 * 采用模块级单例，与 pending-input.ts / early-input.ts 同构，解耦
 * InputArea（产生/还原）与潜在的其他消费方，无需额外 React 状态接线。
 */

/** 粘贴内容类型 */
export type PastedContentType = "text" | "image" | "file";

/** 单条粘贴登记 */
export interface PastedContent {
  /** 自增 id（从 1 开始） */
  id: number;
  /** 内容类型 */
  type: PastedContentType;
  /** 真实内容（text 类型为粘贴原文；image/file 为路径或占位） */
  content: string;
  /** 字符数 */
  charCount: number;
  /** 行数 */
  lineCount: number;
  /** 登记序号（用于稳定排序，避免依赖时间戳） */
  seq: number;
}

/**
 * 触发占位的阈值：超过任一即视为「大块」走占位路径。
 * 小块粘贴仍直接插入，保持顺手。
 */
export const PASTE_LINE_THRESHOLD = 6;
export const PASTE_CHAR_THRESHOLD = 800;

let registry = new Map<number, PastedContent>();
let nextId = 1;
let seqCounter = 0;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

/** 判断一段粘贴文本是否应走占位路径 */
export function shouldPlaceholder(text: string): boolean {
  const lineCount = countLines(text);
  return lineCount > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

/** 人类可读的字符数（1234 → 1.2k 字符） */
function humanCount(n: number): string {
  if (n < 1000) return `${n} 字符`;
  return `${(n / 1000).toFixed(1)}k 字符`;
}

/** 构造某条登记的占位引用字符串 */
function refString(entry: PastedContent): string {
  const summary =
    entry.lineCount > 1
      ? `+${entry.lineCount} 行`
      : humanCount(entry.charCount);
  return `[粘贴 #${entry.id} ${summary}]`;
}

/**
 * 登记一段粘贴内容，返回应插入缓冲区的占位引用字符串。
 * 占位引用形如 `[粘贴 #1 +42 行]`（多行）或 `[粘贴 #2 1.2k 字符]`（单行长文）。
 */
export function registerPaste(
  content: string,
  type: PastedContentType = "text",
): string {
  const entry: PastedContent = {
    id: nextId++,
    type,
    content,
    charCount: content.length,
    lineCount: countLines(content),
    seq: seqCounter++,
  };
  registry.set(entry.id, entry);
  return refString(entry);
}

/** 按 id 取回登记内容（未找到返回 null） */
export function getPaste(id: number): PastedContent | null {
  return registry.get(id) ?? null;
}

/** 当前所有登记（按序号升序），便于回溯展示 */
export function listPastes(): PastedContent[] {
  return [...registry.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 把文本中的占位引用 `[粘贴 #N ...]` 还原为真实内容。
 * 提交前调用。未登记的 id 原样保留（用户可能手敲了相似文本）。
 */
export function expandPastedRefs(text: string): string {
  if (!registry.size) return text;
  // 匹配 [粘贴 #<id> <任意非]>]
  return text.replace(/\[粘贴 #(\d+)[^\]]*\]/g, (whole, idStr) => {
    const id = Number.parseInt(idStr, 10);
    const entry = registry.get(id);
    return entry ? entry.content : whole;
  });
}

/**
 * 清空登记表（一轮输入提交/清空后调用），避免登记无限增长。
 */
export function clearPastes(): void {
  registry = new Map();
  nextId = 1;
  seqCounter = 0;
}
