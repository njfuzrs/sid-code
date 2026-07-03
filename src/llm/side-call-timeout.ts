/**
 * Side-call 硬超时包裹 — side-call-timeout.ts
 *
 * 背景（T3）：auto-compact / context-collapse / memory-recall / warmup 等 side-call
 * 的 LLM 调用此前只有 signal 纵深防御，无独立硬超时。若 provider 层超时机制失效
 * （如 signal 穿透失败、reader 在半开 TCP 上永不 settle），side-call 会永久阻塞，
 * 拖住主循环（auto-compact / context-collapse 在主循环 await 路径上）或后台任务。
 *
 * 本模块提供两个工具：
 *   1. withSideCallDeadline —— 给一个"整体 await 型"操作（如非流式调用 + 后续处理）
 *      套 Promise.race 硬超时。超时后 reject，不依赖 signal 传播。
 *   2. mergeTimeoutSignal —— 生成一个"外部 signal + 超时 signal"合并后的 AbortSignal
 *      + 一个 dispose。传给 provider 让底层 fetch/流在超时时也被 abort（尽力释放连接）。
 *
 * 设计要点：
 *   - Promise.race 是唯一不依赖 abort/cancel 链路的真兜底（对齐 loop.ts L1 的思路）。
 *   - 合并 signal 是"尽力而为"的资源释放：即便对已 hang 的 reader 无效，race 也已让出。
 *   - 超时 reason 统一用 "side-call-timeout"（已登记 ABORT_REASONS，防孤儿 rejection 崩溃）。
 */

import { getLogger } from "../debug/logger.ts";

/** side-call 超时错误（消息含"超时"字样，便于上层 isTimeoutError / catch 识别）。 */
export class SideCallTimeoutError extends Error {
  constructor(public readonly caller: string, public readonly timeoutMs: number) {
    super(`side-call 超时：${caller} 超过 ${(timeoutMs / 1000).toFixed(0)}s 未完成`);
    this.name = "SideCallTimeoutError";
  }
}

/**
 * 生成"外部 signal + 超时 signal"合并后的 AbortSignal。
 *
 * - 返回的 signal 在 externalSignal abort **或** timeoutMs 到点时 abort（reason 后者为
 *   "side-call-timeout"）。
 * - 调用方拿到 signal 传给 provider.sendMessageStream / sendMessageNonStreaming。
 * - 用完务必调 dispose() 清理内部定时器（避免泄漏阻止进程退出）。
 *
 * 注意：这是"尽力释放连接"的一侧；真正的硬兜底是 withSideCallDeadline 的 Promise.race。
 */
export function mergeTimeoutSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const ctl = new AbortController();
  let disposed = false;
  let timedOut = false;

  const onExternalAbort = () => {
    try { ctl.abort(externalSignal?.reason ?? "user-cancel"); } catch { /* ignore */ }
  };

  // 外部 signal 已 abort：立即传播。
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    try { ctl.abort("side-call-timeout"); } catch { /* ignore */ }
  }, timeoutMs);
  // 不 unref：与 loop.ts/fallback.ts 的教训一致——unref timer 在事件循环被 IO 占满时
  // 不保证按时 fire。dispose() 会在正常路径清理，不会泄漏阻止退出。

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) { try { clearTimeout(timer); } catch { /* ignore */ } }
    try { externalSignal?.removeEventListener("abort", onExternalAbort); } catch { /* ignore */ }
  };

  return { signal: ctl.signal, dispose, timedOut: () => timedOut };
}

/**
 * 给一个"整体 await 型" side-call 操作套 Promise.race 硬超时。
 *
 * @param caller     调用方标签（诊断日志用，如 "auto-compact"）
 * @param timeoutMs  硬超时阈值
 * @param fn         接收合并后的 signal，返回 Promise 的操作（内部把 signal 传给 provider）
 * @returns          fn 的结果；超时则 reject SideCallTimeoutError
 *
 * 用法（非流式）：
 *   await withSideCallDeadline("warmup", 10_000, (signal) =>
 *     provider.sendMessageNonStreaming(params, signal));
 *
 * 用法（流式消费）：把整个"建流 + for-await 消费"包进 fn，返回消费结果。
 */
export async function withSideCallDeadline<T>(
  caller: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const log = getLogger();
  const { signal, dispose, timedOut } = mergeTimeoutSignal(externalSignal, timeoutMs);
  const startedAt = Date.now();

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      log.warn("SIDE_CALL", `side-call-timeout`, {
        caller,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
      });
      reject(new SideCallTimeoutError(caller, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(signal), deadlinePromise]);
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    dispose();
    // timedOut 仅用于内部诊断；调用方通过 catch SideCallTimeoutError 感知超时。
    void timedOut;
  }
}
