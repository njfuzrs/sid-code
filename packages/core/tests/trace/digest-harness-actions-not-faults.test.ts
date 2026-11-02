/**
 * digest：harness / 用户的动作不报成故障（2026-11-02，排查诊断检测器精度治理 T2 + T3）。
 *
 * 抽样复核 6 个报 high 的会话，13 条 high 没有一条「准确且有用」。其中四种形态在这里锁住：
 * - T2 权限层拒绝被计成工具错误（本地 578 条 is_error 里 157 条），并进了 real_errors；
 * - T3 中断收尾时还没返回的最后一次模型调用，被报成「hang / 崩溃未被 catch」（15 / 15）；
 * - T3 看门狗触发后同 index 最终配对成功，仍报 high「疑似 hang」（13 个会话里 9 个）；
 * - T3 计费恒等式少的那几条是退出时被截断的后台任务，被报成「有调用链的钱没记上」。
 *
 * 落盘隔离：全程 resolvePaths(tmpdir)，不碰 ~/.sid-code。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolvePaths, buildDigest, type DigestPaths } from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-digest-harness-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-02T00:00:00.000Z");
const ev = (event: string, data: Record<string, unknown> = {}, atMs = T0) => ({
  event,
  session_id: "s",
  timestamp: new Date(atMs).toISOString(),
  data,
});

function digestOf(id: string, opts: { steps?: unknown[]; exit?: string; events?: unknown[] }) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const traj = {
    trajectory: opts.steps ?? [],
    metadata: { session_id: id, exit_status: opts.exit ?? "end_turn" },
  };
  writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
  const events = opts.events ?? [];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ref = { id, dir, trajPath: join(dir, "session.traj"), mtimeMs: Date.now() };
  return buildDigest(ref, false, paths)!;
}

const find = (d: ReturnType<typeof digestOf>, kind: string) =>
  d.anomalies.filter((a) => a.kind === kind);

// ── T2 ──────────────────────────────────────────────────────────────────────

describe("T2 权限层拒绝不计成工具错误", () => {
  const DENY =
    '权限拒绝: 拒绝 — 非交互模式下自动拒绝（无人可确认，重试相同输入不会改变结果）：工具 "bash" 需要用户确认';
  const call = (id: string, content: string) => [
    { message_type: "action", tool_name: "bash", tool_input: { command: id }, tool_use_id: id },
    { message_type: "observation", content, is_error: true, tool_use_id: id },
  ];

  it("2 次拒绝 + 1 次真失败：tool_result_is_error 只计 1，拒绝单列为 low", () => {
    const d = digestOf("t2mix", {
      steps: [...call("a", DENY), ...call("b", "command failed"), ...call("c", DENY)],
      events: [
        ev("PermissionDenied", { tool_name: "bash", tool_use_id: "a", denial_source: "auto" }),
        ev("PermissionDenied", { tool_name: "bash", tool_use_id: "c", denial_source: "auto" }),
      ],
    });
    const err = find(d, "tool_result_is_error");
    expect(err).toHaveLength(1);
    expect(err[0].severity).toBe("medium"); // 1 次，不到 high 的 3 次
    expect(err[0].provenance?.[0].rawValue).toBe("toolErrorCount=1");
    const denied = find(d, "tool_permission_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].severity).toBe("low");
    expect(denied[0].detail).toContain("2 次");
    expect(denied[0].detail).toContain("非交互模式");
    // 工具序列：拒绝标 denied、不标 ✗
    expect(d.toolSequence.map((t) => [t.isError, !!t.denied])).toEqual([
      [false, true],
      [true, false],
      [false, true],
    ]);
  });

  it("全是权限拒绝：不报 tool_result_is_error（也就不进 real_errors）", () => {
    const d = digestOf("t2all", {
      steps: [...call("a", DENY), ...call("b", DENY), ...call("c", DENY)],
      events: ["a", "b", "c"].map((id) =>
        ev("PermissionDenied", { tool_name: "bash", tool_use_id: id, denial_source: "auto" }),
      ),
    });
    expect(find(d, "tool_result_is_error")).toHaveLength(0);
    expect(find(d, "tool_permission_denied")).toHaveLength(1);
  });

  it("只认结构化的 PermissionDenied 事件：文案是「权限拒绝:」但没有事件，仍按工具错误计", () => {
    // 锁住判据来源：按文案判会在产品改一次措辞后静默归零（见 llm/types.ts permissionDenied 注释）
    const d = digestOf("t2text", { steps: call("a", DENY), events: [] });
    expect(find(d, "tool_result_is_error")).toHaveLength(1);
    expect(find(d, "tool_permission_denied")).toHaveLength(0);
  });
});

// ── T3：退出时在途 ──────────────────────────────────────────────────────────

describe("T3 中断收尾时在途的模型调用不报成 hang", () => {
  /** 正常一轮 + 一次 9 分钟的前台命令被用户中断 + 收尾时又发出的 BeforeModel */
  function interrupted(withHttp: boolean) {
    return [
      ev("BeforeModel", { index: 1 }, T0),
      ev("AfterModel", { index: 1 }, T0 + 1_000),
      ev("PreToolUse", { tool_name: "bash", tool_use_id: "long" }, T0 + 2_000),
      ev(
        "PostToolUseFailure",
        { tool_name: "bash", tool_use_id: "long", error_kind: "aborted" },
        T0 + 2_000 + 540_000,
      ),
      ev("BeforeModel", { index: 2 }, T0 + 543_000),
      ...(withHttp ? [ev("HttpConnected", { index: 2, status: 200 }, T0 + 543_500)] : []),
      ev("SessionEnd", { reason: "abort" }, T0 + 544_000),
    ];
  }

  it("请求还没发出：报 low 的 model_call_inflight_at_exit，带上中断前那次工具调用", () => {
    const d = digestOf("t3a", { exit: "abort", events: interrupted(false) });
    expect(find(d, "unpaired_before_model")).toHaveLength(0);
    expect(find(d, "hypothesis_model_call_lost")).toHaveLength(0);
    const a = find(d, "model_call_inflight_at_exit");
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe("low");
    expect(a[0].detail).toContain("请求还没发出");
    expect(a[0].detail).toContain("bash");
    expect(a[0].detail).toContain("9m0s");
    expect(a[0].detail).toContain("aborted");
  });

  it("请求已发出、退出前没收完：同样不报 hang，detail 区分出来", () => {
    const d = digestOf("t3b", { exit: "abort", events: interrupted(true) });
    expect(find(d, "unpaired_before_model")).toHaveLength(0);
    expect(find(d, "model_call_inflight_at_exit")[0].detail).toContain("请求已发出");
  });

  it("不是中断收尾（end_turn）时，最后一个未配对的 BeforeModel 仍按 hang 报 high", () => {
    const d = digestOf("t3c", { exit: "end_turn", events: interrupted(false) });
    expect(find(d, "model_call_inflight_at_exit")).toHaveLength(0);
    expect(find(d, "unpaired_before_model")[0]?.severity).toBe("high");
    expect(find(d, "hypothesis_model_call_lost")).toHaveLength(1);
  });

  it("收尾期间又发出一次（尾部连续两个未配对）：两个都算在途，只报一条 low", () => {
    const d = digestOf("t3run", {
      exit: "abort",
      events: [
        ev("BeforeModel", { index: 1 }, T0),
        ev("AfterModel", { index: 1 }, T0 + 1_000),
        ev("BeforeModel", { index: 2 }, T0 + 2_000),
        ev("SessionEnd", {}, T0 + 12_000),
        ev("BeforeModel", { index: 3 }, T0 + 12_000),
      ],
    });
    expect(find(d, "unpaired_before_model")).toHaveLength(0);
    const a = find(d, "model_call_inflight_at_exit");
    expect(a).toHaveLength(1);
    expect(a[0].detail).toContain("index=2");
    expect(a[0].detail).toContain("又发出 1 次");
  });

  it("中断前已经触发过超时重试（真 stall）：仍按 hang 报 high", () => {
    const d = digestOf("t3stall", {
      exit: "abort",
      events: [
        ev("BeforeModel", { index: 12 }, T0),
        ev("TimeoutRetry", { index: 13 }, T0 + 986_000),
        ev("BeforeModel", { index: 12 }, T0 + 990_000),
        ev("SessionEnd", {}, T0 + 997_000),
      ],
    });
    expect(find(d, "model_call_inflight_at_exit")).toHaveLength(0);
    expect(find(d, "unpaired_before_model")[0]?.severity).toBe("high");
  });

  it("中断收尾，但未配对的是中间那次调用：中间那次仍报 high", () => {
    const d = digestOf("t3d", {
      exit: "abort",
      events: [
        ev("BeforeModel", { index: 1 }, T0),
        ev("BeforeModel", { index: 2 }, T0 + 1_000),
        ev("AfterModel", { index: 2 }, T0 + 2_000),
        ev("SessionEnd", {}, T0 + 3_000),
      ],
    });
    const u = find(d, "unpaired_before_model");
    expect(u).toHaveLength(1);
    expect(u[0].provenance?.[0].lineRef).toContain("1");
    expect(find(d, "model_call_inflight_at_exit")).toHaveLength(0);
  });
});

