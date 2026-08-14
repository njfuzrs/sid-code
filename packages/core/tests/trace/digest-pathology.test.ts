/**
 * P1-8 / P1-9 单测 —— 过程病态六指标 + 信号饱和消除（digest 侧）。
 *
 * 落盘隔离：本文件全程用 `resolvePaths(tmpdir)` 显式传 root，
 * 不读 `SID_CODE_HOME` / `~/.sid-code`，因此不会污染用户真实轨迹目录
 * （与既有 digest.test.ts 同一手法）。不硬编码 `join(homedir(), ".sid-code")`——
 * 那等于"真往家目录写再断言写成功"，隔离一生效立刻失配。
 *
 * 每个用例都配了**反向断言**（健康会话不得触发），因为这批指标的首要风险不是漏报
 * 而是误报：告警一旦被噪声训练成"可以忽略"，就等于没有告警（§8.1 那 29 行的教训）。
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
  type TrajStep,
} from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-pathology-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 写一个会话目录（session.traj + 可选 events.jsonl），返回 SessionRef */
function writeSession(id: string, traj: unknown, events?: unknown[]) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
  if (events) {
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }
  return { id, dir, trajPath: join(dir, "session.traj"), mtimeMs: Date.now() };
}

/** 造一个 action + observation 对 */
function pair(tool: string, input: Record<string, unknown>, obs: unknown, ts?: string): TrajStep[] {
  return [
    {
      message_type: "action",
      role: "assistant",
      tool_name: tool,
      tool_input: input,
      timestamp: ts as unknown as number,
    },
    { message_type: "observation", role: "user", content: obs, is_error: false },
  ];
}

const START = "2026-08-10T00:00:00.000Z";
const START_MS = Date.parse(START);

// ───────────────────────── P1-9：severity 随量级升级 ─────────────────────────

describe("P1-9 · repeated_tool_shape_run 的 severity 随量级升级", () => {
  /**
   * 构造 n 次同 shape 的连续调用。必须给**递增且间隔 > 1s** 的时间戳：
   * digest 会把 1s 内的同 shape 调用当成并行 fan-out 跳过不计数
   * （PARALLEL_DISPATCH_WINDOW_MS），不给时间戳虽然也能计数，但显式给更贴近真实轨迹。
   */
  function runSession(n: number) {
    const steps: TrajStep[] = [];
    for (let i = 0; i < n; i++) {
      steps.push(
        ...pair("bg_task_list", {}, `task ${i}`, new Date(START_MS + i * 5000).toISOString()),
      );
    }
    return {
      trajectory: steps,
      info: { exit_status: "end_turn" },
      metadata: {
        session_id: "x",
        model: "m",
        exit_status: "end_turn",
        start_time: START,
        tools_used: ["bg_task_list"],
      },
    };
  }

  it("run=41 定级为 high（此前固定 low，41 次与 4 次同级）", () => {
    const ref = writeSession("run41", runSession(41));
    const d = buildDigest(ref, false, paths)!;
    const a = d.anomalies.find((x) => x.kind === "repeated_tool_shape_run")!;
    expect(a).toBeDefined();
    expect(a.severity).toBe("high");
    expect(a.detail).toContain("41 次");
    // L1 假设层同步升级，否则最强的循环信号与最弱的同级
    expect(d.anomalies.find((x) => x.kind === "hypothesis_stuck_loop")!.severity).toBe("high");
  });

  it("run=5 仍为 low（反向验收：小量级不得被升级，否则分段读大文件会误报）", () => {
    const ref = writeSession("run5", runSession(5));
    const d = buildDigest(ref, false, paths)!;
    const a = d.anomalies.find((x) => x.kind === "repeated_tool_shape_run")!;
    expect(a.severity).toBe("low");
    // L1 在小量级保持原有的 medium（"值得怀疑"而非"已确证"）
    expect(d.anomalies.find((x) => x.kind === "hypothesis_stuck_loop")!.severity).toBe("medium");
  });

  it("run=15 定级为 medium（中间档存在，不是二元跳变）", () => {
    const ref = writeSession("run15", runSession(15));
    const d = buildDigest(ref, false, paths)!;
    expect(d.anomalies.find((x) => x.kind === "repeated_tool_shape_run")!.severity).toBe("medium");
  });

  it("三个量级的定级严格单调（low < medium < high），量级信息不再丢失", () => {
    const rank = { low: 0, medium: 1, high: 2 } as const;
    const sev = (n: number) => {
      const ref = writeSession(`mono${n}`, runSession(n));
      const d = buildDigest(ref, false, paths)!;
      return rank[d.anomalies.find((x) => x.kind === "repeated_tool_shape_run")!.severity];
    };
    expect(sev(5)).toBeLessThan(sev(15));
    expect(sev(15)).toBeLessThan(sev(41));
  });
});

