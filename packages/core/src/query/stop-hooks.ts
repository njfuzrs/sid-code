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
  /**
   * P2-3：本次是否**真的跑了验证且全部通过**。
   *
   * 调用方据此清零 `stopHookRetryCount`。必须与「shouldContinue=false && forceStop=false」
   * 区分开——后者有三种成因（全部通过 / 续命耗尽仍失败 / hook 执行抛异常），
   * 只有第一种才该清零。混在一起的话，失败耗尽也会被当成"通过"而重置预算。
   */
  passed: boolean;
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

  // P2-3：续命预算耗尽时**仍然执行验证**，只是不再注入修复提示 / 不再 continue。
  //
  // 此前这里直接 return，`fireStopEvent` 根本不跑。后果是同一条用户消息里失败 3 次之后，
  // **后面真正修完的那一轮 end_turn 不再跑任何 Stop Hook**——用户配的 lint/test 从
  // 第 4 轮起彻底静音，而它恰好是最该验证的那一轮（模型说"这次真修好了"）。
  // 「耗尽后放行」是刻意取舍，「放行后连验证都不做」是它的副作用，不是取舍本身。
  const budgetExhausted = stopHookRetryCount >= MAX_STOP_HOOK_RETRIES;

  // 执行 Stop Hooks
  log.info(
    "STOP_HOOKS",
    `执行 Stop Hooks (重试 #${stopHookRetryCount}${budgetExhausted ? "，续命预算已耗尽：只验证不续命" : ""})`,
  );

  try {
    const stopResult = await hookSystem.fireStopEvent(responseText);
    const allOutputs = stopResult.allOutputs ?? [];

    // P1-1：continue===false 优先于 decision:block。两者同时出现时，
    // hook 明确说「别再试」——走 forceStop，不能掉进自动修复 continue。
    // 既看 finalOutput 也扫 allOutputs：聚合器漏网时仍能停。
    const stopRequested =
      stopResult.finalOutput?.shouldStopExecution() === true ||
      allOutputs.some((o) => o.continue === false);
    if (stopRequested) {
      log.info("STOP_HOOKS", "Stop Hook preventContinuation，强制结束");
      return { shouldContinue: false, forceStop: true, errorMessages: [], passed: false };
    }

    // P1-2：按 allOutputs 收集全部 block，不只信 last-wins 的 finalOutput。
    const errorMessages: string[] = [];
    const pushReason = (reason: string) => {
      if (reason && !errorMessages.includes(reason)) errorMessages.push(reason);
    };
    if (stopResult.finalOutput?.isBlockingDecision()) {
      pushReason(stopResult.finalOutput.getEffectiveReason());
    }
    for (const output of allOutputs) {
      if (output.decision === "block" || output.decision === "deny") {
        pushReason(output.reason || output.stopReason || "Stop Hook 验证失败");
      }
    }

    if (errorMessages.length > 0) {
      const reason = errorMessages.join("\n");
      log.info("STOP_HOOKS", `Stop Hook blocking error: ${reason}`);

      // P2-3：预算耗尽 → 验证照跑、结论如实报告，但不注入修复提示也不 continue。
      // 注入了却不 continue 等于往历史里塞一条永远不会被回应的提醒（下一条用户消息
      // 还会看到它），是纯污染。
      if (budgetExhausted) {
        log.warn(
          "STOP_HOOKS",
          `Stop Hooks 自动修复已达上限 (${MAX_STOP_HOOK_RETRIES})，验证仍未通过，放行并如实呈现`,
        );
        yield {
          kind: "system",
          level: "warning",
          text: `Stop Hook 检查仍未通过（自动修复已达上限 ${MAX_STOP_HOOK_RETRIES} 次，不再重试）：\n${reason}`,
        };
        return { shouldContinue: false, forceStop: false, errorMessages, passed: false };
      }

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
        errorMessages,
        passed: false,
      };
    }

    // 全部通过
    log.info("STOP_HOOKS", "Stop Hooks 全部通过");
    return { shouldContinue: false, forceStop: false, errorMessages: [], passed: true };
  } catch (err: any) {
    log.warn("STOP_HOOKS", `Stop Hooks 执行异常: ${err.message}`);
    // 异常不阻止正常结束。passed=false：hook 没跑成功就不算"验证通过"，
    // 不得据此清零续命预算（否则一个恒抛异常的 hook 会让预算永远回满）。
    return { shouldContinue: false, forceStop: false, errorMessages: [], passed: false };
  }
}

/** 获取最大重试次数 */
export function getMaxStopHookRetries(): number {
  return MAX_STOP_HOOK_RETRIES;
}
