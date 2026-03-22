/**
 * Hook 结果聚合器
 * OR 决策、字段替换、消息拼接、additionalContext 收集
 */

import {
  HookEventName,
  DefaultHookOutput,
  PreToolUseHookOutput,
  AfterAgentHookOutput,
  BeforeModelHookOutput,
  AfterModelHookOutput,
  type HookOutput,
  type HookExecutionResult,
  type AggregatedHookResult,
} from "./types.ts";

export class HookAggregator {
  /** 聚合多个 hook 执行结果 */
  aggregateResults(results: HookExecutionResult[], eventName: HookEventName): AggregatedHookResult {
    const allOutputs: HookOutput[] = [];
    const errors: Error[] = [];
    let totalDuration = 0;

    for (const result of results) {
      totalDuration += result.duration;
      if (result.error) errors.push(result.error);
      if (result.output) allOutputs.push(result.output);
    }

    const mergedOutput = this.mergeOutputs(allOutputs, eventName);
    const finalOutput = mergedOutput
      ? this.createSpecificOutput(mergedOutput, eventName)
      : undefined;

    return {
      success: errors.length === 0,
      finalOutput,
      allOutputs,
      errors,
      totalDuration,
    };
  }

  // ---- 私有方法 ----

  /** 根据事件类型选择合并策略 */
  private mergeOutputs(outputs: HookOutput[], eventName: HookEventName): HookOutput | undefined {
    if (outputs.length === 0) return undefined;

    switch (eventName) {
      // OR 决策类事件：任一 deny → 整体 deny
      case HookEventName.PreToolUse:
      case HookEventName.PostToolUse:
      case HookEventName.PostToolUseFailure:
      case HookEventName.UserPromptSubmit:
      case HookEventName.AfterAgent:
      case HookEventName.SessionStart:
        return this.mergeWithOrDecision(outputs);

      // 字段替换类事件：后者覆盖前者
      case HookEventName.BeforeModel:
      case HookEventName.AfterModel:
        return this.mergeWithFieldReplacement(outputs);

      // 其他事件：简单合并
      default:
        return this.mergeSimple(outputs);
    }
  }

  /** OR 决策合并：任一 deny/block → 整体 deny，消息拼接 */
  private mergeWithOrDecision(outputs: HookOutput[]): HookOutput {
    const merged: HookOutput = {
      continue: true,
      suppressOutput: false,
    };

    const stopReasons: string[] = [];
    const reasons: string[] = [];
    const systemMessages: string[] = [];
    const additionalContexts: string[] = [];

    let hasBlockDecision = false;
    let hasContinueFalse = false;

    for (const output of outputs) {
      // continue=false 任一触发即生效
      if (output.continue === false) {
        hasContinueFalse = true;
        merged.continue = false;
        if (output.stopReason) stopReasons.push(output.stopReason);
      }

      // OR 决策：任一 deny/block → 整体 deny
      const temp = new DefaultHookOutput(output);
      if (temp.isBlockingDecision()) {
        hasBlockDecision = true;
        merged.decision = output.decision;
      }

      if (output.reason) reasons.push(output.reason);
      if (output.systemMessage) systemMessages.push(output.systemMessage);

      // suppressOutput 任一 true 即生效
      if (output.suppressOutput) merged.suppressOutput = true;

      // clearContext 任一 true 即生效（AfterAgent）
      if (output.hookSpecificOutput?.["clearContext"] === true) {
        merged.hookSpecificOutput = {
          ...(merged.hookSpecificOutput || {}),
          clearContext: true,
        };
      }

      // 合并 hookSpecificOutput（排除 clearContext）
      if (output.hookSpecificOutput) {
        const { clearContext: _, ...rest } = output.hookSpecificOutput;
        merged.hookSpecificOutput = {
          ...(merged.hookSpecificOutput || {}),
          ...rest,
        };
      }

      // 收集 additionalContext
      this.extractAdditionalContext(output, additionalContexts);
    }

    // 无阻塞决策时默认 allow
    if (!hasBlockDecision && !hasContinueFalse) {
      merged.decision = "allow";
    }

    if (stopReasons.length > 0) merged.stopReason = stopReasons.join("\n");
    if (reasons.length > 0) merged.reason = reasons.join("\n");
    if (systemMessages.length > 0) merged.systemMessage = systemMessages.join("\n");

    // 合并 additionalContext
    if (additionalContexts.length > 0) {
      merged.hookSpecificOutput = {
        ...(merged.hookSpecificOutput || {}),
        additionalContext: additionalContexts.join("\n"),
      };
    }

    return merged;
  }

  /** 字段替换合并：后者覆盖前者 */
  private mergeWithFieldReplacement(outputs: HookOutput[]): HookOutput {
    let merged: HookOutput = {};
    for (const output of outputs) {
      merged = {
        ...merged,
        ...output,
        hookSpecificOutput: {
          ...merged.hookSpecificOutput,
          ...output.hookSpecificOutput,
        },
      };
    }
    return merged;
  }

  /** 简单合并 */
  private mergeSimple(outputs: HookOutput[]): HookOutput {
    let merged: HookOutput = {};
    for (const output of outputs) {
      merged = { ...merged, ...output };
    }
    return merged;
  }

  /** 创建事件专属的 HookOutput 子类 */
  private createSpecificOutput(output: HookOutput, eventName: HookEventName): DefaultHookOutput {
    switch (eventName) {
      case HookEventName.PreToolUse:
        return new PreToolUseHookOutput(output);
      case HookEventName.AfterAgent:
        return new AfterAgentHookOutput(output);
      case HookEventName.BeforeModel:
        return new BeforeModelHookOutput(output);
      case HookEventName.AfterModel:
        return new AfterModelHookOutput(output);
      default:
        return new DefaultHookOutput(output);
    }
  }

  /** 从 hookSpecificOutput 中提取 additionalContext */
  private extractAdditionalContext(output: HookOutput, contexts: string[]): void {
    const specific = output.hookSpecificOutput;
    if (!specific) return;
    if ("additionalContext" in specific && typeof specific["additionalContext"] === "string") {
      contexts.push(specific["additionalContext"]);
    }
  }
}
