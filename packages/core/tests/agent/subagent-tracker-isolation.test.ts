/**
 * 缺口 1 回归测试：进程内子代理 FileReadTracker 隔离
 *
 * 验证 createStatefulTools 工厂 + 子代理独立 tracker 重建逻辑，确保：
 * 1. 子代理用独立 tracker，read 文件后不污染父级 tracker（隔离）
 * 2. 父代理未读、子代理读过的文件，父代理 edit 仍被拒绝（护栏不被绕过）
 * 3. 同一 tracker 内先读后写正常放行（功能不被破坏）
 *
 * 对照文档：docs/bugfixes/todo/子代理委托机制-现状对照与缺口修复方案.md §3.3
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";
import { createStatefulTools, STATEFUL_TOOL_NAMES } from "@sid-code/core/tool/stateful-tools.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { ReadManyTool } from "@sid-code/core/tool/read-many.ts";

const tmpDirs: string[] = [];

function makeTmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-tracker-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "target.ts");
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
});

describe("createStatefulTools 工厂", () => {
  test("返回 read/edit/read_many/write 四个工具，且共享同一 tracker", async () => {
    const tracker = new FileReadTracker();
    const tools = createStatefulTools(tracker);
    const names = tools.map((t) => t.name()).sort();
    expect(names).toEqual(["edit", "read", "read_many", "write"]);

    const filePath = makeTmpFile("line1\nline2\n");
    const readTool = tools.find((t) => t.name() === "read")!;
    await readTool.execute({ file_path: filePath });

    // read 后，工厂内的 tracker 应记录该文件
    expect(tracker.hasBeenRead(filePath)).toBe(true);
  });

  test("write 与工厂内其它工具共享同一 tracker（写后回写，先读后写护栏生效）", async () => {
    const tracker = new FileReadTracker();
    const tools = createStatefulTools(tracker);
    const writeTool = tools.find((t) => t.name() === "write")!;

    // write 新建文件后，tracker 应记录该文件（写后回写），供后续 edit 校验通过
    const filePath = makeTmpFile("");
    rmSync(filePath, { force: true }); // 删掉让 write 走"新建"路径
    await writeTool.execute({ file_path: filePath, content: "const x = 1;\n" });
    expect(tracker.hasBeenRead(filePath)).toBe(true);
  });

  test("STATEFUL_TOOL_NAMES 恰好覆盖四个有状态工具", () => {
    expect([...STATEFUL_TOOL_NAMES].sort()).toEqual(["edit", "read", "read_many", "write"]);
  });
});

describe("缺口 1：子代理独立 tracker 隔离", () => {
  test("子代理 read 文件后，父级 tracker 不含该文件（隔离）", async () => {
    const filePath = makeTmpFile("hello\nworld\n");

    // 父代理 tracker（模拟主代理单例）
    const parentTracker = new FileReadTracker();
    // 子代理独立 tracker（模拟 buildIsolatedToolRegistry 内新建）
    const subTracker = new FileReadTracker();
    const subRead = new ReadTool(subTracker);

    // 子代理读文件
    await subRead.execute({ file_path: filePath });

    // 子代理 tracker 记录了，父代理 tracker 没有 → 隔离成立
    expect(subTracker.hasBeenRead(filePath)).toBe(true);
    expect(parentTracker.hasBeenRead(filePath)).toBe(false);
  });

  test("父代理未读、子代理读过的文件，父代理 edit 仍被拒绝（护栏不被绕过）", async () => {
    const filePath = makeTmpFile("const x = 1;\n");

    const parentTracker = new FileReadTracker();
    const subTracker = new FileReadTracker();
    const subRead = new ReadTool(subTracker);
    const parentEdit = new EditTool(parentTracker);

    // 子代理读过
    await subRead.execute({ file_path: filePath });

    // 父代理从没读过，直接 edit → 必须被先读后写护栏拒绝
    const result = await parentEdit.execute({
      file_path: filePath,
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("必须先用 read 工具读取");
  });

  test("同一 tracker 内先读后写正常放行（功能不被破坏）", async () => {
    const filePath = makeTmpFile("const y = 10;\n");

    // 子代理自己的 tracker：read 和 edit 共用
    const subTracker = new FileReadTracker();
    const subRead = new ReadTool(subTracker);
    const subEdit = new EditTool(subTracker);

    await subRead.execute({ file_path: filePath });
    const result = await subEdit.execute({
      file_path: filePath,
      old_string: "const y = 10;",
      new_string: "const y = 20;",
    });

    expect(result.isError).toBeUndefined();
    // 编辑确实落盘
    const { readFileSync } = await import("fs");
    expect(readFileSync(filePath, "utf-8")).toContain("const y = 20;");
  });

  test("read_many 也用独立 tracker，不污染父级", async () => {
    const filePath = makeTmpFile("a\nb\nc\n");

    const parentTracker = new FileReadTracker();
    const subTracker = new FileReadTracker();
    const subReadMany = new ReadManyTool(subTracker);

    await subReadMany.execute({ pattern: [filePath] });

    expect(parentTracker.hasBeenRead(filePath)).toBe(false);
  });
});
