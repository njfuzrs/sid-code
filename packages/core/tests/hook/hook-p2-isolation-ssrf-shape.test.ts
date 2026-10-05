/**
 * Hook 子系统 P2 回归：H5 / H8 / H9 / H13 / H17 / H18 / H25 / H26 / H28。
 *
 * 与 P0/P1 两份一样，每条同时断言正反两面——只断言修好的那一面，反向改错
 * （脱敏改成白名单把 PATH 也滤掉、disableAllHooks 什么都不关、hook ask 一律压过会话记忆）也会判绿。
 */

import { describe, test, expect, afterAll, afterEach, spyOn } from "bun:test";

import { HookAggregator } from "@sid-code/core/hook/aggregator.ts";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookPlanner } from "@sid-code/core/hook/planner.ts";
import { HookEventHandler } from "@sid-code/core/hook/event-handler.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { AsyncHookRegistry } from "@sid-code/core/hook/async-registry.ts";
import { EnterprisePolicyGate } from "@sid-code/core/hook/enterprise-policy.ts";
import {
  HookEventName,
  ConfigSource,
  type HookExecutionResult,
} from "@sid-code/core/hook/types.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { setFlagSettings } from "@sid-code/core/config/settings/settings.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

const preInput = (cwd = process.cwd()) =>
  ({
    session_id: "s",
    cwd,
    hook_event_name: "PreToolUse",
    timestamp: "",
    tool_name: "bash",
    tool_input: { command: "ls" },
  }) as any;

function warnings<T>(fn: () => T | Promise<T>): Promise<{ v: T; msgs: string[] }> {
  const spy = spyOn(getLogger(), "warn");
  return Promise.resolve(fn()).then(
    (v) => {
      const msgs = spy.mock.calls.map((c) => String(c[1]));
      spy.mockRestore();
      return { v, msgs };
    },
    (e) => {
      spy.mockRestore();
      throw e;
    },
  );
}

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

// ─── H8 / H9 ────────────────────────────────────────────────────────────

describe("H8/H9 runtime hook 异常隔离、耗时进入统计", () => {
  test("H8：抛异常的 runtime hook 只记一条 error，同事件其余 hook 照跑且结论不受影响", async () => {
    const { reg, h } = mkHandler();
    let after = false;
    reg.registerHook(
      {
        type: "runtime",
        name: "boom",
        action: async () => {
          throw new Error("炸了");
        },
      } as any,
      HookEventName.PreToolUse,
    );
    reg.registerHook(
      {
        type: "runtime",
        name: "guard",
        action: async () => {
          after = true;
          return { decision: "deny", reason: "守卫拒绝" };
        },
      } as any,
      HookEventName.PreToolUse,
    );
    const r = await h.firePreToolUseEvent("bash", { command: "x" }, "t1");
    expect(after).toBe(true);
    expect(r.errors.map((e) => e.message)).toEqual(["炸了"]);
    // 后一个 hook 的 deny 没有被前一个的异常吞掉
    expect(r.finalOutput?.isBlockingDecision()).toBe(true);
  });

  test("H9：runtime hook 的耗时计入 totalDuration（原快速路径恒为 0）", async () => {
    const { reg, h } = mkHandler();
    reg.registerHook(
      {
        type: "runtime",
        name: "slow",
        action: async () => {
          await new Promise((r) => setTimeout(r, 40));
        },
      } as any,
      HookEventName.PostToolUse,
    );
    const r = await h.firePostToolUseEvent("bash", {}, { ok: true }, false, "t2");
    expect(r.totalDuration).toBeGreaterThanOrEqual(30);
  });
});

// ─── H13 ────────────────────────────────────────────────────────────────

