import { describe, test, expect } from "bun:test";
import { processImports } from "@sid-code/core/config/import-processor.ts";
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

  test("M3: 允许白名单文本扩展名（.txt/.json）", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const txtFile = join(testDir, "file.txt");

    writeFileSync(txtFile, "This is a text file");
    const mainContent = "# Main\n@file.txt";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    // M3：.txt 现在在白名单内，应被导入
    expect(result).toContain("This is a text file");
    expect(result).toContain("<!-- @import file.txt -->");

    cleanup();
  });

  test("M3: 拒绝非白名单扩展名（.exe）", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const binFile = join(testDir, "bad.exe");
    writeFileSync(binFile, "binary payload");
    const mainContent = "# Main\n@bad.exe";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    expect(result).not.toContain("binary payload");
    // 原始行保留
    expect(result).toContain("@bad.exe");

    cleanup();
  });

  test("M3: 无扩展名文件（@README）可导入", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const readme = join(testDir, "README");
    writeFileSync(readme, "readme body here");
    const mainContent = "# Main\n@README";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    expect(result).toContain("readme body here");

    cleanup();
  });

  test("M3: 行内导入（See @notes.md for details）也识别", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const notes = join(testDir, "notes.md");
    writeFileSync(notes, "inline note body");
    const mainContent = "See @notes.md for details.";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    // 原始 prose 行保留 + 导入内容追加
    expect(result).toContain("See @notes.md for details.");
    expect(result).toContain("inline note body");

    cleanup();
  });

  test("M3: 跳过代码围栏内的 @import", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const fake = join(testDir, "fake.md");
    writeFileSync(fake, "SHOULD NOT IMPORT");
    const mainContent = "# Main\n```\n@fake.md\n```\n";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    // 代码围栏内的 @fake.md 不应被导入
    expect(result).not.toContain("SHOULD NOT IMPORT");
    expect(result).toContain("@fake.md");

    cleanup();
  });

  test("M3: 跳过行内代码内的 @token", async () => {
    setup();

    const mainFile = join(testDir, "main.md");
    const fake = join(testDir, "fake.md");
    writeFileSync(fake, "SHOULD NOT IMPORT");
    const mainContent = "Use `@fake.md` syntax to import.";
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir],
    });

    expect(result).not.toContain("SHOULD NOT IMPORT");

    cleanup();
  });

  test("M4: 外部导入未批准 → 跳过 + 回调", async () => {
    setup();

    // 外部目录（项目根之外）
    const externalDir = "/tmp/sid-code-import-ext";
    rmSync(externalDir, { recursive: true, force: true });
    mkdirSync(externalDir, { recursive: true });
    const externalFile = join(externalDir, "ext.md");
    writeFileSync(externalFile, "EXTERNAL CONTENT");

    const mainFile = join(testDir, "main.md");
    const mainContent = `# Main\n@${externalFile}`;
    writeFileSync(mainFile, mainContent);

    const skipped: string[] = [];
    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir, externalDir],
      projectRoot: testDir,
      externalApproved: false,
      onExternalSkipped: (p) => skipped.push(p),
    });

    // 未批准 → 外部内容不导入
    expect(result).not.toContain("EXTERNAL CONTENT");
    expect(skipped.length).toBe(1);

    rmSync(externalDir, { recursive: true, force: true });
    cleanup();
  });

  test("M4: 外部导入已批准 → 正常展开", async () => {
    setup();

    const externalDir = "/tmp/sid-code-import-ext2";
    rmSync(externalDir, { recursive: true, force: true });
    mkdirSync(externalDir, { recursive: true });
    const externalFile = join(externalDir, "ext.md");
    writeFileSync(externalFile, "EXTERNAL CONTENT OK");

    const mainFile = join(testDir, "main.md");
    const mainContent = `# Main\n@${externalFile}`;
    writeFileSync(mainFile, mainContent);

    const result = await processImports(mainContent, mainFile, {
      allowedDirectories: [testDir, externalDir],
      projectRoot: testDir,
      externalApproved: true,
    });

    expect(result).toContain("EXTERNAL CONTENT OK");

    rmSync(externalDir, { recursive: true, force: true });
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
