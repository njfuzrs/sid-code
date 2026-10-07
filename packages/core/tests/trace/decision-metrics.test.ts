/**
 * B11（权限决策埋点）与 B12（一次 edit 成功率）的口径与接线测试。
 *
 * 分三层：① 纯口径（decision-metrics.ts）；② 门面转发（events.ts 的 logPermission*
 * 必须同时进轨迹观察者 —— 这是「漏一个鉴权分支就永久隐身」的结构保证）；
 * ③ collector 端到端：真实 HookSystem 走一遍，索引行里要有这两个字段。
 *
 * 经 SID_CODE_SESSION_INDEX 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  accumulatePermissionDecision,
  emptyPermissionDecisionStats,
  EditFirstTryTracker,
  MAX_PROMPT_DURATION_SAMPLES,
} from "@sid-code/core/trace/decision-metrics.ts";
import {
  setPermissionDecisionObserver,
  recordPermissionDecision,
  type PermissionDecisionEvent,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { logPermissionAllow, logPermissionDeny } from "@sid-code/core/analytics/events.ts";
import { readSessionIndex } from "@sid-code/core/trace/session-index.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";

const ev = (over: Partial<PermissionDecisionEvent> = {}): PermissionDecisionEvent => ({
  tool: "bash",
  outcome: "allow",
  prompted: false,
  source: "rule",
  context: "main",
  ...over,
});

describe("B11 · 权限决策累加口径", () => {
  test("HITL 分子只数 prompted，规则命中只数 reasonType=rule", () => {
    const s = emptyPermissionDecisionStats();
    accumulatePermissionDecision(s, ev({ reasonType: "rule" }));
    accumulatePermissionDecision(s, ev({ reasonType: "mode" }));
    accumulatePermissionDecision(
      s,
      ev({ prompted: true, outcome: "deny", source: "user", reasonType: "rule", durationMs: 1200 }),
    );
    accumulatePermissionDecision(s, ev({ tool: "edit" }));
    expect(s.total).toBe(4);
    expect(s.prompted).toBe(1);
    expect(s.denied).toBe(1);
    expect(s.ruleHits).toBe(2);
    expect(s.byTool.bash).toEqual({ n: 3, prompted: 1 });
    expect(s.byTool.edit).toEqual({ n: 1, prompted: 0 });
    // 没带 reason 的进 none 桶，不并进 other —— 二者含义不同
    expect(s.byReason.none).toEqual({ n: 1, prompted: 0 });
    expect(s.byReason.rule).toEqual({ n: 2, prompted: 1 });
  });

  test("确认耗时只收弹过窗的样本（规则直放的微秒级耗时会把 p50 压成 0）", () => {
    const s = emptyPermissionDecisionStats();
    accumulatePermissionDecision(s, ev({ durationMs: 0 }));
    accumulatePermissionDecision(s, ev({ prompted: true, durationMs: 3000 }));
    expect(s.promptDurationsMs).toEqual([3000]);
  });

  test("耗时样本封顶，计数不封顶", () => {
    const s = emptyPermissionDecisionStats();
    for (let i = 0; i < MAX_PROMPT_DURATION_SAMPLES + 10; i++) {
      accumulatePermissionDecision(s, ev({ prompted: true, durationMs: i }));
    }
    expect(s.promptDurationsMs).toHaveLength(MAX_PROMPT_DURATION_SAMPLES);
    expect(s.prompted).toBe(MAX_PROMPT_DURATION_SAMPLES + 10);
  });

  test("观察者抛异常不会传染到鉴权主流程", () => {
    setPermissionDecisionObserver(() => {
      throw new Error("boom");
    });
    try {
      expect(() => recordPermissionDecision(ev())).not.toThrow();
    } finally {
      setPermissionDecisionObserver(null);
    }
  });
});

describe("B11 · 门面转发（logPermission* ⇔ 进轨迹，结构保证）", () => {
  afterEach(() => setPermissionDecisionObserver(null));

  test("logPermissionAllow / logPermissionDeny 都会转发到观察者，字段齐全", () => {
    const got: PermissionDecisionEvent[] = [];
    setPermissionDecisionObserver((e) => got.push(e));
    logPermissionAllow("read", {
      source: "rule",
      needsPrompt: false,
      context: "main",
      reasonType: "rule",
    });
    logPermissionDeny("bash", {
      source: "user",
      needsPrompt: true,
      durationMs: 4200,
      context: "subagent",
      reasonType: "dangerousCommand",
    });
    expect(got).toEqual([
      {
        tool: "read",
        outcome: "allow",
        prompted: false,
        source: "rule",
        reasonType: "rule",
        context: "main",
      },
      {
        tool: "bash",
        outcome: "deny",
        prompted: true,
        source: "user",
        reasonType: "dangerousCommand",
        context: "subagent",
        durationMs: 4200,
      },
    ]);
  });
});

describe("B12 · 一次 edit 成功率口径（文件 × 会话）", () => {
  test("同一文件只看第一次：失败后再成功仍算「非一次成功」", () => {
    const t = new EditFirstTryTracker();
    t.record("edit", { file_path: "/a.ts" }, true);
    t.record("edit", { file_path: "/a.ts" }, false);
    t.record("edit", { file_path: "/b.ts" }, false);
    t.record("edit", { file_path: "/b.ts" }, true);
    expect(t.stats()).toEqual({ files: 2, firstTryOk: 1 });
  });

  test("分母按文件计，不按调用次数（同文件重复成功不刷分）", () => {
    const t = new EditFirstTryTracker();
    for (let i = 0; i < 5; i++) t.record("edit", { file_path: "/a.ts" }, false);
    expect(t.stats()).toEqual({ files: 1, firstTryOk: 1 });
  });

  test("write 不计（整文件覆盖没有匹配步骤，会白送一次成功）；notebook_edit 取 notebook_path", () => {
    const t = new EditFirstTryTracker();
    t.record("write", { file_path: "/new.ts" }, false);
    t.record("read", { file_path: "/a.ts" }, false);
    t.record("notebook_edit", { notebook_path: "/n.ipynb" }, true);
    t.record("edit", {}, false);
    expect(t.stats()).toEqual({ files: 1, firstTryOk: 0 });
  });
});

/**
 * 跑一轮模型调用。没有任何 API 调用的会话会被 collector 判为空白会话：
 * 目录清掉、不写索引 —— 不补这一轮，测的就是空白会话清理而不是本次接线。
 */
