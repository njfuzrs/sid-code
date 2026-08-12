/**
 * isDiffContent 测试
 *
 * 锁定:Edit / Write 工具的 output 中含 @@ hunk 头时才判定为 diff,
 * 触发 TUI DiffRenderer 高亮。这是本次 diff 高亮 bugfix 的判定关口。
 */

import { describe, test, expect } from "bun:test";
import {
  isDiffContent,
  getToolSummary,
  getToolDetailFull,
  getResultSummary,
  getThinkThought,
} from "@sid-code/cli/ui/ui-utils.ts";
import { stringWidth } from "@sid-code/tui-renderer/stringWidth.ts";

describe("isDiffContent", () => {
  const editDiff =
    "文件已编辑: /tmp/foo.ts（替换了 1 处）\n\n@@ -1,3 +1,3 @@\n function foo() {\n-  return 1;\n+  return 42;\n }";
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

// 回归守卫：think 工具的展示此前完全不可读——header 恒为光秃秃 `⏺ think`
// （getToolSummary 无 think 分支 → 返回 ""），结果区只有一句无信息的「已记录思考。」，
// 用户不知道记了什么、有什么用。思考正文一直在 input.thought 里但从未被展示。
// 见 docs/_template/已记录思考的显示功能上不清晰不明确.txt
describe("think 工具展示 — 思考内容可见性", () => {
  const shortThought = "先读配置再动手";
  const longThought =
    "先读 config.ts 确认默认值来源，再决定是改 schema 还是改运行时兜底；" +
    "如果两处都要动，优先改 schema 保持单一事实源。";

  describe("getToolSummary — header 摘要", () => {
    test("think 返回思考首句，不再是空串（核心回归点）", () => {
      const s = getToolSummary("think", { thought: shortThought });
      expect(s).not.toBe("");
      expect(s).toBe(shortThought);
    });

    test("按终端列宽截断而非码点数：中文摘要不撑爆 header", () => {
      const s = getToolSummary("think", { thought: longThought });
      // 中文占 2 列，若按码点数(50)截断实际会占约 100 列 → 撑爆 header
      expect(stringWidth(s)).toBeLessThanOrEqual(44);
      expect(s.endsWith("…")).toBe(true);
    });

    test("多行思考折叠为单行（header 只有一行，换行会破坏对齐）", () => {
      const s = getToolSummary("think", { thought: "第一行\n\n  第二行  \n第三行" });
      expect(s).toBe("第一行 第二行 第三行");
      expect(s).not.toContain("\n");
    });

    test("空思考 / 缺字段 → 空串（交由工具自身的 isError 路径处理）", () => {
      expect(getToolSummary("think", { thought: "   " })).toBe("");
      expect(getToolSummary("think", {})).toBe("");
    });

    test("大小写不敏感（工具名可能被上游改写）", () => {
      expect(getToolSummary("Think", { thought: shortThought })).toBe(shortThought);
    });
  });

  describe("getThinkThought — 结果区正文", () => {
    test("返回思考正文并保留换行（结果区多行展示）", () => {
      expect(getThinkThought("think", { thought: "  第一段\n第二段  " })).toBe("第一段\n第二段");
    });

    test("非 think 工具一律 undefined，不污染其它工具的结果渲染", () => {
      expect(getThinkThought("bash", { thought: "x" })).toBeUndefined();
      expect(getThinkThought("read", { file_path: "/tmp/a" })).toBeUndefined();
    });

    test("空思考 / 非字符串 / 缺字段 → undefined（回落到原结果渲染路径）", () => {
      expect(getThinkThought("think", { thought: "   " })).toBeUndefined();
      expect(getThinkThought("think", { thought: 42 })).toBeUndefined();
      expect(getThinkThought("think", {})).toBeUndefined();
      expect(getThinkThought("think", undefined)).toBeUndefined();
    });
  });

  describe("getResultSummary — 不报描述确认语的假指标", () => {
    test("think 返回空串，而不是兜底算出的「6 字符」", () => {
      // 兜底分支会对 content(「已记录思考。」) 算长度，得出一个与思考内容
      // 毫无关系的字符数，是误导性指标。
      expect(getResultSummary("think", "已记录思考。")).toBe("");
    });

    test("其它工具的摘要不受影响（不回归）", () => {
      expect(getResultSummary("read", "a\nb\nc")).toBe("3 行");
      expect(getResultSummary("edit", "whatever")).toBe("替换完成");
    });

    test("错误态仍走错误摘要（优先级高于 think 分支）", () => {
      expect(getResultSummary("think", "思考内容为空", true)).toContain("思考内容为空");
    });
  });

  describe("getToolDetailFull — 权限框看全貌", () => {
    test("返回完整思考正文，不截断", () => {
      const d = getToolDetailFull("think", { thought: longThought });
      expect(d).toBe(longThought);
      expect(d).not.toContain("…");
    });
  });
});
