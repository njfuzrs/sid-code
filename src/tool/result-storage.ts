/**
 * 工具结果持久化
 * 超过 maxResultSizeChars 的结果持久化到磁盘，返回摘要 + 文件路径
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/** 工具结果持久化目录 */
const TOOL_RESULTS_DIR = ".sid-code/tool-results";

/** 各工具的 maxResultSizeChars 配置 */
export const TOOL_MAX_RESULT_SIZE: Record<string, number> = {
  read: Infinity,       // 防止 Read→file→Read 循环，工具自身已有行数限制
  edit: Infinity,       // 编辑结果通常很短（diff 上下文）
  write: Infinity,      // 写入确认通常很短
  bash: 30000,          // 命令输出可能很大
  grep: 30000,          // 搜索结果可能很多
  glob: 30000,          // 文件列表可能很长
  ls: 30000,            // 目录列表可能很长
  read_many: 50000,     // 批量读取
  web_fetch: 50000,     // 网页内容可能很大
  web_search: 30000,    // 搜索结果
};

/** 默认最大结果大小 */
const DEFAULT_MAX_RESULT_SIZE = 30000;

/**
 * 处理工具结果的大小
 * - 超过 maxResultSizeChars 的结果持久化到磁盘
 * - 返回摘要 + 文件路径供模型消费
 */
export function processToolResult(
  toolName: string,
  toolUseId: string,
  output: string,
  maxChars?: number,
): string {
  const limit = maxChars ?? TOOL_MAX_RESULT_SIZE[toolName] ?? DEFAULT_MAX_RESULT_SIZE;

  if (limit === Infinity || output.length <= limit) {
    return output;
  }

  // 持久化到磁盘
  try {
    mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    const filename = `${toolName}-${toolUseId.slice(0, 8)}-${Date.now()}.txt`;
    const filepath = join(TOOL_RESULTS_DIR, filename);
    writeFileSync(filepath, output);

    // 返回摘要：头部预览 + 尾部预览
    const headSize = Math.floor(limit * 0.7);
    const tailSize = limit - headSize - 200; // 留 200 字符给提示信息
    const head = output.slice(0, headSize);
    const tail = tailSize > 0 ? output.slice(-tailSize) : "";

    let summary = head;
    if (tail) {
      summary += `\n\n... [省略 ${output.length - headSize - tailSize} 字符] ...\n\n${tail}`;
    }
    summary += `\n\n[完整输出已保存到 ${filepath}，共 ${output.length} 字符。使用 read 工具查看完整内容]`;

    return summary;
  } catch {
    // 持久化失败，回退到简单截断
    return output.slice(0, limit) + `\n\n... [输出被截断，共 ${output.length} 字符]`;
  }
}
