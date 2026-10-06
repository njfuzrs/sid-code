/**
 * Hook 子系统 P3 回归：H10 / H11 / H12 / H19 / H20 / H21 / H22 / H23 / H27。
 *
 * 与 P0–P2 同纪律：每条同时断言正反两面。只断言修好的那一面，反向改错
 * （maxHookTimeout 什么都拦、blockedCommands 什么都不拦、matcher 管道一律命中）也会判绿。
 */

import { describe, test, expect, spyOn } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { HookAggregator } from "@sid-code/core/hook/aggregator.ts";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookPlanner } from "@sid-code/core/hook/planner.ts";
import { HookEventHandler } from "@sid-code/core/hook/event-handler.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import {
  EnterprisePolicyGate,
  ENTERPRISE_HOOK_POLICY_KEYS,
  commandMatchesBlocked,
  pickHookPolicy,
} from "@sid-code/core/hook/enterprise-policy.ts";
import {
  HookEventName,
  ConfigSource,
  getHookKey,
  resolveHookTimeoutMs,
  type HookConfig,
} from "@sid-code/core/hook/types.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

const HOOK_SRC = join(import.meta.dir, "../../src/hook");
const CLI_APP = join(import.meta.dir, "../../../cli/src/app.ts");

const baseInput = (event: string) =>
  ({ session_id: "s", cwd: process.cwd(), hook_event_name: event, timestamp: "" }) as any;

async function warnings<T>(fn: () => T | Promise<T>): Promise<{ v: T; msgs: string[] }> {
  const spy = spyOn(getLogger(), "warn");
  try {
    const v = await fn();
    return { v, msgs: spy.mock.calls.map((c) => String(c[1])) };
  } finally {
    spy.mockRestore();
  }
}

function plan(
  reg: HookRegistry,
  event: HookEventName,
  ctx?: Parameters<HookPlanner["createExecutionPlan"]>[1],
) {
  return new HookPlanner(reg).createExecutionPlan(event, ctx);
}

// ─── H10 ───────────────────────────────────────────────────────────────

