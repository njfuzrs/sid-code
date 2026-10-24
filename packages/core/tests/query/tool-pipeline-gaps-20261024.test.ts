/**
 * 工具执行管线缺口（2026-10-24 审计 + 本机轨迹扫描）的回归门禁。
 *
 * 每组用例对应一个经源码或数据确认的缺陷，断言的都是**外部可观察结果**（模型收到的
 * tool_result、hook 收到的事件、漏斗埋点、快照对象），不断言实现细节：
 *
 *   1. 并行批次 Bash 失败级联取消兄弟 → 兄弟原先拿到「工具执行异常: undefined」（实测复现）
 *   2. 串行级联跳过 / 中断时未启动的工具 → PreToolUse 没有 Post* 收尾（轨迹 7/23,654 悬空）
 *   3. 工具执行中被 abort 后自己返回 isError → 原先记 tool_error（遥测 aborted 恒 0）
 *   4. 主循环 PreToolUse hook 阻止 → 原先不进漏斗 1（hook_blocked 恒 0）
 *   5. hook 改写 file_path → 快照 / PostToolUse 的 tool_input 原先仍用原路径
 *   6. hook 改写参数后 → 权限层看到的路径原先不展开（`~/` 绕过绝对路径 deny 规则）
 *   7. PostToolUse updatedToolOutput / updatedMCPToolOutput → 原先不生效，MCP 脱敏做不到
 *   8. resolveToolPermission 里 PreToolUse 抛异常 → 原先不写缓存，同一个 hook 再 fire 一次
 *
 * 落盘隔离：checkpoint 一律 enabled:false 或注入替身；analytics 只挂内存 sink。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import {
  executeTools,
  executeSingleTool,
  buildObservableInput,
  type ToolExecutorDeps,
} from "@sid-code/core/query/tool-executor.ts";
import { __resetAnalyticsForTest, attachAnalyticsSink } from "@sid-code/core/analytics/index.ts";
import { PreToolUseHookOutput, DefaultHookOutput } from "@sid-code/core/hook/types.ts";
import {
  abortReasonOf,
  describeAbortReason,
  errorMessageOf,
  isAbortError,
  SIBLING_BASH_ERROR_ABORT_REASON,
} from "@sid-code/core/llm/errors.ts";

// ─── 脚手架 ──────────────────────────────────────────────

type Exec = (input: any, signal?: AbortSignal) => Promise<{ output: string; isError?: boolean }>;

function makeTool(
  name: string,
  exec: Exec,
  opts: { concurrent?: boolean; backfill?: (i: any) => any } = {},
) {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => opts.concurrent ?? true,
    isConcurrencySafe: () => opts.concurrent ?? true,
    ...(opts.backfill ? { backfillObservableInput: opts.backfill } : {}),
    execute: exec,
  };
}

/** 收到 abort 后以 signal.reason 原样 reject——被取消的 fetch / SDK Promise 的真实形态 */
const rejectsOnAbort: Exec = (_i, signal) =>
  new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

interface Log {
  pre: string[];
  post: Array<{ id: string; input: any }>;
  failure: Array<{ id: string; kind?: string; interrupt?: boolean; input: any; error: string }>;
  denied: string[];
}

function makeDeps(
  tools: any[],
  log: Log,
  opts: {
    signal?: AbortSignal;
    preOutput?: (name: string, input: any) => any;
    preThrows?: boolean;
    postOutput?: (name: string) => any;
    checker?: (req: any) => { allowed: boolean; reason?: string };
    extra?: Partial<ToolExecutorDeps>;
  } = {},
): ToolExecutorDeps {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (n: string) => byName.get(n) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "pipeline-gaps",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async (name: string, input: any, id?: string) => {
        log.pre.push(id ?? name);
        if (opts.preThrows) throw new Error("hook 进程崩了");
        const out = opts.preOutput?.(name, input);
        return { finalOutput: out, success: true, allOutputs: [], errors: [], totalDuration: 0 };
      },
      firePostToolUseEvent: async (name: string, input: any, _r: any, _e: any, id?: string) => {
        log.post.push({ id: id ?? name, input });
        return {
          finalOutput: opts.postOutput?.(name),
          success: true,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
      },
      firePostToolUseFailureEvent: async (
        name: string,
        input: any,
        error: string,
        id?: string,
        o?: { failure_kind?: string; is_interrupt?: boolean },
      ) => {
        log.failure.push({
          id: id ?? name,
          kind: o?.failure_kind,
          interrupt: o?.is_interrupt,
          input,
          error,
        });
        return { finalOutput: undefined };
      },
      firePermissionDeniedEvent: async (name: string, _i: any, _r: any, _s: any, id?: string) => {
        log.denied.push(id ?? name);
        return { finalOutput: undefined };
      },
    } as any,
    permissionChecker: {
      check: async (req: any) => opts.checker?.(req) ?? { allowed: true },
      recordUserDenial: () => {},
    } as any,
    preToolUseCache: new Map(),
    getAbortSignal: () => opts.signal,
    requestUserConfirmation: async () => false,
    ...opts.extra,
  } as ToolExecutorDeps;
}

