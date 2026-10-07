/**
 * 子代理路径 Hook 对齐 CC 残留（HC11/HC12/HC18/HC23/HC24 + §五 Q7 的子代理镜像）
 *
 * 主循环 `query/tool-executor.ts` 在 PR #180 已对齐，子代理两条执行路径
 * （进程内 `agent/tool-executor.ts` executeTools、spawn `sub-agent.ts` executeToolForChild）没跟上。
 * 本文件一律用真实 HookSystem（runtime probe 抓 stdin 载荷、command hook 产生 exit 2），
 * 不 mock hookSystem —— 断言的是「真实 fire 出去的输入长什么样」，不是「调用了某个方法」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { ConfigSource } from "@sid-code/core/hook/types.ts";
import { executeTools } from "@sid-code/core/agent/tool-executor.ts";
import { runWithHookAgent } from "@sid-code/core/agent/hook-agent-context.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";
import type { ContentBlock, SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";

// ── 公共脚手架 ─────────────────────────────────────────────

function probe(sys: HookSystem, ev: HookEventName) {
  const seen: any[] = [];
  sys.registerHook(
    { type: "runtime", name: `probe-${ev}`, action: async (i) => void seen.push(i) },
    ev,
    { source: "runtime" as any },
  );
  return seen;
}

/** 带一条用户级 command hook 的 HookSystem（用来产生真实的 exit 2 / block） */
function sysWith(event?: string, command?: string): HookSystem {
  const sys = new HookSystem();
  if (event && command) {
    sys.initializeFromSources([
      {
        hooks: { [event]: [{ hooks: [{ type: "command", command }] }] },
        source: ConfigSource.User,
      },
    ]);
  }
  sys.setSessionId("s-sub");
  return sys;
}

function makeTool(
  name: string,
  run: (input: any, signal?: AbortSignal) => Promise<{ output: string; isError?: boolean }>,
) {
  return {
    name: () => name,
    description: () => name,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    execute: (input: any, signal?: AbortSignal) => run(input, signal),
  };
}

function registry(tools: ReturnType<typeof makeTool>[]) {
  const reg = new Registry();
  for (const t of tools) reg.register(t as any);
  return reg;
}

const allowAll = { check: async () => ({ allowed: true }) } as any;
const denyAll = {
  check: async () => ({ allowed: false, reason: "规则拒绝", decisionReason: { type: "rule" } }),
} as any;
const use = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ type: "tool_use", id, name, input }) as ContentBlock;
const settle = () => new Promise((r) => setTimeout(r, 30));
const AGENT = { agent_id: "subagent-explore-t1", agent_type: "explore" };

function resultText(blocks: ContentBlock[]): string {
  const b = blocks[0] as any;
  return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
}

// ── 1. PostToolUse / Failure 反馈回灌（HC18） ───────────────

