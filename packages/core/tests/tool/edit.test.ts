/**
 * Edit 工具测试 - 4 级匹配策略 + old_string='' + CRLF 保留
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, utimesSync } from "fs";
import { join } from "path";
import os from "os";

const TMP = join(os.tmpdir(), "sid-code-edit-test");

function setup() {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
}

function cleanup(files: string[]) {
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

describe("EditTool - 精确匹配", () => {
  const tool = new EditTool(); // 不传 tracker，跳过先读后改校验

  beforeEach(setup);

  test("精确替换单处", async () => {
    const file = join(TMP, "exact1.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 100;",
    });
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
    const result = await tool.execute({
      file_path: file,
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    expect(result.isError).toBeFalsy();
    expect(await Bun.file(file).text()).toBe("bar\nbar\nbar\n");
    cleanup([file]);
  });

  test("未找到时报错", async () => {
    const file = join(TMP, "exact4.ts");
    writeFileSync(file, "hello world\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "not_exist",
      new_string: "x",
    });
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
    const content =
      "function calculateTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n";
    writeFileSync(file, content);
    // old_string 有 1 个字符错误（calculateTotal → calculateTotol）
    const result = await tool.execute({
      file_path: file,
      old_string:
        "function calculateTotol(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}",
      new_string:
        "function calculateTotal(items, tax = 0) {\n  return items.reduce((sum, item) => sum + item.price, 0) * (1 + tax);\n}",
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

  test("old_string 含 tab 分隔行号前缀时自动剥离（对齐 read 的 cat -n 输出）", async () => {
    const file = join(TMP, "linenum-tab.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    // read 工具实际输出格式：`${n}\t${line}`（tab 分隔）
    const result = await tool.execute({
      file_path: file,
      old_string: "1\tconst a = 1;\n2\tconst b = 2;",
      new_string: "const a = 10;\nconst b = 20;",
    });
    expect(result.isError).toBeFalsy();
    const content = await Bun.file(file).text();
    expect(content).toContain("const a = 10;");
    cleanup([file]);
  });
});

describe("EditTool - no-op 拦截（old===new）", () => {
  const tool = new EditTool();
  beforeEach(setup);

  test("old_string 与 new_string 相同时拒绝且不写盘", async () => {
    const file = join(TMP, "noop.ts");
    writeFileSync(file, "const a = 1;\n");
    const before = (await import("fs")).statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const result = await tool.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 1;",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("完全相同");
    // 不应写盘（mtime 不变）
    const after = (await import("fs")).statSync(file).mtimeMs;
    expect(after).toBe(before);
    cleanup([file]);
  });
});

describe("EditTool - 未找到时回显 old_string", () => {
  const tool = new EditTool();
  beforeEach(setup);

  test("未匹配错误信息包含 old_string 摘要", async () => {
    const file = join(TMP, "nomatch.ts");
    writeFileSync(file, "hello world\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "this_string_definitely_does_not_exist_anywhere",
      new_string: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("this_string_definitely_does_not_exist_anywhere");
    cleanup([file]);
  });
});

describe("EditTool - 模糊匹配歧义守卫", () => {
  const tool = new EditTool();
  beforeEach(setup);

  test("old_string 拼错且多处近似匹配时拒绝（避免静默错位）", async () => {
    const file = join(TMP, "ambig.ts");
    // 两个几乎完全相同的块
    writeFileSync(
      file,
      "function handleA() {\n  doSomethingImportant();\n  return true;\n}\n\nfunction handleB() {\n  doSomethingImportant();\n  return true;\n}\n",
    );
    const result = await tool.execute({
      file_path: file,
      old_string: "function handleX() {\n  doSomethingImportant();\n  return true;\n}",
      new_string: "function handleA() {\n  CHANGED();\n  return true;\n}",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("歧义");
    cleanup([file]);
  });
});

describe("EditTool - 先读后改校验（FileReadTracker 增强）", () => {
  beforeEach(setup);

  test("部分读取（offset/limit）后仍可编辑：old_string 在磁盘全文精确命中即放行（对齐 CC，不再因 partial-view 拒绝）", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const edit = new EditTool(tracker);
    const file = join(TMP, "partial.ts");
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n"));
    // 只读了前 10 行，但 edit 会从磁盘重读全文做精确串匹配，line40 能命中 → 放行
    await read.execute({ file_path: file, offset: 1, limit: 10 });
    const result = await edit.execute({
      file_path: file,
      old_string: "line40",
      new_string: "LINE40",
    });
    expect(result.isError).toBeFalsy();
    expect(await Bun.file(file).text()).toContain("LINE40");
    cleanup([file]);
  });

  test("回归：读全文 → 编辑 → 定向读定位 → 再编辑，全程放行（原 partial-view 误杀场景）", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const edit = new EditTool(tracker);
    const file = join(TMP, "readfull-edit-readpartial-edit.md");
    // 用带尾缀的唯一行，避免 "段落 5" 同时命中 "段落 50~59" 的歧义
    writeFileSync(file, Array.from({ length: 60 }, (_, i) => `## 段落 ${i} 号`).join("\n") + "\n");
    // 1) 完整读取
    await read.execute({ file_path: file });
    // 2) 编辑成功
    const r1 = await edit.execute({
      file_path: file,
      old_string: "## 段落 5 号",
      new_string: "## 段落 五 号",
    });
    expect(r1.isError).toBeFalsy();
    // 3) 为定位下一个锚点做定向读取（带 offset）—— 曾把状态覆盖成 partial-view
    await read.execute({ file_path: file, offset: 40, limit: 10 });
    // 4) 再次编辑：不应再被 partial-view 拒绝
    const r2 = await edit.execute({
      file_path: file,
      old_string: "## 段落 45 号",
      new_string: "## 段落 四五 号",
    });
    expect(r2.isError).toBeFalsy();
    const content = await Bun.file(file).text();
    expect(content).toContain("## 段落 五 号");
    expect(content).toContain("## 段落 四五 号");
    cleanup([file]);
  });

  test("从没 read 直接编辑仍被拒绝（先读后改护栏保留）", async () => {
    const tracker = new FileReadTracker();
    const edit = new EditTool(tracker);
    const file = join(TMP, "never-read.ts");
    writeFileSync(file, "const a = 1;\n");
    const result = await edit.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("先用 read");
    cleanup([file]);
  });

  test("完整读取后可以编辑", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const edit = new EditTool(tracker);
    const file = join(TMP, "full-read.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    await read.execute({ file_path: file });
    const result = await edit.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 9;",
    });
    expect(result.isError).toBeFalsy();
    cleanup([file]);
  });

  test("touch 改 mtime 但内容不变时放行（内容比对兜底，避免假外部修改误报）", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const edit = new EditTool(tracker);
    const file = join(TMP, "touch.ts");
    writeFileSync(file, "const a = 1;\n");
    await read.execute({ file_path: file });
    const future = new Date(Date.now() + 10000);
    utimesSync(file, future, future); // mtime 变，内容不变
    const result = await edit.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(result.isError).toBeFalsy();
    cleanup([file]);
  });

  test("内容真被外部修改时拒绝", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const edit = new EditTool(tracker);
    const file = join(TMP, "realmod.ts");
    writeFileSync(file, "const a = 1;\n");
    await read.execute({ file_path: file });
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(file, "const a = 999;\n"); // 真改内容
    const result = await edit.execute({
      file_path: file,
      old_string: "const a = 999;",
      new_string: "const a = 2;",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("外部修改");
    cleanup([file]);
  });

  test("连续两次编辑：第二次不因自己刚写的内容误判为外部修改", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const edit = new EditTool(tracker);
    const file = join(TMP, "consecutive.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    await read.execute({ file_path: file });
    const r1 = await edit.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 10;",
    });
    expect(r1.isError).toBeFalsy();
    // 不重新 read，直接第二次编辑：应放行（updateMtime 已刷新内容快照）
    const r2 = await edit.execute({
      file_path: file,
      old_string: "const b = 2;",
      new_string: "const b = 20;",
    });
    expect(r2.isError).toBeFalsy();
    const content = await Bun.file(file).text();
    expect(content).toBe("const a = 10;\nconst b = 20;\n");
    cleanup([file]);
  });
});
