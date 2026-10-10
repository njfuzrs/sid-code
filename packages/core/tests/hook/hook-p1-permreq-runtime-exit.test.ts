/**
 * Hook 决策语义 P1 回归：H2 / H3 / H6 / H7 / H14 / H16。
 *
 * 与 P0 那份一样，每条同时断言正反两面：只断言修好的那一面，反向改错（如把 OR 改成 AND、
 * 把 stderr 的告警通道一起删掉）也会判绿。
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { HookAggregator } from "@sid-code/core/hook/aggregator.ts";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookPlanner } from "@sid-code/core/hook/planner.ts";
import { HookEventHandler } from "@sid-code/core/hook/event-handler.ts";
import { HookEventName, PreToolUseHookOutput, type HookOutput } from "@sid-code/core/hook/types.ts";

const agg = new HookAggregator();
function aggregate(eventName: HookEventName, outputs: HookOutput[]) {
  return agg.aggregateResults(
    outputs.map((output, i) => ({
      hookConfig: { type: "command" as const, command: `h${i}` },
      eventName,
      success: true,
      output,
      duration: 1,
    })),
    eventName,
  ).finalOutput!;
}

// ─── H2 / H3 ────────────────────────────────────────────────────────────

describe("H2/H3 PermissionRequest 一票否决且认 permissionDecision", () => {
  const PR = HookEventName.PermissionRequest;

  test("H2：deny + allow 两个顺序都阻塞，reason 保留拒绝者的理由", () => {
    const outs: HookOutput[] = [
      { decision: "deny", reason: "hookA拒绝" },
      { decision: "allow", reason: "hookB放行" },
    ];
    for (const order of [outs, [...outs].reverse()]) {
      const out = aggregate(PR, order);
      expect(out.isBlockingDecision()).toBe(true);
      expect(out.decision).toBe("deny");
      expect(out.getEffectiveReason()).toContain("hookA拒绝");
    }
  });

  test("H2 反面：全是 allow / 没意见时不阻塞（别把 OR 改成「有输出就拦」）", () => {
    expect(aggregate(PR, [{ decision: "allow" }, {}]).isBlockingDecision()).toBe(false);
    expect(aggregate(PR, [{ systemMessage: "审计" }]).isBlockingDecision()).toBe(false);
  });

  test("H3：只写 permissionDecision:deny 也阻塞，且最终结论是 PreToolUse 同一个子类", () => {
    const out = aggregate(PR, [{ hookSpecificOutput: { permissionDecision: "deny" } }]);
    expect(out).toBeInstanceOf(PreToolUseHookOutput);
    expect(out.isBlockingDecision()).toBe(true);
  });

  test("H3：permissionDecision deny 在前、allow 在后，两个顺序都阻塞", () => {
    const outs: HookOutput[] = [
      { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "不许" } },
      { hookSpecificOutput: { permissionDecision: "allow" } },
    ];
    for (const order of [outs, [...outs].reverse()]) {
      const out = aggregate(PR, order) as PreToolUseHookOutput;
      expect(out.isBlockingDecision()).toBe(true);
      expect(out.getPermissionDecision()).toBe("deny");
    }
  });

  test("H2.5 交叉不变量：PermissionRequest 与 PreToolUse 在同样输入下结论相同", () => {
    const cases: HookOutput[][] = [
      [{ decision: "deny" }, { decision: "allow" }],
      [{ decision: "allow" }, { decision: "deny" }],
      [{ hookSpecificOutput: { permissionDecision: "deny" } }, { decision: "allow" }],
      [{ hookSpecificOutput: { permissionDecision: "allow" } }],
      [{ decision: "allow" }],
      [{}],
    ];
    for (const outs of cases) {
      const a = aggregate(PR, outs);
      const b = aggregate(HookEventName.PreToolUse, outs);
      expect(a.isBlockingDecision()).toBe(b.isBlockingDecision());
      expect(a.decision).toBe(b.decision);
    }
  });

  test("结构性：aggregator 不再自带一份事件→子类映射（只能复用 createHookOutput）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/hook/aggregator.ts"), "utf-8");
    // 两份映射各自维护正是 H3 的成因：PermissionRequest 在两处同时漏掉
    expect(src).not.toMatch(/new\s+\w+HookOutput\(/);
  });
});

// ─── H6 / H7 ────────────────────────────────────────────────────────────

function mkHandler() {
  const reg = new HookRegistry();
  const h = new HookEventHandler(
    new HookPlanner(reg),
    new HookRunner(),
    new HookAggregator(),
    "s",
    process.cwd(),
    reg,
  );
  return { reg, h };
}

describe("H6/H7 runtime hook 与其他类型走同一条执行管线", () => {
  const denyGuard = {
    type: "runtime",
    name: "guard",
    action: async () => ({ decision: "deny", reason: "runtime 守卫拒绝" }),
  } as any;

  test("H6：仅 runtime hook 时 deny 也能传达", async () => {
    const { reg, h } = mkHandler();
    reg.registerHook(denyGuard, HookEventName.PreToolUse);
    const r = await h.firePreToolUseEvent("bash", { command: "rm -rf /" }, "t1");
    expect(r.finalOutput?.isBlockingDecision()).toBe(true);
    expect(r.finalOutput?.getEffectiveReason()).toContain("runtime 守卫拒绝");
  });

  test("H6 交叉不变量：纯 runtime 与 runtime+command 混合，结论相同", async () => {
    const pure = mkHandler();
    pure.reg.registerHook(denyGuard, HookEventName.PreToolUse);
    const mixed = mkHandler();
    mixed.reg.registerHook(denyGuard, HookEventName.PreToolUse);
    mixed.reg.registerHook(
      { type: "command", name: "noop", command: "true" } as any,
      HookEventName.PreToolUse,
    );
    const a = await pure.h.firePreToolUseEvent("bash", { command: "x" }, "t2");
    const b = await mixed.h.firePreToolUseEvent("bash", { command: "x" }, "t3");
    expect(a.finalOutput?.isBlockingDecision()).toBe(true);
    expect(a.finalOutput?.isBlockingDecision()).toBe(b.finalOutput?.isBlockingDecision());
    expect(a.finalOutput?.decision).toBe(b.finalOutput?.decision);
  });

  test("H6 反面：返回 void 的 runtime hook 不产生阻塞", async () => {
    const { reg, h } = mkHandler();
    reg.registerHook(
      { type: "runtime", name: "probe", action: async () => undefined } as any,
      HookEventName.PreToolUse,
    );
    const r = await h.firePreToolUseEvent("bash", { command: "ls" }, "t4");
    expect(r.finalOutput?.isBlockingDecision() ?? false).toBe(false);
    expect(r.success).toBe(true);
  });

  test("H7：timeout 生效（实际阻塞 < 200ms），action 收到已 abort 的 signal", async () => {
    const { reg, h } = mkHandler();
    let signal: AbortSignal | undefined;
    reg.registerHook(
      {
        type: "runtime",
        name: "slow",
        timeoutMs: 50, // H10：runtime 的 timeout 已统一为秒，亚秒级走 timeoutMs
        action: async (_input: unknown, opts?: { signal: AbortSignal }) => {
          signal = opts?.signal;
          await new Promise((r) => setTimeout(r, 600));
        },
      } as any,
      HookEventName.PostToolUse,
    );
    const t0 = Date.now();
    const r = await h.firePostToolUseEvent("bash", {}, {}, false, "t5");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
    // 超时记成失败而不是静默成功
    expect(r.success).toBe(false);
  });

  test("H7 附带（H8 同源）：第一个 runtime hook 抛异常，第二个仍执行", async () => {
    const { reg, h } = mkHandler();
    let secondRan = false;
    reg.registerHook(
      {
        type: "runtime",
        name: "boom",
        action: async () => {
          throw new Error("boom");
        },
      } as any,
      HookEventName.PostToolUse,
    );
    reg.registerHook(
      {
        type: "runtime",
        name: "after",
        action: async () => {
          secondRan = true;
        },
      } as any,
      HookEventName.PostToolUse,
    );
    await h.firePostToolUseEvent("bash", {}, {}, false, "t6");
    expect(secondRan).toBe(true);
  });

  test("结构性：event-handler 里不再直接调 config.action", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/hook/event-handler.ts"), "utf-8");
    expect(src).not.toMatch(/\.action\(/);
  });
});

// ─── H14 ────────────────────────────────────────────────────────────────

describe("H14 cwd 不再被拼进 shell 命令串", () => {
  const root = mkdtempSync(join(tmpdir(), "sid-h14-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const runner = new HookRunner();

  const runIn = async (dirName: string, command: string) => {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    // HC14：SID_CODE_PROJECT_DIR 改取会话启动时的项目根（不再是 input.cwd）。注入面没变——
    // 项目根同样可能是一个带 $(...) 的目录名——所以把项目根也设成这个目录，断言照旧有效。
    runner.setProjectDir(dir);
    const r = await runner.executeHook(
      { type: "command", name: "x", command } as any,
      HookEventName.PostToolUse,
      { session_id: "s", cwd: dir, hook_event_name: "PostToolUse", timestamp: "" } as any,
    );
    return { dir, r };
  };

  test("目录名含 $(...)：不执行，且 hook 拿到的是完整原始路径", async () => {
    const pwned = join(root, "PWNED");
    const { dir, r } = await runIn(`a$(touch ${pwned})b`, `printf '%s' "$SID_CODE_PROJECT_DIR"`);
    expect(existsSync(pwned)).toBe(false);
    // 「不注入」与「值正确」一起断言：只断言前者可以靠转义蒙过去，值仍可能错
    expect(r.output?.systemMessage).toBe(dir);
  });

  for (const name of ["a b", "a;touch PWNED2", "a`touch PWNED3`b", "a && touch PWNED4"]) {
    test(`目录名含特殊字符 ${JSON.stringify(name)}：值原样、无副作用`, async () => {
      const { dir, r } = await runIn(name, `printf '%s' "$SID_CODE_PROJECT_DIR"`);
      expect(r.output?.systemMessage).toBe(dir);
      for (const f of ["PWNED2", "PWNED3", "PWNED4"]) {
        expect(existsSync(join(dir, f))).toBe(false);
      }
    });
  }

  test("兼容：$SID_CODE_CWD 写法照常可用（改由环境变量提供）", async () => {
    const { dir, r } = await runIn("cwd-compat", `printf '%s' "$SID_CODE_CWD"`);
    expect(r.output?.systemMessage).toBe(dir);
  });

  test("结构性：runner 里 expandCommand 已删除", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/hook/runner.ts"), "utf-8");
    expect(src).not.toContain("expandCommand");
  });
});

// ─── H16 ────────────────────────────────────────────────────────────────

describe("H16 stderr 从不当 JSON 解析", () => {
  const runner = new HookRunner();
  const input = {
    session_id: "s",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    timestamp: "",
    tool_name: "bash",
    tool_input: { command: "ls" },
  } as any;
  const run = async (command: string) => {
    const r = await runner.executeHook(
      { type: "command", name: "h", command } as any,
      HookEventName.PreToolUse,
      input,
    );
    return agg.aggregateResults([r], HookEventName.PreToolUse).finalOutput!;
  };

  test("exit 0 + stderr 恰好是 deny JSON ⇒ 不阻塞", async () => {
    const out = await run(`echo '{"decision":"deny","reason":"这不是我的意图"}' >&2; exit 0`);
    expect(out.isBlockingDecision()).toBe(false);
  });

  test("exit 1 + stderr 是 JSON ⇒ 仍是非阻塞告警，stderr 文本照常展示", async () => {
    const out = await run(`echo '{"decision":"deny"}' >&2; exit 1`);
    expect(out.isBlockingDecision()).toBe(false);
    expect(out.systemMessage).toContain("hook error");
  });

  test("反面：stdout 的 deny JSON 照常生效（别把 JSON 通道整个关掉）", async () => {
    const out = await run(`echo '{"decision":"deny","reason":"stdout 拒"}'; exit 0`);
    expect(out.isBlockingDecision()).toBe(true);
  });

  test("反面：exit 2 + stderr 是 JSON ⇒ 仍阻塞，stderr 原文作理由（H15 不回退）", async () => {
    const out = await run(`echo '{"reason":"x"}' >&2; exit 2`);
    expect(out.isBlockingDecision()).toBe(true);
    expect(out.getEffectiveReason()).toContain('{"reason":"x"}');
  });
});
