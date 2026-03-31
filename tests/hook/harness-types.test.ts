/**
 * Harness 扩展类型 + Hook 载荷补充测试
 * 验证 Step 1 的所有改动：类型可选性、firePostToolUseEvent options 传递、fireSessionEndEvent options 传递
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "../../src/hook/system.ts";
import { HookEventName } from "../../src/hook/types.ts";
import type {
  HarnessHookContext,
  HarnessEditMeta,
  HarnessSessionSummary,
  PostToolUseInput,
  AfterModelInput,
  BeforeModelInput,
  SessionEndInput,
  HookInput,
} from "../../src/hook/types.ts";

/** 辅助：创建空 HookSystem 并注册 runtime hook 捕获载荷 */
function createSystemWithCapture(eventName: HookEventName) {
  const sys = new HookSystem();
  sys.setSessionId("test-session");
  sys.setCwd("/tmp/test");

  let captured: HookInput | undefined;
  sys.registerHook(
    {
      type: "runtime",
      name: `capture-${eventName}`,
      action: async (input) => {
        captured = input;
      },
    },
    eventName,
    { source: "runtime" as any },
  );

  return { sys, getCaptured: () => captured };
}

// ============================================================
// Harness 扩展类型可选性测试
// ============================================================

describe("Harness 扩展类型可选性", () => {
  test("HarnessHookContext 所有字段可选，空对象合法", () => {
    const ctx: HarnessHookContext = {};
    expect(ctx).toBeDefined();
  });

  test("HarnessHookContext 可以只填部分字段", () => {
    const ctx: HarnessHookContext = {
      task_profile: { task_type: "single_file_edit", risk_level: "low" },
      tool_subset: ["read", "write", "edit"],
      context_pressure_percent: 75,
    };
    expect(ctx.task_profile?.task_type).toBe("single_file_edit");
    expect(ctx.tool_subset?.length).toBe(3);
  });

  test("HarnessEditMeta 所有字段可选，空对象合法", () => {
    const meta: HarnessEditMeta = {};
    expect(meta).toBeDefined();
  });

  test("HarnessEditMeta 可以填充完整字段", () => {
    const meta: HarnessEditMeta = {
      protocol: "hashline",
      first_pass_success: true,
      retry_count: 0,
      match_strategy: "exact",
      hashline_address: "42:k9f2",
    };
    expect(meta.protocol).toBe("hashline");
    expect(meta.first_pass_success).toBe(true);
  });

  test("HarnessSessionSummary 所有字段可选，空对象合法", () => {
    const summary: HarnessSessionSummary = {};
    expect(summary).toBeDefined();
  });

  test("HarnessSessionSummary 可以填充完整字段", () => {
    const summary: HarnessSessionSummary = {
      task_profile: { task_type: "multi_file_edit" },
      edit_stats: {
        total_edits: 10,
        first_pass_success: 8,
        retry_count: 2,
        protocols_used: { replace: 7, hashline: 3 },
      },
      verify_stats: {
        total_runs: 5,
        pass_count: 4,
        auto_repair_success: 1,
        commands_used: ["bun test", "tsc --noEmit"],
      },
      context_stats: {
        trimmed_tokens: 1000,
        expired_items: 3,
        tool_subset_sizes: [6, 8, 10],
        compression_actions: 2,
      },
      runtime_mode: "local-inline",
      candidate_stats: {
        spawned: 3,
        selected: 1,
        selector_reason: "lowest_cost",
      },
    };
    expect(summary.edit_stats?.total_edits).toBe(10);
    expect(summary.candidate_stats?.selector_reason).toBe("lowest_cost");
  });
});

// ============================================================
// firePostToolUseEvent options 参数传递测试
// ============================================================

describe("firePostToolUseEvent options 参数传递", () => {
  test("不传 options 时载荷中新字段为 undefined", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.PostToolUse);
    await sys.firePostToolUseEvent("bash", { command: "ls" }, { output: "ok" }, false, "toolu_001");

    const input = getCaptured() as PostToolUseInput;
    expect(input).toBeDefined();
    expect(input.tool_name).toBe("bash");
    expect(input.duration_ms).toBeUndefined();
    expect(input.edit_meta).toBeUndefined();
    expect(input.verify_triggered).toBeUndefined();
    expect(input.harness_context).toBeUndefined();
  });

  test("传 options.duration_ms 时载荷中正确包含", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.PostToolUse);
    await sys.firePostToolUseEvent(
      "edit", { file: "a.ts" }, { output: "ok" }, false, "toolu_002",
      { duration_ms: 150 },
    );

    const input = getCaptured() as PostToolUseInput;
    expect(input.duration_ms).toBe(150);
  });

  test("传完整 options 时载荷中所有字段正确", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.PostToolUse);
    const editMeta: HarnessEditMeta = {
      protocol: "replace",
      first_pass_success: true,
      match_strategy: "exact",
    };
    const harnessCtx: HarnessHookContext = {
      task_profile: { task_type: "single_file_edit" },
      tool_subset: ["read", "edit"],
    };

    await sys.firePostToolUseEvent(
      "edit", { file: "b.ts" }, { output: "ok" }, false, "toolu_003",
      {
        duration_ms: 200,
        edit_meta: editMeta,
        verify_triggered: true,
        harness_context: harnessCtx,
      },
    );

    const input = getCaptured() as PostToolUseInput;
    expect(input.duration_ms).toBe(200);
    expect(input.edit_meta?.protocol).toBe("replace");
    expect(input.edit_meta?.first_pass_success).toBe(true);
    expect(input.verify_triggered).toBe(true);
    expect(input.harness_context?.task_profile?.task_type).toBe("single_file_edit");
    expect(input.harness_context?.tool_subset).toEqual(["read", "edit"]);
  });
});

