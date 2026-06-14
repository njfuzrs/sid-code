/**
 * isDiffContent 测试
 *
 * 锁定:Edit / Write 工具的 output 中含 @@ hunk 头时才判定为 diff,
 * 触发 TUI DiffRenderer 高亮。这是本次 diff 高亮 bugfix 的判定关口。
 */

import { describe, test, expect } from "bun:test";
import { isDiffContent } from "../../src/ui/ui-utils.ts";

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
