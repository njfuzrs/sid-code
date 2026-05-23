/**
 * 循环检测器测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  ToolCallLoopDetector,
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

  test("clearState 后再次撞同 key 立即触发循环（防恢复后绕过）", () => {
    const input = { path: "/x.ts" };
    detector.record("read", input);
    detector.record("read", input);
    expect(detector.record("read", input)).toBe(true); // 触发循环
    detector.clearState(); // 模拟 LoopDetector.tryRecover() 后的状态清理
    // 注入恢复 prompt 后，模型理论上应换工具；如果还撞同一个 key，必须立即识别
    expect(detector.record("read", input)).toBe(true);
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

  test("LOOP_RECOVERY_PROMPT 非空", () => {
    expect(LOOP_RECOVERY_PROMPT.length).toBeGreaterThan(0);
    expect(LOOP_RECOVERY_PROMPT).toContain("循环");
  });
});
