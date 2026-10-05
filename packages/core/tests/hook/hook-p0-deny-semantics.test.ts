/**
 * Hook 决策语义 P0 回归：H24 / H4 / H1 / H29 / H15。
 *
 * 每条都同时断言正反两面——只断言「修好的那一面」会让反向改错也判绿
 * （如把 OR 改成 AND、把 allow 分支整个删掉）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { HookAggregator } from "@sid-code/core/hook/aggregator.ts";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookEventName, type HookOutput } from "@sid-code/core/hook/types.ts";
import {
  USER_HOOK_HANDLER_TYPES,
  ALL_HOOK_HANDLER_TYPES,
} from "@sid-code/core/hook/handler-types.ts";
import { getSettingsForSource } from "@sid-code/core/config/settings/settings.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { setWorkspaceUntrusted } from "@sid-code/core/permission/trust.ts";
import { validateConfig } from "@sid-code/core/config/schema.ts";
import { createSDKCanUseTool } from "@sid-code/core/sdk/permission-bridge.ts";

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

// ─── H24 ────────────────────────────────────────────────────────────────

describe("H24 hook 类型不再让 settings.json 连带丢掉 permissions.deny", () => {
  let tmpHome: string;
  let ws: string;
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sid-h24-home-"));
    ws = mkdtempSync(join(tmpdir(), "sid-h24-ws-"));
    mkdirSync(join(ws, ".sid-code"), { recursive: true });
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = tmpHome;
    resetSettingsCache();
    setWorkspaceUntrusted(false);
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    resetSettingsCache();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  function load(hooks: unknown) {
    writeFileSync(
      join(ws, ".sid-code", "settings.json"),
      JSON.stringify({
        model: "deepseek-v4-pro",
        permissions: { deny: ["Bash(rm -rf /)"] },
        hooks,
      }),
    );
    return getSettingsForSource("projectSettings", ws);
  }

  test("prompt / agent 型 hook 校验通过且保留，无告警", () => {
    const { settings, errors } = load({
      PreToolUse: [
        { type: "prompt", prompt: "危险吗？" },
        { type: "agent", prompt: "验证一下" },
      ],
    });
    expect(settings?.permissions?.deny).toEqual(["Bash(rm -rf /)"]);
    expect((settings?.hooks as any)?.PreToolUse?.map((h: any) => h.type)).toEqual([
      "prompt",
      "agent",
    ]);
    expect(errors).toEqual([]);
  });

  test("真正无效的类型：只丢这一条 hook + 告警，deny 与同事件其他 hook 照常生效", () => {
    const { settings, errors } = load({
      PreToolUse: [
        { type: "nonsense", command: "echo x" },
        { type: "command", command: "echo ok" },
      ],
    });
    expect(settings).not.toBeNull();
    expect(settings?.permissions?.deny).toEqual(["Bash(rm -rf /)"]);
    expect(settings?.model).toBe("deepseek-v4-pro");
    // 整条被摘掉，而不是只摘 type 键后按缺省 command 继续跑 `echo x`
    expect((settings?.hooks as any)?.PreToolUse).toEqual([{ type: "command", command: "echo ok" }]);
    expect(errors.some((e) => e.message.includes("nonsense"))).toBe(true);
  });

  test("结构性：三处枚举同源（Zod / config/schema / registry）", () => {
    // config/schema 的手写校验对每个用户类型都不报错，对未知类型报错
    for (const type of USER_HOOK_HANDLER_TYPES) {
      const r = validateConfig({
        hooks: { PreToolUse: [{ type, command: "x", prompt: "x", url: "x" }] },
      } as any);
      expect(r.errors.filter((e) => e.path.endsWith(".type"))).toEqual([]);
    }
    const bad = validateConfig({
      hooks: { PreToolUse: [{ type: "nonsense", command: "x" }] },
    } as any);
    expect(bad.errors.some((e) => e.path.endsWith(".type"))).toBe(true);
    // registry 运行期认全部类型（用户类型 + runtime）
    expect(ALL_HOOK_HANDLER_TYPES).toEqual([...USER_HOOK_HANDLER_TYPES, "runtime"]);
    // 源码层不再出现手写枚举（防有人在某处又抄一份）
    const src = (p: string) => readFileSync(join(import.meta.dir, "../../src", p), "utf-8");
    expect(src("config/settings/types.ts")).not.toMatch(/z\.enum\(\["command", "url"/);
    expect(src("config/schema.ts")).not.toMatch(/VALID_HOOK_TYPES\s*=/);
    expect(src("hook/registry.ts")).not.toMatch(/\["command", "url", "runtime"/);
  });

  test("registry 对 prompt 型 hook 实际注册（不是只过了校验）", () => {
    const reg = new HookRegistry();
    reg.initializeFromLegacy({ PreToolUse: [{ type: "prompt", prompt: "危险吗？" }] } as any);
    expect(reg.getHooksForEvent(HookEventName.PreToolUse).map((e) => e.config.type)).toEqual([
      "prompt",
    ]);
  });
});

// ─── H1 ─────────────────────────────────────────────────────────────────

describe("H1 OR 合并认 permissionDecision:deny，且结论与顺序无关", () => {
  const pd = (d: string): HookOutput => ({ hookSpecificOutput: { permissionDecision: d } });

  test.each([
    ["pd:deny + pd:allow", [pd("deny"), pd("allow")]],
    ["顶层 deny + pd:allow", [{ decision: "deny" } as HookOutput, pd("allow")]],
    ["pd:deny + 顶层 allow", [pd("deny"), { decision: "allow" } as HookOutput]],
    ["pd:deny + 纯审计（无 decision）", [pd("deny"), { systemMessage: "审计" }]],
  ])("%s：两个顺序都阻塞，两条通道结论一致", (_label, outs) => {
    for (const order of [outs, [...outs].reverse()]) {
      const out = aggregate(HookEventName.PreToolUse, order as HookOutput[]) as any;
      expect(out.isBlockingDecision()).toBe(true);
      expect(out.decision).toBe("deny");
      if (out.hookSpecificOutput?.permissionDecision !== undefined) {
        expect(out.getPermissionDecision()).toBe("deny");
      }
    }
  });

  test("反面：全部放行不被误判成阻塞（防 OR 被改成「有分歧就拒」）", () => {
    const out = aggregate(HookEventName.PreToolUse, [pd("allow"), { decision: "allow" }]) as any;
    expect(out.isBlockingDecision()).toBe(false);
    expect(out.getPermissionDecision()).toBe("allow");
  });
});

// ─── H29 ────────────────────────────────────────────────────────────────

describe("H29 BeforeModel / AfterModel：阻塞与停机一票否决，字段替换能力保留", () => {
  for (const ev of [HookEventName.BeforeModel, HookEventName.AfterModel]) {
    test(`${ev}：deny + allow 两个顺序都阻塞，reason 取阻塞者`, () => {
      const outs: HookOutput[] = [{ decision: "deny", reason: "预算超限" }, { decision: "allow" }];
      for (const order of [outs, [...outs].reverse()]) {
        const out = aggregate(ev, order);
        expect(out.isBlockingDecision()).toBe(true);
        expect(out.reason).toBe("预算超限");
      }
    });

    test(`${ev}：continue:false 不被后一个 continue:true 取消`, () => {
      const outs: HookOutput[] = [{ continue: false, stopReason: "停" }, { continue: true }];
      for (const order of [outs, [...outs].reverse()]) {
        const out = aggregate(ev, order);
        expect(out.shouldStopExecution()).toBe(true);
        expect(out.stopReason).toBe("停");
      }
    });

    test(`${ev}：多个 hook 改不同字段都生效（反面：别把字段替换改坏）`, () => {
      const key = ev === HookEventName.BeforeModel ? "llm_request" : "llm_response";
      const out = aggregate(ev, [
        { hookSpecificOutput: { [key]: { a: 1 } } },
        { hookSpecificOutput: { other: 2 } },
      ]);
      expect(out.hookSpecificOutput?.[key]).toEqual({ a: 1 });
      expect(out.hookSpecificOutput?.["other"]).toBe(2);
      expect(out.isBlockingDecision()).toBe(false);
      expect(out.shouldStopExecution()).toBe(false);
    });
  }

  test("结构性：凡枚举注释写「可 block」的事件，deny+allow 两个顺序都必须阻塞", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/hook/types.ts"), "utf-8");
    const blockable = [...src.matchAll(/\/\*\*([^*]*?)\*\/\s*(\w+)\s*=\s*"\w+"/g)]
      .filter((m) => /可 block/.test(m[1]!) && !/不可 block/.test(m[1]!))
      .map((m) => m[2]!);
    // 抽取本身先自证：至少包含已知的几个，防正则失配后遍历空集全绿
    expect(blockable).toEqual(
      expect.arrayContaining(["PreToolUse", "BeforeModel", "AfterModel", "Stop", "PreCompact"]),
    );
    // PermissionRequest 是 H2，单独修；这里先登记豁免，修 H2 时删掉这一行
    const KNOWN_GAPS = new Set(["PermissionRequest"]);
    const violators: string[] = [];
    for (const name of blockable) {
      if (KNOWN_GAPS.has(name)) continue;
      const ev = HookEventName[name as keyof typeof HookEventName];
      const outs: HookOutput[] = [{ decision: "deny" }, { decision: "allow" }];
      for (const order of [outs, [...outs].reverse()]) {
        if (!aggregate(ev, order).isBlockingDecision()) violators.push(name);
      }
    }
    expect([...new Set(violators)]).toEqual([]);
  });
});

// ─── H15 ────────────────────────────────────────────────────────────────

describe("H15 exit 2 一律阻塞，JSON 改不了", () => {
  const runner = new HookRunner();
  const input = {
    session_id: "s",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    timestamp: "",
    tool_name: "bash",
    tool_input: { command: "git push origin main" },
  } as any;
  const run = async (command: string) => {
    const r = await runner.executeHook(
      { type: "command", name: "h", command } as any,
      HookEventName.PreToolUse,
      input,
    );
    return { r, out: aggregate(HookEventName.PreToolUse, [r.output!]) };
  };

  test("exit 2 + stdout 是无 decision 的审计 JSON → 阻塞，理由取 stderr，JSON 字段保留", async () => {
    const { r, out } = await run(
      `echo '{"audit":"blocked","systemMessage":"已记录"}'; echo "禁止 push main" >&2; exit 2`,
    );
    expect(out.isBlockingDecision()).toBe(true);
    expect(r.output?.reason).toBe("禁止 push main");
    expect(r.output?.systemMessage).toBe("已记录");
  });

  test("exit 2 + JSON 写 decision:allow → 仍阻塞（JSON 改不了）", async () => {
    const { out } = await run(`echo '{"decision":"allow"}'; echo "不行" >&2; exit 2`);
    expect(out.isBlockingDecision()).toBe(true);
  });

  test("exit 2 + JSON 带 reason → 理由优先取 JSON", async () => {
    const { r } = await run(`echo '{"reason":"JSON 里的理由"}'; echo "stderr 理由" >&2; exit 2`);
    expect(r.output?.reason).toBe("JSON 里的理由");
  });

  test("反面：exit 0 + JSON decision:deny 仍按 JSON 阻塞；exit 1 + 纯文本不阻塞", async () => {
    expect(
      (await run(`echo '{"decision":"deny","reason":"x"}'; exit 0`)).out.isBlockingDecision(),
    ).toBe(true);
    expect((await run(`echo "告警" >&2; exit 1`)).out.isBlockingDecision()).toBe(false);
  });
});

// ─── H4 ─────────────────────────────────────────────────────────────────

describe("H4 SDK 桥只在 hook 显式放行时 allow，沉默 / 告警交给宿主", () => {
  const runner = new HookRunner();
  const input = {
    session_id: "s",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    timestamp: "",
    tool_name: "bash",
    tool_input: {},
  } as any;

  /** 真实 runner + aggregator 产出 finalOutput，喂给真实 createSDKCanUseTool */
  async function bridgeDecision(command: string, hostBehavior: "allow" | "deny") {
    const r = await runner.executeHook(
      { type: "command", name: "h", command } as any,
      HookEventName.PreToolUse,
      input,
    );
    const finalOutput = aggregate(HookEventName.PreToolUse, [r.output!]);
    const hookSystem: any = { firePreToolUseEvent: async () => ({ finalOutput }) };
    // 宿主延迟 80ms 回答：hook 若「主动放行」会先赢；不表态则必须等宿主
    const structuredIO: any = {
      sendRequest: () =>
        new Promise((res) => setTimeout(() => res({ behavior: hostBehavior }), 80)),
      trackResolvedToolUseId: () => {},
    };
    const canUseTool = createSDKCanUseTool({ structuredIO, hookSystem, timeoutMs: 0 });
    return canUseTool("Bash", {}, "t");
  }

  test("纯审计 hook（exit 0 无 JSON）→ 宿主说了算", async () => {
    expect(await bridgeDecision(`echo "审计: 记录一次调用"`, "deny")).toBe("deny");
  });

  test("exit 1 告警 hook → 宿主说了算", async () => {
    expect(await bridgeDecision(`echo "注意" >&2; exit 1`, "deny")).toBe("deny");
  });

  test.each([
    [`echo '{"decision":"approve"}'`],
    [`echo '{"decision":"allow"}'`],
    [`echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`],
  ])("反面：显式放行 %s → allow（越过宿主的 deny）", async (cmd) => {
    expect(await bridgeDecision(cmd, "deny")).toBe("allow");
  });

  test("显式拒绝 → deny（越过宿主的 allow）", async () => {
    expect(await bridgeDecision(`echo "拒" >&2; exit 2`, "allow")).toBe("deny");
  });
});
