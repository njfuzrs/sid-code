/**
 * Hook 系统残留（§三.2 / §三.9）：
 * - statusMessage 有消费者：hook 开始 / 结束经 onHookLifecycle 带出文案；
 * - 无效 handler 类型的报错文案从 handler-types.ts 派生；
 * - skill / agent 运行期注册的诊断进运行期出口（diagnostic-sink），不只进 logger。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { ConfigSource, HookEventName } from "@sid-code/core/hook/types.ts";
import type { HookLifecycleEvent } from "@sid-code/core/hook/runner.ts";
import { normalizeHooksConfig } from "@sid-code/core/hook/config-normalize.ts";
import {
  USER_HOOK_HANDLER_TYPES,
  UNSUPPORTED_HOOK_HANDLER_TYPES,
} from "@sid-code/core/hook/handler-types.ts";
import {
  setRuntimeHookDiagnosticSink,
  resetRuntimeHookDiagnosticsForTest,
} from "@sid-code/core/hook/diagnostic-sink.ts";
import { registerSkillHooks } from "@sid-code/core/skill/hooks.ts";
import { registerAgentHooks } from "@sid-code/core/agent/agent-hooks.ts";

describe("statusMessage 生命周期回调", () => {
  test("hook 开始与结束各回调一次，带出 statusMessage，runId 配对", async () => {
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "true", statusMessage: "正在检查" }] },
          ],
        },
        source: ConfigSource.User,
      },
    ]);
    const evs: HookLifecycleEvent[] = [];
    sys.onHookLifecycle((ev) => evs.push(ev));
    await sys.firePreToolUseEvent("bash", { command: "ls" });

    expect(evs.map((e) => e.phase)).toEqual(["start", "end"]);
    expect((evs[0]!.hookConfig as { statusMessage?: string }).statusMessage).toBe("正在检查");
    expect(evs[0]!.eventName).toBe(HookEventName.PreToolUse);
    expect(evs[0]!.runId).toBe(evs[1]!.runId);
  });

  test("hook 执行失败也会发 end（否则状态行文案永久残留）", async () => {
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: { Stop: [{ hooks: [{ command: "exit 1", statusMessage: "收尾中" }] }] },
        source: ConfigSource.User,
      },
    ]);
    const phases: string[] = [];
    sys.onHookLifecycle((ev) => phases.push(ev.phase));
    await sys.fireStopEvent("done");
    expect(phases).toEqual(["start", "end"]);
  });

  test("监听抛错不影响 hook 结论；取消订阅后不再回调", async () => {
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: { PreToolUse: [{ hooks: [{ command: "true", statusMessage: "x" }] }] },
        source: ConfigSource.User,
      },
    ]);
    const off = sys.onHookLifecycle(() => {
      throw new Error("UI 坏了");
    });
    const r = await sys.firePreToolUseEvent("bash", {});
    expect(r.success).toBe(true);
    off();
    let n = 0;
    sys.onHookLifecycle(() => n++)();
    await sys.firePreToolUseEvent("bash", {});
    expect(n).toBe(0);
  });
});

describe("无效 handler 类型报错文案派生自 handler-types.ts", () => {
  test("文案列出全部可执行类型、不含 mcp_tool / runtime", () => {
    const { diagnostics } = normalizeHooksConfig(
      { PreToolUse: [{ hooks: [{ type: "bogus", command: "x" }] }] },
      ConfigSource.User,
    );
    const msg = diagnostics.find((d) => d.message.includes("无效的 hook 类型"))!.message;
    for (const t of USER_HOOK_HANDLER_TYPES) {
      if (UNSUPPORTED_HOOK_HANDLER_TYPES.has(t)) expect(msg).not.toContain(t);
      else expect(msg).toContain(t);
    }
    expect(msg).not.toContain("runtime");
  });
});

describe("skill / agent hook 诊断进运行期出口", () => {
  let lines: string[] = [];
  let prev: ReturnType<typeof setRuntimeHookDiagnosticSink>;
  const install = () => {
    lines = [];
    resetRuntimeHookDiagnosticsForTest();
    prev = setRuntimeHookDiagnosticSink((l) => lines.push(l));
  };
  afterEach(() => {
    setRuntimeHookDiagnosticSink(prev);
    resetRuntimeHookDiagnosticsForTest();
  });

  test("skill 声明的非法 hook 送到 sink，且同一条只报一次", () => {
    install();
    const sys = new HookSystem();
    const bad = { PreToolUse: [{ hooks: [{ type: "bogus", command: "x" }] }] } as never;
    registerSkillHooks(sys, "my-skill", bad, undefined);
    registerSkillHooks(sys, "my-skill", bad, undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Skill my-skill");
    expect(lines[0]).toContain("无效的 hook 类型");
  });

  test("agent 隔离 HookSystem 上的诊断同样送到 sink", () => {
    install();
    const sys = new HookSystem();
    registerAgentHooks(sys, "reviewer", { NotAnEvent: [{ hooks: [{ command: "x" }] }] });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("Agent reviewer");
  });

  test("未注册 sink（SDK / 测试）时不抛错", () => {
    setRuntimeHookDiagnosticSink(undefined);
    const sys = new HookSystem();
    expect(() =>
      registerSkillHooks(sys, "s", { X: [{ hooks: [{ command: "x" }] }] } as never, undefined),
    ).not.toThrow();
  });
});