// ───────────────────────── P1-8：六个过程病态指标 ─────────────────────────

describe("P1-8 · poll_ratio（状态查询占比）", () => {
  it("分母取 PreToolUse 事件数而非 traj action 数（口径错会夸大近一倍）", () => {
    // traj 只记 10 个 action，但 events 记了 100 次真实调用（traj 会丢步）
    const steps: TrajStep[] = [];
    for (let i = 0; i < 10; i++) steps.push(...pair("bg_task_list", {}, `t${i}`));
    const events = [
      ...Array.from({ length: 20 }, () => ({
        event: "PreToolUse",
        data: { tool_name: "bg_task_list" },
      })),
      ...Array.from({ length: 80 }, () => ({ event: "PreToolUse", data: { tool_name: "read" } })),
    ];
    const p = computeProcessPathology(steps, events, START_MS);
    expect(p.totalCalls).toBe(100);
    expect(p.pollCalls).toBe(20);
    expect(p.pollRatio).toBeCloseTo(0.2, 5);
    expect(p.pollRatioPathological).toBe(true);
  });

  it("无 PreToolUse 事件时退化为按 traj action 计（老会话兜底）", () => {
    const steps = [...pair("bg_task_list", {}, "a"), ...pair("read", { file_path: "/a" }, "b")];
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.totalCalls).toBe(2);
    expect(p.pollCalls).toBe(1);
  });

  it("反向验收：健康会话（轮询占比 5%）不判病态", () => {
    const events = [
      ...Array.from({ length: 5 }, () => ({
        event: "PreToolUse",
        data: { tool_name: "bg_task_list" },
      })),
      ...Array.from({ length: 95 }, () => ({ event: "PreToolUse", data: { tool_name: "read" } })),
    ];
    const p = computeProcessPathology([], events, START_MS);
    expect(p.pollRatio).toBeCloseTo(0.05, 5);
    expect(p.pollRatioPathological).toBe(false);
  });
});

describe("P1-8 · zero_yield_subagents 与 subagent_io_ratio", () => {
  const subEvents = (statuses: string[], io: Array<[number, number]>) =>
    statuses.flatMap((st, i) => [
      { event: "SubagentStart", data: { agent_id: `a${i}`, agent_type: "task" } },
      {
        event: "SubagentStop",
        data: { agent_id: `a${i}`, status: st, input_tokens: io[i][0], output_tokens: io[i][1] },
      },
    ]);

  it("4 个全失败 → zeroYield=4，IO 比 208:1 判失衡", () => {
    const events = subEvents(
      ["error", "error", "error", "error"],
      [
        [389054, 2460],
        [783329, 2925],
        [415965, 1733],
        [254114, 1755],
      ],
    );
    const p = computeProcessPathology([], events, START_MS);
    expect(p.subagentTotal).toBe(4);
    expect(p.zeroYieldSubagents).toBe(4);
    expect(p.zeroYieldPathological).toBe(true);
    // 1,842,462 / 8,873 ≈ 207.6（实测值）
    expect(p.subagentIoRatio).toBeCloseTo(207.6, 1);
    expect(p.subagentIoPathological).toBe(true);
  });

  it("反向验收：子代理全成功且 IO 比 10:1 → 两项都不判病态", () => {
    const events = subEvents(
      ["completed", "completed"],
      [
        [10000, 1000],
        [10000, 1000],
      ],
    );
    const p = computeProcessPathology([], events, START_MS);
    expect(p.zeroYieldSubagents).toBe(0);
    expect(p.zeroYieldPathological).toBe(false);
    expect(p.subagentIoRatio).toBeCloseTo(10, 5);
    expect(p.subagentIoPathological).toBe(false);
  });

  it("没派子代理时 total=0 且 ioRatio 为 undefined（不是 0，两者含义不同）", () => {
    const p = computeProcessPathology([], [], START_MS);
    expect(p.subagentTotal).toBe(0);
    expect(p.subagentIoRatio).toBeUndefined();
    expect(p.subagentIoPathological).toBe(false);
  });

  it("output=0 时 ioRatio 留 undefined 而非 Infinity（除零不是可比较的度量）", () => {
    const events = subEvents(["error"], [[5000, 0]]);
    const p = computeProcessPathology([], events, START_MS);
    expect(p.subagentIoRatio).toBeUndefined();
    expect(p.subagentIoPathological).toBe(false);
  });
});