const use = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const emptyLog = (): Log => ({ pre: [], post: [], failure: [], denied: [] });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const resultOf = (results: any[], id: string) => results.find((r) => r.tool_use_id === id);

/** 每个 fire 过 Pre 的 id 都有且只有一个 Post* 收尾 */
function expectEveryPreClosed(log: Log) {
  const closed = [...log.post.map((p) => p.id), ...log.failure.map((f) => f.id), ...log.denied];
  for (const id of log.pre) {
    expect(
      closed.filter((c) => c === id).length,
      `PreToolUse(${id}) 应恰好收尾一次，实际 ${closed.filter((c) => c === id).length}`,
    ).toBe(1);
  }
}

let analytics: Array<{ name: string; meta: Record<string, any> }> = [];
beforeEach(() => {
  analytics = [];
  __resetAnalyticsForTest();
  attachAnalyticsSink({ logEvent: (name, meta) => analytics.push({ name, meta: meta as any }) });
});
afterEach(() => __resetAnalyticsForTest());
const failures = () => analytics.filter((e) => e.name === "tool_failure").map((e) => e.meta);

// ─── 1. 并行 Bash 级联取消 ─────────────────────────────────

describe("1. 并行批次 Bash 失败 → 兄弟得到级联取消文案，而不是「工具执行异常: undefined」", () => {
  test("在跑的兄弟（以裸字符串 reason reject）", async () => {
    const tools = [
      makeTool("bash", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { output: "exit 1", isError: true };
      }),
      makeTool("web_fetch", rejectsOnAbort),
    ];
    const log = emptyLog();
    const { results } = await executeTools(
      [use("b1", "bash", { command: "false" }), use("w1", "web_fetch")],
      makeDeps(tools, log),
    );
    await flush();

    const sib = resultOf(results, "w1");
    expect(sib.is_error).toBe(true);
    expect(String(sib.content)).not.toContain("undefined");
    expect(String(sib.content)).toContain("先行的 Bash");
    // 级联取消是中断，不是工具自身的异常
    expect(failures().find((f) => f.failure_kind === "exception")).toBeUndefined();
    expect(failures().some((f) => f.failure_kind === "aborted")).toBe(true);
    expectEveryPreClosed(log);
  });

  test("排队未启动的兄弟不再启动，且 PreToolUse 收尾为 skipped", async () => {
    // 默认并发上限 10（SID_TOOL_MAX_CONCURRENT 未设）：bash + 11 个 grep →
    // bash 与 g1..g9 同时启动，g10 / g11 在队列里。bash 立即失败、grep 慢，
    // 所以 bash 那个 worker 出队时级联已触发 —— g10 / g11 必然被跳过，时序确定。
    expect(process.env.SID_TOOL_MAX_CONCURRENT ?? "").toBe("");
    let started = 0;
    const tools = [
      makeTool("bash", async () => ({ output: "exit 2", isError: true })),
      makeTool("grep", async () => {
        started++;
        await new Promise((r) => setTimeout(r, 20));
        return { output: "hit" };
      }),
    ];
    const log = emptyLog();
    const blocks = [
      use("b1", "bash"),
      ...Array.from({ length: 11 }, (_, k) => use(`g${k + 1}`, "grep")),
    ];
    const { results } = await executeTools(blocks, makeDeps(tools, log));
    await flush();

    expect(started).toBe(9);
    for (const id of ["g10", "g11"]) {
      expect(String(resultOf(results, id).content)).toContain("先行的 Bash");
      expect(log.failure.find((f) => f.id === id)?.kind).toBe("skipped");
    }
    expectEveryPreClosed(log);
  });
});

