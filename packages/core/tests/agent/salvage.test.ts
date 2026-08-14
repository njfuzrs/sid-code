/**
 * P0-1(b) 残卷 + P0-1(c) 墙钟预算派生的单测。
 *
 * 这两个模块是"1.84M input token 产出归零"那个缺陷的正面修复，验收口径来自方案 §1.6：
 *   - 主 agent 收到的 output **包含已改动文件清单**，而不是只有一句"超时"；
 *   - usage/turns 按实际值回填，不归零。
 *
 * 为什么这些断言值得单独立测（而不只靠 sub-agent.test.ts 的端到端那条）：
 * 端到端那条用 HangingProvider，**零轮产出**——它证明得了"残卷骨架在"，但证明不了
 * "真的把已改动文件捞回来了"。而后者恰恰是本次修复的全部意义所在。
 *
 * 落盘隔离：本文件涉及的两个模块都是**纯内存**的（salvage 无 IO；timeout-budget 的样本
 * 存在模块级 Map，见其头注释里"为什么不去查 events.jsonl"），所以不需要 SID_CONFIG_DIR
 * 重定向。timeout-budget 的模块级状态用 resetTurnLatencySamples() 在每个 test 前清，
 * 避免同进程内多文件互相污染（bun test 同批跑在一个进程里）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { SalvageCollector, buildSalvageOutput } from "@sid-code/core/agent/salvage.ts";
import {
  resolveSubAgentTimeout,
  recordTurnLatency,
  resetTurnLatencySamples,
  turnLatencySampleCount,
  MIN_SAMPLES,
  TARGET_TURNS,
  DERIVED_MAX_MS,
  HARD_KILL_MULTIPLIER,
} from "@sid-code/core/agent/timeout-budget.ts";

describe("P0-1(b) 残卷收集器", () => {
  test("从 write/edit 调用里攒出已改动文件清单（去重、保序）", () => {
    const c = new SalvageCollector();
    c.recordTurn({
      turn: 1,
      textOutput: "先读代码",
      tools: [{ name: "read", input: { file_path: "/a/read-only.ts" } }],
      tokenCount: 100,
      toolUseCount: 1,
    });
    c.recordTurn({
      turn: 2,
      textOutput: "改了两个文件",
      tools: [
        { name: "edit", input: { file_path: "/a/x.ts" } },
        { name: "write", input: { file_path: "/a/y.ts" } },
        { name: "edit", input: { file_path: "/a/x.ts" } }, // 重复改同一个文件
      ],
      tokenCount: 300,
      toolUseCount: 4,
    });

    const snap = c.snapshot();
    // 只读工具的路径**不得**进"已改动"清单：把 read 的路径算进去比没有清单更坏
    // （主代理会基于"这个文件被动过了"这个假前提继续做）
    expect(snap.changedFiles).toEqual(["/a/x.ts", "/a/y.ts"]);
    expect(snap.turns).toBe(2);
    expect(snap.toolUseCount).toBe(4);
    expect(snap.tokenCount).toBe(300);
  });

  test("跨轮沿用的同一段文本只收一次（否则挤掉真正的新信息）", () => {
    const c = new SalvageCollector();
    // agentic-loop 的 lastTextOutput 在本轮无文本时保持上一轮的值，
    // 不去重会把同一段结论抄进残卷 N 遍
    c.recordTurn({ turn: 1, textOutput: "结论 A", tools: [], tokenCount: 10, toolUseCount: 0 });
    c.recordTurn({ turn: 2, textOutput: "结论 A", tools: [], tokenCount: 20, toolUseCount: 0 });
    c.recordTurn({ turn: 3, textOutput: "结论 B", tools: [], tokenCount: 30, toolUseCount: 0 });
    expect(c.snapshot().findings).toEqual(["结论 A", "结论 B"]);
  });

  test("记录最后一步活动（用于说明卡在哪）", () => {
    const c = new SalvageCollector();
    c.recordTurn({
      turn: 1,
      textOutput: "",
      tools: [{ name: "grep", input: { pattern: "inputBorderColor" } }],
      tokenCount: 10,
      toolUseCount: 1,
    });
    expect(c.snapshot().lastActivity).toBe("grep: inputBorderColor");
  });
});

describe("P0-1(b) 残卷输出（§1.6 验收口径）", () => {
  /** 复刻事故形态：跑了多轮、改过文件、有结论，然后撞墙钟。 */
  function accidentShapedSnapshot() {
    const c = new SalvageCollector();
    c.recordTurn({
      turn: 1,
      textOutput: "已确认 Color 类型定义在 ink.d.ts",
      tools: [{ name: "read", input: { file_path: "/cache/ink.d.ts" } }],
      tokenCount: 169174,
      toolUseCount: 17,
    });
    c.recordTurn({
      turn: 2,
      textOutput: "开始改 UI",
      tools: [{ name: "edit", input: { file_path: "/src/ui/theme.ts" } }],
      tokenCount: 389054,
      toolUseCount: 32,
    });
    return c.snapshot();
  }

  test("§1.6 核心：output 含已改动文件清单，而非只有一句超时", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "timeout",
      finalText: "",
      timeoutMs: 300_000,
    });
    expect(out).toContain("/src/ui/theme.ts");
    expect(out).toContain('<changed-files count="1">');
    // 反向断言：不能退化成改造前那种"一句话"输出
    expect(out.length).toBeGreaterThan(200);
  });

  test("finalText 原样置顶保留（绝不被替换——这是本次修复的硬约束）", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "timeout",
      finalText: "## 发现\nColor 类型是 string 联合",
      timeoutMs: 300_000,
    });
    // 子代理自己的结论必须在最前面、逐字保留
    expect(out.startsWith("## 发现\nColor 类型是 string 联合")).toBe(true);
    // 残卷是**追加**而非替换
    expect(out).toContain("<partial-result>");
  });

  test("已确认的关键结论进 findings 段", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "timeout",
      timeoutMs: 300_000,
    });
    expect(out).toContain("已确认 Color 类型定义在 ink.d.ts");
  });

  test("零改动时显式给 count=0（区分「没改」与「不知道改没改」）", () => {
    const out = buildSalvageOutput(new SalvageCollector().snapshot(), {
      reason: "timeout",
      timeoutMs: 300_000,
    });
    expect(out).toContain('<changed-files count="0"/>');
  });

  test("detach 的下一步建议指向阻塞等待，而不是让模型继续轮询", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "detached",
      timeoutMs: 300_000,
      taskId: "a5bag4tp2",
    });
    // 与 P1-3 呼应：给出具体可调用的工具与参数，消除轮询动机
    expect(out).toContain("bg_task_get");
    expect(out).toContain("block: true");
    expect(out).toContain("a5bag4tp2");
    expect(out).toContain("未被终止");
  });

  test("已落盘的改动要明确告知「不要重做」", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "timeout",
      timeoutMs: 300_000,
    });
    expect(out).toContain("已经落盘生效");
  });

  test("error 成因必须带上真实错误消息（不得替换成笼统的「执行异常」）", () => {
    // 这正是历史上「限流误报成超时」那类错误归因缺陷的同型病灶
    const out = buildSalvageOutput(new SalvageCollector().snapshot(), {
      reason: "error",
      errorMessage: "429 rate_limit_exceeded",
    });
    expect(out).toContain("429 rate_limit_exceeded");
  });

  test("零轮产出时如实指出是起步即失败", () => {
    const out = buildSalvageOutput(new SalvageCollector().snapshot(), {
      reason: "timeout",
      timeoutMs: 300_000,
    });
    expect(out).toContain("起步即失败");
    expect(out).toContain("尚未产生任何工具调用");
  });
});

