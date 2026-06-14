/**
 * formatUnifiedDiff 测试
 *
 * 锁定 Edit/Write 工具产出的 diff 格式:必须含可被 DiffRenderer 解析的 @@ hunk 头,
 * 否则 TUI 的 diff 高亮不会触发(本次 bugfix 的根因)。
 */

import { describe, test, expect } from "bun:test";
import { formatUnifiedDiff } from "../../src/tool/diff-output.ts";

describe("formatUnifiedDiff", () => {
  test("修改文件:产出含 @@ hunk 头与 +/- 行", () => {
    const diff = formatUnifiedDiff(
      "/tmp/foo.ts",
      "function foo() {\n  return 1;\n}\n",
      "function foo() {\n  return 42;\n}\n",
    );
    expect(/^@@ -\d/m.test(diff)).toBe(true);
    expect(diff).toContain("-  return 1;");
    expect(diff).toContain("+  return 42;");
    // 上下文行以空格前缀保留
    expect(diff).toContain(" function foo() {");
  });

  test("新建文件:旧内容为空时全部为 + 行", () => {
    const diff = formatUnifiedDiff("/tmp/new.ts", "", "const a = 1;\nconst b = 2;\n");
    expect(/^@@ -0,0/m.test(diff)).toBe(true);
    expect(diff).toContain("+const a = 1;");
    expect(diff).toContain("+const b = 2;");
    // 不应有删除行
    expect(diff.split("\n").some((l) => l.startsWith("-"))).toBe(false);
  });

  test("无变化:返回空串", () => {
    expect(formatUnifiedDiff("/tmp/x.ts", "same\n", "same\n")).toBe("");
  });

  test("仅 CRLF/LF 差异:视为无变化返回空串", () => {
    expect(formatUnifiedDiff("/tmp/x.ts", "a\r\nb\r\n", "a\nb\n")).toBe("");
  });

  test("剥掉 createPatch 的文件头:首行即 @@,不含 Index:/---/+++", () => {
    const diff = formatUnifiedDiff("/tmp/foo.ts", "a\n", "b\n");
    expect(diff.startsWith("@@")).toBe(true);
    expect(diff).not.toContain("Index:");
    expect(diff).not.toContain("--- ");
    expect(diff).not.toContain("+++ ");
  });

  test("大改动:超过上限时截断主体并标注", () => {
    const oldText = Array.from({ length: 2000 }, (_, i) => `old line ${i}`).join("\n") + "\n";
    const newText = Array.from({ length: 2000 }, (_, i) => `new line ${i}`).join("\n") + "\n";
    const diff = formatUnifiedDiff("/tmp/big.ts", oldText, newText);
    expect(diff).toContain("省略");
    // 截断后仍保留可解析的 hunk 头
    expect(/^@@ -\d/m.test(diff)).toBe(true);
    // 行数受限(上限 500 + 1 行标注)
    expect(diff.split("\n").length).toBeLessThanOrEqual(501);
  });
});
