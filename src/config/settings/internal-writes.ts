/**
 * 内部写入抑制
 *
 * 对齐 Spec 15 §4.3：当 sid-code 自己修改了 settings 文件时，不应触发变更通知。
 *
 * 独立叶子模块——打破 settings 写入侧 → change-detector 的循环依赖：
 * 写入方在写文件前调用 markInternalWrite()，变更检测器处理事件时调用
 * consumeInternalWrite()。两边都只依赖本模块，互不依赖。
 */

const timestamps = new Map<string, number>();

/** 标记一次内部写入（在写入 settings 文件之前调用） */
export function markInternalWrite(path: string): void {
  timestamps.set(path, Date.now());
}

/**
 * 消费一次内部写入标记（在变更检测器处理文件变更时调用）。
 *
 * 返回 true 表示这是内部写入，应跳过通知。
 * "消费"语义：一次 mark 只抑制一次通知——消费后删除时间戳，
 * 否则下一次真正的外部变更会被误判为内部写入而被忽略。
 */
export function consumeInternalWrite(path: string, windowMs: number): boolean {
  const ts = timestamps.get(path);
  if (ts !== undefined && Date.now() - ts < windowMs) {
    timestamps.delete(path);
    return true;
  }
  return false;
}

/** 清空所有标记（测试隔离用） */
export function resetInternalWrites(): void {
  timestamps.clear();
}
