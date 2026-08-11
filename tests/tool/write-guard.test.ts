/**
 * Write 工具「先读后写 + 陈旧检测 + 写后回写」护栏回归测试
 *
 * 背景：write 曾不持有 FileReadTracker，导致两个 P0：
 *   BUG1 —— write 新建/覆盖后紧接 edit 被拒"必须先 read"（写后不回写 tracker）
 *   BUG2 —— 盲覆盖外部已改文件，静默冲掉用户/linter 改动（无先读后写 + 陈旧守卫）
 * 以及三个衍生缺口：
 *   GAP-A —— 部分视图（offset/limit）读取后仍能覆盖，冲掉未读区域
 *   GAP-B —— 纯 mtime 比对把 touch/formatter 改 mtime 误报为"外部修改"
 *   GAP-D —— 写后不记录内容快照，导致模型自己连续覆盖第二次被误报"外部修改"
 *
 * 修复：write 并入 createStatefulTools 工厂与 edit 共享 tracker，
 * 覆盖校验复用 FileReadTracker.validateForWrite（与 validateForEdit 同一实现）。
 *
 * 对标 claude-code FileWriteTool.validateInput（errorCode 2/3）+ 写后 readFileState.set。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "write-guard-"));
  tmpDirs.push(dir);
  return dir;
}

/** 用共享 tracker 构造一组工具，模拟 createStatefulTools 工厂 */
function makeToolset() {
  const tracker = new FileReadTracker();
  return {
    tracker,
    write: new WriteTool(tracker),
    edit: new EditTool(tracker),
    read: new ReadTool(tracker),
  };
}

/** 把文件 mtime 推到未来，模拟"外部修改后 mtime 变新" */
function bumpMtime(filePath: string): void {
  const future = Date.now() / 1000 + 10;
  utimesSync(filePath, future, future);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
});

describe("Write 护栏：新建文件", () => {
  test("新建文件无条件放行（不要求先 read）", async () => {
    const { write } = makeToolset();
    const f = join(makeTmpDir(), "new.ts");
    const res = await write.execute({ file_path: f, content: "const x = 1;\n" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("const x = 1;\n");
  });

  test("新建时自动创建多级父目录", async () => {
    const { write } = makeToolset();
    const f = join(makeTmpDir(), "a/b/c/deep.ts");
    const res = await write.execute({ file_path: f, content: "deep\n" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("deep\n");
  });

  test("BUG1：write 新建后紧接 edit 不被拒（写后回写 tracker）", async () => {
    const { write, edit } = makeToolset();
    const f = join(makeTmpDir(), "b1.ts");
    await write.execute({ file_path: f, content: "const x = 1;\nconst y = 2;\n" });
    const res = await edit.execute({ file_path: f, old_string: "const x = 1;", new_string: "const x = 42;" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toContain("const x = 42;");
  });
});

describe("Write 护栏：覆盖已有文件", () => {
  test("BUG2：读过→外部真改内容→覆盖被拒（防冲掉他人改动）", async () => {
    const { write, read } = makeToolset();
    const f = join(makeTmpDir(), "b2.ts");
    writeFileSync(f, "v1\n" + "line\n".repeat(50));
    await read.execute({ file_path: f });
    writeFileSync(f, "用户手改 v2\n" + "line\n".repeat(50)); // 外部改内容
    bumpMtime(f);
    const res = await write.execute({ file_path: f, content: "模型旧版本冲掉改动\n" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("外部修改");
    // 磁盘仍是用户 v2，未被冲掉
    expect(readFileSync(f, "utf-8")).toContain("用户手改 v2");
  });

  test("覆盖从没读过的已有文件被拒", async () => {
    const { write } = makeToolset();
    const f = join(makeTmpDir(), "unread.ts");
    writeFileSync(f, "未读内容\n");
    const res = await write.execute({ file_path: f, content: "盲覆盖\n" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("read");
    expect(readFileSync(f, "utf-8")).toBe("未读内容\n");
  });

  test("read 完整读取后覆盖放行", async () => {
    const { write, read } = makeToolset();
    const f = join(makeTmpDir(), "ok.ts");
    writeFileSync(f, "orig\n");
    await read.execute({ file_path: f });
    const res = await write.execute({ file_path: f, content: "读后覆盖\n" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("读后覆盖\n");
  });

  test("部分视图（offset/limit）读取后仍可覆盖（对齐 CC，不再因 partial-view 拒绝）", async () => {
    const { write, read } = makeToolset();
    const f = join(makeTmpDir(), "big.ts");
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
    await read.execute({ file_path: f, offset: 1, limit: 10 }); // 部分读
    const res = await write.execute({ file_path: f, content: "覆盖\n" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("覆盖\n");
  });

  test("GAP-B：mtime 变但内容不变（touch/formatter）时覆盖放行，不误报外部修改", async () => {
    const { write, read } = makeToolset();
    const f = join(makeTmpDir(), "same.ts");
    writeFileSync(f, "内容不变\nabc\n");
    await read.execute({ file_path: f }); // 完整读，记录内容
    bumpMtime(f); // 只动 mtime，内容不变
    const res = await write.execute({ file_path: f, content: "新内容\n" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("新内容\n");
  });

  test("GAP-D：write 连续覆盖两次都成功（写后同步内容快照）", async () => {
    const { write, read } = makeToolset();
    const f = join(makeTmpDir(), "twice.ts");
    writeFileSync(f, "orig\n");
    await read.execute({ file_path: f });
    const r1 = await write.execute({ file_path: f, content: "第一次写\n" });
    const r2 = await write.execute({ file_path: f, content: "第二次写\n" });
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("第二次写\n");
  });
});

describe("Write 护栏：errno 友好化", () => {
  test("EISDIR：目标是目录时返回可读中文提示", async () => {
    const { write } = makeToolset();
    const dir = join(makeTmpDir(), "adir");
    mkdirSync(dir);
    const res = await write.execute({ file_path: dir, content: "x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("目录");
    expect(res.output).not.toContain("EISDIR"); // 不暴露裸 errno
  });

  test("ENOTDIR：父路径是文件时返回可读中文提示", async () => {
    const { write } = makeToolset();
    const base = makeTmpDir();
    writeFileSync(join(base, "afile"), "data");
    const res = await write.execute({ file_path: join(base, "afile/child.txt"), content: "x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("父目录");
  });
});

describe("Write 护栏：向后兼容", () => {
  test("tracker=null（旧构造路径）时不做先读后写校验，直接覆盖", async () => {
    const write = new WriteTool(); // 不注入 tracker
    const f = join(makeTmpDir(), "legacy.ts");
    writeFileSync(f, "已存在\n");
    const res = await write.execute({ file_path: f, content: "无 tracker 覆盖\n" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("无 tracker 覆盖\n");
  });
});
