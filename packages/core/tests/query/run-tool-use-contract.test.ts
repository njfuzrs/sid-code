/**
 * 契约测试：同一个工具调用走三条执行路径，hook 事件序列必须一致。
 *
 *   路径 1  主循环        query/tool-executor.ts  executeTools
 *   路径 2  进程内子代理  agent/tool-executor.ts  executeTools   ─┐ 单次执行都是
 *   路径 3  spawn 子代理  agent/sub-agent.ts      executeToolForChild ─┘ query/run-tool-use.ts runToolUse
 *   路径 4  forked        agent/forked-agent.ts   —— 显式例外：刻意不触发用户 hook，权限走 canUseTool 回调
 *
 * 为什么写成矩阵：过去「子代理补成和主循环一致」的修复至少 7 次，每次都是某条路径的某个分支
 * 漏 fire 一个事件。逐路径写断言挡不住下一次漂移；矩阵里任何一格与其他路径不同就红。
 *
 * 允许的差异必须在 DESIGN_DIFFS 里显式声明，不在这里的差异一律算缺陷。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import type { ContentBlock, ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { executeTools as mainExecuteTools } from "@sid-code/core/query/tool-executor.ts";
import { executeTools as subExecuteTools } from "@sid-code/core/agent/tool-executor.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";

type Behavior = "ok" | "tool_error" | "throw";

interface Scenario {
  name: string;
  behavior?: Behavior;
  input?: Record<string, unknown>;
  zodSchema?: unknown;
  hookBlock?: boolean;
  permDeny?: boolean;
  /** 三条路径都必须产出的事件序列 */
  expected: string[];
}

const SCENARIOS: Scenario[] = [
  { name: "成功", expected: ["pre", "post"] },
  { name: "工具返回 isError", behavior: "tool_error", expected: ["pre", "failure:tool_error"] },
  { name: "工具抛异常", behavior: "throw", expected: ["pre", "failure:exception"] },
  {
    name: "参数校验失败",
    zodSchema: z.object({ q: z.string() }),
    input: { header: "x" },
    expected: ["pre", "failure:validation"],
  },
  { name: "PreToolUse 阻止", hookBlock: true, expected: ["pre", "failure:hook_blocked"] },
  // Q7：权限拒绝只 fire PermissionDenied，不补 PostToolUseFailure
  { name: "权限拒绝", permDeny: true, expected: ["pre", "denied:rule"] },
];

/**
 * 显式声明的设计差异（与本矩阵无关，列出防止有人「顺手对齐」）：
 * - 权限 ask：主循环弹窗，子代理无 UI 直接拒绝（本矩阵用 needsConfirmation=false 的规则拒绝，三路同形）
 * - speculativeClassifier：仅主循环在 opt-in 时与弹窗并行放行
 * - 主循环 PostToolUse 额外带 harness_context / progress_events 遥测载荷
 * - 路径 4（forked）不触发用户 hook
 */

function makeTool(s: Scenario) {
  return {
    name: () => "probe_tool",
    description: () => "probe",
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    ...(s.zodSchema ? { zodSchema: s.zodSchema } : {}),
    async execute() {
      if (s.behavior === "throw") throw new Error("炸了");
      if (s.behavior === "tool_error") return { output: "失败输出", isError: true };
      return { output: "ok" };
    },
  };
}

/** 记录事件序列的 hookSystem；未列出的方法一律 no-op（主循环还会 fire PostToolBatch 等） */
function recordingHooks(s: Scenario, log: string[]) {
  const known = {
    firePreToolUseEvent: async () => {
      log.push("pre");
      if (s.hookBlock) {
        return {
          finalOutput: {
            isBlockingDecision: () => true,
            getEffectiveReason: () => "不许跑",
          },
        };
      }
      return { finalOutput: undefined };
    },
    firePostToolUseEvent: async () => {
      log.push("post");
      return { finalOutput: undefined };
    },
    firePostToolUseFailureEvent: async (
      _n: string,
      _i: unknown,
      _e: string,
      _id?: string,
      opts?: { failure_kind?: string },
    ) => {
      log.push(`failure:${opts?.failure_kind}`);
      return { finalOutput: undefined };
    },
    firePermissionDeniedEvent: async (_n: string, _i: unknown, _r: string, source: string) => {
      log.push(`denied:${source}`);
      return { finalOutput: undefined };
    },
  } as Record<string, unknown>;
  return new Proxy(known, {
    get: (t, k: string) => (k in t ? t[k] : async () => ({ finalOutput: undefined })),
  }) as any;
}