describe("H10 timeout 五种类型同单位（秒）", () => {
  test("同一个 timeout:1 在五种类型上都是 1000ms", () => {
    const cfgs: HookConfig[] = [
      { type: "command", command: "x", timeout: 1 },
      { type: "url", url: "http://x", timeout: 1 },
      { type: "runtime", name: "r", action: async () => {}, timeout: 1 },
      { type: "prompt", prompt: "p", timeout: 1 },
      { type: "agent", prompt: "p", timeout: 1 },
    ];
    expect(cfgs.map(resolveHookTimeoutMs)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  test("缺省值：prompt 30s、其余 60s；runtime 的 timeoutMs 优先", () => {
    expect(resolveHookTimeoutMs({ type: "command", command: "x" })).toBe(60_000);
    expect(resolveHookTimeoutMs({ type: "prompt", prompt: "p" })).toBe(30_000);
    expect(resolveHookTimeoutMs({ type: "agent", prompt: "p" })).toBe(60_000);
    expect(
      resolveHookTimeoutMs({
        type: "runtime",
        name: "r",
        action: async () => {},
        timeoutMs: 50,
        timeout: 9,
      }),
    ).toBe(50);
  });

  test("实测：runtime timeout:1 不再是 1ms（睡 200ms 的 action 能跑完）", async () => {
    const r = await new HookRunner().executeHook(
      {
        type: "runtime",
        name: "r",
        timeout: 1,
        action: async () => {
          await new Promise((res) => setTimeout(res, 200));
        },
      },
      HookEventName.PostToolUse,
      baseInput("PostToolUse"),
    );
    expect(r.success).toBe(true);
  });

  test("结构性：runner 里不再手写 timeout 换算（五处都走 resolveHookTimeoutMs）", () => {
    const src = readFileSync(join(HOOK_SRC, "runner.ts"), "utf8");
    expect(src.match(/resolveHookTimeoutMs\(hookConfig\)/g)?.length).toBe(5);
    expect(src).not.toMatch(/hookConfig\.timeout\s*\?\?/);
  });
});

// ─── H11 ───────────────────────────────────────────────────────────────

describe("H11 SessionHookManager 死模块已删", () => {
  test("文件不存在、index 不再导出；registry 注释写明隔离靠实例边界", () => {
    expect(existsSync(join(HOOK_SRC, "session-hooks.ts"))).toBe(false);
    expect(readFileSync(join(HOOK_SRC, "index.ts"), "utf8")).not.toContain("SessionHookManager");
    expect(readFileSync(join(HOOK_SRC, "registry.ts"), "utf8")).toContain("会话隔离靠**实例边界**");
  });

  test("两个 HookSystem 实例的 session hook 互不可见", () => {
    const a = new HookSystem();
    const b = new HookSystem();
    a.registerSessionHook({ type: "command", command: "echo a" }, HookEventName.PreToolUse, {
      skillName: "s",
    });
    expect(a.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);
    expect(b.getHooksForEvent(HookEventName.PreToolUse).length).toBe(0);
  });
});

// ─── H12 ───────────────────────────────────────────────────────────────

describe("H12 企业策略口径", () => {
  const cmd = (timeout?: number): HookConfig => ({ type: "command", command: "echo x", timeout });

  test("maxHookTimeout 按秒、与 hook timeout 同单位", () => {
    const gate = new EnterprisePolicyGate({ maxHookTimeout: 10 });
    expect(gate.isHookAllowed(cmd(10))).toBe(true);
    expect(gate.isHookAllowed(cmd(11))).toBe(false);
  });

  test("未写 timeout 的 hook 按实际缺省 60s 判（不再 fail-open）", () => {
    expect(new EnterprisePolicyGate({ maxHookTimeout: 10 }).isHookAllowed(cmd())).toBe(false);
    expect(new EnterprisePolicyGate({ maxHookTimeout: 60 }).isHookAllowed(cmd())).toBe(true);
    // prompt 缺省 30s
    expect(
      new EnterprisePolicyGate({ maxHookTimeout: 30 }).isHookAllowed({
        type: "prompt",
        prompt: "p",
      }),
    ).toBe(true);
  });

  test("runtime（内部可观测 hook）不受 maxHookTimeout 约束", () => {
    const gate = new EnterprisePolicyGate({ maxHookTimeout: 1 });
    expect(gate.isHookAllowed({ type: "runtime", name: "trace", action: async () => {} })).toBe(
      true,
    );
  });

  test("blockedCommands 按命令词边界：拦 curl 不误伤 mycurlwrapper", () => {
    expect(commandMatchesBlocked("curl https://x", "curl")).toBe(true);
    expect(commandMatchesBlocked("/usr/bin/curl x", "curl")).toBe(true);
    expect(commandMatchesBlocked("ls && curl x", "curl")).toBe(true);
    expect(commandMatchesBlocked("mycurlwrapper x", "curl")).toBe(false);
    expect(commandMatchesBlocked("echo hello-curl", "curl")).toBe(false);
    // 显式正则
    expect(commandMatchesBlocked("wget x", "/^(curl|wget)\\b/")).toBe(true);
    expect(commandMatchesBlocked("echo wget", "/^(curl|wget)\\b/")).toBe(false);
    // 门控接线
    const gate = new EnterprisePolicyGate({ blockedCommands: ["curl"] });
    expect(gate.isHookAllowed({ type: "command", command: "curl x" })).toBe(false);
    expect(gate.isHookAllowed({ type: "command", command: "mycurlwrapper" })).toBe(true);
  });

  test("pickHookPolicy 搬运全部六个字段，未配置时返回 undefined", () => {
    expect(pickHookPolicy({})).toBeUndefined();
    expect(
      pickHookPolicy({ disableAllHooks: false, allowManagedHooksOnly: false }),
    ).toBeUndefined();
    const full = {
      disableAllHooks: true,
      allowManagedHooksOnly: true,
      allowedHookSources: [ConfigSource.Runtime],
      blockedCommands: ["curl"],
      blockedUrls: ["evil"],
      maxHookTimeout: 10,
    };
    expect(pickHookPolicy(full)).toEqual(full);
    expect(
      Object.keys(pickHookPolicy({ blockedCommands: ["curl"], extra: 1 } as any)!) as string[],
    ).toEqual(["blockedCommands"]);
  });

  test("结构性：清单覆盖 EnterprisePolicy 全部字段；app 层走 pickHookPolicy 而非手写字段", () => {
    const src = readFileSync(join(HOOK_SRC, "enterprise-policy.ts"), "utf8");
    const iface = src.slice(src.indexOf("export interface EnterprisePolicy"));
    const body = iface.slice(0, iface.indexOf("\n}"));
    const fields = [...body.matchAll(/^\s+(\w+)\?:/gm)].map((m) => m[1]).sort();
    expect([...ENTERPRISE_HOOK_POLICY_KEYS].sort() as string[]).toEqual(fields);

    const app = readFileSync(CLI_APP, "utf8");
    expect(app).toContain("applyEnterprisePolicy(hookPolicy)");
    expect(app).toContain("pickHookPolicy(policy)");
  });
});

// ─── H19 ───────────────────────────────────────────────────────────────

describe("H19 去重 key 与过滤顺序", () => {
  test("同命令两条 if 只有后一条命中 → 留下的是命中那条（过滤先于去重）", () => {
    const reg = new HookRegistry();
    const c = { type: "command" as const, command: "echo same" };
    reg.registerHook({ ...c }, HookEventName.PreToolUse, {
      if: "Bash(rm *)",
      source: ConfigSource.User,
    });
    reg.registerHook({ ...c }, HookEventName.PreToolUse, {
      if: "Bash(git *)",
      source: ConfigSource.User,
    });
    const p = plan(reg, HookEventName.PreToolUse, {
      toolName: "Bash",
      toolInput: { command: "git status" },
    });
    expect(p?.entries?.length).toBe(1);
    expect(p?.entries?.[0]?.if).toBe("Bash(git *)");
  });

  test("同命令两个 if 都命中 → 本次只跑一次（内容去重是语义）", () => {
    const reg = new HookRegistry();
    const c = { type: "command" as const, command: "echo same" };
    reg.registerHook({ ...c }, HookEventName.PreToolUse, {
      if: "Bash(git *)",
      source: ConfigSource.User,
    });
    reg.registerHook({ ...c }, HookEventName.PreToolUse, {
      if: "Bash(git status)",
      source: ConfigSource.User,
    });
    const p = plan(reg, HookEventName.PreToolUse, {
      toolName: "Bash",
      toolInput: { command: "git status" },
    });
    expect(p?.hookConfigs.length).toBe(1);
  });

  test("两个未命名、内容不同的 prompt hook 不再被误去重", () => {
    expect(getHookKey({ type: "prompt", prompt: "a" })).not.toBe(
      getHookKey({ type: "prompt", prompt: "b" }),
    );
    expect(getHookKey({ type: "prompt", prompt: "a" })).toBe(
      getHookKey({ type: "prompt", prompt: "a" }),
    );
    const reg = new HookRegistry();
    reg.registerHook({ type: "prompt", prompt: "a" }, HookEventName.Stop, {
      source: ConfigSource.User,
    });
    reg.registerHook({ type: "prompt", prompt: "b" }, HookEventName.Stop, {
      source: ConfigSource.User,
    });
    expect(plan(reg, HookEventName.Stop)?.hookConfigs.length).toBe(2);
  });
});

// ─── H20 ───────────────────────────────────────────────────────────────

describe("H20 生命周期 matcher 支持管道", () => {
  const mk = (matcher: string) => {
    const reg = new HookRegistry();
    reg.registerHook({ type: "command", command: "echo s" }, HookEventName.SessionStart, {
      matcher,
      source: ConfigSource.User,
    });
    return reg;
  };
  test("startup|resume 命中 resume 与 startup，不命中 clear", () => {
    const reg = mk("startup|resume");
    expect(plan(reg, HookEventName.SessionStart, { trigger: "resume" })).not.toBeNull();
    expect(plan(reg, HookEventName.SessionStart, { trigger: "startup" })).not.toBeNull();
    expect(plan(reg, HookEventName.SessionStart, { trigger: "clear" })).toBeNull();
  });
  test("单值仍精确匹配（不退化成子串）", () => {
    expect(plan(mk("start"), HookEventName.SessionStart, { trigger: "startup" })).toBeNull();
  });
});

// ─── H21 ───────────────────────────────────────────────────────────────

describe("H21 if 配在非工具事件上：注册期告警", () => {
  test("SessionStart + if → warn；PreToolUse + if → 不 warn", async () => {
    const reg = new HookRegistry();
    const bad = await warnings(() =>
      reg.initializeFromLegacy({
        session_start: [{ command: "echo s", if: "Bash(git *)" }],
      } as any),
    );
    expect(bad.msgs.some((m) => m.includes("if 永远不命中"))).toBe(true);

    const reg2 = new HookRegistry();
    const ok = await warnings(() =>
      reg2.initializeFromLegacy({
        pre_tool_use: [{ command: "echo s", if: "Bash(git *)" }],
      } as any),
    );
    expect(ok.msgs.some((m) => m.includes("if 永远不命中"))).toBe(false);
  });

  test("PermissionRequest 有 tool_input：if 能命中也能不命中", async () => {
    const reg = new HookRegistry();
    reg.registerHook({ type: "command", command: "echo '{}'" }, HookEventName.PermissionRequest, {
      if: "Bash(git *)",
      source: ConfigSource.User,
    });
    const h = new HookEventHandler(
      new HookPlanner(reg),
      new HookRunner(),
      new HookAggregator(),
      "s",
      process.cwd(),
      reg,
    );
    const hit = await h.firePermissionRequestEvent("Bash", { command: "git status" }, "default");
    const miss = await h.firePermissionRequestEvent("Bash", { command: "ls" }, "default");
    expect(hit.allOutputs.length + hit.errors.length).toBe(1);
    expect(miss.allOutputs.length + miss.errors.length).toBe(0);
  });
});

// ─── H22 / H23 ─────────────────────────────────────────────────────────

describe("H22 env / H23 sequential 从用户配置一路到执行", () => {
  test("settings 写 env → 子进程读得到；不写 → 读不到", async () => {
    const sys = new HookSystem();
    sys.initializeFromLegacy({
      pre_tool_use: [
        {
          command: 'printf \'{"reason":"%s"}\' "$H22_FLAG"',
          env: { H22_FLAG: "on" },
        },
      ],
    } as any);
    const entry = sys.getHooksForEvent(HookEventName.PreToolUse)[0]!;
    expect(entry.config.type === "command" && entry.config.env).toEqual({ H22_FLAG: "on" });
    const r = await sys.firePreToolUseEvent("bash", {});
    expect(JSON.stringify(r.allOutputs)).toContain("on");

    const sys2 = new HookSystem();
    sys2.initializeFromLegacy({
      pre_tool_use: [{ command: 'printf \'{"reason":"[%s]"}\' "$H22_FLAG"' }],
    } as any);
    const r2 = await sys2.firePreToolUseEvent("bash", {});
    expect(JSON.stringify(r2.allOutputs)).toContain("[]");
  });

  test("插件路径同样搬运 env 与 sequential", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({
      pre_tool_use: [{ command: "echo p", env: { A: "1" }, sequential: true }],
    } as any);
    const e = sys.getHooksForEvent(HookEventName.PreToolUse)[0]!;
    expect(e.config.type === "command" && e.config.env).toEqual({ A: "1" });
    expect(e.sequential).toBe(true);
  });

  test("settings 写 sequential:true → plan 串行；不写 → 并行", () => {
    const reg = new HookRegistry();
    reg.initializeFromLegacy({
      stop: [{ command: "echo a", sequential: true }, { command: "echo b" }],
    } as any);
    expect(plan(reg, HookEventName.Stop)?.sequential).toBe(true);
    const reg2 = new HookRegistry();
    reg2.initializeFromLegacy({ stop: [{ command: "echo a" }, { command: "echo b" }] } as any);
    expect(plan(reg2, HookEventName.Stop)?.sequential).toBe(false);
  });

  test("零调用的「新格式」路径已删", () => {
    expect(readFileSync(join(HOOK_SRC, "registry.ts"), "utf8")).not.toContain("initializeFromNew");
    expect(readFileSync(join(HOOK_SRC, "system.ts"), "utf8")).not.toContain("initializeFromNew");
  });
});

// ─── H27 ───────────────────────────────────────────────────────────────

describe("H27 allowManagedHooksOnly 不再放行 Project", () => {
  test("Project / User 被拦，Runtime / Managed 放行；不开策略时全放行", () => {
    const on = new EnterprisePolicyGate({ allowManagedHooksOnly: true });
    const off = new EnterprisePolicyGate({});
    const c = (source: ConfigSource): HookConfig => ({ type: "command", command: "echo", source });
    expect(on.isHookAllowed(c(ConfigSource.Project))).toBe(false);
    expect(on.isHookAllowed(c(ConfigSource.User))).toBe(false);
    expect(on.isHookAllowed(c(ConfigSource.Runtime))).toBe(true);
    expect(on.isHookAllowed(c(ConfigSource.Managed))).toBe(true);
    expect(off.isHookAllowed(c(ConfigSource.Project))).toBe(true);
  });
});
