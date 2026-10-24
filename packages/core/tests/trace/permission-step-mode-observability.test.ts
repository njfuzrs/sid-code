/**
 * §4 审计 · 可观测性三个缺口的端到端回归。
 *
 *  1. PermissionDecision 必须带 step（管线位置）与 mode（sid 原生模式）：
 *     修前本机 22409/25933 条决策 reason_type 为空，Step 5.5 / 10 / 12 / skip 早退分不开。
 *  2. SessionStart 记 sid_permission_mode：permission_mode 是 CC 映射值，
 *     always-allow 与 skip 合并成 bypassPermissions，deny-write 记成 default。
 *  3. SessionStart 与 session-index 记权限配置形态（规则条数 / 开关）= 影响面分母。
 *
 * 外加哨兵 mode_guard_breaches：plan / deny-write 下放行写类工具（计划文件除外）恒应为 0。
 *
 * 走生产入口：真实 PermissionChecker 决策 → 门面 logPermission* → collector → 落盘。
 * 经 SID_CODE_SESSION_INDEX / SID_CONFIG_DIR 重定向到 tmp，不触碰真实 ~/.sid-code。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setPermissionDecisionObserver,
  setPermissionConfigProvider,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { logPermissionAllow } from "@sid-code/core/analytics/events.ts";
import { readSessionIndex } from "@sid-code/core/trace/session-index.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import {
  accumulatePermissionDecision,
  emptyPermissionDecisionStats,
} from "@sid-code/core/trace/decision-metrics.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

let dir: string;
const saved = {
  index: process.env.SID_CODE_SESSION_INDEX,
  config: process.env.SID_CONFIG_DIR,
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-perm-obs-")));
  process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  process.env.SID_CONFIG_DIR = join(dir, "cfg");
});

afterEach(() => {
  setPermissionDecisionObserver(null);
  setPermissionConfigProvider(null);
  for (const [k, v] of [
    ["SID_CODE_SESSION_INDEX", saved.index],
    ["SID_CONFIG_DIR", saved.config],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function oneModelRound(hooks: import("@sid-code/core/hook/system.ts").HookSystem) {
  await hooks.fireBeforeModelEvent({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    raw_messages: [{ role: "user", content: "hi" }],
  });
  await hooks.fireAfterModelEvent(
    { model: "claude-test", messages: [], raw_messages: [{ role: "user", content: "hi" }] },
    {
      content_blocks: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } as never,
  );
}

describe("权限可观测性：step / mode / 配置形态端到端落盘", () => {
  test("真实决策 → 门面 → collector：events.jsonl 与 session-index 都带上", async () => {
    const ws = join(dir, "ws");
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "deny-write", disallowedTools: ["WebFetch"] } as never,
      { allow: ["Bash(npm *)", "Read(*)"], deny: ["Bash(curl *)"], ask: [] },
      ws,
    );
    setPermissionConfigProvider(() => checker.describeConfigShape());

    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-obs");
    hooks.setCwd(ws);
    hooks.setPermissionMode("deny-write");
    const trajDir = join(dir, "trajectories");
    new TraceCollector({ outputDir: trajDir }).registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);

    // 与 query/tool-executor 同一透传口径：reasonType / step / mode 都取自 Decision
    const d = await checker.check({ toolName: "glob", input: { pattern: "*" } });
    expect(d.allowed).toBe(true);
    logPermissionAllow("glob", {
      source: "rule",
      needsPrompt: false,
      context: "main",
      reasonType: d.decisionReason?.type,
      step: d.step,
      mode: d.mode,
    });
    await hooks.fireSessionEndEvent("exit");

    const events = readFileSync(join(trajDir, "sessions", "sess-obs", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const start = events.find((e) => e.event === "SessionStart");
    // CC 映射值把 deny-write 记成 default —— sid 原值必须另有一份
    expect(start.data.permission_mode).toBe("default");
    expect(start.data.sid_permission_mode).toBe("deny-write");
    expect(start.data.permission_config).toMatchObject({
      mode: "deny-write",
      skip_permissions: false,
      disallowed_tools: 1,
      rules: { allow: { projectSettings: 2 }, deny: { projectSettings: 1 } },
    });
    // 只有计数，不含规则文本（规则串含命令片段 / 路径）
    expect(JSON.stringify(start.data.permission_config)).not.toContain("curl");

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision.data).toMatchObject({ tool_name: "glob", step: "10", mode: "deny-write" });

    const row = readSessionIndex().find((e) => e.session_id === "sess-obs");
    expect(row!.permission?.by_step).toEqual({ "10": { n: 1, prompted: 0 } });
    expect(row!.permission?.by_mode).toEqual({ "deny-write": { n: 1, prompted: 0 } });
    expect(row!.permission?.mode_guard_breaches).toBe(0);
    expect(row!.permission_config?.rules.deny).toEqual({ projectSettings: 1 });
  });

  test("哨兵口径：只数 plan/deny-write 下写类放行，计划文件（step=3.5）与读工具不算", () => {
    const s = emptyPermissionDecisionStats();
    const base = { prompted: false, source: "rule", context: "main" } as const;
    accumulatePermissionDecision(s, {
      ...base,
      tool: "write",
      outcome: "allow",
      mode: "plan",
      step: "3.5",
    });
    accumulatePermissionDecision(s, {
      ...base,
      tool: "read",
      outcome: "allow",
      mode: "plan",
      step: "9",
    });
    accumulatePermissionDecision(s, {
      ...base,
      tool: "write",
      outcome: "deny",
      mode: "plan",
      step: "mode-gate",
    });
    accumulatePermissionDecision(s, {
      ...base,
      tool: "write",
      outcome: "allow",
      mode: "default",
      step: "8-rule",
    });
    expect(s.modeGuardBreaches).toBe(0);
    accumulatePermissionDecision(s, {
      ...base,
      tool: "bash",
      outcome: "allow",
      mode: "deny-write",
      step: "8-rule",
    });
    expect(s.modeGuardBreaches).toBe(1);
  });

  test("未注入配置 provider 时 SessionStart 不带 permission_config（缺失 ≠ 零规则）", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-noprov");
    hooks.setCwd(dir);
    const trajDir = join(dir, "trajectories");
    new TraceCollector({ outputDir: trajDir }).registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);
    await hooks.fireSessionEndEvent("exit");
    const start = readFileSync(join(trajDir, "sessions", "sess-noprov", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "SessionStart");
    expect(start.data.permission_config).toBeUndefined();
    expect(
      readSessionIndex().find((e) => e.session_id === "sess-noprov")!.permission_config,
    ).toBeUndefined();
  });
});