// ─── 2. 未执行工具的 Pre 收尾 ────────────────────────────────

describe("2. PreToolUse 已 fire 但工具没执行 → 必须收尾（kind=skipped，只为配对）", () => {
  test("串行 Bash 级联跳过（轨迹里 5 个悬空 Pre 的真实形态）", async () => {
    let ran = 0;
    const tools = [
      makeTool(
        "bash",
        async (i) => {
          ran++;
          return i.command === "make" ? { output: "exit 2", isError: true } : { output: "ok" };
        },
        { concurrent: false },
      ),
    ];
    const log = emptyLog();
    const { results } = await executeTools(
      [use("b1", "bash", { command: "make" }), use("b2", "bash", { command: "ls bin" })],
      makeDeps(tools, log),
    );
    await flush();

    expect(ran).toBe(1);
    expect(String(resultOf(results, "b2").content)).toContain("同一轮中先行的 Bash");
    const skipped = log.failure.find((f) => f.id === "b2");
    expect(skipped?.kind).toBe("skipped");
    expectEveryPreClosed(log);
  });

  test("用户中断：已执行的工具抛中断错误，后续批次未启动的工具也要收尾", async () => {
    const ctrl = new AbortController();
    const tools = [
      makeTool(
        "edit",
        async (_i, signal) => {
          ctrl.abort("user-cancel");
          throw signal?.reason ?? "user-cancel";
        },
        { concurrent: false },
      ),
      makeTool("write", async () => ({ output: "written" }), { concurrent: false }),
    ];
    const log = emptyLog();
    let thrown: unknown;
    try {
      await executeTools(
        [use("e1", "edit", { file_path: "/tmp/a" }), use("w1", "write", { file_path: "/tmp/b" })],
        makeDeps(tools, log, { signal: ctrl.signal }),
      );
    } catch (e) {
      thrown = e;
    }
    await flush();

    expect(isAbortError(thrown)).toBe(true);
    expect(log.failure.find((f) => f.id === "e1")?.kind).toBe("aborted");
    expect(log.failure.find((f) => f.id === "w1")?.kind).toBe("skipped");
    expectEveryPreClosed(log);
  });
});

// ─── 3. 中断分型 ─────────────────────────────────────────

describe("3. 工具执行中被 abort 后自己返回 isError → 分型 aborted，不是 tool_error", () => {
  test("bash 式收尾：signal 已 abort + isError（用户 ESC 的常态）", async () => {
    const ctrl = new AbortController();
    const tool = makeTool("bash", async () => {
      ctrl.abort("user-cancel");
      return { output: "命令已取消并终止（用户取消）", isError: true };
    });
    const log = emptyLog();
    await executeSingleTool(use("b1", "bash"), tool as any, makeDeps([tool], log), ctrl.signal);
    await flush();

    const f = log.failure.find((x) => x.id === "b1");
    expect(f?.kind).toBe("aborted");
    expect(f?.interrupt).toBe(true);
    expect(failures().map((x) => x.failure_kind)).toEqual(["aborted"]);
  });

  test("反向：没有 abort 的 isError 仍是 tool_error（真失败不能被一起关掉）", async () => {
    const tool = makeTool("bash", async () => ({ output: "exit 1", isError: true }));
    const log = emptyLog();
    await executeSingleTool(use("b1", "bash"), tool as any, makeDeps([tool], log));
    await flush();

    expect(log.failure.find((x) => x.id === "b1")?.kind).toBe("tool_error");
    expect(failures().map((x) => x.failure_kind)).toEqual(["tool_error"]);
  });
});

// ─── 4. 主循环 hook 阻止进漏斗 ─────────────────────────────

