/**
 * G11：新增事件 InstructionsLoaded / TeammateIdle / Elicitation / ElicitationResult
 *
 * 验证：
 * 1. 事件枚举 + LEGACY_EVENT_MAP（snake_case）已登记；
 * 2. fire 方法能触发已注册的对应 hook（走 runtime hook 快速路径，不依赖外部进程）；
 * 3. 非工具事件也能正常聚合（无 tool_input 依赖）。
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "../../src/hook/system.ts";
import { HookEventName, LEGACY_EVENT_MAP, ConfigSource } from "../../src/hook/types.ts";

describe("G11 新增事件枚举与 legacy 映射", () => {
  test("枚举包含 4 个新事件", () => {
    expect(HookEventName.InstructionsLoaded).toBe("InstructionsLoaded" as HookEventName);
    expect(HookEventName.TeammateIdle).toBe("TeammateIdle" as HookEventName);
    expect(HookEventName.Elicitation).toBe("Elicitation" as HookEventName);
    expect(HookEventName.ElicitationResult).toBe("ElicitationResult" as HookEventName);
  });

  test("LEGACY_EVENT_MAP 有对应 snake_case", () => {
    expect(LEGACY_EVENT_MAP["instructions_loaded"]).toBe(HookEventName.InstructionsLoaded);
    expect(LEGACY_EVENT_MAP["teammate_idle"]).toBe(HookEventName.TeammateIdle);
    expect(LEGACY_EVENT_MAP["elicitation"]).toBe(HookEventName.Elicitation);
    expect(LEGACY_EVENT_MAP["elicitation_result"]).toBe(HookEventName.ElicitationResult);
  });
});

describe("G11 fire 方法触发对应 hook", () => {
  test("InstructionsLoaded 触发 runtime hook，input 携带 sources/total_chars", async () => {
    const system = new HookSystem();
    let captured: any = null;
    system.registerHook(
      {
        type: "runtime",
        name: "capture-instructions",
        action: async (input) => {
          captured = input;
        },
      },
      HookEventName.InstructionsLoaded,
      { source: ConfigSource.Runtime },
    );

    const result = await system.fireInstructionsLoadedEvent(["/proj/CLAUDE.md"], 1234);
    expect(result.success).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured.sources).toEqual(["/proj/CLAUDE.md"]);
    expect(captured.total_chars).toBe(1234);
  });

  test("TeammateIdle 触发 runtime hook，input 携带 teammate_id/name", async () => {
    const system = new HookSystem();
    let captured: any = null;
    system.registerHook(
      {
        type: "runtime",
        name: "capture-teammate-idle",
        action: async (input) => {
          captured = input;
        },
      },
      HookEventName.TeammateIdle,
      { source: ConfigSource.Runtime },
    );

    const result = await system.fireTeammateIdleEvent("team-a:worker1", "worker1", 500);
    expect(result.success).toBe(true);
    expect(captured.teammate_id).toBe("team-a:worker1");
    expect(captured.teammate_name).toBe("worker1");
    expect(captured.idle_ms).toBe(500);
  });

  test("Elicitation / ElicitationResult 可触发（占位事件不报错）", async () => {
    const system = new HookSystem();
    let elicitCaptured: any = null;
    let resultCaptured: any = null;
    system.registerHook(
      { type: "runtime", name: "capture-elicitation", action: async (i) => { elicitCaptured = i; } },
      HookEventName.Elicitation,
      { source: ConfigSource.Runtime },
    );
    system.registerHook(
      { type: "runtime", name: "capture-elicitation-result", action: async (i) => { resultCaptured = i; } },
      HookEventName.ElicitationResult,
      { source: ConfigSource.Runtime },
    );

    const r1 = await system.fireElicitationEvent("确认删除?", { type: "object" });
    const r2 = await system.fireElicitationResultEvent("accept", { confirmed: true });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(elicitCaptured.message).toBe("确认删除?");
    expect(resultCaptured.action).toBe("accept");
    expect(resultCaptured.content).toEqual({ confirmed: true });
  });

  test("无匹配 hook 时 fire 返回空结果不报错", async () => {
    const system = new HookSystem();
    const result = await system.fireInstructionsLoadedEvent(["/x/CLAUDE.md"]);
    expect(result.success).toBe(true);
    expect(result.allOutputs.length).toBe(0);
  });
});