describe("P1-8 · edit_latency（首次编辑延迟）", () => {
  it("首次 edit 在第 18 分钟 → 判病态，值约 1116s", () => {
    const steps = [
      ...pair("read", { file_path: "/a" }, "x", START),
      ...pair("edit", { file_path: "/a" }, "ok", new Date(START_MS + 1_116_908).toISOString()),
    ];
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.editLatencyMs).toBe(1_116_908);
    expect(p.editLatencyPathological).toBe(true);
  });

  it("反向验收：1 分钟内开始编辑 → 不判病态", () => {
    const steps = [
      ...pair("edit", { file_path: "/a" }, "ok", new Date(START_MS + 60_000).toISOString()),
    ];
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.editLatencyMs).toBe(60_000);
    expect(p.editLatencyPathological).toBe(false);
  });

  it("反向验收：纯只读会话（从未编辑）不判病态——否则每个问答都会误报", () => {
    const steps = [...pair("read", { file_path: "/a" }, "x", START)];
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.editLatencyMs).toBeUndefined();
    expect(p.editLatencyPathological).toBe(false);
  });

  it("缺 start_time 时留 undefined，不判病态（缺数据不等于有病）", () => {
    const steps = [...pair("edit", { file_path: "/a" }, "ok", START)];
    const p = computeProcessPathology(steps, [], undefined);
    expect(p.editLatencyMs).toBeUndefined();
    expect(p.editLatencyPathological).toBe(false);
  });
});

describe("P1-8 · observation_entropy（重复劳动是否产出新信息）", () => {
  it("同命令连续 7 次返回值都是 139 → 判空转", () => {
    const cmd = { command: "tsc --noEmit | grep -c 'error TS'" };
    const steps: TrajStep[] = [];
    for (let i = 0; i < 7; i++) steps.push(...pair("bash", cmd, "139\n"));
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.maxUnchangedObservationRun).toBe(7);
    expect(p.unchangedObservationTool).toBe("bash");
    expect(p.observationEntropyPathological).toBe(true);
  });

  it("重复调用之间夹着别的工具仍能算出（按指纹分组，非全局相邻）", () => {
    // 这是最初实现的真实缺陷：全局相邻判定对这种形态只能算出 2
    const cmd = { command: "tsc --noEmit | grep -c 'error TS'" };
    const steps: TrajStep[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push(...pair("bash", cmd, "139\n"));
      steps.push(...pair("read", { file_path: `/f${i}.ts` }, `content ${i}`));
      steps.push(...pair("edit", { file_path: `/f${i}.ts` }, "ok"));
    }
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.maxUnchangedObservationRun).toBe(5);
    expect(p.observationEntropyPathological).toBe(true);
  });

  it("反向验收：返回值每次都变的轮询不判空转（49 次 bg_task_list 是合法轮询）", () => {
    const steps: TrajStep[] = [];
    for (let i = 0; i < 49; i++) steps.push(...pair("bg_task_list", {}, `progress ${i}%`));
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.maxUnchangedObservationRun).toBe(0);
    expect(p.observationEntropyPathological).toBe(false);
  });

  it("入参键序不同不影响指纹（稳定序列化，否则重复被算成不重复）", () => {
    const steps = [
      ...pair("bash", { command: "ls", cwd: "/a" }, "out"),
      ...pair("bash", { cwd: "/a", command: "ls" }, "out"),
      ...pair("bash", { command: "ls", cwd: "/a" }, "out"),
    ];
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.maxUnchangedObservationRun).toBe(3);
  });

  it("两次都缺观察值不算'返回值相同'（未闭合 ≠ 空转）", () => {
    const steps: TrajStep[] = [
      {
        message_type: "action",
        role: "assistant",
        tool_name: "bash",
        tool_input: { command: "x" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "bash",
        tool_input: { command: "x" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "bash",
        tool_input: { command: "x" },
      },
    ];
    const p = computeProcessPathology(steps, [], START_MS);
    expect(p.maxUnchangedObservationRun).toBe(0);
    expect(p.observationEntropyPathological).toBe(false);
  });
});

