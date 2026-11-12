/**
 * G11: NotebookEdit 工具测试
 * replace / insert / delete 三种模式 + 错误处理
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { z } from "zod/v4";
import { NotebookEditTool } from "@sid-code/core/tool/notebook-edit.ts";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";

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

/**
 * D2：工具必须挂 `zodSchema`，否则 `validateToolInput()` 走 `!schema` 早退，
 * 别名 / null 回填 / 数字归一 / safeParse 整条链全部跳过（畸形参数直接进 `execute()`）。
 *
 * 这里测的是「执行器边界」而非 `execute()`：`execute()` 内部的手工检查仍在（纵深防御），
 * 但模型拿到的错误从「工具内部兜底的自由文本」变成结构化中文 zod 错误。
 */
describe("NotebookEditTool 的 zodSchema 校验链（D2）", () => {
  test("实例上挂了 zodSchema，且 inputSchema() 与它同源", () => {
    expect(tool.zodSchema).toBeDefined();
    // registry 优先用 zodSchema 生成 LLM 定义；inputSchema() 只是转换失败时的回退。
    // 两者不同源会让「发给模型的契约」与「运行时校验器」漂移，所以逐字段比对。
    expect(tool.inputSchema()).toEqual(z.toJSONSchema(tool.zodSchema!));
  });

  test("strict 契约的 null 能被回填：cell_id / cell_type 传 null 也通过", () => {
    // OpenAI strict 模式把所有 optional 字段塞进 required 并用 null 表达「未提供」，
    // 模型遵约传 null。没有 zodSchema 时这层归一被整条跳过。
    const r = validateToolInput(tool, {
      notebook_path: nbPath,
      new_source: "print(1)",
      edit_mode: "replace",
      cell_id: null,
      cell_type: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      // null 回填后等于「未提供」：字段不该以 null 的形态留下
      expect(data.cell_id).toBeUndefined();
      expect(data.cell_type).toBeUndefined();
      expect(data.edit_mode).toBe("replace");
    }
  });

  test("非法 edit_mode：返回带中文翻译的 zod 错误，而不是进 execute() 后手工兜底", () => {
    const r = validateToolInput(tool, {
      notebook_path: nbPath,
      new_source: "x",
      edit_mode: "bogus",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("参数校验失败");
      expect(r.message).toContain("notebook_edit");
      expect(r.message).toContain("edit_mode");
      // invalid_value 的中文翻译会列出合法取值，便于模型下一次直接改对
      expect(r.message).toContain("取值非法");
      expect(r.message).toContain("replace");
    }
  });

  test("缺必填 new_source：在工具边界拦下并点名字段", () => {
    const r = validateToolInput(tool, { notebook_path: nbPath });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("new_source");
    }
  });
});