// ============================================================
// fireSessionEndEvent options 参数传递测试
// ============================================================

describe("fireSessionEndEvent options 参数传递", () => {
  test("不传 options 时载荷中 harness_summary 为 undefined", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.SessionEnd);
    await sys.fireSessionEndEvent("exit");

    const input = getCaptured() as SessionEndInput;
    expect(input).toBeDefined();
    expect(input.reason).toBe("exit");
    expect(input.harness_summary).toBeUndefined();
  });

  test("传 options.harness_summary 时载荷中正确包含", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.SessionEnd);
    const summary: HarnessSessionSummary = {
      edit_stats: {
        total_edits: 5,
        first_pass_success: 4,
        retry_count: 1,
        protocols_used: { replace: 5 },
      },
      runtime_mode: "local-inline",
    };

    await sys.fireSessionEndEvent("exit", undefined, { harness_summary: summary });

    const input = getCaptured() as SessionEndInput;
    expect(input.harness_summary).toBeDefined();
    expect(input.harness_summary?.edit_stats?.total_edits).toBe(5);
    expect(input.harness_summary?.runtime_mode).toBe("local-inline");
  });

  test("同时传 stats 和 options 时两者都正确", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.SessionEnd);
    const stats = {
      model: "claude-3",
      total_cost_usd: 0.05,
      total_api_calls: 3,
    };
    const summary: HarnessSessionSummary = {
      candidate_stats: { spawned: 2, selected: 1 },
    };

    await sys.fireSessionEndEvent("exit", stats, { harness_summary: summary });

    const input = getCaptured() as SessionEndInput;
    expect(input.stats?.model).toBe("claude-3");
    expect(input.stats?.total_cost_usd).toBe(0.05);
    expect(input.harness_summary?.candidate_stats?.spawned).toBe(2);
  });
});

// ============================================================
// AfterModelInput 新增字段测试
// ============================================================

describe("AfterModelInput 新增字段", () => {
  test("fireAfterModelEvent 载荷中包含 cost_usd/api_duration_ms/cache_savings_usd", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.AfterModel);

    await sys.fireAfterModelEvent(
      { model: "claude-3", messages: [] },
      {
        text: "hello",
        usage: { inputTokens: 100, outputTokens: 50 },
        stop_reason: "end_turn",
        cost_usd: 0.001,
        api_duration_ms: 500,
        cache_savings_usd: 0.0005,
        ttft_ms: 120,
      },
    );

    const input = getCaptured() as AfterModelInput;
    expect(input.llm_response.cost_usd).toBe(0.001);
    expect(input.llm_response.api_duration_ms).toBe(500);
    expect(input.llm_response.cache_savings_usd).toBe(0.0005);
    expect(input.llm_response.ttft_ms).toBe(120);
  });

  test("不传新字段时为 undefined（向后兼容）", async () => {
    const { sys, getCaptured } = createSystemWithCapture(HookEventName.AfterModel);

    await sys.fireAfterModelEvent(
      { model: "claude-3", messages: [] },
      { text: "hello", stop_reason: "end_turn" },
    );

    const input = getCaptured() as AfterModelInput;
    expect(input.llm_response.cost_usd).toBeUndefined();
    expect(input.llm_response.api_duration_ms).toBeUndefined();
    expect(input.llm_response.cache_savings_usd).toBeUndefined();
    expect(input.llm_response.ttft_ms).toBeUndefined();
  });
});

// ============================================================
// BeforeModelInput harness_context 扩展点测试
// ============================================================

describe("BeforeModelInput harness_context", () => {
  test("BeforeModelInput 类型支持 harness_context 字段", () => {
    const input: BeforeModelInput = {
      session_id: "s1",
      cwd: "/tmp",
      hook_event_name: "BeforeModel",
      timestamp: new Date().toISOString(),
      llm_request: { model: "claude-3", messages: [] },
      harness_context: {
        task_profile: { task_type: "read_only" },
        context_pressure_percent: 30,
      },
    };
    expect(input.harness_context?.task_profile?.task_type).toBe("read_only");
  });
});