describe("4. 主循环 PreToolUse hook 阻止 → 漏斗 1 记 call + hook_blocked", () => {
  test("走真实主循环路径（resolveToolPermission 先 fire 并命中缓存）", async () => {
    const tool = makeTool("write", async () => ({ output: "不该执行" }));
    const log = emptyLog();
    const { results } = await executeTools(
      [use("w1", "write", { file_path: "/tmp/x" })],
      makeDeps([tool], log, {
        preOutput: () => new PreToolUseHookOutput({ decision: "block", reason: "策略禁止" }),
      }),
    );
    await flush();

    expect(String(resultOf(results, "w1").content)).toContain("Hook 阻止执行");
    expect(analytics.filter((e) => e.name === "tool_call")).toHaveLength(1);
    expect(failures().map((x) => x.failure_kind)).toEqual(["hook_blocked"]);
    expectEveryPreClosed(log);
  });
});

// ─── 5. hook 改写路径后，执行后的消费方跟着改写值走 ────────────

describe("5. hook 改写 file_path → 快照与 PostToolUse 的 tool_input 都用改写后的路径", () => {
  // 真实 CheckpointManager：快照目录落在 preload 设的临时 SID_CONFIG_DIR 下，不碰 ~/.sid-code。
  // 被快照的文件放进本用例自己的临时目录，跑完删除。
  let dir: string;
  let modelPath: string;
  let realPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-pipeline-snap-"));
    modelPath = join(dir, "model.ts");
    realPath = join(dir, "real.ts");
    writeFileSync(modelPath, "model");
    writeFileSync(realPath, "real");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const snapDeps = (
    log: Log,
    snapshotted: string[][],
    extra: Parameters<typeof makeDeps>[2] = {},
  ) =>
    makeDeps([makeTool("write", async () => ({ output: "ok" }), { concurrent: false })], log, {
      ...extra,
      extra: {
        config: { checkpoint: { enabled: true } } as any,
        checkpointSessionId: `pipeline-gaps-${Date.now()}`,
        recordFileChanges: (files: string[]) => snapshotted.push(files),
      },
    });

  test("快照对象 = 实际写入对象", async () => {
    const snapshotted: string[][] = [];
    const log = emptyLog();
    const deps = snapDeps(log, snapshotted, {
      preOutput: () =>
        new PreToolUseHookOutput({
          hookSpecificOutput: { updatedInput: { file_path: realPath, content: "x" } },
        }),
    });
    await executeTools([use("w1", "write", { file_path: modelPath, content: "x" })], deps);
    await flush();

    expect(snapshotted).toEqual([[realPath]]);
    expect(log.post.find((p) => p.id === "w1")?.input.file_path).toBe(realPath);
  });

  test("被权限拒绝的写操作不建快照", async () => {
    const snapshotted: string[][] = [];
    const deps = snapDeps(emptyLog(), snapshotted, {
      checker: () => ({ allowed: false, reason: "deny" }),
    });
    await executeTools([use("w1", "write", { file_path: modelPath })], deps);
    expect(snapshotted).toEqual([]);
  });

  test("反向：没有 hook 改写时照常快照模型给的路径（挪位置不能把快照弄丢）", async () => {
    const snapshotted: string[][] = [];
    await executeTools(
      [use("w1", "write", { file_path: modelPath })],
      snapDeps(emptyLog(), snapshotted),
    );
    expect(snapshotted).toEqual([[modelPath]]);
  });
});

// ─── 6. 改写参数也要过观测回填 ─────────────────────────────

describe("6. hook 改写参数 → 权限层看到的是展开后的路径", () => {
  test("改写成 `~/` 路径，权限层收到绝对路径", async () => {
    const seen: any[] = [];
    const tool = makeTool("read", async () => ({ output: "ok" }), {
      backfill: (i: any) =>
        typeof i?.file_path === "string" && i.file_path.startsWith("~/")
          ? { ...i, file_path: "/home/u/" + i.file_path.slice(2) }
          : undefined,
    });
    await executeTools(
      [use("r1", "read", { file_path: "/tmp/ok.txt" })],
      makeDeps([tool], emptyLog(), {
        preOutput: () =>
          new PreToolUseHookOutput({
            hookSpecificOutput: { updatedInput: { file_path: "~/.ssh/id_rsa" } },
          }),
        checker: (req) => {
          seen.push(req.input);
          return { allowed: true };
        },
      }),
    );
    expect(seen[0].file_path).toBe("/home/u/.ssh/id_rsa");
  });

  test("buildObservableInput：无回填钩子 / 钩子抛错都原样返回", () => {
    const plain = makeTool("x", async () => ({ output: "" }));
    expect(buildObservableInput(plain as any, { a: 1 })).toEqual({ a: 1 });
    const broken = makeTool("x", async () => ({ output: "" }), {
      backfill: () => {
        throw new Error("boom");
      },
    });
    expect(buildObservableInput(broken as any, { a: 1 })).toEqual({ a: 1 });
  });
});

