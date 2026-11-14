/**
 * PR-0 · 权限可观测三件套（B11 / B12 / B13）的端到端回归。
 *
 * ## 为什么断言必须打到 `events.jsonl`
 *
 * B11 的 `confirm_via` 就是这么丢的：上游 `PermissionDecisionEvent` 带了字段、
 * 门面也透传了，唯独 collector 没映射；而当时的单测只断言到「观察者入参」，
 * 于是全绿 —— 轨迹里恒无该字段，直到 G2 探针实测才发现（见 decision-telemetry.ts
 * 里 `confirm_via` 的注释）。所以这里一律走
 * 「真实 checker → 门面 → collector → 读 events.jsonl 原文」。
 *
 * 每个用例都同时钉住 **字段有值** 与 **不该有时没有**（老轨迹 / 非 bash 工具），
 * 否则「恒落一个字面量」也能让断言变绿。
 *
 * 落盘目标经 `SID_CONFIG_DIR` 重定向到 tmpdir，不触碰真实 `~/.sid-code`。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { logPermissionAllow, logPermissionDeny } from "@sid-code/core/analytics/events.ts";
import {
  decisionFactsOf,
  recordPermissionDecision,
  setPermissionDecisionObserver,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { aggregateSessionMetrics } from "@sid-code/core/trace/digest.ts";

let dir: string;
const saved = {
  config: process.env.SID_CONFIG_DIR,
  index: process.env.SID_CODE_SESSION_INDEX,
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr0-obs-")));
  process.env.SID_CONFIG_DIR = join(dir, "cfg");
  process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
});

afterEach(() => {
  setPermissionDecisionObserver(null);
  for (const [k, v] of [
    ["SID_CONFIG_DIR", saved.config],
    ["SID_CODE_SESSION_INDEX", saved.index],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 起一个真 collector 并读回 events.jsonl。
 *
 * 必须跑一轮模型：否则整个会话是空的，SessionEnd 的 `cleanupIfBlankSession`
 * 会把轨迹目录删掉（实测表现为 `sessions/` 目录存在但其下没有会话目录，
 * readFileSync 报 ENOENT —— 不是落盘失败，是目录被主动清理了）。
 */
