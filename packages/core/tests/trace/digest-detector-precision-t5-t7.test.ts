/**
 * digest：记录器丢数据 / 已恢复的瞬时错误不报成故障
 *（2026-11-07，排查诊断检测器精度治理 T5 + T7）
 *
 * 前三轮（T0–T4，PR #519–#522）消掉了「用错价表」「把 harness 动作当故障」「打转误报」
 * 三类误报，剩下三条 high 抽样复核后同样是「事实对、结论错」：
 *
 * - T5 `tool_use_without_result`：115 个孤儿里 97 个其实**执行过**，是轨迹记录器把
 *   tool_result 丢了（根因 `computeNewMessages` 按条数切增量，重试 / 压缩后切出空）。
 *   原来无条件 high + 「中途崩溃 / 协议违规」，把排查引向不存在的协议缺陷。
 * - T7 `errors_jsonl_has_entries`：44 条错误里 26 条已被重试恢复（同 index 之后又出现了
 *   AfterModelRaw），和「会话最终失败」算成同一件事，等于「凡有重试就报警」。
 * - T7 `billing_identity_broken`：15 条缺口里只有 2–4 条是真漏记，其余是退出截断，
 *   而旧判据只有「SessionEnd 前 10 秒」一条，把 fork 在 SessionEnd 之后建连、
 *   根本没有 SessionEnd 两类漏在外面。
 *
 * 落盘隔离：全程 resolvePaths(tmpdir)，不碰 ~/.sid-code。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  buildDigest,
  computeProcessPathology,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-digest-precision-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const ev = (event: string, data: Record<string, unknown> = {}, atMs = T0) => ({
  event,
  session_id: "s",
  timestamp: new Date(atMs).toISOString(),
  data,
});

function digestOf(
  id: string,
  opts: {
    steps?: unknown[];
    exit?: string;
    events?: unknown[];
    errors?: unknown[];
  },
) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const traj = {
    trajectory: opts.steps ?? [],
    metadata: { session_id: id, exit_status: opts.exit ?? "end_turn" },
  };
  writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
  writeFileSync(
    join(dir, "events.jsonl"),
    (opts.events ?? []).map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  if (opts.errors) {
    writeFileSync(
      join(dir, "errors.jsonl"),
      opts.errors.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }
  const ref = { id, dir, trajPath: join(dir, "session.traj"), mtimeMs: Date.now() };
  return buildDigest(ref, false, paths)!;
}

const find = (d: ReturnType<typeof digestOf>, kind: string) =>
  d.anomalies.filter((a) => a.kind === kind);

/** 造一次「action + 孤儿 observation」 */
const orphanCall = (id: string) => [
  { message_type: "action", tool_name: "bash", tool_input: { command: id }, tool_use_id: id },
  {
    message_type: "observation",
    content: "[tool_result not found - session may have ended mid-execution]",
    tool_use_id: id,
    _orphan: true,
  },
];
/** 造一次正常完成的调用 */
const okCall = (id: string) => [
  { message_type: "action", tool_name: "bash", tool_input: { command: id }, tool_use_id: id },
  { message_type: "observation", content: "ok", tool_use_id: id },
];

// ── T5 ──────────────────────────────────────────────────────────────────────

