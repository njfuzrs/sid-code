/**
 * tool-classifier.ts 测试
 * 聚焦 G7：toAutoClassifierInput 钩子经 classifierInput 字段的三态行为
 * （空串跳过 / 非空替代 input / undefined 回退），以及既有快速路径。
 */

import { describe, test, expect } from "bun:test";
import { ToolClassifier } from "../../src/permission/tool-classifier.ts";

describe("ToolClassifier fastPath", () => {
  const clf = new ToolClassifier({ enabled: true });

  test("只读工具直接安全", () => {
    const r = clf.fastPath({ toolName: "read", input: {}, cwd: "/w" });
    expect(r?.safe).toBe(true);
    expect(r?.risk).toBe("none");
  });

  test("write 工作区内自动放行", () => {
    const r = clf.fastPath({ toolName: "write", input: { file_path: "/w/a.ts" }, cwd: "/w" });
    expect(r?.safe).toBe(true);
  });

  test("write 工作区外需 LLM 判断（fastPath 返回 null）", () => {
    const r = clf.fastPath({ toolName: "write", input: { file_path: "/etc/passwd" }, cwd: "/w" });
    expect(r).toBeNull();
  });

  // G7：classifierInput 三态
  test("G7 classifierInput 为空串 → 跳过 LLM，直接判安全", () => {
    const r = clf.fastPath({
      toolName: "some_tool",
      input: { foo: "bar" },
      cwd: "/w",
      classifierInput: "",
    });
    expect(r?.safe).toBe(true);
    expect(r?.reason).toContain("无安全关联");
  });

  test("G7 classifierInput 非空 → 不短路，落到 LLM 路径（fastPath 返回 null）", () => {
    const r = clf.fastPath({
      toolName: "some_tool",
      input: { foo: "bar" },
      cwd: "/w",
      classifierInput: "编辑 /w/a.ts: x → y",
    });
    // 非只读、非 accept-edits、classifierInput 非空 → 需 LLM
    expect(r).toBeNull();
  });

  test("G7 classifierInput 为 undefined → 走原有 fastPath 逻辑", () => {
    const r = clf.fastPath({
      toolName: "read",
      input: {},
      cwd: "/w",
      classifierInput: undefined,
    });
    expect(r?.safe).toBe(true);
  });

  test("分类器不可用 → classify 回退 classifierUnavailable", async () => {
    const r = await clf.classify({ toolName: "some_tool", input: { x: 1 }, cwd: "/w" });
    expect(r.classifierUnavailable).toBe(true);
    expect(r.safe).toBe(false);
  });

  test("G7 classifierInput 空串在 classify 中同样短路（不触达 provider）", async () => {
    // provider 未设置，若真走到 LLM 会返回 classifierUnavailable；空串应先短路为 safe
    const r = await clf.classify({ toolName: "some_tool", input: { x: 1 }, cwd: "/w", classifierInput: "" });
    expect(r.safe).toBe(true);
    expect(r.classifierUnavailable).toBeUndefined();
  });
});
