/**
 * P0-1(b) 残卷单测。（P0-1(c) 墙钟预算派生随 timeout-budget.ts 在 PR-B 删除。）
 *
 * 这两个模块是"1.84M input token 产出归零"那个缺陷的正面修复，验收口径来自方案 §1.6：
 *   - 主 agent 收到的 output **包含已改动文件清单**，而不是只有一句"超时"；
 *   - usage/turns 按实际值回填，不归零。
 *
 * 为什么这些断言值得单独立测（而不只靠 sub-agent.test.ts 的端到端那条）：
 * 端到端那条用 HangingProvider，**零轮产出**——它证明得了"残卷骨架在"，但证明不了
 * "真的把已改动文件捞回来了"。而后者恰恰是本次修复的全部意义所在。
 *
 * 落盘隔离：salvage 是纯内存模块（无 IO），不需要 SID_CONFIG_DIR 重定向。
 */

import { describe, test, expect } from "bun:test";
import { SalvageCollector, buildSalvageOutput } from "@sid-code/core/agent/salvage.ts";

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
  /** 复刻事故形态：跑了多轮、改过文件、有结论，然后被中止。 */
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
      reason: "aborted",
      finalText: "",
    });
    expect(out).toContain("/src/ui/theme.ts");
    expect(out).toContain('<changed-files count="1">');
    // 反向断言：不能退化成改造前那种"一句话"输出
    expect(out.length).toBeGreaterThan(200);
  });

  test("finalText 原样置顶保留（绝不被替换——这是本次修复的硬约束）", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "aborted",
      finalText: "## 发现\nColor 类型是 string 联合",
    });
    // 子代理自己的结论必须在最前面、逐字保留
    expect(out.startsWith("## 发现\nColor 类型是 string 联合")).toBe(true);
    // 残卷是**追加**而非替换
    expect(out).toContain("<partial-result>");
  });

  test("已确认的关键结论进 findings 段", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "aborted",
    });
    expect(out).toContain("已确认 Color 类型定义在 ink.d.ts");
  });

  test("零改动时显式给 count=0（区分「没改」与「不知道改没改」）", () => {
    const out = buildSalvageOutput(new SalvageCollector().snapshot(), {
      reason: "aborted",
    });
    expect(out).toContain('<changed-files count="0"/>');
  });

  test("已落盘的改动要明确告知「不要重做」", () => {
    const out = buildSalvageOutput(accidentShapedSnapshot(), {
      reason: "aborted",
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
      reason: "aborted",
    });
    expect(out).toContain("起步即失败");
    expect(out).toContain("尚未产生任何工具调用");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 卡 D1（2026-10-14）：子代理失败的真实归因与文案
// 事故 20261014-110202-8c0ffb30：三个 explore 子代理死于「休眠断网 → 漏斗放弃」，残卷却说
// 「达到墙钟预算」「停在读懂上下文」「检查模型是否可用」。
// ═══════════════════════════════════════════════════════════════════
import {
  classifySubAgentFailure,
  type FailureClassInput,
  type SubAgentGiveUpEvidence,
} from "@sid-code/core/agent/salvage.ts";

describe("D1 classifySubAgentFailure + 建议文案（表驱动）", () => {
  const DEADLINE_TRANSIENT: SubAgentGiveUpEvidence = {
    giveUpReason: "deadline",
    family: "transient",
    attempts: 1,
    lastError: "Connection error.",
  };
  const RATE: SubAgentGiveUpEvidence = {
    giveUpReason: "budget",
    family: "transient",
    attempts: 6,
    lastError: "429 rate limit",
  };
  const AUTH: SubAgentGiveUpEvidence = {
    giveUpReason: "budget",
    family: "auth_suspect",
    attempts: 2,
    lastError: "401 Unauthorized",
  };

  // 一个跑了多轮、零改动的快照（事故现场：9–10 轮、只读）
  const snapOf = () => {
    const c = new SalvageCollector();
    for (let t = 1; t <= 9; t++) {
      c.recordTurn({
        turn: t,
        textOutput: `发现 ${t}`,
        tools: [{ name: "read", input: { file_path: `/x/${t}.ts` } }],
        tokenCount: t * 1000,
        toolUseCount: t,
      });
    }
    return c.snapshot();
  };

  type Row = {
    name: string;
    input: Partial<FailureClassInput>;
    readOnly: boolean;
    sleptMs?: number;
    retryAttempts?: number;
    reason: string;
    has: string[];
    lacks: string[];
  };
  const base: FailureClassInput = { parentAborted: false };
  const rows: Row[] = [
    {
      name: "事故组：giveUp(deadline/transient) + 休眠 181s + explore",
      input: { giveUp: DEADLINE_TRANSIENT },
      readOnly: true,
      sleptMs: 181_000,
      retryAttempts: 1,
      reason: "error",
      has: ["网络连接中断", "期间系统休眠", "这不是网关或模型故障", "执行出错"],
      lacks: ["墙钟预算", "读懂上下文", "模型是否可用"],
    },
    {
      name: "giveUp(rate_limit) → 上游限流",
      input: { giveUp: RATE, lastRetryReason: "rate_limit" },
      readOnly: true,
      reason: "error",
      has: ["上游限流"],
      lacks: ["墙钟预算", "读懂上下文", "休眠"],
    },
    {
      name: "giveUp(auth) → 检查凭证",
      input: { giveUp: AUTH },
      readOnly: false,
      reason: "error",
      has: ["检查凭证"],
      lacks: ["读懂上下文"],
    },
    {
      name: "giveUp(context_overflow) → 缩小范围",
      input: {
        giveUp: {
          giveUpReason: "budget",
          family: "request_suspect",
          lastError: "context_length_exceeded",
        },
      },
      readOnly: false,
      reason: "error",
      has: ["缩小任务范围"],
      lacks: ["读懂上下文"],
    },
    {
      name: "父代理 abort 压过一切 → aborted",
      input: { parentAborted: true, giveUp: DEADLINE_TRANSIENT },
      readOnly: false,
      reason: "aborted",
      has: ["被主动中止"],
      lacks: ["墙钟预算"],
    },
    {
      name: "无 giveUp、Connection error 异常（catch 路径）→ error/网络",
      input: { errorMessage: "Connection error." },
      readOnly: true,
      reason: "error",
      has: ["网络连接中断"],
      lacks: ["墙钟预算", "读懂上下文"],
    },
    {
      name: "PR-B：被中止 + 多轮零改动 + 非只读 → 给「读懂上下文」",
      input: { parentAborted: true },
      readOnly: false,
      reason: "aborted",
      has: ["被主动中止", "读懂上下文"],
      lacks: ["墙钟"],
    },
    {
      name: "PR-B：被中止 + 只读类 → 不给「读懂上下文」",
      input: { parentAborted: true },
      readOnly: true,
      reason: "aborted",
      has: ["被主动中止"],
      lacks: ["读懂上下文", "墙钟"],
    },
  ];

  for (const r of rows) {
    test(r.name, () => {
      const fc = classifySubAgentFailure({ ...base, ...r.input });
      expect(fc.reason).toBe(r.reason as typeof fc.reason);
      const out = buildSalvageOutput(snapOf(), {
        reason: fc.reason,
        cause: fc.cause,
        sleptMs: r.sleptMs,
        retryAttempts: r.retryAttempts,
        readOnlyAgent: r.readOnly,
        errorMessage: r.input.giveUp?.lastError ?? r.input.errorMessage,
      });
      for (const s of r.has) expect(out).toContain(s);
      for (const s of r.lacks) expect(out).not.toContain(s);
    });
  }
});

describe("PR-B：「到点」类成因整体删除（事故 20261016-222758 的错误归因）", () => {
  test("无 giveUp、无 abort、无错误 → error，不再有 timeout / detached", () => {
    const fc = classifySubAgentFailure({ parentAborted: false });
    expect(fc.reason).toBe("error");
  });

  test.each(["aborted", "error"] as const)("%s 残卷不含任何墙钟 / 硬 kill 字样", (reason) => {
    const out = buildSalvageOutput(new SalvageCollector().snapshot(), { reason });
    expect(out).not.toContain("墙钟");
    expect(out).not.toContain("硬 kill");
    expect(out).not.toContain("转后台");
  });
});

describe("D1 <progress> token 口径", () => {
  test("给了 usage → 显式 input/output/cache_read/cache_creation，无裸 tokens=", () => {
    const snap = new SalvageCollector().snapshot();
    const out = buildSalvageOutput(snap, {
      reason: "error",
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 7,
      },
    });
    expect(out).toContain('input="100" output="5" cache_read="900" cache_creation="7"');
    expect(out).not.toMatch(/ tokens="/);
  });

  test("没有 usage → 属性名写明口径 input_output_tokens", () => {
    const c = new SalvageCollector();
    c.recordTurn({ turn: 1, textOutput: "", tools: [], tokenCount: 42, toolUseCount: 0 });
    const out = buildSalvageOutput(c.snapshot(), { reason: "error" });
    expect(out).toContain('input_output_tokens="42"');
    expect(out).not.toMatch(/ tokens="/);
  });
});

describe("D1 回放：事故三个 explore 子代理（脱敏 fixture）", () => {
  // 取自 sidechain transcript 的形态：9–10 轮只读工具、最后一次 Connection error、
  // recovery_give_up giveUpReason=deadline attempts=1、休眠 181s。路径已脱敏。
  const FIXTURE = [
    { turns: 9, lastError: "Connection error.", sleptMs: 181_000 },
    { turns: 10, lastError: "Connection error.", sleptMs: 181_000 },
    { turns: 10, lastError: "Connection error.", sleptMs: 181_000 },
  ];
  for (const [i, f] of FIXTURE.entries()) {
    test(`子代理 #${i + 1}`, () => {
      const c = new SalvageCollector();
      for (let t = 1; t <= f.turns; t++) {
        c.recordTurn({
          turn: t,
          textOutput: "",
          tools: [{ name: "grep", input: { pattern: "foo", path: "/repo" } }],
          tokenCount: t * 10_000,
          toolUseCount: t,
        });
      }
      const fc = classifySubAgentFailure({
        parentAborted: false,
        giveUp: {
          giveUpReason: "deadline",
          family: "transient",
          attempts: 1,
          lastError: f.lastError,
        },
      });
      const out = buildSalvageOutput(c.snapshot(), {
        reason: fc.reason,
        cause: fc.cause,
        sleptMs: f.sleptMs,
        readOnlyAgent: true,
        errorMessage: f.lastError,
      });
      expect(out).toContain("执行出错：Connection error.");
      expect(out).toContain("网络连接中断");
      expect(out).toContain("期间系统休眠 约 3 分钟（181s）");
      expect(out).not.toContain("墙钟预算");
      expect(out).not.toContain("读懂上下文");
      expect(out).not.toContain("模型是否可用");
    });
  }
});
