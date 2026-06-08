/**
 * 循环检测器测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ToolCallLoopDetector,
  ToolShapeLoopDetector,
  ContentLoopDetector,
  LoopDetector,
  DEFAULT_LOOP_CONFIG,
  LOOP_RECOVERY_PROMPT,
} from "../../src/agent/loop-detection.ts";

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
    expect(detector.record("read", input)).toBe(true);  // 3 = 阈值
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
    const a = { pattern: "undo", path: "/src", output_mode: "files_with_matches", case_insensitive: true };
    const b = { case_insensitive: true, output_mode: "files_with_matches", path: "/src", pattern: "undo" };
    const c = { output_mode: "files_with_matches", path: "/src", pattern: "undo", case_insensitive: true };
    expect(detector.record("grep", a)).toBe(false); // 1
    expect(detector.record("grep", b)).toBe(false); // 2
    expect(detector.record("grep", c)).toBe(true);  // 3 = 阈值（如果未排序，这里会因 hash 不同而漏判）
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
    expect(detector.record("read", input)).toBe(true);  // count=3
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
    expect(detector.record("grep", { pattern: "zzz_e", path: "/repo", case_insensitive: false })).toBe(true); // 5 = 阈值
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
    expect(detector.record("edit", { file_path: "/a.ts", old_string: "line1", new_string: "new1" })).toBe(false);
    expect(detector.record("edit", { file_path: "/a.ts", old_string: "line2", new_string: "new2" })).toBe(false);
    expect(detector.record("edit", { file_path: "/a.ts", old_string: "line3", new_string: "new3" })).toBe(false);
    expect(detector.record("edit", { file_path: "/a.ts", old_string: "line4", new_string: "new4" })).toBe(false);
    expect(detector.record("edit", { file_path: "/a.ts", old_string: "line5", new_string: "new5" })).toBe(false);
    // 5 次 edit 同文件但不同 old_string（改不同位置），不应触发
  });

  test("同文件 edit 相同 old_string 仍触发循环（真循环：反复用同一 old_string 失败）", () => {
    for (let i = 0; i < 4; i++) {
      expect(detector.record("edit", { file_path: "/a.ts", old_string: "stale_content", new_string: `v${i}` })).toBe(false);
    }
    // 第 5 次同 old_string → 同 shape → 触发
    expect(detector.record("edit", { file_path: "/a.ts", old_string: "stale_content", new_string: "v5" })).toBe(true);
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
    expect(detector.record(text)).toBe(true);  // 3 = 阈值
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
    expect(detector.tryRecover()).toBe(true);  // 1
    expect(detector.tryRecover()).toBe(true);  // 2
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