describe("1. 子代理 PostToolUse / PostToolUseFailure 的 hook 反馈回灌给子代理模型", () => {
  test("进程内：PostToolUse exit 2 的 stderr 以 [Hook 反馈] 拼进工具结果", async () => {
    const sys = sysWith("PostToolUse", "echo 'lint 失败: 缺分号' >&2; exit 2");
    const tools = registry([makeTool("edit_x", async () => ({ output: "已写入" }))]);
    const out = await executeTools([use("t1", "edit_x")], tools, undefined, sys, allowAll);
    expect(resultText(out)).toContain("已写入");
    expect(resultText(out)).toContain("[Hook 反馈]\nlint 失败: 缺分号");
  });

  test("进程内：工具返回 isError 时 PostToolUseFailure 的反馈同样回灌", async () => {
    const sys = sysWith("PostToolUseFailure", "echo '别再重试' >&2; exit 2");
    const tools = registry([makeTool("bash_x", async () => ({ output: "exit 1", isError: true }))]);
    const out = await executeTools([use("t1", "bash_x")], tools, undefined, sys, allowAll);
    expect((out[0] as any).is_error).toBe(true);
    expect(resultText(out)).toContain("[Hook 反馈]\n别再重试");
  });

  test("进程内：工具抛异常时 Failure 反馈回灌", async () => {
    const sys = sysWith("PostToolUseFailure", "echo '看日志' >&2; exit 2");
    const tools = registry([
      makeTool("boom", async () => {
        throw new Error("炸了");
      }),
    ]);
    const out = await executeTools([use("t1", "boom")], tools, undefined, sys, allowAll);
    expect(resultText(out)).toContain("工具执行异常: 炸了");
    expect(resultText(out)).toContain("[Hook 反馈]\n看日志");
  });

  test("进程内：exit 0 不产生反馈，结果原样", async () => {
    const sys = sysWith("PostToolUse", "echo ok");
    const tools = registry([makeTool("edit_x", async () => ({ output: "已写入" }))]);
    const out = await executeTools([use("t1", "edit_x")], tools, undefined, sys, allowAll);
    expect(resultText(out)).toBe("已写入");
  });

  test("spawn：executeToolForChild 同样回灌（与进程内共用 runPostToolHooks）", async () => {
    const sys = sysWith("PostToolUse", "echo 'spawn lint 红' >&2; exit 2");
    const tools = registry([makeTool("edit_x", async () => ({ output: "已写入" }))]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    const r = await (sub as any).executeToolForChild("edit_x", {}, tools, undefined, "tu-1");
    expect(r.content).toContain("[Hook 反馈]\nspawn lint 红");
  });

  test("spawn：工具抛异常时反馈回灌", async () => {
    const sys = sysWith("PostToolUseFailure", "echo '异常反馈' >&2; exit 2");
    const tools = registry([
      makeTool("boom", async () => {
        throw new Error("炸了");
      }),
    ]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    const r = await (sub as any).executeToolForChild("boom", {}, tools, undefined, "tu-1");
    expect(r.content).toContain("[Hook 反馈]\n异常反馈");
  });
});

// ── 2. 工具事件带 agent_id / agent_type（HC23） ─────────────

describe("2. 子代理内工具事件 stdin 带 agent_id / agent_type，主循环不带", () => {
  test("进程内：Pre / Post 在子代理作用域里带两个字段", async () => {
    const sys = sysWith();
    const pre = probe(sys, HookEventName.PreToolUse);
    const post = probe(sys, HookEventName.PostToolUse);
    const tools = registry([makeTool("echo_x", async () => ({ output: "ok" }))]);
    await runWithHookAgent({ agent: AGENT }, () =>
      executeTools([use("t1", "echo_x")], tools, undefined, sys, allowAll),
    );
    expect(pre[0]).toMatchObject({ ...AGENT, tool_use_id: "t1" });
    expect(post[0]).toMatchObject({ ...AGENT, tool_use_id: "t1" });
  });

  test("进程内：Failure / PermissionDenied 也带", async () => {
    const sys = sysWith();
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const denied = probe(sys, HookEventName.PermissionDenied);
    const tools = registry([
      makeTool("bad", async () => ({ output: "x", isError: true })),
      makeTool("nope", async () => ({ output: "x" })),
    ]);
    await runWithHookAgent({ agent: AGENT }, async () => {
      await executeTools([use("t1", "bad")], tools, undefined, sys, allowAll);
      await executeTools([use("t2", "nope")], tools, undefined, sys, denyAll);
    });
    await settle();
    expect(fail[0]).toMatchObject(AGENT);
    expect(denied[0]).toMatchObject({ ...AGENT, tool_use_id: "t2" });
  });

  test("主循环（无作用域）：输入里根本没有 agent_id 键（runner 按 `in` 设环境变量）", async () => {
    const sys = sysWith();
    const pre = probe(sys, HookEventName.PreToolUse);
    const tools = registry([makeTool("echo_x", async () => ({ output: "ok" }))]);
    await executeTools([use("t1", "echo_x")], tools, undefined, sys, allowAll);
    expect("agent_id" in pre[0]).toBe(false);
    expect("agent_type" in pre[0]).toBe(false);
  });

  test("spawn：executeToolForChild 的 Pre / Post 带两个字段", async () => {
    const sys = sysWith();
    const pre = probe(sys, HookEventName.PreToolUse);
    const post = probe(sys, HookEventName.PostToolUse);
    const tools = registry([makeTool("echo_x", async () => ({ output: "ok" }))]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    await runWithHookAgent({ agent: AGENT }, () =>
      (sub as any).executeToolForChild("echo_x", {}, tools, undefined, "tu-9"),
    );
    expect(pre[0]).toMatchObject({ ...AGENT, tool_use_id: "tu-9" });
    expect(post[0]).toMatchObject({ ...AGENT, tool_use_id: "tu-9" });
  });
});

// ── 3. is_interrupt 按真实中断 ────────────────────────────

describe("3. 子代理异常路径 PostToolUseFailure 的 is_interrupt 按真实 abort 传值", () => {
  function abortingTool() {
    return makeTool("slow", async (_i, signal) => {
      // 工具以普通 Error 收尾（不是 AbortError）——只看异常名会漏判
      if (signal?.aborted) throw new Error("子进程被终止");
      return { output: "ok" };
    });
  }

  test("进程内：signal 已 abort → is_interrupt=true", async () => {
    const sys = sysWith();
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const ctrl = new AbortController();
    ctrl.abort("user-cancel");
    const tools = registry([abortingTool()]);
    await executeTools([use("t1", "slow")], tools, ctrl.signal, sys, allowAll);
    expect(fail[0]).toMatchObject({ is_interrupt: true, sid_failure_kind: "exception" });
  });

  test("进程内：普通异常 → is_interrupt=false", async () => {
    const sys = sysWith();
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const tools = registry([
      makeTool("boom", async () => {
        throw new Error("炸了");
      }),
    ]);
    await executeTools([use("t1", "boom")], tools, undefined, sys, allowAll);
    expect(fail[0].is_interrupt).toBe(false);
  });

  test("spawn：signal 已 abort → is_interrupt=true", async () => {
    const sys = sysWith();
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const ctrl = new AbortController();
    ctrl.abort("user-cancel");
    const tools = registry([abortingTool()]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    await (sub as any).executeToolForChild("slow", {}, tools, ctrl.signal, "tu-1");
    expect(fail[0]).toMatchObject({ is_interrupt: true, tool_use_id: "tu-1" });
  });
});

// ── 4. spawn PermissionDenied 带 tool_use_id ─────────────

describe("4. spawn 路径 PermissionDenied 带 tool_use_id", () => {
  test("被拒工具的 PermissionDenied 载荷含 tool_use_id（runtime 消费者据此关 span）", async () => {
    const sys = sysWith();
    const denied = probe(sys, HookEventName.PermissionDenied);
    const tools = registry([makeTool("nope", async () => ({ output: "x" }))]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    sub.setPermissionChecker(denyAll);
    const r = await (sub as any).executeToolForChild("nope", {}, tools, undefined, "tu-deny");
    await settle();
    expect(r.is_error).toBe(true);
    expect(denied[0]).toMatchObject({
      tool_use_id: "tu-deny",
      tool_name: "nope",
      denial_source: "rule",
    });
  });
});

// ── 5. CwdChanged / TaskCreated / TaskCompleted（HC24） ─────

describe("5. 子代理两条路径同样触发 CwdChanged / TaskCreated / TaskCompleted", () => {
  let savedCwd: string;
  beforeEach(() => {
    savedCwd = getCwd();
  });
  afterEach(() => setCwd(savedCwd));

  const taskTools = () => [
    makeTool("task_create", async () => ({
      output: JSON.stringify({ id: "7", subject: "写测试" }),
    })),
    makeTool("task_update", async () => ({
      output: JSON.stringify({ id: "7", subject: "写测试", status: "completed" }),
    })),
    makeTool("cd_x", async () => {
      setCwd(tmpdir());
      return { output: "" };
    }),
  ];

  test("进程内：三个事件都 fire，且带 agent 字段", async () => {
    const sys = sysWith();
    const created = probe(sys, HookEventName.TaskCreated);
    const completed = probe(sys, HookEventName.TaskCompleted);
    const cwd = probe(sys, HookEventName.CwdChanged);
    const tools = registry(taskTools());
    await runWithHookAgent({ agent: AGENT }, async () => {
      await executeTools(
        [use("a", "task_create", { description: "写测试" })],
        tools,
        undefined,
        sys,
        allowAll,
      );
      await executeTools(
        [use("b", "task_update", { status: "completed" })],
        tools,
        undefined,
        sys,
        allowAll,
      );
      await executeTools([use("c", "cd_x")], tools, undefined, sys, allowAll);
    });
    await settle();
    expect(created[0]).toMatchObject({ task_id: "7", task_description: "写测试", ...AGENT });
    expect(completed[0]).toMatchObject({ task_id: "7", success: true, ...AGENT });
    expect(cwd[0]).toMatchObject({ old_cwd: savedCwd, new_cwd: tmpdir(), ...AGENT });
  });

  test("spawn：executeToolForChild 同样 fire TaskCreated", async () => {
    const sys = sysWith();
    const created = probe(sys, HookEventName.TaskCreated);
    const tools = registry(taskTools());
    const sub = new SubAgent({} as any, "m", tools, sys);
    await (sub as any).executeToolForChild(
      "task_create",
      { description: "写测试" },
      tools,
      undefined,
      "tu-1",
    );
    await settle();
    expect(created[0]).toMatchObject({ task_id: "7" });
  });
});

// ── 6. SubagentStop 的 CC 字段 ─────────────────────────────

class TextProvider implements Provider {
  name() {
    return "mock";
  }
  defaultModel() {
    return "mock-model";
  }
  async *sendMessageStream(_p: SendParams): AsyncIterable<StreamEvent> {
    yield {
      type: "message_start",
      message: { id: "m1", role: "assistant", usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "子代理最终答复" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 3 },
    } as StreamEvent;
  }
}

function fakeSpawnedProcess(messages: object[]) {
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      for (const m of messages) c.enqueue(enc.encode(JSON.stringify(m) + "\n"));
      c.close();
    },
  });
  let killed = false;
  return {
    stdin: { write: (d: Uint8Array) => d.length },
    stdout,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
    },
    exited: Promise.resolve(0),
    exitCode: 0,
  };
}

describe("6. SubagentStop 带 last_assistant_message / agent_transcript_path", () => {
  let testDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-sub-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    for (const k of ["HOME", "SID_CONFIG_DIR", "SIDCODE_NO_SPAWN"]) saved[k] = process.env[k];
    // 落盘隔离（CONTRIBUTING 测试约定）：sidechain 写在 sessions/ 下，必须重定向到 tmpdir
    process.env.HOME = testDir;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  test("进程内 execute：最后一条 assistant 文本 + 真实存在的 sidechain 路径", async () => {
    process.env.SIDCODE_NO_SPAWN = "1";
    const sys = sysWith();
    const stop = probe(sys, HookEventName.SubagentStop);
    const sub = new SubAgent(new TextProvider(), "mock-model", new Registry(), sys);
    sub.setParentSessionId("S-PARENT-STOP");
    const r = await sub.execute({ type: "explore", description: "d", prompt: "p" });
    await settle();
    expect(r.success).toBe(true);
    expect(stop[0].last_assistant_message).toBe("子代理最终答复");
    const p = stop[0].agent_transcript_path as string;
    expect(p).toContain("S-PARENT-STOP-");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8")).toContain("sidechain_start");
  });

  test("进程内 executeCustom：同样带两个字段", async () => {
    process.env.SIDCODE_NO_SPAWN = "1";
    const sys = sysWith();
    const stop = probe(sys, HookEventName.SubagentStop);
    const sub = new SubAgent(new TextProvider(), "mock-model", new Registry(), sys);
    sub.setParentSessionId("S-PARENT-STOP");
    await sub.executeCustom({
      systemPrompt: "s",
      userPrompt: "u",
      allowedTools: [],
      type: "my-skill",
    });
    await settle();
    expect(stop[0].last_assistant_message).toBe("子代理最终答复");
    expect(existsSync(stop[0].agent_transcript_path)).toBe(true);
  });

  test("spawn execute：取子进程 result.output，路径同样可读", async () => {
    delete process.env.SIDCODE_NO_SPAWN;
    const sys = sysWith();
    const stop = probe(sys, HookEventName.SubagentStop);
    const sub = new SubAgent(new TextProvider(), "mock-model", new Registry(), sys);
    (sub as any).spawnConfig = { providerName: "anthropic", apiKey: "k" };
    sub.setParentSessionId("S-PARENT-STOP");
    const proc = fakeSpawnedProcess([
      {
        type: "result",
        success: true,
        output: "spawn 最终答复",
        usage: { inputTokens: 1, outputTokens: 1 },
        turns: 1,
        toolUseCount: 0,
      },
    ]);
    const original = Bun.spawn;
    (Bun as any).spawn = () => proc;
    try {
      await sub.execute({ type: "explore", description: "d", prompt: "p" });
    } finally {
      (Bun as any).spawn = original;
    }
    await settle();
    expect(stop[0].last_assistant_message).toBe("spawn 最终答复");
    expect(existsSync(stop[0].agent_transcript_path)).toBe(true);
  });

  test("无父会话 id（sidechain 未启用）：不报一个不存在的路径", async () => {
    process.env.SIDCODE_NO_SPAWN = "1";
    const sys = sysWith();
    const stop = probe(sys, HookEventName.SubagentStop);
    const sub = new SubAgent(new TextProvider(), "mock-model", new Registry(), sys);
    await sub.execute({ type: "explore", description: "d", prompt: "p" });
    await settle();
    expect(stop[0].last_assistant_message).toBe("子代理最终答复");
    expect("agent_transcript_path" in stop[0]).toBe(false);
  });
});

// ── 7. spawn PreToolUse 阻止补 Failure 收尾 ────────────────

describe("7. spawn 路径 PreToolUse 被 block 时补 hook_blocked 的 Failure 收尾", () => {
  test("runtime 消费者收到 sid_failure_kind=hook_blocked、带 tool_use_id（span 能关）", async () => {
    const sys = sysWith("PreToolUse", "echo '不许跑' >&2; exit 2");
    const fail = probe(sys, HookEventName.PostToolUseFailure);
    const tools = registry([makeTool("echo_x", async () => ({ output: "ok" }))]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    const r = await (sub as any).executeToolForChild("echo_x", {}, tools, undefined, "tu-b");
    await settle();
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("Hook 阻止执行");
    expect(fail.length).toBe(1);
    expect(fail[0]).toMatchObject({ sid_failure_kind: "hook_blocked", tool_use_id: "tu-b" });
  });

  test("用户 hook 看不到 hook_blocked 的 Failure（CC 语义：PreToolUse 拦截不触发 Failure）", async () => {
    const marker = join(tmpdir(), `sid-hb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo no >&2; exit 2" }] }],
          PostToolUseFailure: [{ hooks: [{ type: "command", command: `touch '${marker}'` }] }],
        },
        source: ConfigSource.User,
      },
    ]);
    const tools = registry([makeTool("echo_x", async () => ({ output: "ok" }))]);
    const sub = new SubAgent({} as any, "m", tools, sys);
    await (sub as any).executeToolForChild("echo_x", {}, tools, undefined, "tu-b");
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
  });
});
