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
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/a.ts" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/a.ts" },
      },
    ]);
    expect(r.retry_count).toBe(1);
  });

  test("相邻同 tool + 不同 input 不算 retry", () => {
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/a.ts" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/b.ts" },
      },
    ]);
    expect(r.retry_count).toBe(0);
  });

  test("中间隔了 observation 也算相邻 action", () => {
    // observation 不是 action，actions 列表只收 message_type=action 的
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/a.ts" },
      },
      { message_type: "observation", role: "user", content: "result" },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/a.ts" },
      },
    ]);
    expect(r.retry_count).toBe(1);
  });

  test("3 次连续相同 = 2 次 retry", () => {
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    ]);
    expect(r.retry_count).toBe(2);
  });
});

/**
 * P2-11：retry 判据从「相邻」改为「滑动窗口内同指纹」。
 *
 * 旧判据只比 actions[i] 与 actions[i-1]，插一个只读调用就把链条切断、计数缩水，
 * 等于给「原地打转」留了免检通道。这里钉住「插步不再能断链」。
 */
describe("analyzeTrajectorySignals — retry_count 窗口化（P2-11）", () => {
  /** 造一个 action 步骤 */
  const action = (tool: string, input: Record<string, unknown>) => ({
    message_type: "action" as const,
    role: "assistant",
    tool_name: tool,
    tool_input: input,
  });

  const A = () => action("Bash", { command: "bun test foo" });
  const READ = () => action("Read", { file_path: "/some/other.ts" });

  test("A A read A A A：插入的只读调用不再断链", () => {
    const r = analyzeTrajectorySignals([A(), A(), READ(), A(), A(), A()]);

    // 同一个 A 被发了 5 次 → 首次不算重试，重复 4 次。
    // 旧实现在这里算 1+2=3（被 read 切成两段），少记 1 次。
    expect(r.retry_count).toBe(4);
    // 峰值：这一簇 A 的规模是 5，即「同一个调用最多被连着发了 5 次」。
    // 方案文档写的「重复计数为 5」指的是这个口径（含首次的簇规模），
    // 而 retry_count 沿用既有语义（不含首次），两个数字各有其义、不要混。
    expect(r.max_repeat_cluster).toBe(5);
  });

  test("旧判据的漏检形态：A read A → 记 1 次重试（旧实现记 0）", () => {
    const r = analyzeTrajectorySignals([A(), READ(), A()]);
    expect(r.retry_count).toBe(1);
    expect(r.max_repeat_cluster).toBe(2);
  });

  test("间隔超出窗口（>10 步）不算重试：偶然重复同一命令不误判", () => {
    // A ...12 个不同的中间步骤... A → 窗口内看不到前一个 A
    const filler = Array.from({ length: 12 }, (_, i) => action("Read", { file_path: `/f${i}.ts` }));
    const r = analyzeTrajectorySignals([A(), ...filler, A()]);
    expect(r.retry_count).toBe(0);
    expect(r.max_repeat_cluster).toBe(1);
  });

  test("不同 input 前缀仍不算重试（指纹口径未变）", () => {
    const r = analyzeTrajectorySignals([
      action("Bash", { command: "bun test a" }),
      READ(),
      action("Bash", { command: "bun test b" }),
    ]);
    expect(r.retry_count).toBe(0);
  });

  test("多簇累加与峰值分离：两处各重试一次 ≠ 一处死磕三次", () => {
    const B = () => action("Bash", { command: "make build" });
    // A A（重复1） … B B（重复1）：累加 2，峰值 2
    const spread = analyzeTrajectorySignals([A(), A(), READ(), B(), B()]);
    expect(spread.retry_count).toBe(2);
    expect(spread.max_repeat_cluster).toBe(2);

    // A A A（重复2）：累加 2 与上例相同，但峰值 3 —— 靠峰值才能区分这两种失败模式
    const stuck = analyzeTrajectorySignals([A(), A(), A()]);
    expect(stuck.retry_count).toBe(2);
    expect(stuck.max_repeat_cluster).toBe(3);
  });

  test("空输入的峰值为 0，不是 1", () => {
    const r = analyzeTrajectorySignals([]);
    expect(r.retry_count).toBe(0);
    expect(r.max_repeat_cluster).toBe(0);
  });
});

describe("analyzeTrajectorySignals — backtrack_count", () => {
  test("Write 同一 file 两次 = 1 次 backtrack", () => {
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Write",
        tool_input: { file_path: "/x.ts", content: "v1" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Write",
        tool_input: { file_path: "/x.ts", content: "v2" },
      },
    ]);
    expect(r.backtrack_count).toBe(1);
  });

  test("Edit / Write 混合也算 backtrack", () => {
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Write",
        tool_input: { file_path: "/x.ts" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Edit",
        tool_input: { file_path: "/x.ts" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Edit",
        tool_input: { file_path: "/x.ts" },
      },
    ]);
    expect(r.backtrack_count).toBe(2);
  });

  test("不同 file 不算 backtrack", () => {
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Write",
        tool_input: { file_path: "/x.ts" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Write",
        tool_input: { file_path: "/y.ts" },
      },
    ]);
    expect(r.backtrack_count).toBe(0);
  });

  test("Read 同 file 两次不算 backtrack（不是 write 类工具）", () => {
    const r = analyzeTrajectorySignals([
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/x.ts" },
      },
      {
        message_type: "action",
        role: "assistant",
        tool_name: "Read",
        tool_input: { file_path: "/x.ts" },
      },
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