describe("T5 孤儿按「工具是否真执行过」分流", () => {
  it("events 有同 id 的 PostToolUse：报 trajectory_tool_result_lost（medium），不发崩溃假设", () => {
    const d = digestOf("t5record", {
      // 中段孤儿：后面还有正常 observation，排除「尾部 + 中断」这一路
      steps: [...orphanCall("a"), ...okCall("b")],
      events: [ev("PostToolUse", { tool_name: "bash", tool_use_id: "a" })],
    });
    const lost = find(d, "trajectory_tool_result_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0].severity).toBe("medium");
    expect(lost[0].detail).toContain("工具执行了");
    // 关键：不再报成崩溃 / 协议违规
    expect(find(d, "tool_use_without_result")).toHaveLength(0);
    expect(find(d, "hypothesis_crash_or_violation")).toHaveLength(0);
    // pointer 指向采集侧，不指向 protocol-violations
    expect(lost[0].pointer).toContain("computeNewMessages");
  });

  it("尾部孤儿 + 会话中断：降为 low，不发崩溃假设", () => {
    const d = digestOf("t5abort", {
      steps: orphanCall("a"),
      exit: "abort",
      // 没有任何收尾事件 —— 中断时工具结果本来就没回灌
      events: [],
    });
    const orphan = find(d, "tool_use_without_result");
    expect(orphan).toHaveLength(1);
    expect(orphan[0].severity).toBe("low");
    expect(orphan[0].detail).toContain("abort");
    expect(find(d, "hypothesis_crash_or_violation")).toHaveLength(0);
  });

  it("孤儿既无收尾事件、又不在尾部：仍是 high + 崩溃假设（真异常不能放过）", () => {
    const d = digestOf("t5unexplained", {
      steps: [...orphanCall("a"), ...okCall("b")],
      exit: "end_turn",
      events: [],
    });
    const orphan = find(d, "tool_use_without_result");
    expect(orphan).toHaveLength(1);
    expect(orphan[0].severity).toBe("high");
    const l1 = find(d, "hypothesis_crash_or_violation");
    expect(l1).toHaveLength(1);
    expect(l1[0].severity).toBe("medium");
  });

  it("回归：撞 maxTurns 的尾部孤儿仍是 low（§20.3 的口径不能被 T5 覆盖）", () => {
    const d = digestOf("t5maxturns", {
      steps: orphanCall("a"),
      exit: "max_turns",
      events: [ev("PostToolUse", { tool_name: "bash", tool_use_id: "a" })],
    });
    const orphan = find(d, "tool_use_without_result");
    expect(orphan).toHaveLength(1);
    expect(orphan[0].severity).toBe("low");
    expect(orphan[0].detail).toContain("maxTurns");
    expect(find(d, "hypothesis_crash_or_violation")).toHaveLength(0);
  });
});

// ── T7 errors ───────────────────────────────────────────────────────────────

const errEntry = (index: number, context: Record<string, unknown>, atMs = T0) => ({
  event: "Error",
  timestamp: new Date(atMs).toISOString(),
  session_id: "s",
  data: { phase: "stream", index, error: "boom", context },
});

describe("T7 errors.jsonl 区分「已恢复」与「最终失败」", () => {
  it("willRetry=true 且同 index 之后有 AfterModelRaw：只报 low，不报 high", () => {
    const d = digestOf("t7recovered", {
      steps: [],
      events: [ev("AfterModelRaw", { index: 3 }, T0 + 1000)],
      errors: [errEntry(3, { kind: "timeout", willRetry: true })],
    });
    expect(find(d, "errors_jsonl_has_entries")).toHaveLength(0);
    const recovered = find(d, "errors_jsonl_recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].severity).toBe("low");
    expect(recovered[0].detail).toContain("timeout 1");
  });

  it("willRetry=true 但之后没有同 index 的 AfterModelRaw：仍是 high（打算重试 ≠ 恢复了）", () => {
    const d = digestOf("t7unrecovered", {
      steps: [],
      // 只有别的 index 成功 —— 不能算恢复
      events: [ev("AfterModelRaw", { index: 4 }, T0 + 1000)],
      errors: [errEntry(3, { kind: "timeout", willRetry: true })],
    });
    const high = find(d, "errors_jsonl_has_entries");
    expect(high).toHaveLength(1);
    expect(high[0].severity).toBe("high");
    expect(high[0].detail).toContain("1 条未恢复");
  });

  it("没有 willRetry 的 engine 级失败：仍是 high", () => {
    const d = digestOf("t7engine", {
      steps: [],
      events: [],
      errors: [errEntry(5, {})],
    });
    const high = find(d, "errors_jsonl_has_entries");
    expect(high).toHaveLength(1);
    expect(high[0].severity).toBe("high");
  });
});

// ── T7 billing ──────────────────────────────────────────────────────────────

const conn = (index: number, atMs: number, agentId?: string) =>
  ev(
    "HttpConnected",
    { index, agent_id: agentId, status: 200, content_type: "text/event-stream" },
    atMs,
  );
const billed = (index: number, atMs: number, agentId?: string) =>
  ev("BilledRequest", { index, agent_id: agentId }, atMs);
const sessionEnd = (atMs: number) =>
  ev("SessionEnd", { reason: "exit", exit_status: "end_turn" }, atMs);

describe("T7 计费缺口按退出形态归因", () => {
  it("建连在 SessionEnd 之后：判退出截断（low）", () => {
    const p = computeProcessPathology(
      [] as any,
      [
        conn(1, T0),
        billed(1, T0 + 100),
        sessionEnd(T0 + 1000),
        conn(900001, T0 + 5000, "fork:session-memory-update"),
      ] as any,
    );
    expect(p.billingIdentityBroken).toBe(true);
    expect(p.unbilledConnections?.[0].exitTruncatedBy).toBe("after_session_end");
    expect(p.billingExitTruncated).toBe(true);
  });

  it("会话根本没有 SessionEnd：判退出截断（low）", () => {
    const p = computeProcessPathology(
      [] as any,
      [conn(1, T0), billed(1, T0 + 100), conn(2, T0 + 200)] as any,
    );
    expect(p.unbilledConnections?.[0].exitTruncatedBy).toBe("no_session_end");
    expect(p.billingExitTruncated).toBe(true);
  });

  it("建连在结束前 20 秒（旧 10 秒窗口外）：判退出截断（窗口已放宽到 60 秒）", () => {
    const p = computeProcessPathology(
      [] as any,
      [conn(1, T0), billed(1, T0 + 100), conn(2, T0 + 200), sessionEnd(T0 + 20_200)] as any,
    );
    expect(p.unbilledConnections?.[0].exitTruncatedBy).toBe("within_window");
    expect(p.billingExitTruncated).toBe(true);
  });

  it("建连离结束 5 分钟：保持 high（中段真漏记，不能被宽判据放过）", () => {
    const p = computeProcessPathology(
      [] as any,
      [conn(1, T0), billed(1, T0 + 100), conn(2, T0 + 200), sessionEnd(T0 + 300_200)] as any,
    );
    expect(p.unbilledConnections?.[0].exitTruncatedBy).toBeUndefined();
    expect(p.billingExitTruncated).toBeUndefined();
  });

  it("建连之后还有别的计费事件、离结束也远：保持 high", () => {
    const p = computeProcessPathology(
      [] as any,
      [
        conn(1, T0),
        billed(1, T0 + 100),
        conn(2, T0 + 200),
        billed(3, T0 + 300),
        sessionEnd(T0 + 3_600_000),
      ] as any,
    );
    expect(p.unbilledConnections?.[0].exitTruncatedBy).toBeUndefined();
    expect(p.billingExitTruncated).toBeUndefined();
  });
});