describe("H13 环境变量脱敏：补漏网 key + 值形态兜底", () => {
  const planted: Record<string, string> = {
    OPENAI_SK: "sk-live-5abcdefgh",
    PRIVATE_KEY_PEM: "-----BEGIN-----",
    SESSION_COOKIE: "cookie6",
    ANTHROPIC_BASE_URL: "https://gw.internal",
    // key 名完全无害，只靠值形态命中——这条才证明防线不再依赖命名习惯
    FOO_H13: "sk-live-xxxxxxxxxxxx",
    BAR_H13: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    // 反面：形似但无害的名字不能被误伤
    KEYBOARD_LAYOUT_H13: "us",
    MONKEY_H13: "banana",
  };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(planted)) {
    saved[k] = process.env[k];
    process.env[k] = planted[k];
  }
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("漏网四类与值形态命中的变量在子进程里不可见，PATH/HOME 与无害名仍可见", async () => {
    const names = [...Object.keys(planted), "PATH", "HOME"];
    const cmd = names.map((n) => `echo "${n}=\${${n}:-<unset>}"`).join("; ");
    const r = await new HookRunner().executeHook(
      { type: "command", command: cmd },
      HookEventName.PreToolUse,
      preInput(),
    );
    const seen = Object.fromEntries(
      (r.stdout ?? "")
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    for (const k of [
      "OPENAI_SK",
      "PRIVATE_KEY_PEM",
      "SESSION_COOKIE",
      "ANTHROPIC_BASE_URL",
      "FOO_H13",
      "BAR_H13",
    ]) {
      expect(seen[k]).toBe("<unset>");
    }
    expect(seen["KEYBOARD_LAYOUT_H13"]).toBe("us");
    expect(seen["MONKEY_H13"]).toBe("banana");
    expect(seen["PATH"]).not.toBe("<unset>");
    expect(seen["HOME"]).not.toBe("<unset>");
  });
});

// ─── H17 ────────────────────────────────────────────────────────────────

describe("H17 hook JSON 输出形状校验", () => {
  const runner = new HookRunner();
  const run = (stdout: string, exit = 0) =>
    runner.executeHook(
      { type: "command", command: `printf '%s' '${stdout}'; exit ${exit}` },
      HookEventName.PreToolUse,
      preInput(),
    );

  test("JSON 数组不被当成 HookOutput，且打 warn", async () => {
    const { v, msgs } = await warnings(() => run("[1,2,3]"));
    expect(Array.isArray(v.output)).toBe(false);
    expect(msgs.some((m) => m.includes("JSON 数组"))).toBe(true);
  });

  test("拼错的字段被点名告警（顶层与 hookSpecificOutput 两层）", async () => {
    const a = await warnings(() => run('{"decission":"deny"}'));
    expect(a.msgs.some((m) => m.includes('"decission"'))).toBe(true);
    const b = await warnings(() => run('{"hookSpecificOutput":{"permission_decision":"deny"}}'));
    expect(b.msgs.some((m) => m.includes("hookSpecificOutput.permission_decision"))).toBe(true);
  });

  test("反面：合法输出零告警（含 CC 的 hookEventName），且仍被采纳", async () => {
    const { v, msgs } = await warnings(() =>
      run(
        '{"decision":"deny","reason":"r","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
      ),
    );
    expect(msgs.filter((m) => m.includes("形状可疑"))).toEqual([]);
    expect(v.output?.decision).toBe("deny");
  });

  test("反面：exit 2 + 数组 stdout 仍阻塞（H15 不被本条改坏）", async () => {
    const { v } = await warnings(() => run("[1,2,3]", 2));
    expect(v.output?.decision).toBe("deny");
  });
});

// ─── H18 ────────────────────────────────────────────────────────────────

