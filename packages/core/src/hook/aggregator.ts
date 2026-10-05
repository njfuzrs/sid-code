/**
 * Hook 结果聚合器
 * OR 决策、字段替换、消息拼接、additionalContext 收集
 */

import {
  HookEventName,
  DefaultHookOutput,
  PreToolUseHookOutput,
  createHookOutput,
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
      // P1-2：Stop 必须走 OR。last-wins（mergeSimple）会让后一个 allow 覆盖前一个
      // lint/test 失败——Ralph 验证器互相放行。与 AfterAgent 同一语义：任一 block 即拦。
      case HookEventName.Stop:
      // H29：PreCompact 的枚举注释写「可 block」，原先落在 default 的 mergeSimple（last-wins），
      // 后一个 hook 的 allow 能取消前一个的阻止。凡注释写「可 block」的事件都必须一票否决——
      // 由 tests/hook/aggregator-veto-invariant.test.ts 遍历枚举机械断言。
      case HookEventName.PreCompact:
      // 同上：注释写「可 block」。当前 team.ts 不消费它的结论，但接上消费方的那天不该再踩一次
      case HookEventName.TeammateIdle:
        return this.mergeWithOrDecision(outputs, eventName);

      // G4：SessionStart/SubagentStart/Setup 忽略 exit2 阻塞（对齐 CC hooksConfigManager）——
      // 这些生命周期事件的 hook 不能阻塞会话启动，block 降级为 systemMessage 告警。
      case HookEventName.SessionStart:
      case HookEventName.SubagentStart:
      case HookEventName.Setup:
        return this.mergeWithOrDecision(outputs, eventName, /* ignoreBlock */ true);

      // 字段替换类事件：llm_request / llm_response 后者覆盖前者，但阻塞与停机仍是一票否决（H29）
      case HookEventName.BeforeModel:
      case HookEventName.AfterModel:
        return this.mergeWithFieldReplacement(outputs, eventName);

      // 其他事件：简单合并
      default:
        return this.mergeSimple(outputs);
    }
  }

  /**
   * OR 决策合并：任一 deny/block → 整体 deny，消息拼接
   * @param ignoreBlock G4：SessionStart/SubagentStart/Setup 忽略阻塞，block 降级为 systemMessage。
   */
  private mergeWithOrDecision(
    outputs: HookOutput[],
    eventName: HookEventName,
    ignoreBlock = false,
  ): HookOutput {
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
    let hasApproveDecision = false;
    /** 第一个阻塞者：合并后要用它的结论覆盖掉被浅合并冲掉的 permissionDecision（H1） */
    let firstBlocker: DefaultHookOutput | undefined;

    for (const output of outputs) {
      // continue=false 任一触发即生效
      if (output.continue === false) {
        hasContinueFalse = true;
        merged.continue = false;
        if (output.stopReason) stopReasons.push(output.stopReason);
      }

      // OR 决策：任一 deny/block → 整体 deny。
      // H1：必须按事件建子类判阻塞——`permissionDecision:"deny"` 的识别只在
      // PreToolUseHookOutput 的 override 里，用父类判会漏掉它，结论随 hook 先后顺序反转。
      const temp = createHookOutput(eventName, output);
      if (temp.isBlockingDecision()) {
        if (ignoreBlock) {
          // G4：忽略阻塞的事件——block 降级为告警文本，不影响 decision
          const blockText = output.reason || output.stopReason;
          if (blockText) systemMessages.push(`[hook 阻塞已忽略] ${blockText}`);
        } else {
          hasBlockDecision = true;
          firstBlocker ??= temp;
          // 只写了 permissionDecision:"deny" 的 hook 顶层 decision 为空，统一落成 deny
          merged.decision = output.decision === "block" ? "block" : "deny";
        }
      } else if (temp.isApproveDecision()) {
        hasApproveDecision = true;
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

    // H4：只有某个 hook **显式**放行（decision:"allow"/"approve"）时才写 allow。
    // 原先「无阻塞即 allow」把「没意见」和「批准」压成同一个值，SDK 桥据此跳过宿主 can_use_tool。
    if (!hasBlockDecision && !hasContinueFalse && hasApproveDecision) {
      merged.decision = "allow";
    }

    // H1：hookSpecificOutput 是逐个浅合并的，后一个 hook 的 permissionDecision:"allow"
    // 会冲掉前一个的 "deny"。阻塞成立时把权限三值钉回 deny，两条通道结论一致。
    if (hasBlockDecision && firstBlocker && merged.hookSpecificOutput?.["permissionDecision"]) {
      const blockerSpecific = firstBlocker.hookSpecificOutput ?? {};
      merged.hookSpecificOutput = {
        ...merged.hookSpecificOutput,
        permissionDecision: "deny",
        permissionDecisionReason:
          blockerSpecific["permissionDecisionReason"] ?? firstBlocker.reason ?? undefined,
      };
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

  /**
   * 字段替换合并：hookSpecificOutput（llm_request / llm_response）后者覆盖前者，
   * 让多个 hook 分别改请求的不同字段都生效。
   *
   * H29：但 decision 与 continue 不能跟着 last-wins——BeforeModel/AfterModel 声明「可 block」，
   * 后一个 hook 顺手带的 `continue:true` 或 `decision:"allow"` 曾能取消前一个的停机 / 拒绝。
   * 这里在字段替换之后把「任一阻塞 / 任一停机」钉回去，并保留阻塞者自己的 reason。
   */
  private mergeWithFieldReplacement(outputs: HookOutput[], eventName: HookEventName): HookOutput {
    let merged: HookOutput = {};
    let blocker: HookOutput | undefined;
    const stopReasons: string[] = [];
    for (const output of outputs) {
      merged = {
        ...merged,
        ...output,
        hookSpecificOutput: {
          ...merged.hookSpecificOutput,
          ...output.hookSpecificOutput,
        },
      };
      if (!blocker && createHookOutput(eventName, output).isBlockingDecision()) blocker = output;
      if (output.continue === false && output.stopReason) stopReasons.push(output.stopReason);
    }
    if (blocker) {
      merged.decision = blocker.decision === "block" ? "block" : "deny";
      if (blocker.reason) merged.reason = blocker.reason;
    }
    if (outputs.some((o) => o.continue === false)) {
      merged.continue = false;
      if (stopReasons.length > 0) merged.stopReason = stopReasons.join("\n");
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
