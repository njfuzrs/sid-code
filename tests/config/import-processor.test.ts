import { describe, test, expect } from "bun:test";
import { processImports } from "../../src/config/import-processor.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

describe("Import Processor", () => {
  const testDir = "/tmp/sid-code-import-test";

  // 清理测试目录
  function cleanup() {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  // 设置测试环境
  function setup() {
    cleanup();
    mkdirSync(testDir, { recursive: true });
  }

  test("processes simple import", async () => {
    setup();

    // 创建被导入的文件
    const importedFile = join(testDir, "imported.md");
    writeFileSync(importedFile, "# Imported Content\nThis is imported.");

    // 创建主文件
    const mainFile = join(testDir, "main.md");
    const mainContent = "# Main\n@imported.md\n# End";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    expect(result).toContain("<!-- @import imported.md -->");
    expect(result).toContain("# Imported Content");
    expect(result).toContain("This is imported.");
    expect(result).toContain("<!-- end @import imported.md -->");

    cleanup();
  });

  test("detects circular imports", async () => {
    setup();

    // 创建循环导入的文件
    const file1 = join(testDir, "file1.md");
    const file2 = join(testDir, "file2.md");

    writeFileSync(file1, "# File 1\n@file2.md");
    writeFileSync(file2, "# File 2\n@file1.md");

    const mainContent = "# Main\n@file1.md";
    const result = await processImports(mainContent, join(testDir, "main.md"), {
      allowedDirectories: [testDir],
    });

    // 循环导入应该被检测并跳过
    expect(result).toContain("# File 1");
    expect(result).toContain("# File 2");
    // file1.md 在 file2.md 中的导入应该被跳过（因为已经访问过）
    // 所以 @file1.md 指令应该被保留
    expect(result).toContain("@file1.md");

    cleanup();
  });

  test("respects depth limit", async () => {
    setup();

    // 创建深层嵌套的导入
    const file1 = join(testDir, "file1.md");
    const file2 = join(testDir, "file2.md");
    const file3 = join(testDir, "file3.md");

    writeFileSync(file1, "# Level 1\n@file2.md");
    writeFileSync(file2, "# Level 2\n@file3.md");
    writeFileSync(file3, "# Level 3");

    const mainContent = "# Main\n@file1.md";
    const result = await processImports(mainContent, join(testDir, "main.md"), {
      allowedDirectories: [testDir],
      maxDepth: 0, // 深度 > 0 时停止，只允许处理 main.md 本身
    });

    expect(result).toContain("# Main");
    // file1.md 应该因为超过深度限制而不被导入
    expect(result).not.toContain("# Level 1");
    expect(result).not.toContain("# Level 2");
    expect(result).not.toContain("# Level 3");
    // @import 指令应该被保留
    expect(result).toContain("@file1.md");

    cleanup();
  });

  test("only allows .md files", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const txtFile = join(testDir, "file.txt");

    writeFileSync(txtFile, "This is a text file");
    const mainContent = "# Main\n@file.txt";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    // .txt 文件不应该被导入
    expect(result).toContain("@file.txt");
    expect(result).not.toContain("This is a text file");

    cleanup();
  });

  test("handles non-existent files gracefully", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const mainContent = "# Main\n@nonexistent.md";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    // 不存在的文件应该保留原指令
    expect(result).toContain("@nonexistent.md");

    cleanup();
  });
});
