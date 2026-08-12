/**
 * 循环检测器测试
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import {
  ToolCallLoopDetector,
  ToolShapeLoopDetector,
  ContentLoopDetector,
  LoopDetector,
  DEFAULT_LOOP_CONFIG,
  LOOP_RECOVERY_PROMPT,
  LOOP_RECOVERY_FINAL_PROMPT,
  resolveLoopConfig,
  isLoopDetectionEnabled,
} from "@sid-code/core/agent/loop-detection.ts";

// P0-1：循环检测默认全局启用；此处显式设置为 "1" 只是为了与其他文件的用例隔离，
// 防止某个用例把 env 设为 "0"（显式关闭）后残留影响本文件的测试顺序。
beforeAll(() => {
  process.env.SID_ENABLE_LOOP_DETECTION = "1";
});
afterAll(() => {
  delete process.env.SID_ENABLE_LOOP_DETECTION;
});

describe("ToolCallLoopDetector", () => {
  let detector: ToolCallLoopDetector;

  beforeEach(() => {
    detector = new ToolCallLoopDetector({ ...DEFAULT_LOOP_CONFIG, toolCallThreshold: 3 });
  });

  test("不同工具调用不触发循环", () => {
    expect(detector.record("read", { path: "/a.ts" })).toBe(false);
    expect(detector.record("read", { path: "/b.ts" })).toBe(false);
    expect(detector.record("grep", { pattern: "foo" })).toBe(false);
  });

  test("连续相同工具调用达到阈值触发循环", () => {
    const input = { path: "/a.ts" };
    expect(detector.record("read", input)).toBe(false); // 1
    expect(detector.record("read", input)).toBe(false); // 2
    expect(detector.record("read", input)).toBe(true); // 3 = 阈值
  });

  test("中间插入不同调用会重置计数", () => {
    const input = { path: "/a.ts" };
    expect(detector.record("read", input)).toBe(false); // 1
    expect(detector.record("read", input)).toBe(false); // 2
    expect(detector.record("grep", { pattern: "x" })).toBe(false); // 重置
    expect(detector.record("read", input)).toBe(false); // 1（重新开始）
    expect(detector.record("read", input)).toBe(false); // 2
  });

  test("reset 清除所有状态", () => {
    const input = { path: "/a.ts" };
    detector.record("read", input);
    detector.record("read", input);
    detector.reset();
    // 重置后重新计数
    expect(detector.record("read", input)).toBe(false); // 1
    expect(detector.record("read", input)).toBe(false); // 2
  });

  test("相同工具名但不同参数不触发循环", () => {
    expect(detector.record("read", { path: "/a.ts" })).toBe(false);
    expect(detector.record("read", { path: "/b.ts" })).toBe(false);
    expect(detector.record("read", { path: "/c.ts" })).toBe(false);
    expect(detector.record("read", { path: "/d.ts" })).toBe(false);
  });

  test("参数顺序变化视为相同调用（regression: case_005 grep 11 次未拦）", () => {
    // 模拟 case_005：LLM 在重试时调换了 pattern/path/output_mode/case_insensitive 的输出顺序
    // 旧实现 JSON.stringify 会得到不同字符串 → hash 不同 → 计数被重置
    // 新实现 canonicalizeToolInput 排序 key，必须把这两次算成相同调用
    const a = {
      pattern: "undo",
      path: "/src",
      output_mode: "files_with_matches",
      case_insensitive: true,
    };
    const b = {
      case_insensitive: true,
      output_mode: "files_with_matches",
      path: "/src",
      pattern: "undo",
    };
    const c = {
      output_mode: "files_with_matches",
      path: "/src",
      pattern: "undo",
      case_insensitive: true,
    };
    expect(detector.record("grep", a)).toBe(false); // 1
    expect(detector.record("grep", b)).toBe(false); // 2
    expect(detector.record("grep", c)).toBe(true); // 3 = 阈值（如果未排序，这里会因 hash 不同而漏判）
  });

  test("嵌套对象参数顺序也不影响判定", () => {
    const a = { tool: { name: "x", opts: { a: 1, b: 2 } }, count: 3 };
    const b = { count: 3, tool: { opts: { b: 2, a: 1 }, name: "x" } };
    expect(detector.record("foo", a)).toBe(false);
    expect(detector.record("foo", b)).toBe(false);
    expect(detector.record("foo", a)).toBe(true); // 第 3 次相同调用即命中
  });

  test("clearState 后 grace 缓冲生效，同 key 不会立即触发（方案 C-2）", () => {
    const input = { path: "/x.ts" };
    detector.record("read", input);
    detector.record("read", input);
    expect(detector.record("read", input)).toBe(true); // 触发循环
    detector.clearState(); // 记录到 grace map（初始值 = toolCallThreshold = 3）
    // 恢复后 grace 缓冲：前 2 次免费，第 3 次 grace 耗尽后开始正常计数
    expect(detector.record("read", input)).toBe(false); // grace 3→2，放过
    expect(detector.record("read", input)).toBe(false); // grace 2→1，放过
    // grace 耗尽，删除记录，正常计数：count=1
    expect(detector.record("read", input)).toBe(false); // count=1
    expect(detector.record("read", input)).toBe(false); // count=2
    expect(detector.record("read", input)).toBe(true); // count=3
  });

  test("clearState 后换其他工具不应误报", () => {
    const a = { path: "/x.ts" };
    detector.record("read", a);
    detector.record("read", a);
    detector.record("read", a); // 触发
    detector.clearState();
    // 真正换了路径，不该再被判循环
    expect(detector.record("read", { path: "/y.ts" })).toBe(false);
    expect(detector.record("grep", { pattern: "x" })).toBe(false);
  });
});

describe("ToolShapeLoopDetector (ADR-020 §2.2 — hrn_006 grep 不同 pattern 探测循环)", () => {
  let detector: ToolShapeLoopDetector;

  beforeEach(() => {
    detector = new ToolShapeLoopDetector({
      ...DEFAULT_LOOP_CONFIG,
      toolShapeThreshold: 5,
      toolShapeWindow: 8,
    });
  });

  test("同 toolName + 同 path + 不同 pattern 反复探测,在窗口内达到阈值触发（hrn_006 仍被兜住）", () => {
    // 模拟 hrn_006:agent 反复 grep 同一目录但变换 pattern 找不存在的字符串
    const calls = [
      { pattern: "zzz_a", path: "/repo", case_insensitive: false },
      { pattern: "zzz_b", path: "/repo", case_insensitive: false },
      { pattern: "zzz_c", path: "/repo", case_insensitive: true },
      { pattern: "zzz_d", path: "/repo", case_insensitive: true },
    ];
    expect(detector.record("grep", calls[0])).toBe(false); // 1
    expect(detector.record("grep", calls[1])).toBe(false); // 2
    expect(detector.record("grep", calls[2])).toBe(false); // 3
    expect(detector.record("grep", calls[3])).toBe(false); // 4
    expect(
      detector.record("grep", { pattern: "zzz_e", path: "/repo", case_insensitive: false }),
    ).toBe(true); // 5 = 阈值
  });

  test("同 toolName 但不同 path 不应聚合为同 shape", () => {
    expect(detector.record("grep", { pattern: "x", path: "/a" })).toBe(false);
    expect(detector.record("grep", { pattern: "y", path: "/b" })).toBe(false);
    expect(detector.record("grep", { pattern: "z", path: "/c" })).toBe(false);
    expect(detector.record("grep", { pattern: "x", path: "/d" })).toBe(false);
    expect(detector.record("grep", { pattern: "y", path: "/e" })).toBe(false);
    // 5 次同工具但不同 path,不应触发
  });

  test("不同 toolName 不应聚合", () => {
    for (let i = 0; i < 5; i++) {
      const tool = i % 2 === 0 ? "grep" : "read";
      expect(detector.record(tool, { path: "/a" })).toBe(false);
    }
  });

  test("read 同 path 但不同 offset/limit 不应触发 shape 循环（方案 A: 分页读是正当行为）", () => {
    expect(detector.record("read", { file_path: "/a.ts", offset: 0 })).toBe(false);
    expect(detector.record("read", { file_path: "/a.ts", offset: 100 })).toBe(false);
    expect(detector.record("read", { file_path: "/a.ts", offset: 200 })).toBe(false);
    expect(detector.record("read", { file_path: "/a.ts", offset: 300 })).toBe(false);
    expect(detector.record("read", { file_path: "/a.ts", offset: 400 })).toBe(false);
    // 5 次 read 同文件不同 offset —— 分页推进，不应误杀
  });

  test("同文件 edit 不同 old_string 不应触发 shape 循环（方案 B: 多点编辑是正当行为）", () => {
    expect(
      detector.record("edit", { file_path: "/a.ts", old_string: "line1", new_string: "new1" }),
    ).toBe(false);
    expect(
      detector.record("edit", { file_path: "/a.ts", old_string: "line2", new_string: "new2" }),
    ).toBe(false);
    expect(
      detector.record("edit", { file_path: "/a.ts", old_string: "line3", new_string: "new3" }),
    ).toBe(false);
    expect(
      detector.record("edit", { file_path: "/a.ts", old_string: "line4", new_string: "new4" }),
    ).toBe(false);
    expect(
      detector.record("edit", { file_path: "/a.ts", old_string: "line5", new_string: "new5" }),
    ).toBe(false);
    // 5 次 edit 同文件但不同 old_string（改不同位置），不应触发
  });

  test("同文件 edit 相同 old_string 仍触发循环（真循环：反复用同一 old_string 失败）", () => {
    for (let i = 0; i < 4; i++) {
      expect(
        detector.record("edit", {
          file_path: "/a.ts",
          old_string: "stale_content",
          new_string: `v${i}`,
        }),
      ).toBe(false);
    }
    // 第 5 次同 old_string → 同 shape → 触发
    expect(
      detector.record("edit", {
        file_path: "/a.ts",
        old_string: "stale_content",
        new_string: "v5",
      }),
    ).toBe(true);
  });

  test("clearState 后 grace 缓冲生效，同 shape 不会立即触发（方案 C-2）", () => {
    // 先触发循环
    for (let i = 0; i < 5; i++) {
      const last = detector.record("grep", { pattern: `p${i}`, path: "/x" });
      if (i === 4) expect(last).toBe(true);
    }
    detector.clearState(); // 记录到 grace map（初始值 = 3）
    // 恢复后 grace 缓冲：前 2 次免费
    expect(detector.record("grep", { pattern: "new_pattern", path: "/x" })).toBe(false); // grace 3→2
    expect(detector.record("grep", { pattern: "new_pattern2", path: "/x" })).toBe(false); // grace 2→1
    // grace 耗尽后，shape 进入窗口正常计数，需要再从 1 累积到 5
    expect(detector.record("grep", { pattern: "new_pattern3", path: "/x" })).toBe(false);
  });

  test("reset 完全清除状态", () => {
    for (let i = 0; i < 5; i++) detector.record("grep", { pattern: `p${i}`, path: "/x" });
    detector.reset();
    expect(detector.record("grep", { pattern: "new", path: "/x" })).toBe(false);
  });

  test("scalar 输入不抛异常,按 toolName:scalar 聚合", () => {
    expect(detector.record("custom", "abc")).toBe(false);
    expect(detector.record("custom", null)).toBe(false);
    expect(detector.record("custom", 42)).toBe(false);
  });

  test("窗口外的旧 shape 不计入(window=8)", () => {
    // 4 次 grep:/x → 4 次 read:/y(占满窗口)→ 再 grep:/x 应只剩 1 次记录
    for (let i = 0; i < 4; i++) detector.record("grep", { pattern: `g${i}`, path: "/x" });
    for (let i = 0; i < 4; i++) detector.record("read", { file_path: "/y", offset: i * 100 });
    // 此时窗口里 grep:/x 已被挤出 4 个,grep:/x 计数应回到 0;新一次 grep:/x 还能再走 4 次才触发
    expect(detector.record("grep", { pattern: "g_new_1", path: "/x" })).toBe(false);
    expect(detector.record("grep", { pattern: "g_new_2", path: "/x" })).toBe(false);
    expect(detector.record("grep", { pattern: "g_new_3", path: "/x" })).toBe(false);
    expect(detector.record("grep", { pattern: "g_new_4", path: "/x" })).toBe(false);
    // 第 5 次同 shape 才触发
    expect(detector.record("grep", { pattern: "g_new_5", path: "/x" })).toBe(true);
  });

  test("f2124f85 真实轨迹回归：大文件分段读 + bash 验证不应触发 shape 循环（ADR-043）", () => {
    // 来自 session f2124f85（deepseek-v4-pro，整理 1920 行 Markdown）
    // 修复前：第 6 次 read（offset=200）被误判为 shape 循环
    // 修复后：方案 A（分页字段进 key）区分翻页推进，全序列不触发
    const F = "/repo/deepseek-api.md";

    // 1. read 读全文（无 offset —— shape 不含 pages 段）
    expect(detector.record("read", { file_path: F })).toBe(false);

    // 2. bash grep 定位标题行
    expect(detector.record("bash", { command: 'grep -n "^#"', description: "定位标题行" })).toBe(
      false,
    );

    // 3-8. 分段读不同区间（各有不同 offset，方案 A 修复后各算各的 shape）
    expect(detector.record("read", { file_path: F, offset: 1, limit: 200 })).toBe(false);
    expect(detector.record("read", { file_path: F, offset: 1040, limit: 200 })).toBe(false);
    expect(detector.record("read", { file_path: F, offset: 1240, limit: 250 })).toBe(false);
    expect(detector.record("read", { file_path: F, offset: 1490, limit: 250 })).toBe(false); // ← 修复前误杀点
    expect(detector.record("read", { file_path: F, offset: 1740 })).toBe(false);
    expect(detector.record("read", { file_path: F, offset: 200, limit: 450 })).toBe(false);

    // 9. write 重写整个文件（任务核心动作）
    expect(detector.record("write", { file_path: F, content: "重新整理后的内容..." })).toBe(false);

    // 10-11. bash 验证结果（不同 command 内容）
    expect(detector.record("bash", { command: 'grep -n "^#"', description: "验证标题" })).toBe(
      false,
    );
    expect(
      detector.record("bash", { command: 'grep -n "^# Turn 1"', description: "验证 Turn 1" }),
    ).toBe(false);

    // 12. read 再次分段验证（offset=1008，修复前触发第二次误杀）
    expect(detector.record("read", { file_path: F, offset: 1008, limit: 200 })).toBe(false);

    // 13. grep 验证代码围栏
    expect(detector.record("grep", { pattern: "```python", path: "/repo" })).toBe(false);
    expect(detector.record("grep", { pattern: "\\\\`\\\\`\\\\`python", path: "/repo" })).toBe(
      false,
    );
    expect(detector.record("grep", { pattern: "```", path: "/repo" })).toBe(false);

    // 全序列无触发 —— 方案 A/B/C 修复后误杀消除
  });

  test("P1-3 回归：DEFAULT_LOOP_CONFIG 下 6 次同目录不同主题的正当探索性 grep 不应触发", () => {
    // 差距分析 P1-3 指出的残余假阳性场景：agent 系统性搜索同一目录下多个不相关 symbol
    // （不是反复探测同一个不存在目标），阈值放宽到 7/10 后应有足够空间容纳此类正当操作。
    const defaultDetector = new ToolShapeLoopDetector(DEFAULT_LOOP_CONFIG);
    const topics = ["authenticate", "login", "session", "token", "credential", "authorize"];
    for (const topic of topics) {
      expect(defaultDetector.record("grep", { pattern: topic, path: "/repo/src" })).toBe(false);
    }
  });

  test("P1-3 回归：DEFAULT_LOOP_CONFIG 下 hrn_006 式持续同 shape 探测仍在预算内触发（第 7 次）", () => {
    // 放宽阈值后必须验证真循环依然被兜住，且在 case_hrn_006 的 max_steps=12 预算内完成
    const defaultDetector = new ToolShapeLoopDetector(DEFAULT_LOOP_CONFIG);
    for (let i = 0; i < 6; i++) {
      expect(
        defaultDetector.record("grep", {
          pattern: `zzz_${i}`,
          path: "/repo",
          case_insensitive: i % 2 === 0,
        }),
      ).toBe(false);
    }
    expect(
      defaultDetector.record("grep", { pattern: "zzz_6", path: "/repo", case_insensitive: false }),
    ).toBe(true); // 第 7 次 = 阈值，仍在 12 步预算内
  });
});

describe("ContentLoopDetector", () => {
  let detector: ContentLoopDetector;

  beforeEach(() => {
    detector = new ContentLoopDetector({
      ...DEFAULT_LOOP_CONFIG,
      contentThreshold: 3,
      contentChunkSize: 10,
    });
  });

  test("不同内容不触发循环", () => {
    expect(detector.record("这是第一段不同的内容")).toBe(false);
    expect(detector.record("这是第二段完全不同的文本")).toBe(false);
    expect(detector.record("第三段也是独特的内容哦")).toBe(false);
  });

  test("重复内容达到阈值触发循环", () => {
    const text = "重复的内容块用于测试循环检测功能";
    expect(detector.record(text)).toBe(false); // 1
    expect(detector.record(text)).toBe(false); // 2
    expect(detector.record(text)).toBe(true); // 3 = 阈值
  });

  test("reset 清除所有状态", () => {
    const text = "重复的内容块用于测试循环检测功能";
    detector.record(text);
    detector.record(text);
    detector.reset();
    // 重置后重新计数
    expect(detector.record(text)).toBe(false);
    expect(detector.record(text)).toBe(false);
  });

  test("短文本也能检测", () => {
    const text = "短文本重复";
    expect(detector.record(text)).toBe(false);
    expect(detector.record(text)).toBe(false);
    expect(detector.record(text)).toBe(true);
  });
});

describe("LoopDetector", () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector({
      ...DEFAULT_LOOP_CONFIG,
      toolCallThreshold: 3,
      contentThreshold: 3,
      contentChunkSize: 10,
      maxRecoveryAttempts: 2,
    });
  });

  test("工具调用循环检测", () => {
    const input = { path: "/a.ts" };
    expect(detector.recordToolCall("read", input)).toBe(false);
    expect(detector.recordToolCall("read", input)).toBe(false);
    expect(detector.recordToolCall("read", input)).toBe(true);
  });

  test("内容循环检测", () => {
    const text = "重复的内容块用于测试循环检测功能";
    expect(detector.recordContent(text)).toBe(false);
    expect(detector.recordContent(text)).toBe(false);
    expect(detector.recordContent(text)).toBe(true);
  });

  test("恢复机制：第一次恢复成功", () => {
    expect(detector.tryRecover()).toBe(true);
    expect(detector.getRecoveryAttempts()).toBe(1);
  });

  test("恢复机制：第二次恢复成功", () => {
    expect(detector.tryRecover()).toBe(true);
    expect(detector.tryRecover()).toBe(true);
    expect(detector.getRecoveryAttempts()).toBe(2);
  });

  test("恢复机制：第三次恢复失败（超过最大次数）", () => {
    expect(detector.tryRecover()).toBe(true); // 1
    expect(detector.tryRecover()).toBe(true); // 2
    expect(detector.tryRecover()).toBe(false); // 3 > maxRecoveryAttempts(2)
  });

  test("reset 重置恢复计数", () => {
    detector.tryRecover();
    detector.tryRecover();
    detector.reset();
    expect(detector.getRecoveryAttempts()).toBe(0);
    expect(detector.tryRecover()).toBe(true);
  });

  test("getMaxRecoveryAttempts 返回配置值", () => {
    expect(detector.getMaxRecoveryAttempts()).toBe(2);
  });

  test("LOOP_RECOVERY_PROMPT 非空且包含正当操作出口（方案 C-3）", () => {
    expect(LOOP_RECOVERY_PROMPT.length).toBeGreaterThan(0);
    expect(LOOP_RECOVERY_PROMPT).toContain("循环");
    expect(LOOP_RECOVERY_PROMPT).toContain("合法的分段读取");
  });
});

describe("resolveLoopConfig（env 配置化，保成功优先）", () => {
  const ENV_KEYS = [
    "SID_LOOP_MAX_RECOVERY",
    "SID_LOOP_TOOL_CALL_THRESHOLD",
    "SID_LOOP_SHAPE_THRESHOLD",
    "SID_LOOP_SHAPE_WINDOW",
    "SID_LOOP_EXHAUSTED_ACTION",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("未设置任何 env 时回退到 DEFAULT_LOOP_CONFIG", () => {
    expect(resolveLoopConfig()).toEqual(DEFAULT_LOOP_CONFIG);
  });

  test("默认 recoveryExhaustedAction 为 continue（保成功优先）", () => {
    expect(resolveLoopConfig().recoveryExhaustedAction).toBe("continue");
    expect(DEFAULT_LOOP_CONFIG.recoveryExhaustedAction).toBe("continue");
  });

  test("env 覆盖各阈值", () => {
    process.env.SID_LOOP_MAX_RECOVERY = "10";
    process.env.SID_LOOP_TOOL_CALL_THRESHOLD = "8";
    process.env.SID_LOOP_SHAPE_THRESHOLD = "12";
    process.env.SID_LOOP_SHAPE_WINDOW = "20";
    const cfg = resolveLoopConfig();
    expect(cfg.maxRecoveryAttempts).toBe(10);
    expect(cfg.toolCallThreshold).toBe(8);
    expect(cfg.toolShapeThreshold).toBe(12);
    expect(cfg.toolShapeWindow).toBe(20);
  });

  test("仅显式 terminate 才回退旧的耗尽即终止", () => {
    process.env.SID_LOOP_EXHAUSTED_ACTION = "terminate";
    expect(resolveLoopConfig().recoveryExhaustedAction).toBe("terminate");
    process.env.SID_LOOP_EXHAUSTED_ACTION = "anything-else";
    expect(resolveLoopConfig().recoveryExhaustedAction).toBe("continue");
  });

  test("非法值（NaN / ≤0）静默忽略，不会让限制变得更严", () => {
    process.env.SID_LOOP_MAX_RECOVERY = "0";
    process.env.SID_LOOP_TOOL_CALL_THRESHOLD = "-5";
    process.env.SID_LOOP_SHAPE_THRESHOLD = "abc";
    const cfg = resolveLoopConfig();
    expect(cfg.maxRecoveryAttempts).toBe(DEFAULT_LOOP_CONFIG.maxRecoveryAttempts);
    expect(cfg.toolCallThreshold).toBe(DEFAULT_LOOP_CONFIG.toolCallThreshold);
    expect(cfg.toolShapeThreshold).toBe(DEFAULT_LOOP_CONFIG.toolShapeThreshold);
  });
});

describe("LoopDetector 耗尽处置（continue vs terminate）", () => {
  test("默认 continue：shouldContinueAfterExhausted 返回 true", () => {
    const detector = new LoopDetector({ ...DEFAULT_LOOP_CONFIG, maxRecoveryAttempts: 2 });
    expect(detector.shouldContinueAfterExhausted()).toBe(true);
  });

  test("terminate：shouldContinueAfterExhausted 返回 false", () => {
    const detector = new LoopDetector({
      ...DEFAULT_LOOP_CONFIG,
      maxRecoveryAttempts: 2,
      recoveryExhaustedAction: "terminate",
    });
    expect(detector.shouldContinueAfterExhausted()).toBe(false);
  });

  test("循环检测显式关闭（SID_ENABLE_LOOP_DETECTION=0）时 shouldContinueAfterExhausted 恒为 true（不误杀）", () => {
    process.env.SID_ENABLE_LOOP_DETECTION = "0"; // P0-1：显式关闭；仅 delete 已不再等价于关闭（新默认是全局启用）
    const detector = new LoopDetector({
      ...DEFAULT_LOOP_CONFIG,
      recoveryExhaustedAction: "terminate",
    });
    expect(detector.shouldContinueAfterExhausted()).toBe(true);
    process.env.SID_ENABLE_LOOP_DETECTION = "1"; // 恢复，供后续测试用
  });

  test("softResetForContinue 归零恢复计数但保留 turnCount", () => {
    const detector = new LoopDetector({ ...DEFAULT_LOOP_CONFIG, maxRecoveryAttempts: 2 });
    detector.recordTurn();
    detector.recordTurn();
    detector.tryRecover();
    detector.tryRecover();
    expect(detector.getRecoveryAttempts()).toBe(2);
    detector.softResetForContinue();
    // 恢复计数归零 → 可以再次恢复（任务不会因一次耗尽而永久终止）
    expect(detector.getRecoveryAttempts()).toBe(0);
    expect(detector.tryRecover()).toBe(true);
    // turnCount 保留（不打乱 LLM 认知检测节奏）
    expect(detector.getTurnCount()).toBe(2);
  });

  test("LOOP_RECOVERY_FINAL_PROMPT 非空且把停止决定权交给模型", () => {
    expect(LOOP_RECOVERY_FINAL_PROMPT.length).toBeGreaterThan(0);
    expect(LOOP_RECOVERY_FINAL_PROMPT).toContain("最后");
    expect(LOOP_RECOVERY_FINAL_PROMPT).toContain("不会强行终止");
  });
});

describe("isLoopDetectionEnabled 全局默认关闭（对齐 CC，仅 =1 显式开启）", () => {
  const saved = process.env.SID_ENABLE_LOOP_DETECTION;
  afterAll(() => {
    if (saved === undefined) delete process.env.SID_ENABLE_LOOP_DETECTION;
    else process.env.SID_ENABLE_LOOP_DETECTION = saved;
  });

  test("未设置 env 时默认关闭（对齐 CC 不做工具循环检测）", () => {
    delete process.env.SID_ENABLE_LOOP_DETECTION;
    expect(isLoopDetectionEnabled()).toBe(false);
    // LoopDetector 实例应处于禁用状态：即使连续相同调用也不触发（无启发式误判风险）
    const detector = new LoopDetector({ ...DEFAULT_LOOP_CONFIG, toolCallThreshold: 3 });
    const input = { path: "/a.ts" };
    expect(detector.recordToolCall("read", input)).toBe(false);
    expect(detector.recordToolCall("read", input)).toBe(false);
    expect(detector.recordToolCall("read", input)).toBe(false);
  });

  test('仅显式设为 "1" 才开启检测', () => {
    process.env.SID_ENABLE_LOOP_DETECTION = "1";
    expect(isLoopDetectionEnabled()).toBe(true);
    // 显式开启后工具调用循环能被正常检测到
    const detector = new LoopDetector({ ...DEFAULT_LOOP_CONFIG, toolCallThreshold: 3 });
    const input = { path: "/a.ts" };
    expect(detector.recordToolCall("read", input)).toBe(false);
    expect(detector.recordToolCall("read", input)).toBe(false);
    expect(detector.recordToolCall("read", input)).toBe(true);
  });

  test('显式设为 "0" 保持关闭', () => {
    process.env.SID_ENABLE_LOOP_DETECTION = "0";
    expect(isLoopDetectionEnabled()).toBe(false);
  });

  test('其他任意值（非 "1"）都不开启，只有精确匹配 "1" 才开启', () => {
    process.env.SID_ENABLE_LOOP_DETECTION = "true";
    expect(isLoopDetectionEnabled()).toBe(false);
    process.env.SID_ENABLE_LOOP_DETECTION = "yes";
    expect(isLoopDetectionEnabled()).toBe(false);
    process.env.SID_ENABLE_LOOP_DETECTION = "2";
    expect(isLoopDetectionEnabled()).toBe(false);
  });
});
