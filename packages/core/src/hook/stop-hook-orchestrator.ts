/**
 * Stop Hook 编排器
 * 管理 Stop 事件的验证反馈循环：执行验证 → 收集阻塞错误 → 注入消息让模型修复
 */

import type { HookSystem } from "./system.ts";
import type { StopInput } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

export interface StopHookResult {
  blockingErrors: string[];
  preventContinuation: boolean;
  stopReason?: string;
}

export interface StopHookProgress {
  type: "progress" | "blocking_error" | "prevent_continuation" | "summary" | "warning";
  hookName?: string;
  statusMessage?: string;
  error?: string;
  stopReason?: string;
  message?: string;
}

const MAX_STOP_HOOK_RETRIES = 3;

export class StopHookOrchestrator {
  private retryCount = 0;

  constructor(
    private hookSystem: HookSystem,
    private abortSignal?: AbortSignal,
  ) {}

  async execute(stopInput: StopInput): Promise<StopHookResult> {
    const log = getLogger();

    if (this.retryCount >= MAX_STOP_HOOK_RETRIES) {
      log.warn("HOOK", `Stop Hook 重试次数已达上限 (${MAX_STOP_HOOK_RETRIES})，强制结束`);
      return { blockingErrors: [], preventContinuation: true, stopReason: "Stop Hook 重试上限" };
    }

    this.retryCount++;

    try {
      if (this.abortSignal?.aborted) {
        return { blockingErrors: [], preventContinuation: true, stopReason: "用户中断" };
      }

      const result = await this.hookSystem.fireStopEvent(stopInput.assistant_response);

      const blockingErrors: string[] = [];
      let preventContinuation = false;
      let stopReason: string | undefined;

      if (result.finalOutput) {
        if (result.finalOutput.isBlockingDecision()) {
          blockingErrors.push(result.finalOutput.getEffectiveReason());
        }
        if (result.finalOutput.shouldStopExecution()) {
          preventContinuation = true;
          stopReason = result.finalOutput.getEffectiveReason();
        }
      }

      for (const output of result.allOutputs) {
        if (output.decision === "block" || output.decision === "deny") {
          const reason = output.reason || output.stopReason || "Stop Hook 验证失败";
          if (!blockingErrors.includes(reason)) {
            blockingErrors.push(reason);
          }
        }
      }

      return { blockingErrors, preventContinuation, stopReason };
    } catch (error) {
      log.error("HOOK", `Stop Hook 执行异常: ${error}`);
      return { blockingErrors: [], preventContinuation: false };
    }
  }

  resetRetryCount(): void {
    this.retryCount = 0;
  }

  get currentRetryCount(): number {
    return this.retryCount;
  }
}

export function createStopHookErrorMessage(error: string, hookName?: string): string {
  const prefix = hookName ? `[Stop Hook: ${hookName}]` : "[Stop Hook 验证失败]";
  return `${prefix}\n${error}\n\n请根据上述错误修复问题，然后重新尝试完成任务。`;
}