describe("P1-8 · retry_wasted_tokens（重试白烧）", () => {
  const mk = (connected: number, turns: number, inputPerTurn: number) => [
    ...Array.from({ length: connected }, (_, i) => ({
      event: "HttpConnected",
      data: { index: i, status: 200 },
    })),
    ...Array.from({ length: turns }, (_, i) => ({
      event: "AfterModelRaw",
      data: { index: i, usage: { input_tokens: inputPerTurn } },
    })),
  ];

  it("254 次建连 vs 153 轮记账 → 101 次白建，约 13.6M token", () => {
    const p = computeProcessPathology([], mk(254, 153, 134_379), START_MS);
    expect(p.extraConnections).toBe(101);
    expect(p.retryWastedTokens).toBe(101 * 134_379);
    expect(p.retryWastedPathological).toBe(true);
  });

  it("反向验收：建连数与记账轮次相等 → 零浪费，不判病态", () => {
    const p = computeProcessPathology([], mk(100, 100, 50_000), START_MS);
    expect(p.extraConnections).toBe(0);
    expect(p.retryWastedTokens).toBeUndefined();
    expect(p.retryWastedRatio).toBeUndefined();
    expect(p.retryWastedPathological).toBe(false);
  });

  it("浪费占比 10%（低于阈值 20%）不判病态", () => {
    // 100 轮 + 10 次白建 = 10% 占比
    const p = computeProcessPathology([], mk(110, 100, 1000), START_MS);
    expect(p.extraConnections).toBe(10);
    expect(p.retryWastedRatio).toBeCloseTo(0.1, 5);
    expect(p.retryWastedPathological).toBe(false);
  });

  it("有 HttpConnected 但无 usage 时留 undefined（给 0 会被误读成'没有浪费'）", () => {
    const events = [
      { event: "HttpConnected", data: { index: 1 } },
      { event: "HttpConnected", data: { index: 2 } },
      { event: "AfterModelRaw", data: { index: 1 } },
    ];
    const p = computeProcessPathology([], events, START_MS);
    expect(p.extraConnections).toBe(1);
    expect(p.retryWastedTokens).toBeUndefined();
    expect(p.retryWastedPathological).toBe(false);
  });
});

// ───────────────── 接线 + 反向验收：健康会话六项全部在阈值内 ─────────────────

