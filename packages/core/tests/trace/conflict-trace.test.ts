/**
 * PR-7（B9 + B11）— 并发冲突埋点接入轨迹系统回归测试
 *
 * 此前 conflict-analytics 的 TODO 一直未接入 trace：冲突事件只进 debug 日志，
 * 误报率代理（continue 占比）与触发率无法按 release 从轨迹复算；冲突弹窗的
 * 等待墙钟被整段算进工具耗时（436bfce5 实测 edit p95=428,400ms 而
 * PermissionDecision(prompted=true)=0——人的犹豫被误归到工具层）。
 *
 * 分四层验证（与 decision-metrics.test.ts 同一结构）：
 * ① 纯口径：accumulateConflictEvent（计数 / 分布 / HITL 样本只收弹窗且有封顶）
 * ② 观察者转发：emitConflictEvent → observer（异常不传染主流程）
 * ③ digest 汇总：ConflictDetected 进 conflict 计数，hitl_ms 并入 HITL 等待总口径
 * ④ collector 端到端：真实 HookSystem 走一遍，events.jsonl 有 ConflictDetected、
 *    session-index 行带 conflict 块、新会话不继承
 *
 * 经 SID_CODE_SESSION_INDEX 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  accumulateConflictEvent,
  emptyConflictStats,
  MAX_PROMPT_DURATION_SAMPLES,
} from "@sid-code/core/trace/decision-metrics.ts";
import {
  setConflictEventObserver,
  emitConflictEvent,
  recordConflict,
  type ConflictEvent,
} from "@sid-code/core/session/conflict-analytics.ts";
import { aggregateSessionMetrics } from "@sid-code/core/trace/digest.ts";
import { readSessionIndex } from "@sid-code/core/trace/session-index.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";

const cev = (over: Partial<ConflictEvent> = {}): ConflictEvent => ({
  filePathHash: "abcd1234",
  otherSessionCount: 1,
  severity: "critical",
  action: "continue",
  tool: "edit",
  timestamp: 0,
  ...over,
});

describe("B9 · 冲突累加口径（decision-metrics.ConflictStats）", () => {
  test("count / byAction / byTool 分桶计数", () => {
    const s = emptyConflictStats();
    accumulateConflictEvent(s, cev({ action: "continue", tool: "edit" }));
    accumulateConflictEvent(s, cev({ action: "continue", tool: "write" }));
    accumulateConflictEvent(s, cev({ action: "blocked", tool: "edit" }));
    accumulateConflictEvent(s, cev({ action: "branch_auto_continue", tool: "notebook_edit" }));
    expect(s.count).toBe(4);
    // A1 契约：branch_auto_continue 与 continue 必须是两个桶——误报率代理的分子
    // 只取 continue，混桶等于把没人裁决过的样本算成"用户认为误报"
    expect(s.byAction.continue).toBe(2);
    expect(s.byAction.blocked).toBe(1);
    expect(s.byAction.branch_auto_continue).toBe(1);
    expect(s.byTool).toEqual({ edit: 2, write: 1, notebook_edit: 1 });
  });

  test("HITL 等待只收弹过窗的样本（自动放行/block/无头没有等人，不产生样本）", () => {
    const s = emptyConflictStats();
    accumulateConflictEvent(s, cev({ action: "branch_auto_continue" })); // 无 hitlMs
    accumulateConflictEvent(s, cev({ action: "blocked" })); // 无 hitlMs
    accumulateConflictEvent(s, cev({ action: "continue", hitlMs: 428_000 }));
    accumulateConflictEvent(s, cev({ action: "stop", hitlMs: 0 })); // 0 是合法样本（秒选）
    expect(s.hitlWaitMs).toEqual([428_000, 0]);
  });

  test("等待样本封顶，计数不封顶（与 permission 同一条规则）", () => {
    const s = emptyConflictStats();
    for (let i = 0; i < MAX_PROMPT_DURATION_SAMPLES + 10; i++) {
      accumulateConflictEvent(s, cev({ hitlMs: i }));
    }
    expect(s.hitlWaitMs).toHaveLength(MAX_PROMPT_DURATION_SAMPLES);
    expect(s.count).toBe(MAX_PROMPT_DURATION_SAMPLES + 10);
  });
});

describe("B9 · 观察者转发（conflict-analytics → collector）", () => {
  afterEach(() => setConflictEventObserver(null));

  test("emitConflictEvent 转发完整事件（含 timestamp 与 hitlMs）", () => {
    const got: ConflictEvent[] = [];
    setConflictEventObserver((e) => got.push(e));
    recordConflict("/repo/a.ts", 2, "critical", "continue", "edit", 1500);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      otherSessionCount: 2,
      severity: "critical",
      action: "continue",
      tool: "edit",
      hitlMs: 1500,
    });
    expect(got[0].filePathHash).toHaveLength(8); // 脱敏：只留 8 位哈希
    expect(typeof got[0].timestamp).toBe("number");
  });

  test("不传 hitlMs 时事件里没有该键（缺失=没等人，不落 0）", () => {
    const got: ConflictEvent[] = [];
    setConflictEventObserver((e) => got.push(e));
    recordConflict("/repo/a.ts", 1, "warning", "branch_auto_continue", "write");
    expect("hitlMs" in got[0]).toBe(false);
  });

  test("观察者抛异常不会传染到写路径主流程", () => {
    setConflictEventObserver(() => {
      throw new Error("boom");
    });
    expect(() => emitConflictEvent(cev())).not.toThrow();
  });

  test("未注入观察者（测试/无轨迹模式）静默 no-op", () => {
    setConflictEventObserver(null);
    expect(() => recordConflict("/repo/a.ts", 1, "warning", "stop", "edit")).not.toThrow();
  });
});

describe("B9 + B11 · digest 汇总（ConflictDetected 进计数、hitl_ms 并入 HITL）", () => {
  test("action 分布三计数 + conflict_count", () => {
    const m = aggregateSessionMetrics(
      [
        { event: "ConflictDetected", data: { action: "continue", tool: "edit" } },
        { event: "ConflictDetected", data: { action: "continue", tool: "write" } },
        { event: "ConflictDetected", data: { action: "blocked", tool: "edit" } },
        { event: "ConflictDetected", data: { action: "branch_auto_continue", tool: "edit" } },
        { event: "ConflictDetected", data: { action: "headless_fallback", tool: "edit" } },
      ],
      { trajCorrupt: false },
    );
    expect(m.conflict_count).toBe(5);
    // A1 契约在 digest 侧同样成立：auto_continue 不进 continue 计数
    expect(m.conflict_continue_count).toBe(2);
    expect(m.conflict_blocked_count).toBe(1);
    expect(m.conflict_auto_continue_count).toBe(1);
  });

  test("B11：冲突弹窗等待与权限弹窗等待进同一份 HITL 汇总（相加口径）", () => {
    const m = aggregateSessionMetrics(
      [
        { event: "PermissionDecision", data: { prompted: true, duration_ms: 1000 } },
        { event: "ConflictDetected", data: { action: "continue", hitl_ms: 3000 } },
        // 没等人的冲突不进 HITL（缺失 hitl_ms = 自动决策）
        { event: "ConflictDetected", data: { action: "branch_auto_continue" } },
        // 权限规则直放同样不进（prompted=false，既有口径不被本次改动放松）
        { event: "PermissionDecision", data: { prompted: false, duration_ms: 5 } },
      ],
      { trajCorrupt: false },
    );
    expect(m.hitl_prompts).toBe(2); // 权限弹窗 1 + 冲突弹窗 1
    expect(m.hitl_wait_n).toBe(2);
    expect(m.hitl_wait_total_ms).toBe(4000); // 1000 + 3000，两者相加
  });

  test("零冲突会话：conflict_count=0 且 HITL 不受影响", () => {
    const m = aggregateSessionMetrics(
      [{ event: "PermissionDecision", data: { prompted: true, duration_ms: 800 } }],
      { trajCorrupt: false },
    );
    expect(m.conflict_count).toBe(0);
    expect(m.conflict_continue_count).toBe(0);
    expect(m.hitl_wait_total_ms).toBe(800);
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

describe("B9 · collector 端到端落 session-index 与 events.jsonl", () => {
  let dir: string;
  const savedIndex = process.env.SID_CODE_SESSION_INDEX;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-conflict-trace-"));
    process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  });

  afterEach(() => {
    setConflictEventObserver(null);
    if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
    else process.env.SID_CODE_SESSION_INDEX = savedIndex;
    rmSync(dir, { recursive: true, force: true });
  });

  test("真实 HookSystem 跑一遍：索引行带 conflict 块，事件逐条落盘", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-b9");
    hooks.setCwd("/tmp/test");
    const trajDir = join(dir, "trajectories");
    const collector = new TraceCollector({ outputDir: trajDir });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);

    // 走生产入口（recordConflict），不直接调观察者 —— 证明接线而不是证明观察者能被调
    recordConflict("/repo/a.ts", 1, "critical", "continue", "edit", 2500);
    recordConflict("/repo/b.ts", 2, "critical", "blocked", "write");
    recordConflict("/repo/c.ipynb", 1, "warning", "branch_auto_continue", "notebook_edit");

    await hooks.fireSessionEndEvent("exit");

    const row = readSessionIndex().find((e) => e.session_id === "sess-b9");
    expect(row).toBeDefined();
    expect(row!.conflict).toMatchObject({
      count: 3,
      by_action: { continue: 1, blocked: 1, branch_auto_continue: 1 },
      by_tool: { edit: 1, write: 1, notebook_edit: 1 },
      hitl_wait_ms: [2500], // 只有弹窗那条有等待样本
    });

    const events = readFileSync(join(trajDir, "sessions", "sess-b9", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const conflicts = events.filter((e) => e.event === "ConflictDetected");
    expect(conflicts).toHaveLength(3);
    expect(conflicts[0].data).toMatchObject({
      action: "continue",
      tool: "edit",
      hitl_ms: 2500,
      other_session_count: 1,
    });
    // 没等人的事件不带 hitl_ms 键（缺失 ≠ 0）
    expect("hitl_ms" in conflicts[1].data).toBe(false);
    // 路径已脱敏：只有 8 位哈希，没有原始路径字段
    expect(conflicts[0].data.file_path_hash).toHaveLength(8);
    expect(JSON.stringify(conflicts[0].data)).not.toContain("/repo/a.ts");
  });

  test("新会话不继承上个会话的冲突累计（SessionStart 重置）", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setCwd("/tmp/test");
    const collector = new TraceCollector({ outputDir: join(dir, "trajectories") });
    collector.registerHooks(hooks);

    hooks.setSessionId("sess-a");
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);
    recordConflict("/repo/a.ts", 1, "critical", "continue", "edit", 100);
    await hooks.fireSessionEndEvent("exit");

    hooks.setSessionId("sess-b");
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await oneModelRound(hooks);
    await hooks.fireSessionEndEvent("exit");

    const a = readSessionIndex().find((e) => e.session_id === "sess-a")!;
    expect(a.conflict?.count).toBe(1);
    const b = readSessionIndex().find((e) => e.session_id === "sess-b")!;
    // 接了埋点但零冲突 = count 0（键存在），与「旧版本没接」（键缺失）分开
    expect(b.conflict).toBeDefined();
    expect(b.conflict!.count).toBe(0);
    expect(b.conflict!.hitl_wait_ms).toEqual([]);
  });
});
