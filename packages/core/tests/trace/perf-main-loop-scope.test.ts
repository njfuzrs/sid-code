/**
 * /perf PR-A：数据口径 —— 主循环判据、中断分组、tok/s 现算、分位数补全、索引口径标记。
 *
 * 编号对应修复方案 5.1 节（T-A1…T-A9）。每条都做过变异自证：注释里写了改坏哪一行会让哪条断言变红。
 *
 * ⚠️ T-A9 的期望值**只从 `recompute.py` 的输出抄**（它只读 events.jsonl，不经过被测代码），
 * 不许从修改后的 digest 跑出来反推。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callScopeOf,
  isTruncatedStream,
  SIDE_OBSERVER_INDEX_BASE,
} from "@sid-code/core/trace/call-scope.ts";
import { nextSideObserverIndex } from "@sid-code/core/llm/resilient-stream.ts";
import {
  aggregateSessionMetrics,
  aggregateProviderStats,
  buildDigest,
  listSessions,
  resolvePaths,
} from "@sid-code/core/trace/digest.ts";
import { deriveOutputTps, deriveReasoningShare } from "@sid-code/core/trace/builder.ts";
import {
  buildSessionIndexEntry,
  isMainScopePerfRow,
  type SessionIndexEntry,
} from "@sid-code/core/trace/session-index.ts";
import { buildByVersion, buildTrend } from "@sid-code/core/trace/perf-report.ts";
// PR-B：渲染搬到 cli（要用 string-width / 颜色），断言文本不变
import {
  renderByVersion as renderByVersionEnv,
  renderTrend as renderTrendEnv,
} from "@sid-code/cli/command/commands/perf/render.ts";

const PLAIN = { width: 120, color: false };
const renderTrend = (t: Parameters<typeof renderTrendEnv>[0]) => renderTrendEnv(t, PLAIN);
const renderByVersion = (v: Parameters<typeof renderByVersionEnv>[0]) =>
  renderByVersionEnv(v, PLAIN);

const ev = (event: string, data: Record<string, unknown>) => ({ event, data });

// ── 真实事件形态：从取证会话原样抄字段（不手编），见 call-scope.ts 文件头的组合表 ──
// 20261110-152006-77684ab7（glm-5.3，含 4 次后台记忆 fork）
const MAIN_SP = {
  index: 1,
  phase: "first_content",
  attempt: 1,
  ttft_ms: 2240,
  model: "glm-5.3-uniapi",
  provider: "openai",
  pair_index: 1,
};
const MAIN_SC = {
  type: "stream_completed",
  provider: "openai",
  elapsedMs: 1791,
  model: "glm-5.3-uniapi",
  turnIndex: 1,
  pair_index: 1,
};
const FORK_SP = {
  index: 900002,
  phase: "first_content",
  agent_id: "fork:session-memory-update",
  attempt: 1,
  caller: "agent:fork",
  ttft_ms: 30639,
  model: "glm-5.3-uniapi",
  provider: "openai",
};
const FORK_SC = {
  type: "stream_completed",
  provider: "openai",
  elapsedMs: 29526,
  model: "glm-5.3-uniapi",
  turnIndex: 900002,
  caller: "agent:fork",
  agentId: "fork:session-memory-update",
};
// 20261105-191455-9d34a035（3 个子代理）
const SUB_SP = {
  index: 10001,
  phase: "first_content",
  agent_id: "subagent-a1djevi0k",
  attempt: 3,
  caller: "agent:builtin",
  ttft_ms: 1713,
  model: "origin-deepseek-v4-1-flash",
  provider: "openai",
};
const SUB_SC = {
  type: "stream_completed",
  provider: "openai",
  elapsedMs: 96,
  model: "origin-deepseek-v4-1-flash",
  turnIndex: 10001,
  caller: "agent:builtin",
  agentId: "subagent-a1djevi0k",
  agent_turn: 1,
};

describe("T-A1 callScopeOf：6 种真实事件形态", () => {
  // 变异自证：删掉 `idx >= SIDE_OBSERVER_INDEX_BASE` 那条 → compact / goal_eval（caller 非 agent:fork、
  // 无 agent_id）落进 subagent，下面「其他后台辅助」那条变红。
  test.each([
    ["主循环 StreamPhase", MAIN_SP, "main"],
    ["主循环 stream_completed（无 caller）", MAIN_SC, "main"],
    ["fork StreamPhase", FORK_SP, "side"],
    ["fork stream_completed", FORK_SC, "side"],
    ["子代理 StreamPhase", SUB_SP, "subagent"],
    ["子代理 stream_completed（落盘无 agent_id，只靠 caller）", SUB_SC, "subagent"],
  ] as const)("%s → %s", (_name, data, want) => {
    expect(callScopeOf(data as Record<string, unknown>)).toBe(want);
  });

  test("其他后台辅助（compact / goal_eval：caller=任务名、无 agent_id、900000+ 段）→ side", () => {
    expect(callScopeOf({ type: "stream_completed", turnIndex: 900010, caller: "compact" })).toBe(
      "side",
    );
    expect(callScopeOf({ phase: "first_content", index: 900011, caller: "goal_eval" })).toBe(
      "side",
    );
  });

  test("PostToolUse：带 agent_id 是子代理，不带是主循环", () => {
    expect(callScopeOf({ tool_name: "bash", agent_id: "subagent-x" })).toBe("subagent");
    expect(callScopeOf({ tool_name: "bash" })).toBe("main");
  });

  test("号段只有一个字面量：分配侧与判定侧共用 SIDE_OBSERVER_INDEX_BASE", () => {
    const idx = nextSideObserverIndex();
    expect(idx).toBeGreaterThan(SIDE_OBSERVER_INDEX_BASE);
    expect(callScopeOf({ index: idx })).toBe("side");
    // 防漂移：trace/ 与 llm/ 源码里不许再出现 `900_000` 字面量判断（注释除外）
    const root = join(import.meta.dir, "../../src");
    for (const rel of ["trace/digest.ts", "trace/latency-by-model.ts", "llm/resilient-stream.ts"]) {
      const code = readFileSync(join(root, rel), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(/[<>]=?\s*900_?000/);
    }
  });

  test("isTruncatedStream：aborted / timedOut 任一为真；老轨迹（无字段）不算截断", () => {
    expect(isTruncatedStream({ aborted: true })).toBe(true);
    expect(isTruncatedStream({ timedOut: true })).toBe(true);
    expect(isTruncatedStream(MAIN_SC)).toBe(false);
  });
});

describe("T-A2 aggregateSessionMetrics：主口径只含主循环，后台 / 子代理单列", () => {
  // 变异自证：把 ttfts 的 scope 分组改回无条件 push → ttft_p95 = 40000、ttft_n = 5。
  test("主循环 3 条（1s/2s/3s）+ fork 1 条（40s）+ 子代理 1 条", () => {
    const m = aggregateSessionMetrics(
      [
        ev("StreamPhase", { ...MAIN_SP, index: 1, ttft_ms: 1000 }),
        ev("StreamPhase", { ...MAIN_SP, index: 2, ttft_ms: 2000 }),
        ev("StreamPhase", { ...MAIN_SP, index: 3, ttft_ms: 3000 }),
        ev("StreamPhase", { ...FORK_SP, ttft_ms: 40000 }),
        ev("StreamPhase", SUB_SP),
        ev("RetryTelemetry", MAIN_SC),
        ev("RetryTelemetry", FORK_SC),
        ev("RetryTelemetry", SUB_SC),
      ],
      { trajCorrupt: false },
    );
    expect(m.ttft_p95).toBe(3000);
    expect(m.ttft_n).toBe(3);
    expect(m.side_ttft_n).toBe(1);
    expect(m.side_ttft_max).toBe(40000);
    expect(m.subagent_ttft_n).toBe(1);
    expect(m.gen_n).toBe(1);
    expect(m.side_gen_n).toBe(1);
    expect(m.subagent_gen_n).toBe(1);
  });
});

describe("T-A3 aggregateProviderStats：TTFT / 生成耗时 / latencyByModel 同口径", () => {
  // 变异自证：去掉 aggregateProviderStats 里 ttfts 的 `callScopeOf(...) === "main"` → ttft_p95 = 40000。
  test("fork 的 TTFT 不进 provider 级分位数，也不进按 model 的那一份", () => {
    const events = [
      ev("AfterModelRaw", { provider: "openai", model: "glm-5.3-uniapi", elapsed_ms: 5000 }),
      ev("StreamPhase", { ...MAIN_SP, ttft_ms: 1000 }),
      ev("StreamPhase", { ...MAIN_SP, index: 2, ttft_ms: 2000 }),
      ev("StreamPhase", { ...FORK_SP, ttft_ms: 40000 }),
      ev("RetryTelemetry", MAIN_SC),
      ev("RetryTelemetry", FORK_SC),
    ];
    const [p] = aggregateProviderStats(events);
    expect(p!.ttft_p95).toBe(2000);
    expect(p!.latencyByModel?.["glm-5.3-uniapi"]?.n).toBe(2);
    expect(p!.requests).toBe(1); // requests 只来自 AfterModelRaw，本来就只有主循环
  });
});

describe("T-A4 端到端：中断轮单列", () => {
  // 变异自证：把判据改成 `stop_reason !== "end_turn"` → error 那条被剔，e2e_n 变 1。
  test("abort 进 e2e_interrupted，不进 e2e_n / e2e_no_hitl_n；error 留在主口径", () => {
    const m = aggregateSessionMetrics(
      [
        ev("TurnComplete", { stop_reason: "end_turn", elapsed_ms_since_prompt: 5000 }),
        ev("TurnComplete", { stop_reason: "abort", elapsed_ms_since_prompt: 8689 }),
        ev("TurnComplete", { stop_reason: "error", elapsed_ms_since_prompt: 3000 }),
      ],
      { trajCorrupt: false },
    );
    expect(m.e2e_n).toBe(2);
    expect(m.e2e_no_hitl_n).toBe(2);
    expect(m.e2e_interrupted_n).toBe(1);
    expect(m.e2e_interrupted_max).toBe(8689);
  });
});

describe("T-A6 生成耗时跳过截断流", () => {
  // 变异自证：去掉 aggregateSessionMetrics 里的 isTruncatedStream 判断 → gen_n = 3。
  test("aborted / timedOut 的 stream_completed 不进 gens，单独计数", () => {
    const m = aggregateSessionMetrics(
      [
        ev("RetryTelemetry", MAIN_SC),
        ev("RetryTelemetry", { ...MAIN_SC, elapsedMs: 2647, aborted: true }),
        ev("RetryTelemetry", { ...MAIN_SC, elapsedMs: 60000, timedOut: true }),
      ],
      { trajCorrupt: false },
    );
    expect(m.gen_n).toBe(1);
    expect(m.gen_truncated_n).toBe(2);
    expect(m.gen_total_ms).toBe(1791);
  });
});

describe("T-A7 deriveOutputTps：会话中快照也有值", () => {
  // 变异自证：让 builder.ts 只写 metadata.output_tokens_per_sec（不走 deriveOutputTps 兜底）→
  // 中途快照里不再有这个字段，/perf 回到「无样本」。
  test("中途快照 metadata（无 output_tokens_per_sec、无 gen_samples，有 total_gen_elapsed_ms）→ 有值", () => {
    // 取证会话 metadata 的子集：154530 token / 4,726.3s（截图时刻的分母仍含 fork）
    const tps = deriveOutputTps({ total_tokens_received: 154530, total_gen_elapsed_ms: 4726127 });
    expect(tps).toBeCloseTo(32.697, 2);
  });
  test("collector 内存态 gen_samples=0 → undefined（不落 0 或 ∞）", () => {
    expect(
      deriveOutputTps({ total_tokens_received: 100, total_gen_elapsed_ms: 0, gen_samples: 0 }),
    ).toBeUndefined();
    expect(deriveOutputTps({ total_tokens_received: 100 })).toBeUndefined();
  });
  test("reasoning 占比：Anthropic 族恒 0 → undefined，不是 0", () => {
    expect(
      deriveReasoningShare({ total_tokens_received: 154530, total_reasoning_tokens: 108838 }),
    ).toBeCloseTo(0.7043, 3);
    expect(
      deriveReasoningShare({ total_tokens_received: 100, total_reasoning_tokens: 0 }),
    ).toBeUndefined();
  });
});

describe("A8 索引口径切换点", () => {
  const row = (extra: Partial<SessionIndexEntry>): SessionIndexEntry =>
    ({
      session_id: "s",
      ts: 1000,
      model: "m",
      exit_status: "end_turn",
      duration_ms: 1,
      turns: 1,
      total_steps: 1,
      cost_usd: 0,
      tokens_sent: 0,
      tokens_received: 0,
      ttft_n: 5,
      e2e_n: 1,
      real_errors: 0,
      anomalies_count: 0,
      pathological: [],
      ttft_p50: 1000,
      ttft_p95: 2000,
      ...extra,
    }) as SessionIndexEntry;

  // 变异自证：删掉 buildSessionIndexEntry 末尾的 `perf_scope: "main"` → 这条红。
  test("新写入的索引行一律带 perf_scope=main", () => {
    const e = buildSessionIndexEntry({ session_id: "x" }, { ts: 1 });
    expect(e.perf_scope).toBe("main");
    expect(isMainScopePerfRow(e)).toBe(true);
    expect(isMainScopePerfRow({})).toBe(false);
  });

  test("--days：任一期含旧口径行时提示，全是新口径时不提示", () => {
    const now = 100 * 86400;
    const mixed = [
      ...Array.from({ length: 3 }, (_, i) =>
        row({ session_id: `n${i}`, ts: now - 100, perf_scope: "main" }),
      ),
      ...Array.from({ length: 2 }, (_, i) => row({ session_id: `o${i}`, ts: now - 8 * 86400 })),
    ];
    const t = buildTrend(mixed, { days: 7, nowSec: now });
    expect(t.current.legacyScopeSessions).toBe(0);
    expect(t.previous.legacyScopeSessions).toBe(2);
    expect(renderTrend(t)).toContain("上期含 2 个旧口径会话");

    const clean = buildTrend(
      mixed.filter((r) => r.perf_scope === "main"),
      { days: 7, nowSec: now },
    );
    expect(renderTrend(clean)).not.toContain("旧口径");
  });

  test("--by-version：含旧口径行的版本被点名", () => {
    const v = buildByVersion(
      [
        row({ session_id: "a", app_version: "0.1.615" }),
        row({ session_id: "b", app_version: "0.1.616", perf_scope: "main" }),
      ],
      10,
    );
    const out = renderByVersion(v);
    expect(out).toContain("0.1.615 含旧口径会话");
    expect(out).not.toContain("0.1.616 含旧口径");
  });
});

describe("T-A9 端到端对账：取证会话 20261110-152006-77684ab7（脱敏夹具）", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "perf-scope-"));
    const dir = join(root, "trajectories", "sessions", "20261110-152006-77684ab7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "events.jsonl"),
      readFileSync(
        join(import.meta.dir, "../fixtures/perf-scope/20261110-152006-77684ab7.events.jsonl"),
      ),
    );
    writeFileSync(
      join(dir, "session.traj"),
      JSON.stringify({
        trajectory: [],
        info: { exit_status: "terminal_closed" },
        metadata: { session_id: "20261110-152006-77684ab7", model: "glm-5.3-uniapi" },
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // 期望值抄自 recompute.py 输出（方案附录 A）：
  //   仅主循环 TTFT n=161 P50=5.9s P95=15.4s P99=32.1s；仅后台辅助 n=4 P50=43.5s max=49.0s
  //   TTFB 仅主循环 n=161 P50=5.7s P95=15.2s；生成耗时仅主循环 n=161 P50=10.4s P95=128.3s 合计 4655s
  //   端到端 3 条：end_turn 5179.2s / abort 8.7s / end_turn 872.2s
  // 毫秒级精确值由同一判据的独立 Python 脚本（只读 events.jsonl）给出。
  //
  // ⚠️ 与方案 5.1 的不同：方案写 `gen_n = 160`，前提是被打断那条流（2647ms）带 `aborted`。
  // 这份轨迹由 0.1.614 写出，没有该字段；按 A3「老轨迹不反推」仍计入，所以是 161，
  // 与 recompute.py「仅主循环 n=161」一致。新轨迹由 T-A5 / T-A6 守。
  //
  // 变异自证：任意一处 scope 过滤去掉 → ttft_n 165 / side_ttft_n 0 / e2e_n 3 至少一项变红。
  test("digest 主口径与 recompute.py 逐项一致", () => {
    const paths = resolvePaths(root);
    const d = buildDigest(listSessions(paths)[0]!, false, paths)!;
    const m = d.sessionMetrics!;
    expect(m.ttft_n).toBe(161);
    expect(m.ttft_p50).toBe(5880);
    expect(m.ttft_p95).toBe(15407);
    expect(m.ttft_p99).toBe(32092);
    expect(m.side_ttft_n).toBe(4);
    expect(m.side_ttft_p50).toBe(43549);
    expect(m.side_ttft_max).toBe(48967);
    expect(m.subagent_ttft_n).toBe(0);
    expect(m.main_headers_n).toBe(161);
    expect(m.main_headers_p50).toBe(5699);
    expect(m.main_headers_p95).toBe(15197);
    expect(m.gen_n).toBe(161);
    expect(m.gen_p50).toBe(10370);
    expect(m.gen_p95).toBe(128313);
    expect(m.gen_p99).toBe(291938);
    expect(m.gen_total_ms).toBe(4655240);
    expect(m.side_gen_n).toBe(4);
    expect(m.e2e_n).toBe(2);
    expect(m.e2e_interrupted_n).toBe(1);
    expect(m.e2e_interrupted_max).toBe(8689);
    // 按 model 那一份与会话级同口径（修复前 n=165、P95=29249）
    const lbm = d.providerStats?.[0]?.latencyByModel?.["glm-5.3-uniapi"];
    expect(lbm?.n).toBe(161);
    expect(lbm?.ttft_p95).toBe(15407);
  });
});
