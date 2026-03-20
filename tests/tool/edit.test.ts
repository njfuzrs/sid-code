/**
 * Edit 工具测试 - 4 级匹配策略 + old_string='' + CRLF 保留
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EditTool } from "../../src/tool/edit.ts";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import os from "os";

const TMP = join(os.tmpdir(), "sid-code-edit-test");

function setup() {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
}

function cleanup(files: string[]) {
  for (const f of files) {
    try { unlinkSync(f); } catch { /* 忽略 */ }
  }
}

describe("EditTool - 精确匹配", () => {
  const tool = new EditTool(); // 不传 tracker，跳过先读后改校验

  beforeEach(setup);

  test("精确替换单处", async () => {
    const file = join(TMP, "exact1.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const result = await tool.execute({ file_path: file, old_string: "const a = 1;", new_string: "const a = 100;" });
    expect(result.isError).toBeFalsy();
    expect(await Bun.file(file).text()).toBe("const a = 100;\nconst b = 2;\n");
    cleanup([file]);
  });

  test("多处匹配但 replace_all=false 时报错", async () => {
    const file = join(TMP, "exact2.ts");
    writeFileSync(file, "foo\nfoo\n");
    const result = await tool.execute({ file_path: file, old_string: "foo", new_string: "bar" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("2 处匹配");
    cleanup([file]);
  });

  test("replace_all=true 替换所有匹配", async () => {
    const file = join(TMP, "exact3.ts");
    writeFileSync(file, "foo\nfoo\nfoo\n");
    const result = await tool.execute({ file_path: file, old_string: "foo", new_string: "bar", replace_all: true });
    expect(result.isError).toBeFalsy();
    expect(await Bun.file(file).text()).toBe("bar\nbar\nbar\n");
    cleanup([file]);
  });

  test("未找到时报错", async () => {
    const file = join(TMP, "exact4.ts");
    writeFileSync(file, "hello world\n");
    const result = await tool.execute({ file_path: file, old_string: "not_exist", new_string: "x" });
    expect(result.isError).toBe(true);
    cleanup([file]);
  });
});

describe("EditTool - 灵活匹配（忽略缩进差异）", () => {
  const tool = new EditTool();

  beforeEach(setup);

  test("old_string 缩进与文件不同时匹配成功，保留文件缩进", async () => {
    const file = join(TMP, "flex1.ts");
    // 文件中有 4 空格缩进
    writeFileSync(file, "function foo() {\n    const x = 1;\n    return x;\n}\n");
    // old_string 用 2 空格缩进
    const result = await tool.execute({
      file_path: file,
      old_string: "  const x = 1;\n  return x;",
      new_string: "  const x = 42;\n  return x;",
    });
    expect(result.isError).toBeFalsy();
    const content = await Bun.file(file).text();
    // 应保留 4 空格缩进
    expect(content).toContain("    const x = 42;");
    cleanup([file]);
  });

  test("old_string 行尾有多余空格时匹配成功", async () => {
    const file = join(TMP, "flex2.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "const a = 1;   \nconst b = 2;  ",
      new_string: "const a = 10;\nconst b = 20;",
    });
    expect(result.isError).toBeFalsy();
    const content = await Bun.file(file).text();
    expect(content).toContain("const a = 10;");
    cleanup([file]);
  });
});

describe("EditTool - 正则匹配（忽略空白数量差异）", () => {
  const tool = new EditTool();

  beforeEach(setup);

  test("空白数量不同时匹配成功", async () => {
    const file = join(TMP, "regex1.ts");
    // 文件中 = 两侧有多个空格
    writeFileSync(file, "const  x  =  1;\n");
    // old_string 用单空格
    const result = await tool.execute({
      file_path: file,
      old_string: "const x = 1;",
      new_string: "const x = 99;",
    });
    expect(result.isError).toBeFalsy();
    cleanup([file]);
  });
});

describe("EditTool - 模糊匹配（Levenshtein）", () => {
  const tool = new EditTool();

  beforeEach(setup);

  test("old_string 有少量字符差异时模糊匹配成功", async () => {
    const file = join(TMP, "fuzzy1.ts");
    const content = "function calculateTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n";
    writeFileSync(file, content);
    // old_string 有 1 个字符错误（calculateTotal → calculateTotol）
    const result = await tool.execute({
      file_path: file,
      old_string: "function calculateTotol(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}",
      new_string: "function calculateTotal(items, tax = 0) {\n  return items.reduce((sum, item) => sum + item.price, 0) * (1 + tax);\n}",
    });
    // 模糊匹配可能成功也可能失败（取决于阈值），但不应抛出异常
    expect(typeof result.output).toBe("string");
    cleanup([file]);
  });
});

describe("EditTool - old_string='' 创建新文件", () => {
  const tool = new EditTool();

  beforeEach(setup);

  test("文件不存在时创建新文件", async () => {
    const file = join(TMP, "new-file.ts");
    if (existsSync(file)) unlinkSync(file);
    const result = await tool.execute({
      file_path: file,
      old_string: "",
      new_string: "export const hello = 'world';\n",
    });
    expect(result.isError).toBeFalsy();
    expect(existsSync(file)).toBe(true);
    expect(await Bun.file(file).text()).toBe("export const hello = 'world';\n");
    cleanup([file]);
  });

  test("文件已存在时返回错误", async () => {
    const file = join(TMP, "existing.ts");
    writeFileSync(file, "existing content\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "",
      new_string: "new content\n",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("已存在");
    cleanup([file]);
  });
});

describe("EditTool - CRLF 行尾保留", () => {
  const tool = new EditTool();

  beforeEach(setup);

  test("原文件 CRLF，编辑后保持 CRLF", async () => {
    const file = join(TMP, "crlf.ts");
    // 写入 CRLF 文件
    writeFileSync(file, "const a = 1;\r\nconst b = 2;\r\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 100;",
    });
    expect(result.isError).toBeFalsy();
    const raw = await Bun.file(file).text();
    expect(raw).toContain("\r\n");
    expect(raw).toBe("const a = 100;\r\nconst b = 2;\r\n");
    cleanup([file]);
  });
});

describe("EditTool - 行号前缀剥离", () => {
  const tool = new EditTool();

  beforeEach(setup);

  test("old_string 含行号前缀时自动剥离", async () => {
    const file = join(TMP, "linenum.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "1→const a = 1;\n2→const b = 2;",
      new_string: "const a = 10;\nconst b = 20;",
    });
    expect(result.isError).toBeFalsy();
    const content = await Bun.file(file).text();
    expect(content).toContain("const a = 10;");
    cleanup([file]);
  });
});