// ── T3：看门狗触发后最终配对成功 ────────────────────────────────────────────

describe("T3 看门狗触发后最终返回的调用报慢响应，不报 hang", () => {
  it("鉴权失败重试后 10 分钟返回：medium 慢响应，detail 带重启原因与总耗时", () => {
    const d = digestOf("t3w", {
      events: [
        ev("BeforeModel", { index: 50 }, T0),
        ev("StreamRestart", { index: 10, reason: "server_error" }, T0 + 9_000),
        ev("StreamRestart", { index: 10, reason: "auth_failed" }, T0 + 12_000),
        ev("ModelCallUnpaired", { index: 50, model: "m", elapsed_ms: 300_000 }, T0 + 345_000),
        ev("StreamRestart", { index: 10, reason: "retry_same" }, T0 + 607_000),
        ev("AfterModel", { index: 50, elapsed_ms: 633_732 }, T0 + 634_000),
      ],
    });
    expect(find(d, "model_call_unpaired_watchdog")).toHaveLength(0);
    const s = find(d, "model_call_slow_response");
    expect(s).toHaveLength(1);
    expect(s[0].severity).toBe("medium");
    expect(s[0].detail).toContain("server_error → auth_failed → retry_same");
    expect(s[0].detail).toContain("10m34s");
  });

  it("一直没返回：仍报 high 的 model_call_unpaired_watchdog", () => {
    const d = digestOf("t3w2", {
      events: [
        ev("BeforeModel", { index: 50 }, T0),
        ev("ModelCallUnpaired", { index: 50, model: "m", elapsed_ms: 300_000 }, T0 + 300_000),
      ],
    });
    expect(find(d, "model_call_unpaired_watchdog")[0]?.severity).toBe("high");
    expect(find(d, "model_call_slow_response")).toHaveLength(0);
  });
});

