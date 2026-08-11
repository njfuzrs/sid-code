/**
 * Markdown 流式安全分割工具函数
 *
 * 背景与目的：
 * findSafeSplitPoint 函数用于处理大型、可能流式传输的 Markdown 文本的显示或处理挑战。
 * 当内容（例如来自 LLM）以块的形式到达或增长到单个显示单元（如消息气泡）无法容纳时，
 * 需要进行拆分。简单的拆分（例如仅在字符限制处）可能会破坏 Markdown 格式，
 * 特别是对于多行元素（如代码块、列表或引用），导致渲染不正确。
 *
 * 此函数旨在在提供的 content 字符串中找到一个智能或"安全"的索引来进行拆分，
 * 优先保持 Markdown 完整性。
 */

/**
 * 检查给定字符索引是否在围栏代码块（```）内。
 * @param content 完整字符串内容
 * @param indexToTest 要测试的字符索引
 * @returns 如果索引在代码块内容中则返回 true，否则返回 false
 */
export const isIndexInsideCodeBlock = (
  content: string,
  indexToTest: number,
): boolean => {
  let fenceCount = 0;
  let searchPos = 0;
  while (searchPos < content.length) {
    const nextFence = content.indexOf('```', searchPos);
    if (nextFence === -1 || nextFence >= indexToTest) {
      break;
    }
    fenceCount++;
    searchPos = nextFence + 3;
  }
  return fenceCount % 2 === 1;
};

/**
 * 查找包含给定索引的代码块的起始索引。
 * 如果索引不在代码块内则返回 -1。
 * @param content Markdown 内容
 * @param index 要检查的索引
 * @returns 包含代码块的起始索引或 -1
 */
export const findEnclosingCodeBlockStart = (
  content: string,
  index: number,
): number => {
  if (!isIndexInsideCodeBlock(content, index)) {
    return -1;
  }
  let currentSearchPos = 0;
  while (currentSearchPos < index) {
    const blockStartIndex = content.indexOf('```', currentSearchPos);
    if (blockStartIndex === -1 || blockStartIndex >= index) {
      break;
    }
    const blockEndIndex = content.indexOf('```', blockStartIndex + 3);
    if (blockStartIndex < index) {
      if (blockEndIndex === -1 || index < blockEndIndex + 3) {
        return blockStartIndex;
      }
    }
    if (blockEndIndex === -1) break;
    currentSearchPos = blockEndIndex + 3;
  }
  return -1;
};

/**
 * 查找内容末尾的最后一个安全拆分点。
 *
 * 关键期望与行为（按优先级）：
 *
 * 1. 代码块完整性（最高优先级）：
 *    - 如果内容末尾在代码块内，在代码块开始之前拆分
 *
 * 2. Markdown 感知的换行拆分：
 *    - 优先在双换行符（\n\n）之后拆分（段落边界）
 *    - 选择的任何换行符也不能在代码块内
 *
 * 3. 回退到 content.length：
 *    - 如果找不到更安全的拆分点，返回 content.length 保持内容完整
 *
 * @param content 要查找拆分点的内容
 * @returns 安全拆分点的索引
 */
export const findLastSafeSplitPoint = (content: string): number => {
  const enclosingBlockStart = findEnclosingCodeBlockStart(
    content,
    content.length,
  );
  if (enclosingBlockStart !== -1) {
    // 内容末尾在代码块内。在代码块之前拆分。
    return enclosingBlockStart;
  }

  // 搜索不在代码块内的最后一个双换行符（\n\n）
  let searchStartIndex = content.length;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf('\n\n', searchStartIndex);
    if (dnlIndex === -1) {
      // 没有找到更多双换行符
      break;
    }

    const potentialSplitPoint = dnlIndex + 2;
    if (!isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }

    // 如果 potentialSplitPoint 在代码块内，
    // 下一次搜索应该从我们刚找到的 \n\n 之前开始以确保进度。
    searchStartIndex = dnlIndex - 1;
  }

  // 如果没有找到安全的双换行符，返回 content.length
  // 以将整个内容保持为一个部分。
  return content.length;
};
