/**
 * digest：「打转」按完整入参判 + 异常按判据计数（2026-11-02，排查诊断检测器精度治理 T1 + T4）。
 *
 * T1：本地 158 次形状命中里 149 次最长段的完整入参全部不同（`cd <worktree> && …` 开头的不同命令
 *     被截成同一形状）。hypothesis_stuck_loop 改为完整入参连续相同 ≥ 3 才推；轮询降级不豁免。
 * T4：成对推入的 L0 事实 + L1 假设共用 criterion，summary 按判据去重。
 *
 * 落盘隔离：全程 resolvePaths(tmpdir)，不碰 ~/.sid-code。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  buildDigest,
  maxIdenticalCallRun,
  ANOMALY_CRITERION,
  type DigestPaths,
  type TrajStep,
} from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-digest-loop-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-02T00:00:00.000Z");

/** n 次 bash 调用，间隔 5 秒（> 1 秒并行窗口），命令与返回值由回调给出 */
function bashRun(n: number, cmd: (i: number) => string, obs: (i: number) => string): TrajStep[] {
  const steps: TrajStep[] = [];
  for (let i = 0; i < n; i++) {
    steps.push(
      {
        message_type: "action",
        role: "assistant",
        tool_name: "bash",
        tool_input: { command: cmd(i), description: "x" },
        timestamp: new Date(T0 + i * 5_000).toISOString() as unknown as number,
      },
      { message_type: "observation", role: "user", content: obs(i), is_error: false },
    );
  }
  return steps;
}

function digestOf(id: string, steps: TrajStep[], events: unknown[] = []) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.traj"),
    JSON.stringify({ trajectory: steps, metadata: { session_id: id, exit_status: "end_turn" } }),
  );
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ref = { id, dir, trajPath: join(dir, "session.traj"), mtimeMs: Date.now() };
  return buildDigest(ref, false, paths)!;
}

const find = (d: ReturnType<typeof digestOf>, kind: string) =>
  d.anomalies.filter((a) => a.kind === kind);

const WT = "cd /repo/.sid-code/worktrees/feat-x";

// ── T1 ──────────────────────────────────────────────────────────────────────

