/**
 * StopFailure（HC24）：轮次因 API 错误终止时触发。
 *
 * 只在「这一轮确实因为 API 错误结束」的出口调用（loop.ts 的重试耗尽与最终重抛），
 * 用户取消 / 会话超时收尾不算 —— 那不是 API 失败，CC 也不在这些情形发 StopFailure。
 * error_type 按 HTTP 状态码优先归类，状态码缺失才看错误类型字段，最后才落到 unknown：
 * 裸子串匹配错误文案会把网关自定义文案误归类（见归因与真实信号脱节那类教训）。
 */

import type { HookSystem } from "../hook/system.ts";
import type { StopFailureInput } from "../hook/types.ts";
import { getLogger } from "../debug/logger.ts";

type ErrorType = StopFailureInput["error_type"];

export function classifyStopFailure(err: unknown): ErrorType {
  const e = err as { statusCode?: number; status?: number; errorType?: string; type?: string };
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") {
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "authentication_failed";
    if (status === 402) return "billing_error";
    if (status === 400 || status === 404 || status === 413 || status === 422)
      return "invalid_request";
    if (status >= 500) return "server_error";
  }
  const t = e?.errorType ?? e?.type;
  if (t === "rate_limit_error") return "rate_limit";
  if (t === "authentication_error" || t === "permission_error") return "authentication_failed";
  if (t === "invalid_request_error") return "invalid_request";
  if (t === "overloaded_error" || t === "api_error") return "server_error";
  return "unknown";
}

/** fire-and-forget：通知类事件不能改变错误的传播 */
export function fireStopFailure(
  hookSystem: HookSystem | undefined,
  err: unknown,
  errorType: ErrorType = classifyStopFailure(err),
): void {
  if (!hookSystem) return;
  const message = (err as Error)?.message ?? String(err);
  try {
    void hookSystem
      .fireStopFailureEvent(message, errorType)
      ?.catch?.((e: unknown) =>
        getLogger().error("HOOK", `stop_failure hook 失败: ${(e as Error)?.message ?? e}`),
      );
  } catch (e) {
    getLogger().error("HOOK", `stop_failure 触发异常（忽略）: ${(e as Error)?.message ?? e}`);
  }
}