function checker(s: Scenario) {
  return {
    check: async () =>
      s.permDeny
        ? { allowed: false, reason: "规则拒绝", decisionReason: { type: "rule" } }
        : { allowed: true },
    recordUserDenial: () => {},
  } as any;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function block(s: Scenario): ToolUseBlock {
  return { type: "tool_use", id: "tu-1", name: "probe_tool", input: s.input ?? {} };
}

type PathRunner = (s: Scenario, log: string[]) => Promise<void>;

const PATHS: Record<string, PathRunner> = {
  "1 主循环": async (s, log) => {
    const tool = makeTool(s);
    await mainExecuteTools(
      [block(s)] as ContentBlock[],
      {
        config: { checkpoint: { enabled: false } } as any,
        toolRegistry: {
          get: (n: string) => (n === "probe_tool" ? tool : null),
          isDeferred: () => false,
          isActivated: () => true,
          isToolSearchEnabled: () => false,
        } as any,
        sessionState: {
          sessionId: "contract",
          addToolDuration: () => {},
          recordToolResult: () => {},
        } as any,
        hookSystem: recordingHooks(s, log),
        permissionChecker: checker(s),
        preToolUseCache: new Map(),
        getAbortSignal: () => undefined,
        requestUserConfirmation: async () => false,
      } as any,
    );
  },
  "2 进程内子代理": async (s, log) => {
    const reg = new Registry();
    reg.register(makeTool(s) as any);
    await subExecuteTools(
      [block(s)] as ContentBlock[],
      reg,
      undefined,
      recordingHooks(s, log),
      checker(s),
      undefined,
      "contract",
    );
  },
  "3 spawn 子代理": async (s, log) => {
    const reg = new Registry();
    reg.register(makeTool(s) as any);
    const sub = new SubAgent({} as any, "m", reg, recordingHooks(s, log));
    sub.setPermissionChecker(checker(s));
    await (sub as any).executeToolForChild("probe_tool", s.input ?? {}, reg, undefined, "tu-1");
  },
};

describe("runToolUse 契约：三条执行路径的 hook 事件序列一致", () => {
  for (const s of SCENARIOS) {
    for (const [path, run] of Object.entries(PATHS)) {
      test(`${s.name} · 路径 ${path}`, async () => {
        const log: string[] = [];
        await run(s, log);
        await flush();
        expect(log).toEqual(s.expected);
      });
    }
  }
});

describe("收口前 spawn 路径漏掉的 4 处，现与进程内路径一致", () => {
  test("abort 预检：已中断时不执行、不 fire PreToolUse", async () => {
    let executed = 0;
    const reg = new Registry();
    reg.register({
      name: () => "w",
      description: () => "w",
      inputSchema: () => ({ type: "object", properties: {} }),
      readOnly: () => true,
      execute: async () => {
        executed++;
        return { output: "ok" };
      },
    } as any);
    const log: string[] = [];
    const sub = new SubAgent({} as any, "m", reg, recordingHooks({} as Scenario, log));
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await (sub as any).executeToolForChild("w", {}, reg, ctrl.signal, "tu-a");
    expect(executed).toBe(0);
    expect(log).toEqual([]);
    expect(r.is_error).toBe(true);
  });

  test("未配权限检查器：写类工具 fail-closed，不执行", async () => {
    let executed = 0;
    const reg = new Registry();
    reg.register({
      name: () => "writer",
      description: () => "w",
      inputSchema: () => ({ type: "object", properties: {} }),
      readOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => {
        executed++;
        return { output: "已写入" };
      },
    } as any);
    const sub = new SubAgent({} as any, "m", reg);
    const r = await (sub as any).executeToolForChild("writer", {}, reg, undefined, "tu-w");
    expect(executed).toBe(0);
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("fail-closed");
  });

  test("模型伪造的内部字段被剥离，_agentId 由执行器注入", async () => {
    const seen: any[] = [];
    const reg = new Registry();
    reg.register({
      name: () => "echo",
      description: () => "e",
      inputSchema: () => ({ type: "object", properties: {} }),
      readOnly: () => true,
      execute: async (input: any) => {
        seen.push(input);
        return { output: "ok" };
      },
    } as any);
    const sub = new SubAgent({} as any, "m", reg);
    await (sub as any).executeToolForChild(
      "echo",
      { a: 1, _parentToolUseId: "forged", _agentId: "forged" },
      reg,
      undefined,
      "tu-e",
    );
    expect(seen[0]._agentId).toBe("sub-agent");
    expect("_parentToolUseId" in seen[0]).toBe(false);
    expect(seen[0].a).toBe(1);
  });
});