async function withCollector(
  sessionId: string,
  fn: (hooks: import("@sid-code/core/hook/system.ts").HookSystem) => Promise<void>,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const { HookSystem } = await import("@sid-code/core/hook/system.ts");
  const hooks = new HookSystem();
  hooks.setSessionId(sessionId);
  hooks.setCwd(dir);
  const trajDir = join(dir, "trajectories");
  new TraceCollector({ outputDir: trajDir }).registerHooks(hooks);
  await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
  // 空会话会被 cleanupIfBlankSession 删掉：跑一轮模型给它一个 pair
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
  await fn(hooks);
  await hooks.fireSessionEndEvent("exit");
  return readFileSync(join(trajDir, "sessions", sessionId, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("B12：PermissionDecision 的危险成因与 bash 形状落盘", () => {
  test("危险命令 → danger_pattern / danger_severity 有值，且必须带 bash_shape=dangerous", async () => {
    const checker = new PermissionChecker({ ...defaultConfig() } as never, {}, dir);
    // `rm -rf /` 走硬编码预检 → dangerousCommand（critical，直接拒）
    const d = await checker.check({ toolName: "bash", input: { command: "rm -rf /" } });
    expect(d.decisionReason?.type).toBe("dangerousCommand");
    expect(d.allowed).toBe(false);

    const events = await withCollector("b12-danger", async () => {
      logPermissionDeny("bash", {
        source: "rule",
        needsPrompt: false,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.danger_pattern).toBeString();
    expect(decision?.data.danger_pattern as string).not.toHaveLength(0);
    expect(decision?.data.danger_severity).toBe("critical");
    // checker 在出口统一算形状：危险优先，取值必须是 `dangerous`
    expect(decision?.data.bash_shape).toBe("dangerous");
  });

  test("工作区内 cd + 只读主体 → bash_shape=cd_workspace_readonly（命令完整，不靠 digest 重算）", async () => {
    const checker = new PermissionChecker(
      { ...defaultConfig() } as never,
      // 显式 ask 一条 bash 规则：PR-0 不改判定，「cd + 只读」此刻仍要确认（PR-2 才免），
      // 这里要测的正是「这条确认的形状」
      { ask: ["Bash(*)"] },
      dir,
    );
    const cmd = `cd ${dir} && git status`;
    const d = await checker.check({ toolName: "bash", input: { command: cmd } });
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);

    const events = await withCollector("b12-shape", async () => {
      logPermissionDeny("bash", {
        source: "rule",
        needsPrompt: true,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.bash_shape).toBe("cd_workspace_readonly");
    // 非危险命令不得带危险成因（否则「danger_pattern 有值」这条判据就废了）
    expect(decision?.data.danger_pattern).toBeUndefined();
  });

  test("非 bash 工具不落 bash_shape（字段语义只在 bash 上成立）", async () => {
    const checker = new PermissionChecker({ ...defaultConfig() } as never, {}, dir);
    const d = await checker.check({ toolName: "read", input: { file_path: join(dir, "a.txt") } });

    const events = await withCollector("b12-nonbash", async () => {
      logPermissionAllow("read", {
        source: "rule",
        needsPrompt: false,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.bash_shape).toBeUndefined();
  });

  test("forked 决策带 mode=fork:<策略名>（此前恒空，digest 按 mode 切片全落 unknown）", async () => {
    const events = await withCollector("b12-fork", async () => {
      // forked-agent 走的就是 recordPermissionDecision（不写 PreToolUse，这是它唯一留痕）
      recordPermissionDecision({
        tool: "bash",
        outcome: "deny",
        prompted: false,
        source: "other",
        context: "forked",
        agentId: "fork:memory-extract",
        mode: "fork:memory-extract",
        step: "forked",
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.mode).toBe("fork:memory-extract");
    expect(decision?.data.execution_context).toBe("forked");
  });

  test("env_prefix_vars / git_trust 未接线时键不落盘（缺失 ≠ 空数组）", async () => {
    const checker = new PermissionChecker({ ...defaultConfig() } as never, {}, dir);
    const d = await checker.check({ toolName: "bash", input: { command: "git status" } });

    const events = await withCollector("b12-unwired", async () => {
      logPermissionAllow("bash", {
        source: "rule",
        needsPrompt: false,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    // PR-1 合入后这两个字段会有值；在此之前「键不落盘」是正确形态，
    // 落一个空数组会被读成「看了，没有变量」——那是另一种事实。
    expect("env_prefix_vars" in (decision?.data ?? {})).toBe(false);
    expect("git_trust" in (decision?.data ?? {})).toBe(false);
  });
});

describe("B13：digest 的「确认成因」分桶", () => {
  /** 造一条主循环弹出的确认事件 */
  function pd(data: Record<string, unknown>) {
    return {
      event: "PermissionDecision",
      data: { prompted: true, execution_context: "main", ...data },
    };
  }

  test("按 bash_shape / danger_pattern / reason_type 分桶，并统计次数与墙钟", () => {
    const m = aggregateSessionMetrics(
      [
        pd({ tool_name: "bash", bash_shape: "cd_workspace_readonly", duration_ms: 1000 }),
        pd({ tool_name: "bash", bash_shape: "cd_workspace_readonly", duration_ms: 3000 }),
        pd({ tool_name: "bash", bash_shape: "cd_outside_workspace", duration_ms: 500 }),
        pd({ tool_name: "bash", bash_shape: "cd_workspace_nonreadonly" }),
        pd({ tool_name: "bash", bash_shape: "no_cd_prefix", duration_ms: 200 }),
        pd({ tool_name: "bash", danger_pattern: "rm-rf-root", duration_ms: 800 }),
        pd({ tool_name: "read", reason_type: "pathValidation", duration_ms: 400 }),
        pd({ tool_name: "edit", reason_type: "rule", duration_ms: 100 }),
      ],
      { trajCorrupt: false },
    );

    const byBucket = Object.fromEntries((m.hitl_cause_buckets ?? []).map((b) => [b.bucket, b]));
    expect(byBucket["工作区内 cd + 只读"]).toMatchObject({ n: 2, timed_n: 2, total_ms: 4000 });
    expect(byBucket["cd 到工作区外"]).toMatchObject({ n: 1, timed_n: 1, total_ms: 500 });
    expect(byBucket["非只读其他"]).toMatchObject({ n: 2, timed_n: 1, total_ms: 200 });
    expect(byBucket["危险：rm-rf-root"]).toMatchObject({ n: 1, timed_n: 1, total_ms: 800 });
    expect(byBucket["路径：工作区外读/写"]).toMatchObject({ n: 1, timed_n: 1, total_ms: 400 });
    expect(byBucket["工具：rule"]).toMatchObject({ n: 1, timed_n: 1, total_ms: 100 });
    // 分母自证：分桶次数之和 == hitl_prompts
    expect((m.hitl_cause_buckets ?? []).reduce((a, b) => a + b.n, 0)).toBe(m.hitl_prompts);
  });

  test("老轨迹（无 bash_shape）归「未分类」，与「分桶没生效」区分开", () => {
    const m = aggregateSessionMetrics([pd({ tool_name: "bash", duration_ms: 1200 })], {
      trajCorrupt: false,
    });
    expect(m.hitl_cause_buckets).toEqual([
      { bucket: "未分类（老轨迹无 bash_shape）", n: 1, timed_n: 1, total_ms: 1200 },
    ]);
  });

  test("非主循环（子代理 / forked）不进分桶，但仍计入 hitl_prompts 总数", () => {
    const m = aggregateSessionMetrics(
      [
        pd({ tool_name: "bash", bash_shape: "cd_workspace_readonly" }),
        { event: "PermissionDecision", data: { prompted: true, execution_context: "forked" } },
      ],
      { trajCorrupt: false },
    );
    expect(m.hitl_prompts).toBe(2);
    expect((m.hitl_cause_buckets ?? []).reduce((a, b) => a + b.n, 0)).toBe(1);
  });

  test("按次数降序（读者先看最大那桶）", () => {
    const m = aggregateSessionMetrics(
      [
        pd({ tool_name: "read", reason_type: "rule" }),
        pd({ tool_name: "bash", bash_shape: "cd_workspace_readonly" }),
        pd({ tool_name: "bash", bash_shape: "cd_workspace_readonly" }),
      ],
      { trajCorrupt: false },
    );
    expect(m.hitl_cause_buckets?.[0]).toMatchObject({ bucket: "工作区内 cd + 只读", n: 2 });
  });
});
