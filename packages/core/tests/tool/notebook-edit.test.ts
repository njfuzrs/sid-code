/**
 * G11: NotebookEdit 工具测试
 * replace / insert / delete 三种模式 + 错误处理
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NotebookEditTool } from "@sid-code/core/tool/notebook-edit.ts";

let tmpDir: string;
let nbPath: string;
let tool: NotebookEditTool;

const SAMPLE_NOTEBOOK = {
  cells: [
    {
      cell_type: "markdown",
      source: ["# Title\n"],
      metadata: { id: "cell-md-1" },
    },
    {
      cell_type: "code",
      source: ["print('hello')\n"],
      metadata: { id: "cell-code-1" },
      outputs: [{ output_type: "stream", text: ["hello\n"] }],
      execution_count: 1,
    },
    {
      cell_type: "code",
      source: ["x = 42\n"],
      metadata: { id: "cell-code-2" },
      outputs: [],
      execution_count: 2,
    },
  ],
  metadata: { kernelspec: { display_name: "Python 3" } },
  nbformat: 4,
  nbformat_minor: 5,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sid-nbedit-"));
  nbPath = join(tmpDir, "test.ipynb");
  writeFileSync(nbPath, JSON.stringify(SAMPLE_NOTEBOOK, null, 1));
  tool = new NotebookEditTool();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readNb() {
  return JSON.parse(readFileSync(nbPath, "utf-8"));
}

describe("NotebookEditTool", () => {
  test("基础元信息", () => {
    expect(tool.name()).toBe("notebook_edit");
    expect(tool.readOnly()).toBe(false);
    expect(tool.shouldDefer).toBe(true);
  });

  // replace
  test("replace: 替换 cell 内容", async () => {
    const result = await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-code-1",
      edit_mode: "replace",
      new_source: "print('world')",
    });
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("replace");

    const nb = readNb();
    expect(nb.cells[1].source).toEqual(["print('world')"]);
    // 替换 code cell 时清空输出
    expect(nb.cells[1].outputs).toEqual([]);
    expect(nb.cells[1].execution_count).toBeNull();
  });

  test("replace: 可以改 cell_type", async () => {
    await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-md-1",
      edit_mode: "replace",
      new_source: "# New Title",
      cell_type: "code",
    });
    const nb = readNb();
    expect(nb.cells[0].cell_type).toBe("code");
  });

  test("replace: 缺少 cell_id → 报错", async () => {
    const result = await tool.execute({
      notebook_path: nbPath,
      edit_mode: "replace",
      new_source: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cell_id");
  });

  test("replace: cell_id 不存在 → 报错", async () => {
    const result = await tool.execute({
      notebook_path: nbPath,
      cell_id: "nonexistent",
      edit_mode: "replace",
      new_source: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("未找到");
  });

  // insert
  test("insert: 在指定 cell 后插入", async () => {
    const result = await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-md-1",
      edit_mode: "insert",
      new_source: "# Section 2",
      cell_type: "markdown",
    });
    expect(result.isError).toBeUndefined();

    const nb = readNb();
    expect(nb.cells.length).toBe(4);
    expect(nb.cells[1].cell_type).toBe("markdown");
    expect(nb.cells[1].source).toEqual(["# Section 2"]);
  });

  test("insert: 无 cell_id → 插到最前面", async () => {
    await tool.execute({
      notebook_path: nbPath,
      edit_mode: "insert",
      new_source: "# Preamble",
      cell_type: "markdown",
    });
    const nb = readNb();
    expect(nb.cells.length).toBe(4);
    expect(nb.cells[0].source).toEqual(["# Preamble"]);
  });

  test("insert: 缺少 cell_type → 报错", async () => {
    const result = await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-md-1",
      edit_mode: "insert",
      new_source: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cell_type");
  });

  test("insert code cell: 自动带 outputs + execution_count", async () => {
    await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-md-1",
      edit_mode: "insert",
      new_source: "import os",
      cell_type: "code",
    });
    const nb = readNb();
    expect(nb.cells[1].outputs).toEqual([]);
    expect(nb.cells[1].execution_count).toBeNull();
  });

  // delete
  test("delete: 删除指定 cell", async () => {
    const result = await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-code-2",
      edit_mode: "delete",
      new_source: "",
    });
    expect(result.isError).toBeUndefined();

    const nb = readNb();
    expect(nb.cells.length).toBe(2);
    // 确认剩余 cell 正确
    expect(nb.cells[0].metadata.id).toBe("cell-md-1");
    expect(nb.cells[1].metadata.id).toBe("cell-code-1");
  });

  // 数字索引回退
  test("cell_id 支持数字索引匹配", async () => {
    await tool.execute({
      notebook_path: nbPath,
      cell_id: "0",
      edit_mode: "replace",
      new_source: "# Replaced by index",
    });
    const nb = readNb();
    expect(nb.cells[0].source).toEqual(["# Replaced by index"]);
  });

  // 多行 source 格式
  test("多行 source 按 ipynb 格式拆行（中间行带 \\n）", async () => {
    await tool.execute({
      notebook_path: nbPath,
      cell_id: "cell-code-1",
      edit_mode: "replace",
      new_source: "line1\nline2\nline3",
    });
    const nb = readNb();
    expect(nb.cells[1].source).toEqual(["line1\n", "line2\n", "line3"]);
  });

  // 文件不存在
  test("notebook 文件不存在 → 报错", async () => {
    const result = await tool.execute({
      notebook_path: join(tmpDir, "nope.ipynb"),
      edit_mode: "replace",
      cell_id: "x",
      new_source: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不存在");
  });

  // 非 .ipynb 文件
  test("非 .ipynb 文件 → 报错", async () => {
    const result = await tool.execute({
      notebook_path: join(tmpDir, "test.py"),
      edit_mode: "replace",
      cell_id: "x",
      new_source: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不是 .ipynb");
  });
});