async function oneModelRound(hooks: any): Promise<void> {
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
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } as never,
  );
}

describe("B11 + B12 · collector 端到端落 session-index 与 events.jsonl", () => {
  let dir: string;
  const savedIndex = process.env.SID_CODE_SESSION_INDEX;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-decision-metrics-"));
    process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  });

  afterEach(() => {
    setPermissionDecisionObserver(null);
    if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
    else process.env.SID_CODE_SESSION_INDEX = savedIndex;
    rmSync(dir, { recursive: true, force: true });
  });

  test("真实 HookSystem 跑一遍：索引行带 permission 与 edit_first_try，事件逐条落盘", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-b11");
    hooks.setCwd("/tmp/test");
    const trajDir = join(dir, "trajectories");
    const collector = new TraceCollector({ outputDir: trajDir });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);

    // 走生产入口（门面），不直接调观察者 —— 证明接线而不是证明观察者能被调
    logPermissionAllow("edit", {
      source: "rule",
      needsPrompt: false,
      context: "main",
      reasonType: "rule",
    });
    logPermissionDeny("bash", {
      source: "user",
      needsPrompt: true,
      durationMs: 2500,
      context: "main",
      reasonType: "rule",
    });

    await hooks.firePostToolUseEvent("edit", { file_path: "/x.ts" }, { output: "err" }, true);
    await hooks.firePostToolUseEvent("edit", { file_path: "/x.ts" }, { output: "ok" }, false);
    await hooks.firePostToolUseEvent("edit", { file_path: "/y.ts" }, { output: "ok" }, false);

    await hooks.fireSessionEndEvent("exit");

    const row = readSessionIndex().find((e) => e.session_id === "sess-b11");
    expect(row).toBeDefined();
    expect(row!.permission).toMatchObject({
      total: 2,
      prompted: 1,
      denied: 1,
      rule_hits: 2,
      prompt_durations_ms: [2500],
    });
    expect(row!.edit_first_try).toEqual({ files: 2, first_try_ok: 1 });

    const events = readFileSync(join(trajDir, "sessions", "sess-b11", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const decisions = events.filter((e) => e.event === "PermissionDecision");
    expect(decisions).toHaveLength(2);
    expect(decisions[1].data).toMatchObject({ tool_name: "bash", outcome: "deny", prompted: true });
  });

  test("新会话不继承上个会话的累计（SessionStart 重置）", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setCwd("/tmp/test");
    const collector = new TraceCollector({ outputDir: join(dir, "trajectories") });
    collector.registerHooks(hooks);

    hooks.setSessionId("sess-a");
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);
    logPermissionAllow("read", { source: "rule", needsPrompt: false, context: "main" });
    await hooks.firePostToolUseEvent("edit", { file_path: "/x.ts" }, {}, false);
    await hooks.fireSessionEndEvent("exit");

    hooks.setSessionId("sess-b");
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);
    await hooks.fireSessionEndEvent("exit");

    const b = readSessionIndex().find((e) => e.session_id === "sess-b")!;
    expect(b.permission?.total).toBe(0);
    expect(b.edit_first_try).toEqual({ files: 0, first_try_ok: 0 });
  });
});