describe("T1 hypothesis_stuck_loop 按完整入参判", () => {
  it("38 条 `cd <wt> && …` 开头的不同命令：形状段仍报（上限 medium），但不推「打转」", () => {
    const d = digestOf(
      "cdrun",
      bashRun(
        38,
        (i) => `${WT} && bun test case-${i}`,
        (i) => `ok ${i}`,
      ),
    );
    const l0 = find(d, "repeated_tool_shape_run");
    expect(l0).toHaveLength(1);
    expect(l0[0].severity).toBe("medium"); // 38 ≥ 30，原来是 high
    expect(find(d, "hypothesis_stuck_loop")).toHaveLength(0);
  });

  it("4 次完全相同的 `gh run view`，返回 in_progress：判为轮询，low", () => {
    const d = digestOf(
      "poll",
      bashRun(
        4,
        () => "gh run view 123 --json status",
        () => '{"status":"in_progress"}',
      ),
    );
    const l1 = find(d, "hypothesis_stuck_loop");
    expect(l1).toHaveLength(1);
    expect(l1[0].severity).toBe("low");
    expect(l1[0].detail).toContain("轮询");
  });

  it("`gh pr checks` 的制表符分隔输出（…\\tpending\\t…）返回值不变：仍判为轮询", () => {
    // 回归：曾按 JSON 序列化后的文本匹配，制表符变成字面量 \t，\bpending 边界失效
    const d = digestOf(
      "tabpoll",
      bashRun(
        4,
        () => "gh pr checks 340",
        () => "test (macos-latest)\tpending\t0\thttps://x",
      ),
    );
    const l1 = find(d, "hypothesis_stuck_loop");
    expect(l1[0]?.severity).toBe("low");
    expect(l1[0]?.detail).toContain("轮询");
  });

  it("4 次完全相同的命令、返回值完全相同且无进行中状态：真打转，medium", () => {
    const d = digestOf(
      "stuck",
      bashRun(
        4,
        () => "grep -c foo src/a.ts",
        () => "0",
      ),
    );
    const l1 = find(d, "hypothesis_stuck_loop");
    expect(l1).toHaveLength(1);
    expect(l1[0].severity).toBe("medium");
    expect(l1[0].detail).toContain("原地打转");
  });

  it("12 次真打转：high", () => {
    const d = digestOf(
      "stuck12",
      bashRun(
        12,
        () => "grep -c foo src/a.ts",
        () => "0",
      ),
    );
    expect(find(d, "hypothesis_stuck_loop")[0]?.severity).toBe("high");
  });

  it("只有 2 次相同：不推", () => {
    const d = digestOf(
      "two",
      bashRun(
        2,
        () => "grep -c foo src/a.ts",
        () => "0",
      ),
    );
    expect(find(d, "hypothesis_stuck_loop")).toHaveLength(0);
  });

  it("1 秒内同指纹的调用算并行派发，不计入连续段", () => {
    const steps: TrajStep[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push(
        {
          message_type: "action",
          role: "assistant",
          tool_name: "read",
          tool_input: { file_path: "/a.ts" },
          timestamp: new Date(T0 + i * 100).toISOString() as unknown as number,
        },
        { message_type: "observation", role: "user", content: "same", is_error: false },
      );
    }
    expect(maxIdenticalCallRun(steps).run).toBe(0);
  });

  it("入参键序不同视为同一指纹（stableStringify）", () => {
    const steps: TrajStep[] = [];
    const inputs = [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      { a: 1, b: 2 },
    ];
    inputs.forEach((input, i) => {
      steps.push(
        {
          message_type: "action",
          role: "assistant",
          tool_name: "grep",
          tool_input: input,
          timestamp: new Date(T0 + i * 5_000).toISOString() as unknown as number,
        },
        { message_type: "observation", role: "user", content: "x", is_error: false },
      );
    });
    expect(maxIdenticalCallRun(steps).run).toBe(3);
  });
});

// ── T4 ──────────────────────────────────────────────────────────────────────

describe("T4 异常按判据计数", () => {
  it("成对推入的 L0 + L1 共用 criterion，未登记的 kind 的 criterion 等于自身", () => {
    // 孤儿 tool_use：中间留一个没有结果的调用 → tool_use_without_result + hypothesis_crash_or_violation
    const steps: TrajStep[] = [
      {
        message_type: "action",
        role: "assistant",
        tool_name: "bash",
        tool_input: { command: "a" },
      },
      {
        message_type: "observation",
        role: "user",
        content: "[no result]",
        _orphan: true,
      } as TrajStep,
      {
        message_type: "action",
        role: "assistant",
        tool_name: "bash",
        tool_input: { command: "b" },
      },
      { message_type: "observation", role: "user", content: "ok", is_error: false },
    ];
    const d = digestOf("pair", steps);
    const fact = find(d, "tool_use_without_result")[0];
    const hyp = find(d, "hypothesis_crash_or_violation")[0];
    expect(fact).toBeDefined();
    expect(hyp).toBeDefined();
    expect(fact.criterion).toBe(hyp.criterion);
    for (const a of d.anomalies) expect(a.criterion).toBe(ANOMALY_CRITERION[a.kind] ?? a.kind);
  });

  it("登记表自检：digest.ts 里每个 hypothesis_* kind 都在 ANOMALY_CRITERION 里登记了判据", () => {
    // 新增成对推入却忘了登记，summary 又会按 kind 把一个判据数成两个 —— 用源码扫描兜住
    const src = readFileSync(join(import.meta.dir, "../../src/trace/digest.ts"), "utf8");
    const hyps = [...new Set([...src.matchAll(/kind: "(hypothesis_[a-z_]+)"/g)].map((m) => m[1]))];
    expect(hyps.length).toBeGreaterThanOrEqual(9);
    for (const h of hyps) expect(ANOMALY_CRITERION[h], h).toBeDefined();
  });
});