describe("P1-8/P1-7 · buildDigest 接线与健康会话反向验收", () => {
  /** 一次干净的编辑会话：读两个文件、改一个、验证一次，无子代理无重试 */
  function healthySession() {
    const steps = [
      ...pair("read", { file_path: "/a.ts" }, "content a", START),
      ...pair("read", { file_path: "/b.ts" }, "content b", new Date(START_MS + 5000).toISOString()),
      ...pair("edit", { file_path: "/a.ts" }, "ok", new Date(START_MS + 30_000).toISOString()),
      ...pair("bash", { command: "bun test" }, "5 pass", new Date(START_MS + 60_000).toISOString()),
    ];
    const events = [
      { event: "SessionStart", data: {} },
      ...["read", "read", "edit", "bash"].map((t) => ({
        event: "PreToolUse",
        data: { tool_name: t },
      })),
      { event: "HttpConnected", data: { index: 1 } },
      { event: "HttpConnected", data: { index: 2 } },
      { event: "AfterModelRaw", data: { index: 1, usage: { input_tokens: 20000 } } },
      { event: "AfterModelRaw", data: { index: 2, usage: { input_tokens: 22000 } } },
      { event: "SessionEnd", data: {} },
    ];
    return {
      traj: {
        trajectory: steps,
        info: { exit_status: "end_turn" },
        metadata: {
          session_id: "healthy",
          model: "m",
          exit_status: "end_turn",
          start_time: START,
          end_time: new Date(START_MS + 90_000).toISOString(),
          tools_used: ["read", "edit", "bash"],
          files_edited: ["/a.ts"],
          user_prompts: ["改一下 a.ts"],
        },
      },
      events,
    };
  }

  it("buildDigest 输出 pathology 字段（算了必须被消费，不能算完丢掉）", () => {
    const h = healthySession();
    const ref = writeSession("wired", h.traj, h.events);
    const d = buildDigest(ref, false, paths)!;
    expect(d.pathology).toBeDefined();
    expect(d.pathology!.totalCalls).toBe(4);
  });

  it("反向验收：健康会话六项全部在阈值内（防误报刷屏）", () => {
    const h = healthySession();
    const ref = writeSession("healthy", h.traj, h.events);
    const d = buildDigest(ref, false, paths)!;
    const p = d.pathology!;
    expect(p.pollRatioPathological).toBe(false);
    expect(p.zeroYieldPathological).toBe(false);
    expect(p.subagentIoPathological).toBe(false);
    expect(p.editLatencyPathological).toBe(false);
    expect(p.observationEntropyPathological).toBe(false);
    expect(p.retryWastedPathological).toBe(false);
  });

  it("反向验收：健康会话不产生任何 [高] 级异常（P1-7 的 WARN 通道不得被误触）", () => {
    const h = healthySession();
    const ref = writeSession("healthy2", h.traj, h.events);
    const d = buildDigest(ref, false, paths)!;
    const highs = d.anomalies.filter((a) => a.severity === "high");
    expect(highs).toEqual([]);
  });

  it("反向验收：健康会话不产生任何 pathology 类 anomaly", () => {
    const PATHOLOGY_KINDS = [
      "poll_ratio_high",
      "zero_yield_subagents",
      "subagent_io_imbalance",
      "edit_latency_high",
      "observation_entropy_zero",
      "retry_wasted_tokens",
    ];
    const h = healthySession();
    const ref = writeSession("healthy3", h.traj, h.events);
    const d = buildDigest(ref, false, paths)!;
    expect(d.anomalies.filter((a) => PATHOLOGY_KINDS.includes(a.kind))).toEqual([]);
  });

  it("病态会话产生 pathology 类 anomaly，且带 provenance（出处可追）", () => {
    const steps: TrajStep[] = [];
    for (let i = 0; i < 20; i++) {
      steps.push(...pair("bg_task_list", {}, `p${i}`, new Date(START_MS + i * 5000).toISOString()));
    }
    const events = Array.from({ length: 20 }, () => ({
      event: "PreToolUse",
      data: { tool_name: "bg_task_list" },
    }));
    const ref = writeSession(
      "sick",
      {
        trajectory: steps,
        info: { exit_status: "end_turn" },
        metadata: {
          session_id: "sick",
          model: "m",
          exit_status: "end_turn",
          start_time: START,
          tools_used: ["bg_task_list"],
        },
      },
      events,
    );
    const d = buildDigest(ref, false, paths)!;
    const a = d.anomalies.find((x) => x.kind === "poll_ratio_high")!;
    expect(a).toBeDefined();
    expect(a.layer).toBe("L0");
    expect(a.severity).toBe("medium"); // 过程可疑 ≠ 确证故障，见 describePathology 注释
    expect(a.provenance?.[0]?.sourceFile).toContain("events.jsonl");
  });

  it("异常排序契约不被破坏：high 仍排在 medium 之前", () => {
    const steps: TrajStep[] = [];
    for (let i = 0; i < 41; i++) {
      steps.push(...pair("bg_task_list", {}, `p${i}`, new Date(START_MS + i * 5000).toISOString()));
    }
    const events = Array.from({ length: 41 }, () => ({
      event: "PreToolUse",
      data: { tool_name: "bg_task_list" },
    }));
    const ref = writeSession(
      "order",
      {
        trajectory: steps,
        info: { exit_status: "end_turn" },
        metadata: {
          session_id: "order",
          model: "m",
          exit_status: "end_turn",
          start_time: START,
          tools_used: ["bg_task_list"],
        },
      },
      events,
    );
    const d = buildDigest(ref, false, paths)!;
    const l0 = d.anomalies.filter((a) => a.layer === "L0");
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < l0.length; i++) {
      expect(rank[l0[i - 1].severity]).toBeLessThanOrEqual(rank[l0[i].severity]);
    }
  });
});
