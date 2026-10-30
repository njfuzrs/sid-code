/**
 * 回归：hook additionalContext 单条上限。
 *
 * additionalContext 拼进本轮 user 消息，此前无上限、多 hook 直接 join。一个失控的 hook
 * 就能让本轮输入自己超窗，而压缩层只按消息删 / 摘要，缩短不了本轮输入。
 */

import { describe, test, expect } from "bun:test";
import { HookAggregator, ADDITIONAL_CONTEXT_MAX_CHARS } from "@sid-code/core/hook/aggregator.ts";
import { HookEventName, type HookOutput } from "@sid-code/core/hook/types.ts";

function aggregate(outputs: HookOutput[]) {
  return new HookAggregator().aggregateResults(
    outputs.map((output, i) => ({
      hookConfig: { type: "command" as const, command: `h${i}` },
      eventName: HookEventName.UserPromptSubmit,
      success: true,
      output,
      duration: 1,
    })),
    HookEventName.UserPromptSubmit,
  ).finalOutput!;
}

const ctxOf = (text: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
});

describe("hook additionalContext 上限", () => {
  test("超限的单条被截断并注明原长度", () => {
    const huge = "a".repeat(ADDITIONAL_CONTEXT_MAX_CHARS * 5);
    const out = aggregate([ctxOf(huge)]);
    const merged = String(out.hookSpecificOutput?.["additionalContext"]);
    expect(merged.length).toBeLessThan(ADDITIONAL_CONTEXT_MAX_CHARS + 200);
    expect(merged).toContain(`共 ${huge.length} 字符，已截断`);
  });

  test("每条各自截断：两个超限 hook 合并后不超过两份上限", () => {
    const huge = "b".repeat(ADDITIONAL_CONTEXT_MAX_CHARS * 3);
    const out = aggregate([ctxOf(huge), ctxOf(huge)]);
    const merged = String(out.hookSpecificOutput?.["additionalContext"]);
    expect(merged.length).toBeLessThan(ADDITIONAL_CONTEXT_MAX_CHARS * 2 + 400);
  });

  test("对照：未超限的原样保留", () => {
    const out = aggregate([ctxOf("small-1"), ctxOf("small-2")]);
    expect(out.hookSpecificOutput?.["additionalContext"]).toBe("small-1\nsmall-2");
  });
});
