/**
 * Stop Hooks — 模型 end_turn 后的自动检查与修复
 *
 * 当模型认为"完成"后，执行用户配置的 Stop Hooks（如 lint/test），
 * 如果有 blocking error，将错误注入对话让模型自动修复。
 *
 * 流程：
 *   模型 end_turn → 执行 Stop Hooks → 全部通过 → 正常结束
 *                                    → blocking error → 注入错误 → continue
 *                                    → preventContinuation → 强制结束
 */

import type { HookSystem } from "../hook/system.ts";
import type { QueryLoopYield } from "./types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";

/** Stop Hook 执行结果 */
export interface StopHookResult {
  /** 是否应该继续循环（有 blocking error 需要模型修复） */
  shouldContinue: boolean;
  /** 是否强制结束（preventContinuation） */
  forceStop: boolean;
  /** 错误消息（注入到对话中） */
  errorMessages: string[];
}

/** Stop Hooks 最大重试次数 */
const MAX_STOP_HOOK_RETRIES = 3;

/**
 * 执行 Stop Hooks 并处理结果
 *
 * 作为 async generator，通过 yield* 与 queryLoop 组合：
 * - yield system 消息通知 UI
 * - 返回 StopHookResult 告诉 queryLoop 是否需要 continue
 */
export async function* handleStopHooks(
  hookSystem: HookSystem,
  ctxMgr: ContextManager,
  responseText: string,
  stopHookRetryCount: number,
): AsyncGenerator<QueryLoopYield, StopHookResult> {
  const log = getLogger();

  // 检查重试次数
  if (stopHookRetryCount >= MAX_STOP_HOOK_RETRIES) {
    log.warn("STOP_HOOKS", `Stop Hooks 重试次数已达上限 (${MAX_STOP_HOOK_RETRIES})，强制结束`);
    yield {
      kind: "system",
      level: "warning",
      text: `Stop Hooks 自动修复已达上限（${MAX_STOP_HOOK_RETRIES} 次），停止重试`,
    };
    return { shouldContinue: false, forceStop: false, errorMessages: [] };
  }

  // 执行 Stop Hooks
  log.info("STOP_HOOKS", `执行 Stop Hooks (重试 #${stopHookRetryCount})`);

  try {
    const stopResult = await hookSystem.fireStopEvent(responseText);

    // 检查是否有 blocking error
    if (stopResult.finalOutput?.isBlockingDecision()) {
      const reason = stopResult.finalOutput.getEffectiveReason();
      log.info("STOP_HOOKS", `Stop Hook blocking error: ${reason}`);

      // 注入错误消息到对话
      const errorMsg = `<system-reminder>\n[Stop Hook 检查失败]\n${reason}\n\n请修复上述问题。\n</system-reminder>`;
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: errorMsg }],
      });

      yield {
        kind: "system",
        level: "warning",
        text: `Stop Hook 检查失败，自动修复 (#${stopHookRetryCount + 1}/${MAX_STOP_HOOK_RETRIES})`,
      };

      return {
        shouldContinue: true,
        forceStop: false,
        errorMessages: [reason],
      };
    }

    // 检查是否强制结束
    if (stopResult.finalOutput?.shouldStopExecution()) {
      log.info("STOP_HOOKS", "Stop Hook preventContinuation，强制结束");
      return { shouldContinue: false, forceStop: true, errorMessages: [] };
    }

    // 全部通过
    log.info("STOP_HOOKS", "Stop Hooks 全部通过");
    return { shouldContinue: false, forceStop: false, errorMessages: [] };
  } catch (err: any) {
    log.warn("STOP_HOOKS", `Stop Hooks 执行异常: ${err.message}`);
    // 异常不阻止正常结束
    return { shouldContinue: false, forceStop: false, errorMessages: [] };
  }
}

/** 获取最大重试次数 */
export function getMaxStopHookRetries(): number {
  return MAX_STOP_HOOK_RETRIES;
}
