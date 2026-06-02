/**
 * 错误边界工具函数（对齐 Claude Code 的 errors.ts 工具集）
 *
 * 设计目标：在 catch 块中以最小成本规范化 unknown 错误。
 * - toError()：catch 块第一行，把 unknown 收窄为 Error
 * - errorMessage()：只需要消息时的轻量提取
 * - shortErrorStack()：截断堆栈，发送给 LLM 时节省 token
 *
 * 这是零依赖模块（仅依赖内置 Error），任何模块可安全导入而不引入循环依赖。
 */

/**
 * 将 unknown 规范化为 Error。
 * - 已是 Error：原样返回（保留 stack / cause）
 * - 其他：用 String() 包装为 Error
 */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * 只需要错误消息时的轻量提取。
 * - Error：返回 .message
 * - 其他：返回 String(e)
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 截断错误堆栈到指定帧数（默认 5）。
 *
 * 完整堆栈通常 500-2000 字符，大部分是内部框架帧，对 LLM 理解
 * 错误根因没有帮助，反而消耗 token。保留头部（错误类型 + 消息）
 * 和前 maxFrames 个调用帧即可。
 *
 * @param e 错误对象
 * @param maxFrames 保留的调用帧数量，默认 5
 */
export function shortErrorStack(e: unknown, maxFrames = 5): string {
  if (!(e instanceof Error) || !e.stack) return String(e);

  const lines = e.stack.split("\n");
  const header = lines[0] ?? e.message;
  const frames = lines.slice(1).filter((l) => l.trim().startsWith("at "));

  if (frames.length <= maxFrames) return e.stack;

  const truncated = frames.length - maxFrames;
  return [
    header,
    ...frames.slice(0, maxFrames),
    `    ... ${truncated} more frame(s) truncated`,
  ].join("\n");
}