describe("H18 async hook 挂在可阻塞事件上要告警，后台退出码照记", () => {
  test("PreToolUse 上的 async hook 注册时告警；PostToolUse 上不告警", async () => {
    const reg = new HookRegistry();
    const a = await warnings(() =>
      reg.registerHook(
        { type: "command", command: "exit 2", async: true },
        HookEventName.PreToolUse,
      ),
    );
    expect(a.msgs.some((m) => m.includes("async hook") && m.includes("不能阻塞"))).toBe(true);
    const b = await warnings(() =>
      reg.registerHook(
        { type: "command", command: "true", async: true },
        HookEventName.PostToolUse,
      ),
    );
    expect(b.msgs.filter((m) => m.includes("不能阻塞"))).toEqual([]);
  });

  test("settings 路径（initializeFromLegacy）同样告警", async () => {
    const reg = new HookRegistry();
    const { msgs } = await warnings(() =>
      reg.initializeFromLegacy({ PreToolUse: [{ command: "exit 2", async: true }] } as any),
    );
    expect(msgs.some((m) => m.includes("不能阻塞"))).toBe(true);
  });

  test("非 rewake 的后台 hook：真实退出码记下来，但不进回灌队列", async () => {
    const runner = new HookRunner();
    const ar = new AsyncHookRegistry();
    runner.setAsyncRegistry(ar);
    await runner.executeHook(
      { type: "command", command: "echo bad >&2; exit 2", async: true },
      HookEventName.PostToolUse,
      preInput(),
    );
    const deadline = Date.now() + 3000;
    let entry: any;
    while (Date.now() < deadline) {
      entry = (ar as any).pending && [...(ar as any).pending.values()][0];
      if (entry?.completed) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(entry?.completed).toBe(true);
    expect(entry.exitCode).toBe(2);
    expect((ar as any).rewakeQueue.length).toBe(0);
  });

  test("反面：asyncRewake 的 exit 2 仍进回灌队列", () => {
    const ar = new AsyncHookRegistry();
    const id = ar.register("h");
    ar.markCompleted(id, 2, "err", true);
    expect((ar as any).rewakeQueue.length).toBe(1);
  });
});

// ─── H5 ─────────────────────────────────────────────────────────────────

describe("H5 url hook 走 SSRF 防护（经用户配置的真实路径）", () => {
  test("指向云元数据 169.254.169.254 的 url hook 被拦，且有拦截记录", async () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({
      PreToolUse: [{ type: "url", url: "http://169.254.169.254/latest/meta-data/", timeout: 2 }],
    } as any);
    const { v, msgs } = await warnings(() =>
      sys.firePreToolUseEvent("bash", { command: "ls" }, "t"),
    );
    expect(v.errors.some((e) => e.message.includes("SSRF"))).toBe(true);
    expect(msgs.some((m) => m.includes("SSRF"))).toBe(true);
  });

  describe("本机端点", () => {
    let seenHeaders: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seenHeaders = Object.fromEntries(req.headers as any);
        return Response.json({ decision: "deny", reason: "本机审计服务拒绝" });
      },
    });
    afterAll(() => server.stop(true));
    const prev = process.env.H5_ALLOWED_TOKEN;
    process.env.H5_ALLOWED_TOKEN = "tok-allowed";
    process.env.H5_OTHER_SECRET_ISH = "should-not-leak";
    afterAll(() => {
      if (prev === undefined) delete process.env.H5_ALLOWED_TOKEN;
      else process.env.H5_ALLOWED_TOKEN = prev;
      delete process.env.H5_OTHER_SECRET_ISH;
    });

    test("反面：loopback 放行；headers 只插值 allowedEnvVars 白名单（经 settings 转换器）", async () => {
      const reg = new HookRegistry();
      reg.initializeFromLegacy({
        PreToolUse: [
          {
            type: "url",
            url: `http://127.0.0.1:${server.port}/hook`,
            headers: { "X-A": "Bearer $H5_ALLOWED_TOKEN", "X-B": "v=$H5_OTHER_SECRET_ISH" },
            allowedEnvVars: ["H5_ALLOWED_TOKEN"],
          },
        ],
      } as any);
      const h = new HookEventHandler(
        new HookPlanner(reg),
        new HookRunner(),
        new HookAggregator(),
        "s",
        process.cwd(),
        reg,
      );
      const r = await h.firePreToolUseEvent("bash", { command: "ls" }, "t");
      expect(r.errors).toEqual([]);
      expect(r.finalOutput?.isBlockingDecision()).toBe(true);
      expect(seenHeaders["x-a"]).toBe("Bearer tok-allowed");
      expect(seenHeaders["x-b"]).toBe("v=");
    });
  });
});

// ─── H25 ────────────────────────────────────────────────────────────────

describe("H25 会话记忆不吃掉 hook 的 ask 升级", () => {
  const mk = (over: any = {}) =>
    new PermissionChecker({
      permissionMode: "default",
      allowedTools: [],
      disallowedTools: [],
      allowedDirectories: [],
      blockedDirectories: [],
      skipPermissions: false,
      ...over,
    } as any);
  const req = { toolName: "read", input: { file_path: "/etc/hosts" }, description: "read" } as any;
  const interactive = (c: PermissionChecker) => {
    (c as any).isNonInteractive = () => false;
    return c;
  };

  test("记忆 allow + hook ask ⇒ 升级确认", async () => {
    const c = interactive(mk());
    c.rememberDecision(req, true);
    const d = await c.check(req, undefined, undefined, { hookPermissionDecision: "ask" });
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });

  test("反面：记忆 allow 无 hook 意见 ⇒ 照旧走记忆快速路径", async () => {
    const c = interactive(mk());
    c.rememberDecision(req, true);
    const d = await c.check(req);
    expect(d.allowed).toBe(true);
    expect(d.decisionReason?.type).toBe("sessionMemory");
  });

  test("反面：记忆 deny + hook allow ⇒ 仍拒绝（hook 不能越过用户明确拒绝）", async () => {
    const c = interactive(mk());
    c.rememberDecision(req, false);
    const d = await c.check(req, undefined, undefined, { hookPermissionDecision: "allow" });
    expect(d.allowed).toBe(false);
    expect(d.decisionReason?.type).toBe("sessionMemory");
  });

  test("反面：记忆 deny + hook ask ⇒ 仍拒绝（让路只对 allow 记忆，不把用户的拒绝降成确认）", async () => {
    const c = interactive(mk());
    c.rememberDecision(req, false);
    const d = await c.check(req, undefined, undefined, { hookPermissionDecision: "ask" });
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBeFalsy();
    expect(d.decisionReason?.type).toBe("sessionMemory");
  });

  test("反面：skipPermissions + hook ask ⇒ 仍放行（该 flag 的显式语义不动）", async () => {
    const d = await mk({ skipPermissions: true }).check(req, undefined, undefined, {
      hookPermissionDecision: "ask",
    });
    expect(d.allowed).toBe(true);
  });
});

