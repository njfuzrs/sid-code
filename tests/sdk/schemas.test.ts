/**
 * Phase 1 单测：SDK 消息 Schema 与控制协议 Schema 校验
 */

import { describe, test, expect } from "bun:test";
import {
  SDKMessageSchema,
  SDKUserMessageSchema,
  SDKAssistantMessageSchema,
  SDKResultSuccessSchema,
  SDKResultErrorSchema,
  SDKResultMessageSchema,
  SDKSystemInitSchema,
  SDKToolProgressSchema,
  UsageSchema,
  ContentBlockSchema,
} from "../../src/sdk/schemas.ts";
import {
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  SDKControlPermissionResponseSchema,
} from "../../src/sdk/control-schemas.ts";
import { lazySchema } from "../../src/sdk/lazy-schema.ts";
import { z } from "zod";

describe("lazySchema", () => {
  test("首次调用构造，后续返回同一实例", () => {
    let calls = 0;
    const factory = lazySchema(() => {
      calls++;
      return z.string();
    });
    const a = factory();
    const b = factory();
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});

describe("UsageSchema", () => {
  test("接受完整 usage", () => {
    const parsed = UsageSchema().safeParse({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 3,
    });
    expect(parsed.success).toBe(true);
  });

  test("缓存字段可选", () => {
    const parsed = UsageSchema().safeParse({ inputTokens: 1, outputTokens: 2 });
    expect(parsed.success).toBe(true);
  });

  test("缺失 inputTokens 失败", () => {
    const parsed = UsageSchema().safeParse({ outputTokens: 2 });
    expect(parsed.success).toBe(false);
  });
});

describe("ContentBlockSchema", () => {
  test("text block", () => {
    expect(ContentBlockSchema().safeParse({ type: "text", text: "hi" }).success).toBe(true);
  });
  test("tool_use block", () => {
    expect(
      ContentBlockSchema().safeParse({
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
      }).success,
    ).toBe(true);
  });
  test("tool_result block", () => {
    expect(
      ContentBlockSchema().safeParse({
        type: "tool_result",
        tool_use_id: "t1",
        content: "out",
      }).success,
    ).toBe(true);
  });
  test("未知 type 失败", () => {
    expect(ContentBlockSchema().safeParse({ type: "image", url: "x" }).success).toBe(false);
  });
});

describe("SDKUserMessageSchema", () => {
  test("合法用户消息", () => {
    const parsed = SDKUserMessageSchema().safeParse({
      type: "user",
      uuid: "u1",
      session_id: "s1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("SDKAssistantMessageSchema", () => {
  test("合法助手消息", () => {
    const parsed = SDKAssistantMessageSchema().safeParse({
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      stop_reason: null,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("SDKResultMessageSchema", () => {
  test("success 结果", () => {
    const ok = {
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 2,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0.01,
      usage: { inputTokens: 1, outputTokens: 2 },
      session_id: "s1",
    };
    expect(SDKResultSuccessSchema().safeParse(ok).success).toBe(true);
    expect(SDKResultMessageSchema().safeParse(ok).success).toBe(true);
  });

  test("error 结果", () => {
    const err = {
      type: "result",
      subtype: "error_max_turns",
      errors: ["达到最大轮次"],
      duration_ms: 100,
      num_turns: 5,
      total_cost_usd: 0.02,
      usage: { inputTokens: 1, outputTokens: 2 },
      session_id: "s1",
    };
    expect(SDKResultErrorSchema().safeParse(err).success).toBe(true);
    expect(SDKResultMessageSchema().safeParse(err).success).toBe(true);
  });

  test("未知 subtype 失败", () => {
    expect(
      SDKResultMessageSchema().safeParse({ type: "result", subtype: "weird" }).success,
    ).toBe(false);
  });
});

describe("SDKSystemInitSchema", () => {
  test("合法 init", () => {
    const parsed = SDKSystemInitSchema().safeParse({
      type: "system",
      subtype: "init",
      session_id: "s1",
      tools: [{ name: "Bash", description: "run shell" }],
      model: "claude-x",
      cwd: "/tmp",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("SDKToolProgressSchema", () => {
  test("start", () => {
    expect(
      SDKToolProgressSchema().safeParse({
        type: "tool_progress",
        tool_name: "Bash",
        status: "start",
        input: { command: "ls" },
      }).success,
    ).toBe(true);
  });
  test("end with result", () => {
    expect(
      SDKToolProgressSchema().safeParse({
        type: "tool_progress",
        tool_name: "Bash",
        status: "end",
        result: { is_error: false, elapsed_ms: 12 },
      }).success,
    ).toBe(true);
  });
});

describe("SDKMessageSchema 聚合联合", () => {
  test("接受 init / user / assistant / result / tool_progress / status", () => {
    const samples: unknown[] = [
      { type: "system", subtype: "init", session_id: "s", tools: [], model: "m", cwd: "/" },
      { type: "user", uuid: "u", session_id: "s", message: { role: "user", content: [] } },
      {
        type: "assistant",
        uuid: "a",
        session_id: "s",
        message: { role: "assistant", content: [] },
        stop_reason: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        session_id: "s",
      },
      { type: "tool_progress", tool_name: "X", status: "start" },
      { type: "system", subtype: "status", message: "hi" },
      { type: "system", subtype: "compact_boundary" },
    ];
    for (const s of samples) {
      const parsed = SDKMessageSchema().safeParse(s);
      expect(parsed.success).toBe(true);
    }
  });

  test("拒绝完全未知类型", () => {
    expect(SDKMessageSchema().safeParse({ type: "garbage" }).success).toBe(false);
  });
});

describe("控制协议 Schema", () => {
  test("control_request: can_use_tool", () => {
    const parsed = SDKControlRequestSchema().safeParse({
      type: "control_request",
      request_id: "r1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "t1",
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("control_request: initialize", () => {
    const parsed = SDKControlRequestSchema().safeParse({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "initialize", max_turns: 10 },
    });
    expect(parsed.success).toBe(true);
  });

  test("control_response: success", () => {
    const parsed = SDKControlResponseSchema().safeParse({
      type: "control_response",
      response: { subtype: "success", request_id: "r1", response: { ok: true } },
    });
    expect(parsed.success).toBe(true);
  });

  test("control_response: error", () => {
    const parsed = SDKControlResponseSchema().safeParse({
      type: "control_response",
      response: { subtype: "error", request_id: "r1", error: "boom" },
    });
    expect(parsed.success).toBe(true);
  });

  test("权限响应 behavior 枚举", () => {
    expect(
      SDKControlPermissionResponseSchema().safeParse({ behavior: "allow", tool_use_id: "t1" })
        .success,
    ).toBe(true);
    expect(
      SDKControlPermissionResponseSchema().safeParse({ behavior: "nope", tool_use_id: "t1" })
        .success,
    ).toBe(false);
  });
});
