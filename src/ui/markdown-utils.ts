/**
 * Markdown 安全分割工具
 *
 * 用于流式渲染时安全地分割 Markdown 文本，
 * 确保不在代码块、表格等结构内部分割。
 */

/** 匹配代码块 fence（允许最多 3 空格缩进），非全局模式用于逐行匹配 */
const FENCE_LINE_RE = /^ {0,3}(?:```|~~~)/;

/** 统计文本中的 fence 数量 */
function countFences(text: string): number {
  let count = 0;
  const len = text.length;
  let lineStart = 0;
  for (let i = 0; i <= len; i++) {
    if (i === len || text.charCodeAt(i) === 10) {
      if (FENCE_LINE_RE.test(text.slice(lineStart, i))) count++;
      lineStart = i + 1;
    }
  }
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
 * 使用递增 fence 计数器，O(n) 复杂度（n = 文本长度）
 *
 * @returns 分割点索引（不含），-1 表示没有安全分割点
 */
export function findLastSafeSplitPoint(text: string, maxLength?: number): number {
  const searchText = maxLength ? text.slice(0, maxLength) : text;
  let bestSplit = -1;

  // 逐行扫描，维护递增的 fence 计数器
  let fenceCount = 0;
  let lineStart = 0;
  let prevLineEnd = -1; // 上一行的结束位置

  for (let i = 0; i <= searchText.length; i++) {
    if (i === searchText.length || searchText[i] === "\n") {
      const line = searchText.slice(lineStart, i);

      // 检查当前行是否是 fence
      if (FENCE_LINE_RE.test(line)) {
        fenceCount++;
      }

      // 检查是否是双换行（空行 = 段落边界）
      if (prevLineEnd >= 0 && lineStart === prevLineEnd + 1 && line === "") {
        // 候选分割点是这个空行的开头（即 lineStart）
        if (fenceCount % 2 === 0) {
          // 不在代码块内，检查是否在表格内
          if (!isInTableAtLine(searchText, lineStart)) {
            bestSplit = lineStart;
          }
        }
      }

      prevLineEnd = i;
      lineStart = i + 1;
    }
  }

  // 如果没有双换行分割点，尝试最后一个单换行
  if (bestSplit < 0) {
    const lastNewline = searchText.lastIndexOf("\n");
    if (lastNewline > 0) {
      // 计算到 lastNewline 位置的 fence 数量：
      // 从 lastNewline 之后的文本中减去 fence 数
      let fencesAfter = 0;
      let ls = lastNewline + 1;
      for (let i = ls; i <= searchText.length; i++) {
        if (i === searchText.length || searchText.charCodeAt(i) === 10) {
          if (FENCE_LINE_RE.test(searchText.slice(ls, i))) fencesAfter++;
          ls = i + 1;
        }
      }
      if ((fenceCount - fencesAfter) % 2 === 0 && !isInTableAtLine(searchText, lastNewline)) {
        bestSplit = lastNewline;
      }
    }
  }

  return bestSplit;
}

/** 检查指定位置之前的最后一个非空行是否是表格行 */
function isInTableAtLine(text: string, pos: number): boolean {
  // 从 pos 向前找最后一个非空行
  let end = pos;
  while (end > 0 && text[end - 1] === "\n") end--;
  if (end <= 0) return false;
  let start = end;
  while (start > 0 && text[start - 1] !== "\n") start--;
  const line = text.slice(start, end).trim();
  if (!line) return false;
  return line.startsWith("|") && line.endsWith("|");
}


/**
 * 增量 fence 计数器，用于流式场景
 * 避免每次流式更新都全量扫描
 */
class IncrementalFenceCounter {
  private count = 0;
  private processedLength = 0;
  private lastLineStart = 0;

  /** 更新计数器，只扫描新增部分 */
  update(text: string): number {
    if (text.length < this.processedLength) {
      // 文本被截断/重置，全量重算
      this.count = countFences(text);
      this.processedLength = text.length;
      // 找到最后一个换行位置
      this.lastLineStart = text.lastIndexOf("\n") + 1;
      return this.count;
    }

    if (text.length === this.processedLength) {
      return this.count;
    }

    // 只扫描新增部分，但需要从上一个未完成行的开头开始
    const scanFrom = this.lastLineStart;
    let lineStart = scanFrom;
    let newCount = 0;

    // 先减去上一个未完成行可能贡献的 fence（因为它可能被追加了内容）
    if (this.processedLength > scanFrom) {
      const oldPartialLine = text.slice(scanFrom, this.processedLength);
      if (FENCE_LINE_RE.test(oldPartialLine)) newCount--;
    }

    for (let i = scanFrom; i <= text.length; i++) {
      if (i === text.length || text.charCodeAt(i) === 10) {
        if (FENCE_LINE_RE.test(text.slice(lineStart, i))) newCount++;
        lineStart = i + 1;
      }
    }

    this.count += newCount;
    this.processedLength = text.length;
    this.lastLineStart = lineStart > text.length ? text.length : (text.lastIndexOf("\n") + 1);
    return this.count;
  }

  reset(): void {
    this.count = 0;
    this.processedLength = 0;
    this.lastLineStart = 0;
  }
}

// 单例，供 getStreamingSuffix 使用
const streamingFenceCounter = new IncrementalFenceCounter();

/**
 * 获取流式文本的后缀提示
 * 如果文本处于未闭合的代码块中，返回提示文本
 * 使用增量计数器，O(delta) 复杂度
 */
export function getStreamingSuffix(text: string): string {
  const fences = streamingFenceCounter.update(text);
  if (fences % 2 !== 0) {
    return "\n... 生成中 ...";
  }
  return "";
}

/** 重置流式 fence 计数器（新消息开始时调用） */
export function resetStreamingFenceCounter(): void {
  streamingFenceCounter.reset();
}