// ── T3：计费恒等式的退出截断 ────────────────────────────────────────────────

describe("T3 计费恒等式少的是退出截断的后台任务时，降为 low 并点名", () => {
  function billingEvents(gapBeforeEndMs: number) {
    const end = T0 + 600_000;
    return [
      ev("HttpConnected", { index: 1, status: 200 }, T0),
      ev("BilledRequest", { index: 1, model: "m" }, T0 + 5_000),
      ev(
        "HttpConnected",
        { index: 900036, agent_id: "fork:session-memory-update", status: 200 },
        end - gapBeforeEndMs,
      ),
      ev("SessionEnd", {}, end),
    ];
  }

  it("缺口是 SessionEnd 前 7 秒建的后台连接：low，写明退出截断与是哪次建连", () => {
    const d = digestOf("t3b1", { events: billingEvents(7_000) });
    const b = find(d, "billing_identity_broken");
    expect(b).toHaveLength(1);
    expect(b[0].severity).toBe("low");
    expect(b[0].detail).toContain("退出截断");
    expect(b[0].detail).toContain("fork:session-memory-update#900036");
  });

  it("缺口离结束很远：仍是 high 的漏记，也点名是哪次建连", () => {
    const d = digestOf("t3b2", { events: billingEvents(300_000) });
    const b = find(d, "billing_identity_broken");
    expect(b[0].severity).toBe("high");
    expect(b[0].detail).toContain("钱没记上");
    expect(b[0].detail).toContain("fork:session-memory-update#900036");
  });
});
