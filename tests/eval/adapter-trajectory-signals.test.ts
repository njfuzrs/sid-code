/**
 * W10.D3a 单元测试 — adapter L2 trajectory 信号解析 + max_steps fallback
 */

import { describe, test, expect } from "bun:test";
import { analyzeTrajectorySignals } from "../../evals/bench-runner/adapters/sid-code.ts";
import { computeEffectiveMaxSteps } from "../../evals/bench-runner/runner.ts";

describe("analyzeTrajectorySignals — error_count", () => {
  test("空 trajectory 返回 0", () => {
    const r = analyzeTrajectorySignals([]);
    expect(r.error_count).toBe(0);
    expect(r.retry_count).toBe(0);
    expect(r.backtrack_count).toBe(0);
  });

  test("is_error == true 计入 error_count", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "observation", role: "user", is_error: true, content: "Tavily API error" },
      { message_type: "observation", role: "user", is_error: false, content: "ok" },
      { message_type: "observation", role: "user", is_error: true, content: "Permission denied" },
    ]);
    expect(r.error_count).toBe(2);
  });

  test("is_error 缺失视为非错误", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "observation", role: "user", content: "ok" },
    ]);
    expect(r.error_count).toBe(0);
  });
});

describe("analyzeTrajectorySignals — retry_count", () => {
  test("相邻同 tool + 相同 input 视为 retry", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/a.ts" } },
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/a.ts" } },
    ]);
    expect(r.retry_count).toBe(1);
  });

  test("相邻同 tool + 不同 input 不算 retry", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/a.ts" } },
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/b.ts" } },
    ]);
    expect(r.retry_count).toBe(0);
  });

  test("中间隔了 observation 也算相邻 action", () => {
    // observation 不是 action，actions 列表只收 message_type=action 的
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/a.ts" } },
      { message_type: "observation", role: "user", content: "result" },
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/a.ts" } },
    ]);
    expect(r.retry_count).toBe(1);
  });

  test("3 次连续相同 = 2 次 retry", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Bash", tool_input: { command: "ls" } },
      { message_type: "action", role: "assistant", tool_name: "Bash", tool_input: { command: "ls" } },
      { message_type: "action", role: "assistant", tool_name: "Bash", tool_input: { command: "ls" } },
    ]);
    expect(r.retry_count).toBe(2);
  });
});

describe("analyzeTrajectorySignals — backtrack_count", () => {
  test("Write 同一 file 两次 = 1 次 backtrack", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Write", tool_input: { file_path: "/x.ts", content: "v1" } },
      { message_type: "action", role: "assistant", tool_name: "Write", tool_input: { file_path: "/x.ts", content: "v2" } },
    ]);
    expect(r.backtrack_count).toBe(1);
  });

  test("Edit / Write 混合也算 backtrack", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Write", tool_input: { file_path: "/x.ts" } },
      { message_type: "action", role: "assistant", tool_name: "Edit", tool_input: { file_path: "/x.ts" } },
      { message_type: "action", role: "assistant", tool_name: "Edit", tool_input: { file_path: "/x.ts" } },
    ]);
    expect(r.backtrack_count).toBe(2);
  });

  test("不同 file 不算 backtrack", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Write", tool_input: { file_path: "/x.ts" } },
      { message_type: "action", role: "assistant", tool_name: "Write", tool_input: { file_path: "/y.ts" } },
    ]);
    expect(r.backtrack_count).toBe(0);
  });

  test("Read 同 file 两次不算 backtrack（不是 write 类工具）", () => {
    const r = analyzeTrajectorySignals([
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/x.ts" } },
      { message_type: "action", role: "assistant", tool_name: "Read", tool_input: { file_path: "/x.ts" } },
    ]);
    expect(r.backtrack_count).toBe(0);
  });
});

describe("computeEffectiveMaxSteps — bench v0.1 fallback", () => {
  test("yaml=45, estimated=88 → 132（公式 88 × 1.5）", () => {
    expect(computeEffectiveMaxSteps({ yamlMaxSteps: 45, estimatedTurns: 88 })).toBe(132);
  });

  test("yaml=45, estimated=45 → 45（不触发 fallback）", () => {
    expect(computeEffectiveMaxSteps({ yamlMaxSteps: 45, estimatedTurns: 45 })).toBe(45);
  });

  test("yaml=45, estimated=10 → 45（estimated 比 yaml 小，不 fallback）", () => {
    expect(computeEffectiveMaxSteps({ yamlMaxSteps: 45, estimatedTurns: 10 })).toBe(45);
  });

  test("yaml=100（非 frozen 值）→ 100（不动）", () => {
    expect(computeEffectiveMaxSteps({ yamlMaxSteps: 100, estimatedTurns: 200 })).toBe(100);
  });

  test("estimated=400 触发 500 上限", () => {
    expect(computeEffectiveMaxSteps({ yamlMaxSteps: 45, estimatedTurns: 400 })).toBe(500);
  });

  test("yaml 缺失 → 默认 30", () => {
    expect(computeEffectiveMaxSteps({ estimatedTurns: 100 })).toBe(30);
  });
});
