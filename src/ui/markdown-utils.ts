/**
 * Markdown 安全分割工具
 *
 * 用于流式渲染时安全地分割 Markdown 文本，
 * 确保不在代码块、表格等结构内部分割。
 */

/** 匹配代码块 fence（允许最多 3 空格缩进） */
const FENCE_RE = /^ {0,3}(?:```|~~~)/gm;

/** 统计文本中的 fence 数量 */
function countFences(text: string): number {
  FENCE_RE.lastIndex = 0;
  let count = 0;
  while (FENCE_RE.exec(text)) count++;
  return count;
}

/** 检查指定索引是否在代码块内部 */
export function isIndexInsideCodeBlock(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return countFences(before) % 2 !== 0;
}

/**
 * 在文本中找到最后一个安全的分割点
 * 安全 = 不在代码块内、不在表格内
 *
 * @returns 分割点索引（不含），-1 表示没有安全分割点
 */
export function findLastSafeSplitPoint(text: string, maxLength?: number): number {
  const searchText = maxLength ? text.slice(0, maxLength) : text;
  let bestSplit = -1;
  let searchFrom = 0;

  while (true) {
    const idx = searchText.indexOf("\n\n", searchFrom);
    if (idx < 0) break;

    const candidatePos = idx + 1;
    const textToSplit = text.slice(0, candidatePos);

    // 检查是否在代码块内
    if (countFences(textToSplit) % 2 !== 0) {
      searchFrom = idx + 2;
      continue;
    }

    // 检查是否在表格内
    if (!isInTable(textToSplit)) {
      bestSplit = candidatePos;
    }

    searchFrom = idx + 2;
  }

  // 如果没有双换行分割点，尝试单换行
  if (bestSplit < 0) {
    const lastNewline = searchText.lastIndexOf("\n");
    if (lastNewline > 0) {
      const textToSplit = text.slice(0, lastNewline);
      if (countFences(textToSplit) % 2 === 0 && !isInTable(textToSplit)) {
        bestSplit = lastNewline;
      }
    }
  }

  return bestSplit;
}

/** 检查文本末尾是否处于未完成的表格中 */
function isInTable(text: string): boolean {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    return trimmed.startsWith("|") && trimmed.endsWith("|");
  }
  return false;
}

/**
 * 获取流式文本的后缀提示
 * 如果文本处于未闭合的代码块中，返回提示文本
 */
export function getStreamingSuffix(text: string): string {
  if (countFences(text) % 2 !== 0) {
    return "\n... 生成中 ...";
  }
  return "";
}
