/**
 * Goal Evaluator 单测
 *
 * 验证独立评估者逻辑：
 * - 快速路径（tryFastPathEval）：测试全绿 / 构建成功直接判定满足，不调 LLM
 * - evaluateGoal：基于 Evidence Log + 对话上下文调用 LLM 判定
 * - parseEvalResponse：解析 JSON（含 markdown 包裹 / 非法格式降级）
 * - extractEvalContext：从消息列表提取上下文
 * - 评估者调用失败时降级为"未满足"继续工作
 *
 * LLM 调用通过 mock Provider 隔离，不发真实网络请求。
 */

import { describe, test, expect } from "bun:test";
import {
  evaluateGoal,
  tryFastPathEval,
  extractEvalContext,
  type EvalConfig,
} from "../../src/goal/evaluator.ts";
import { createGoal } from "../../src/goal/state.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { StreamEvent, Message } from "../../src/llm/types.ts";

// ─── Mock Provider ───

/** 构造一个返回固定文本的 mock Provider（模拟评估者 LLM 流式响应） */
function mockProvider(responseText: string): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      // 逐字符吐出，模拟流式
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: responseText } } as StreamEvent;
    },
  };
}

/** 构造一个抛错的 mock Provider（模拟评估者调用失败） */
function failingProvider(): Provider {
  return {
    name: () => "mock-fail",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      throw new Error("network error");
    },
  };
}

function mockConfig(provider: Provider): EvalConfig {
  return {
    model: "haiku-test",
    provider,
    timeout: 1000,
    minTurnsBeforeEval: 2,
  };
}

// ─── 快速路径 ───

describe("tryFastPathEval", () => {
  test("测试全绿 + 目标含'测试'关键词 → 快速满足", () => {
    const goal = createGoal("让 bun test 通过");
    goal.evidenceLog = [
      { turn: 3, timestamp: 1, type: "test_result", summary: "42 tests passed, 0 failures" },
    ];
    const result = tryFastPathEval(goal);
    expect(result).not.toBeNull();
    expect(result!.satisfied).toBe(true);
    expect(result!.progress).toBe(100);
  });

  test("构建成功 + 目标含'build'关键词 → 快速满足", () => {
    const goal = createGoal("让 build 成功");
    goal.evidenceLog = [
      { turn: 2, timestamp: 1, type: "build_result", summary: "Build success in 0.3s" },
    ];
    const result = tryFastPathEval(goal);
    expect(result).not.toBeNull();
    expect(result!.satisfied).toBe(true);
  });

  test("测试有失败时不走快速路径", () => {
    const goal = createGoal("让 bun test 通过");
    goal.evidenceLog = [
      { turn: 3, timestamp: 1, type: "test_result", summary: "40 passed, 2 failures" },
    ];
    expect(tryFastPathEval(goal)).toBeNull();
  });

  test("目标与证据类型不匹配时不走快速路径", () => {
    // 目标讲测试，但最新证据是构建 → 不快速判定
    const goal = createGoal("让 bun test 通过");
    goal.evidenceLog = [
      { turn: 2, timestamp: 1, type: "build_result", summary: "Build success" },
    ];
    expect(tryFastPathEval(goal)).toBeNull();
  });

  test("无证据时返回 null", () => {
    const goal = createGoal("让 bun test 通过");
    expect(tryFastPathEval(goal)).toBeNull();
  });
});

// ─── evaluateGoal（含 LLM mock）───

describe("evaluateGoal", () => {
  test("Evidence Log 含测试全绿时走快速路径判定 satisfied（不调 LLM）", async () => {
    const goal = createGoal("让 bun test 通过");
    goal.evidenceLog = [
      {
        turn: 3,
        timestamp: 1,
        type: "test_result",
        summary: "42 tests passed, 0 failures",
        raw: "$ bun test\n✓ 42 tests passed\n0 failures",
      },
    ];
    // 即使 provider 抛错也不影响——快速路径优先
    const result = await evaluateGoal(goal, "", mockConfig(failingProvider()));
    expect(result.satisfied).toBe(true);
    expect(result.progress).toBe(100);
  });

  test("评估者返回 satisfied=false + blockerKey", async () => {
    const goal = createGoal("让 auth 测试通过");
    goal.evidenceLog = [
      { turn: 3, timestamp: 1, type: "test_result", summary: "40 passed, 2 failures" },
    ];
    const provider = mockProvider(
      JSON.stringify({ satisfied: false, reason: "auth 测试仍有 2 个失败", blockerKey: "auth-test-fail", progress: 80 }),
    );
    const result = await evaluateGoal(goal, "正在修复", mockConfig(provider));
    expect(result.satisfied).toBe(false);
    expect(result.blockerKey).toBe("auth-test-fail");
    expect(result.progress).toBe(80);
  });

  test("评估者判定 impossible", async () => {
    const goal = createGoal("修复 src/nonexistent.ts 的类型错误");
    goal.evidenceLog = [
      { turn: 1, timestamp: 1, type: "command_output", summary: "ls: src/nonexistent.ts: No such file" },
    ];
    const provider = mockProvider(
      JSON.stringify({ satisfied: false, reason: "目标文件不存在", impossible: true }),
    );
    const result = await evaluateGoal(goal, "文件不存在", mockConfig(provider));
    expect(result.impossible).toBe(true);
  });

  test("评估者返回被 markdown 代码块包裹的 JSON 也能解析", async () => {
    const goal = createGoal("完成迁移");
    goal.evidenceLog = [
      { turn: 3, timestamp: 1, type: "file_change", summary: "修改 a.ts" },
    ];
    const provider = mockProvider(
      "```json\n{\"satisfied\": true, \"reason\": \"迁移完成\"}\n```",
    );
    const result = await evaluateGoal(goal, "", mockConfig(provider));
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe("迁移完成");
  });

  test("评估者返回非 JSON 时降级为未满足", async () => {
    const goal = createGoal("完成任务");
    goal.evidenceLog = [
      { turn: 3, timestamp: 1, type: "file_change", summary: "改了点东西" },
    ];
    const provider = mockProvider("我觉得还没完成呢");
    const result = await evaluateGoal(goal, "", mockConfig(provider));
    expect(result.satisfied).toBe(false);
  });

  test("评估者调用抛错时降级为未满足继续工作", async () => {
    const goal = createGoal("完成任务");
    goal.evidenceLog = [
      { turn: 3, timestamp: 1, type: "file_change", summary: "改了点东西" },
    ];
    const result = await evaluateGoal(goal, "", mockConfig(failingProvider()));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain("评估器暂时不可用");
  });
});

// ─── extractEvalContext ───

describe("extractEvalContext", () => {
  test("提取最近消息的文本与工具结果", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "请修复测试" }] },
      { role: "assistant", content: [{ type: "text", text: "我来跑一下测试" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "2 failures", is_error: false }],
      },
    ];
    const ctx = extractEvalContext(messages);
    expect(ctx).toContain("我来跑一下测试");
    expect(ctx).toContain("2 failures");
  });

  test("超长上下文按 maxChars 截断保留最新", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "A".repeat(3000) }] },
      { role: "assistant", content: [{ type: "text", text: "B".repeat(3000) }] },
    ];
    const ctx = extractEvalContext(messages, 1000);
    expect(ctx.length).toBeLessThanOrEqual(1000);
    // 保留最新 → 应含 B
    expect(ctx).toContain("B");
  });

  test("空消息列表返回空字符串", () => {
    expect(extractEvalContext([])).toBe("");
  });
});
