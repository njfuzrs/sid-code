/**
 * 压缩后重注入标志的唯一置位入口（2026-11-01，进度清单横向剖析第五部分 T6）
 *
 * 三个 `*PendingAfterCompact` 标志（goal / todo / deferredTools）此前在 `loop.ts` 里
 * 7 处手写三连赋值，注释却写「8 处」。核对所有压缩出口后发现缺的不是 loop 内某一处，
 * 而是**手动 `/compact`**：它在两条用户消息之间由 CLI 命令执行，碰不到 `LoopState`，
 * 下一条消息 `createInitialLoopState()` 重建时三个标志恒为 false——压缩把清单 / 目标 /
 * 延迟工具播报从上下文里抹掉了，却没有任何一条旁路负责重注。
 *
 * 所以分两半：
 *   - loop 内的压缩出口直接调 `markPostCompactReinject(state)`；
 *   - loop 外的压缩（手动 /compact）调 `markSessionCompacted(sessionState)` 记一个会话级标记，
 *     下一次 `queryLoop` 入口由 `consumeSessionCompactMark` 消费并置位。
 *
 * 新增压缩出口时只能走这两个函数之一；哨兵测试 `post-compact-flags.test.ts` 锁住
 * 「loop.ts 里不许再出现裸的 `PendingAfterCompact = true`」。
 */
import type { LoopState } from "./types.ts";

/** SessionState 键：loop 外发生过一次压缩，下一次 queryLoop 入口要补置重注入标志 */
export const SESSION_COMPACTED_PENDING_KEY = "postCompactReinjectPending";

/** 最小接口：只要能读写会话级键值即可（避免 core 依赖具体 SessionState 实现） */
interface SessionKV {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
}

/** 压缩成功后置位三个重注入标志（loop 内唯一写法） */
export function markPostCompactReinject(state: LoopState): void {
  state.goalReminderPendingAfterCompact = true;
  state.todoReminderPendingAfterCompact = true;
  state.deferredToolsPendingAfterCompact = true;
}

/** loop 外的压缩（手动 /compact）调用：记会话级标记，由下一次 queryLoop 消费 */
export function markSessionCompacted(sessionState: SessionKV | undefined): void {
  // 容忍缺省：命令层部分调用方（含测试 mock ctx）不带 sessionState，标记丢失只是退回旧行为
  sessionState?.set(SESSION_COMPACTED_PENDING_KEY, true);
}

/** queryLoop 入口调用：有标记则置位并清掉标记。返回是否消费了标记 */
export function consumeSessionCompactMark(sessionState: SessionKV, state: LoopState): boolean {
  if (sessionState.get(SESSION_COMPACTED_PENDING_KEY) !== true) return false;
  sessionState.delete(SESSION_COMPACTED_PENDING_KEY);
  markPostCompactReinject(state);
  return true;
}
