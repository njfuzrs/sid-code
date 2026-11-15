/**
 * tool-classifier.ts 测试
 * 聚焦 G7：toAutoClassifierInput 钩子经 classifierInput 字段的三态行为
 * （空串跳过 / 非空替代 input / undefined 回退），以及既有快速路径。
 */

import { describe, test, expect } from "bun:test";
import { ToolClassifier } from "@sid-code/core/permission/tool-classifier.ts";

describe("ToolClassifier fastPath", () => {
  const clf = new ToolClassifier({ enabled: true });

  // M1：Level 1 的路径判定改由 checker 传入。缺省（unknown）**不放行**——
  // 漏传字段必须退化成「多调一次 LLM」，而不是「静默恢复成不判路径的旧行为」。
  test("只读工具 + pathVerdict=inside 直接安全", () => {
    const r = clf.fastPath({ toolName: "read", input: {}, cwd: "/w", pathVerdict: "inside" });
    expect(r?.safe).toBe(true);
    expect(r?.risk).toBe("none");
  });

  test("M1：只读工具越界 / 未判定 → 落到 LLM（返回 null）", () => {
    for (const verdict of ["outside", "unknown", undefined] as const) {
      const r = clf.fastPath({
        toolName: "read",
        input: {},
        cwd: "/w",
        ...(verdict === undefined ? {} : { pathVerdict: verdict }),
      });
      expect(r, `pathVerdict=${String(verdict)}`).toBeNull();
    }
  });

  test("M1：不带路径的清单类只读工具仍直接安全（pathVerdict 缺省也不影响）", () => {
    for (const toolName of ["task_list", "task_get", "bg_task_list", "bg_task_get"]) {
      const r = clf.fastPath({ toolName, input: {}, cwd: "/w" });
      expect(r?.safe, toolName).toBe(true);
    }
  });

  test("write 工作区内自动放行（pathVerdict=inside）", () => {
    const r = clf.fastPath({
      toolName: "write",
      input: { file_path: "/w/a.ts" },
      cwd: "/w",
      pathVerdict: "inside",
    });
    expect(r?.safe).toBe(true);
  });

  test("write 工作区外需 LLM 判断（fastPath 返回 null）", () => {
    const r = clf.fastPath({
      toolName: "write",
      input: { file_path: "/etc/passwd" },
      cwd: "/w",
      pathVerdict: "outside",
    });
    expect(r).toBeNull();
  });

  test("M1b：同前缀兄弟目录不再靠 startsWith 判成工作区内", () => {
    // 旧实现 `filePath.startsWith(cwd)` 会让 /w-evil 通过；现在只认 pathVerdict
    const r = clf.fastPath({
      toolName: "write",
      input: { file_path: "/w-evil/x.ts" },
      cwd: "/w",
      pathVerdict: "outside",
    });
    expect(r).toBeNull();
  });

  test("M1b：skipFastPath 优先于所有 Level（含 Level 0 与 Level 1）", () => {
    const cases = [
      { toolName: "read", classifierInput: "", pathVerdict: "inside" as const },
      { toolName: "read", pathVerdict: "inside" as const },
      { toolName: "write", input: { file_path: "/w/a.ts" }, pathVerdict: "inside" as const },
    ];
    for (const over of cases) {
      const r = clf.fastPath({ input: {}, cwd: "/w", skipFastPath: true, ...over });
      expect(r, JSON.stringify(over)).toBeNull();
    }
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
      pathVerdict: "inside",
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
    const r = await clf.classify({
      toolName: "some_tool",
      input: { x: 1 },
      cwd: "/w",
      classifierInput: "",
    });
    expect(r.safe).toBe(true);
    expect(r.classifierUnavailable).toBeUndefined();
  });
});
