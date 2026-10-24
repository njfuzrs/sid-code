/**
 * 子代理（进程内 agent/tool-executor.ts）与主循环同口径的管线修复（2026-10-24）。
 *
 * 主循环那组见 tests/query/tool-pipeline-gaps-20261024.test.ts。这里只锁子代理侧三条：
 *   - 工具执行中 signal 被 abort、工具自己返回 isError → aborted（原先 tool_error）
 *   - hook 改写参数后，权限层看到展开后的路径（原先子代理完全不展开）
 *   - PostToolUse updatedMCPToolOutput 替换模型侧输出
 * 用真实 HookSystem + runtime 探针，断言 hook 实际收到的事件。
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { executeTools } from "@sid-code/core/agent/tool-executor.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";

function probe(sys: HookSystem, ev: HookEventName) {
  const seen: any[] = [];
  sys.registerHook(
    { type: "runtime", name: `probe-${ev}`, action: async (i) => void seen.push(i) },
    ev,
    { source: "runtime" as any },
  );
  return seen;
}

function runtimeHook(sys: HookSystem, ev: HookEventName, out: Record<string, unknown>) {
  sys.registerHook({ type: "runtime", name: `out-${ev}`, action: async () => out as any }, ev, {
    source: "runtime" as any,
  });
}

function newSys(): HookSystem {
  const sys = new HookSystem();
  sys.setSessionId("s-sub-gaps");
  return sys;
}

function registry(tools: any[]) {
  const reg = new Registry();
  for (const t of tools) reg.register(t);
  return reg;
}

function tool(name: string, run: (i: any, s?: AbortSignal) => Promise<any>, extra: any = {}) {
  return {
    name: () => name,
    description: () => name,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    execute: run,
    ...extra,
  };
}

const allowAll = { check: async () => ({ allowed: true }) } as any;
const use = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ type: "tool_use", id, name, input }) as ContentBlock;
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("子代理：中断分型", () => {
  test("signal 已 abort + 工具返回 isError → PostToolUseFailure kind=aborted, is_interrupt", async () => {
    const sys = newSys();
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const ctrl = new AbortController();
    const t = tool("bash", async () => {
      ctrl.abort("user-cancel");
      return { output: "命令已取消并终止（用户取消）", isError: true };
    });
    await executeTools([use("b1", "bash")], registry([t]), ctrl.signal, sys, allowAll);
    await settle();
    expect(fail[0]).toMatchObject({ sid_failure_kind: "aborted", is_interrupt: true });
  });

  test("反向：未 abort 的 isError 仍是 tool_error", async () => {
    const sys = newSys();
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const t = tool("bash", async () => ({ output: "exit 1", isError: true }));
    await executeTools([use("b1", "bash")], registry([t]), undefined, sys, allowAll);
    await settle();
    expect(fail[0]).toMatchObject({ sid_failure_kind: "tool_error", is_interrupt: false });
  });
});

describe("子代理：hook 改参后权限层看到展开路径", () => {
  test("updatedInput 给 `~/` 路径 → checker 收到回填展开后的绝对路径", async () => {
    const sys = newSys();
    runtimeHook(sys, HookEventName.PreToolUse, {
      hookSpecificOutput: { updatedInput: { file_path: "~/.ssh/id_rsa" } },
    });
    const seen: any[] = [];
    const checker = {
      check: async (req: any) => {
        seen.push(req.input);
        return { allowed: true };
      },
    } as any;
    const t = tool("read", async () => ({ output: "ok" }), {
      backfillObservableInput: (i: any) =>
        i?.file_path?.startsWith("~/")
          ? { ...i, file_path: "/home/u/" + i.file_path.slice(2) }
          : undefined,
    });
    await executeTools(
      [use("r1", "read", { file_path: "a.txt" })],
      registry([t]),
      undefined,
      sys,
      checker,
    );
    expect(seen[0].file_path).toBe("/home/u/.ssh/id_rsa");
  });
});

describe("子代理：PostToolUse 输出替换", () => {
  test("MCP 工具 updatedMCPToolOutput → 模型侧收不到原文", async () => {
    const sys = newSys();
    runtimeHook(sys, HookEventName.PostToolUse, {
      hookSpecificOutput: { updatedMCPToolOutput: "token=[redacted]" },
    });
    const t = tool("mcp__vault__read", async () => ({ output: "token=sk-live-abcdef0123456789" }));
    const [r] = (await executeTools(
      [use("m1", "mcp__vault__read")],
      registry([t]),
      undefined,
      sys,
      allowAll,
    )) as any[];
    expect(String(r.content)).toContain("[redacted]");
    expect(String(r.content)).not.toContain("sk-live");
  });
});
