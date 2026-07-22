/**
 * isDiffContent 测试
 *
 * 锁定:Edit / Write 工具的 output 中含 @@ hunk 头时才判定为 diff,
 * 触发 TUI DiffRenderer 高亮。这是本次 diff 高亮 bugfix 的判定关口。
 */

import { describe, test, expect } from "bun:test";
import { isDiffContent, getToolSummary, getToolDetailFull } from "../../src/ui/ui-utils.ts";

describe("isDiffContent", () => {
  const editDiff = "文件已编辑: /tmp/foo.ts（替换了 1 处）\n\n@@ -1,3 +1,3 @@\n function foo() {\n-  return 1;\n+  return 42;\n }";
  const writeDiff = "文件已创建: /tmp/new.ts\n\n@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;";

  test("edit 含 @@ hunk 头 → true", () => {
    expect(isDiffContent("edit", editDiff)).toBe(true);
    expect(isDiffContent("Edit", editDiff)).toBe(true);
  });

  test("write 含 @@ hunk 头 → true(此前完全未识别,本次修复)", () => {
    expect(isDiffContent("write", writeDiff)).toBe(true);
    expect(isDiffContent("Write", writeDiff)).toBe(true);
  });

  test("edit/write 无 hunk 头 → false", () => {
    expect(isDiffContent("edit", "文件已编辑: /tmp/foo.ts（替换了 1 处）")).toBe(false);
    expect(isDiffContent("write", "文件已写入: /tmp/x.ts")).toBe(false);
  });

  test("散文中偶含 --- 但无 @@ → false(避免旧逻辑误判)", () => {
    expect(isDiffContent("edit", "操作完成 --- 详情见上 +++ 结束")).toBe(false);
  });

  test("其它工具一律 false", () => {
    expect(isDiffContent("bash", "@@ -1,1 +1,1 @@\n-a\n+b")).toBe(false);
    expect(isDiffContent("read", "@@ whatever")).toBe(false);
  });
});

// 回归守卫（根治方案 §5.2）：真实工具名是 `sub_agent`（带下划线），此前只判 startsWith("subagent")
// → getToolSummary("sub_agent", …) 恒返回 ""，sub_agent 卡片 header 光秃秃没有描述。锁定返回非空。
describe("getToolSummary / getToolDetailFull — sub_agent 命名匹配", () => {
  const input = { type: "explore", prompt: "找出所有渲染路径的入口文件并总结" };

  test("getToolSummary(sub_agent, …) 返回非空且含 agentType", () => {
    const s = getToolSummary("sub_agent", input);
    expect(s).not.toBe("");
    expect(s).toContain("explore");
  });

  test("getToolDetailFull(sub_agent, …) 返回完整 prompt（不截断）", () => {
    const d = getToolDetailFull("sub_agent", input);
    expect(d).toContain("explore");
    expect(d).toContain("找出所有渲染路径的入口文件并总结");
  });

  test("无 type 时回落到 prompt 摘要，仍非空", () => {
    expect(getToolSummary("sub_agent", { prompt: "只有 prompt" })).not.toBe("");
  });

  test("历史别名 subagent/agent__/skill__ 仍匹配（不回归）", () => {
    expect(getToolSummary("subagent", input)).toContain("explore");
    expect(getToolSummary("agent__foo", input)).toContain("explore");
    expect(getToolSummary("skill__bar", input)).toContain("explore");
  });
});
