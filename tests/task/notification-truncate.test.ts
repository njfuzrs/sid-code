/**
 * formatNotification 截断行为单测
 *
 * 验证问题修复：子代理结论此前被 slice(0, 2000) 截在半句，
 * 现提高阈值并在超长时给出指向 output-file 的截断提示。
 */

import { describe, test, expect } from "bun:test";
import {
  formatNotification,
  NOTIFICATION_OUTPUT_MAX_CHARS,
  NOTIFICATION_ERROR_MAX_CHARS,
} from "@sid-code/core/task/notification.ts";
import type { AgentTaskResult } from "@sid-code/core/task/types.ts";

const buildResult = (output: string): AgentTaskResult => ({
  output,
  totalToolUseCount: 1,
  totalTokens: 100,
  usage: { inputTokens: 80, outputTokens: 20 },
});

describe("formatNotification — 结果截断阈值", () => {
  test("2000~16000 字符的结论被完整保留（不再被旧 2000 阈值截断）", () => {
    const output = "结论正文。".repeat(600); // 远超旧 2000、仍 < 16000 字符
    expect(output.length).toBeGreaterThan(2000);
    expect(output.length).toBeLessThan(NOTIFICATION_OUTPUT_MAX_CHARS);

    const xml = formatNotification({
      taskId: "t1",
      outputFile: "/tmp/t1.output",
      status: "completed",
      summary: "完成",
      result: buildResult(output),
    });
    // 完整正文应原样出现，且无截断提示
    expect(xml).toContain(output);
    expect(xml).not.toContain("已截断");
  });

  test("超长结论被截断并提示指向 output-file（完整内容不丢失）", () => {
    const output = "X".repeat(NOTIFICATION_OUTPUT_MAX_CHARS + 500);
    const xml = formatNotification({
      taskId: "t2",
      outputFile: "/tmp/t2.output",
      status: "completed",
      summary: "完成",
      result: buildResult(output),
    });
    expect(xml).toContain("已截断");
    expect(xml).toContain("/tmp/t2.output"); // 指向完整内容
    // 截断后保留的正文长度应为阈值（不含提示语）
    expect(xml).toContain("X".repeat(NOTIFICATION_OUTPUT_MAX_CHARS));
  });

  test("error 走独立阈值，超长同样截断并提示", () => {
    const error = "E".repeat(NOTIFICATION_ERROR_MAX_CHARS + 100);
    const xml = formatNotification({
      taskId: "t3",
      outputFile: "/tmp/t3.output",
      status: "failed",
      summary: "失败",
      error,
    });
    expect(xml).toContain("<error>");
    expect(xml).toContain("已截断");
  });

  test("码点安全截断：多字节中文不被切坏", () => {
    const output = "汉".repeat(NOTIFICATION_OUTPUT_MAX_CHARS + 50);
    const xml = formatNotification({
      taskId: "t4",
      outputFile: "/tmp/t4.output",
      status: "completed",
      summary: "完成",
      result: buildResult(output),
    });
    // 不应出现替换字符（U+FFFD）——切坏多字节会产生它
    expect(xml).not.toContain("�");
    expect(xml).toContain("已截断");
  });
});