// ─── 7. PostToolUse 输出替换 ───────────────────────────────

describe("7. PostToolUse updatedToolOutput / updatedMCPToolOutput 替换模型侧输出", () => {
  const SECRET = "sk-live-0123456789abcdef";

  test("MCP 工具：updatedMCPToolOutput 生效，模型收不到原文", async () => {
    const tool = makeTool("mcp__vault__read", async () => ({ output: `token=${SECRET}` }));
    const { results } = await executeTools(
      [use("m1", "mcp__vault__read")],
      makeDeps([tool], emptyLog(), {
        postOutput: () =>
          new DefaultHookOutput({
            hookSpecificOutput: { updatedMCPToolOutput: "token=[redacted]" },
          }),
      }),
    );
    const c = String(resultOf(results, "m1").content);
    expect(c).toContain("[redacted]");
    expect(c).not.toContain(SECRET);
  });

  test("内置工具：只认 updatedToolOutput，updatedMCPToolOutput 不生效（对齐 CC）", async () => {
    const tool = makeTool("read", async () => ({ output: "原文" }));
    const mcpOnly = await executeTools(
      [use("r1", "read")],
      makeDeps([tool], emptyLog(), {
        postOutput: () =>
          new DefaultHookOutput({ hookSpecificOutput: { updatedMCPToolOutput: "改写" } }),
      }),
    );
    expect(String(resultOf(mcpOnly.results, "r1").content)).toBe("原文");

    const generic = await executeTools(
      [use("r2", "read")],
      makeDeps([tool], emptyLog(), {
        postOutput: () =>
          new DefaultHookOutput({ hookSpecificOutput: { updatedToolOutput: { ok: true } } }),
      }),
    );
    expect(String(resultOf(generic.results, "r2").content)).toBe('{"ok":true}');
  });
});

// ─── 8. PreToolUse 异常也要 fire-once ───────────────────────

describe("8. resolveToolPermission 里 PreToolUse 抛异常 → 不再二次 fire，批次不被炸穿", () => {
  test("同一个 tool_use_id 的 PreToolUse 只 fire 一次，工具照常执行", async () => {
    const tool = makeTool("read", async () => ({ output: "ok" }));
    const log = emptyLog();
    const { results } = await executeTools(
      [use("r1", "read")],
      makeDeps([tool], log, { preThrows: true }),
    );
    expect(log.pre).toEqual(["r1"]);
    expect(resultOf(results, "r1").content).toBe("ok");
  });
});

// ─── 工具函数 ───────────────────────────────────────────

describe("中断 reason 工具函数", () => {
  test("abortReasonOf：裸字符串 / .reason / 嵌套 reason / message", () => {
    expect(abortReasonOf("user-cancel")).toBe("user-cancel");
    expect(abortReasonOf({ reason: SIBLING_BASH_ERROR_ABORT_REASON })).toBe("sibling-bash-error");
    expect(abortReasonOf({ reason: { reason: "turn-timeout" } })).toBe("turn-timeout");
    expect(abortReasonOf(new Error("x"))).toBe("x");
    expect(abortReasonOf(undefined)).toBeUndefined();
  });

  test("sibling-bash-error 被识别为中断（原名未登记，isAbortError=false）", () => {
    expect(isAbortError(SIBLING_BASH_ERROR_ABORT_REASON)).toBe(true);
  });

  test("describeAbortReason 不把非用户成因说成「用户取消」", () => {
    expect(describeAbortReason("user-cancel")).toBe("用户取消");
    expect(describeAbortReason(SIBLING_BASH_ERROR_ABORT_REASON)).not.toContain("用户");
    expect(describeAbortReason("turn-timeout")).toContain("超时");
  });

  test("errorMessageOf：非 Error 抛出值不产出 undefined", () => {
    expect(errorMessageOf("sibling-bash-error")).toBe("sibling-bash-error");
    expect(errorMessageOf(new Error("boom"))).toBe("boom");
    expect(errorMessageOf(42)).toBe("42");
  });
});