// ─── H26 ────────────────────────────────────────────────────────────────

describe("H26 多个 hook 改参冲突要可见", () => {
  const agg = new HookAggregator();
  const res = (name: string, updatedInput?: Record<string, unknown>): HookExecutionResult => ({
    hookConfig: { type: "command", name, command: name },
    eventName: HookEventName.PreToolUse,
    success: true,
    output: updatedInput ? { hookSpecificOutput: { updatedInput } } : {},
    duration: 1,
  });

  test("两个 hook 改写成不同内容 ⇒ warn 点名双方与最终采纳者", async () => {
    const { msgs } = await warnings(() =>
      agg.aggregateResults(
        [
          res("hookA", { command: "rm -rf /tmp/x --dry-run" }),
          res("hookB", { command: "echo 别的" }),
        ],
        HookEventName.PreToolUse,
      ),
    );
    const m = msgs.find((x) => x.includes("同时改写了工具参数"));
    expect(m).toBeDefined();
    expect(m).toContain("hookA");
    expect(m).toContain("最终采纳 hookB");
  });

  test("反面：只有一个改写 / 两个改写相同 ⇒ 不告警", async () => {
    const a = await warnings(() =>
      agg.aggregateResults(
        [res("hookA", { command: "x" }), res("hookB")],
        HookEventName.PreToolUse,
      ),
    );
    const b = await warnings(() =>
      agg.aggregateResults(
        [res("hookA", { command: "x" }), res("hookB", { command: "x" })],
        HookEventName.PreToolUse,
      ),
    );
    expect([...a.msgs, ...b.msgs].filter((x) => x.includes("同时改写"))).toEqual([]);
  });
});

// ─── H28 ────────────────────────────────────────────────────────────────

describe("H28 disableAllHooks 不关内部可观测 runtime hook", () => {
  afterEach(() => setFlagSettings(null));

  const build = () => {
    const reg = new HookRegistry();
    reg.registerHook(
      { type: "runtime", name: "trace-collector", action: async () => {} } as any,
      HookEventName.PostToolUse,
    );
    reg.registerHook({ type: "command", command: "echo user" }, HookEventName.PostToolUse, {
      source: ConfigSource.User,
    });
    return reg;
  };
  const names = (reg: HookRegistry) =>
    reg.getHooksForEvent(HookEventName.PostToolUse).map((e) => e.config.type);

  test("企业策略 disableAllHooks ⇒ 用户 hook 屏蔽、内部 runtime hook 保留", () => {
    const reg = build();
    reg.setPolicyGate(new EnterprisePolicyGate({ disableAllHooks: true }));
    expect(names(reg)).toEqual(["runtime"]);
  });

  test("用户 settings disableAllHooks ⇒ 同上，且打一条说明影响范围的日志", () => {
    const reg = build();
    setFlagSettings({ disableAllHooks: true } as any);
    const spy = spyOn(getLogger(), "info");
    expect(names(reg)).toEqual(["runtime"]);
    const msg = spy.mock.calls
      .map((c) => String(c[1]))
      .find((m) => m.includes("disableAllHooks 已生效"));
    spy.mockRestore();
    expect(msg).toContain("屏蔽 1 个用户可配置 hook");
    expect(msg).toContain("保留 1 个内部 runtime hook");
  });

  test("反面：未开 disableAllHooks ⇒ 两个都在", () => {
    expect(names(build()).sort()).toEqual(["command", "runtime"]);
  });
});