describe("P0-1(c) 墙钟预算按实测吞吐派生", () => {
  beforeEach(() => {
    resetTurnLatencySamples();
    delete process.env.SID_CODE_SUBAGENT_TIMEOUT_MS;
  });

  test("显式 task.timeout 优先级最高（调用方比我们更清楚）", () => {
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      explicitTimeoutMs: 50,
      model: "m",
      fallbackMs: 120_000,
    });
    expect(r.timeoutMs).toBe(50);
    expect(r.source).toBe("explicit");
  });

  test("env 覆盖入口生效（settings/env 覆盖是 §1.5(c) 的要求）", () => {
    process.env.SID_CODE_SUBAGENT_TIMEOUT_MS = "77000";
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      model: "m",
      fallbackMs: 120_000,
    });
    expect(r.timeoutMs).toBe(77_000);
    expect(r.source).toBe("env");
  });

  test("非法 env 静默回退，绝不把 NaN 交给 setTimeout（那等价于立即触发）", () => {
    process.env.SID_CODE_SUBAGENT_TIMEOUT_MS = "abc";
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      model: "m",
      fallbackMs: 120_000,
    });
    expect(r.timeoutMs).toBe(300_000);
    expect(r.source).toBe("definition");
  });

  test("样本不足时回退 AgentDefinition.timeout（行为与改造前逐字节一致）", () => {
    recordTurnLatency("slow-model", 30_000); // 只喂 1 条，远少于 MIN_SAMPLES
    expect(turnLatencySampleCount("slow-model")).toBe(1);
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      model: "slow-model",
      fallbackMs: 120_000,
    });
    expect(r.timeoutMs).toBe(300_000);
    expect(r.source).toBe("definition");
  });

  test("慢模型：样本足够时按 p95 × 目标轮数放宽（事故里 300s 连读懂上下文都不够）", () => {
    // 单轮 30s 的慢模型：300s 只够 10 轮，而实测撞墙的子代理跑到 16 轮仍在 grep
    for (let i = 0; i < MIN_SAMPLES; i++) recordTurnLatency("slow-model", 30_000);
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      model: "slow-model",
      fallbackMs: 120_000,
    });
    expect(r.source).toBe("derived");
    expect(r.timeoutMs).toBe(Math.min(DERIVED_MAX_MS, 30_000 * TARGET_TURNS));
    expect(r.timeoutMs).toBeGreaterThan(300_000);
    expect(r.detail?.samples).toBe(MIN_SAMPLES);
  });

  test("派生值钳到上限，不会无界放大", () => {
    for (let i = 0; i < MIN_SAMPLES; i++) recordTurnLatency("very-slow", 600_000);
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      model: "very-slow",
      fallbackMs: 120_000,
    });
    expect(r.timeoutMs).toBe(DERIVED_MAX_MS);
  });

  test("快模型：只放大不收缩（收缩预算会让原本能跑完的子代理提前 detach）", () => {
    for (let i = 0; i < MIN_SAMPLES; i++) recordTurnLatency("fast-model", 1_000);
    const r = resolveSubAgentTimeout({
      definitionTimeoutMs: 300_000,
      model: "fast-model",
      fallbackMs: 120_000,
    });
    // 1s × 12 = 12s 远小于 300s → 保持声明值，不减预算
    expect(r.timeoutMs).toBe(300_000);
    expect(r.source).toBe("definition");
  });

  test("硬 kill 倍数 > 1（否则 detach 会退化成到点即 kill，等于没改）", () => {
    expect(HARD_KILL_MULTIPLIER).toBeGreaterThan(1);
  });
});
