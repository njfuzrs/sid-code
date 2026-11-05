/**
 * `CheckpointManager.restoreBeforeSnapshot` 单测（A1：仅代码回滚 0 个文件）
 *
 * 语义：把磁盘恢复到**产生 sN 那次工具调用之前**的状态，即回滚 `[sN, 最新]` 全区间（含 sN）。
 * 这是会话回退（Esc+Esc / `/rewind`）要的语义；`/restore` 要的「sN 之后」仍由
 * `restoreToSnapshot` 提供，两者的边界用例分别在 p0-undo-restore-semantics.test.ts
 * 与本文件锁住，不要互相借用。
 *
 * ## 隔离说明
 * `new CheckpointManager(sessionId)` 无条件写 `sidPaths.checkpoints(sessionId)`，
 * 也就是真实的 `~/.sid-code/checkpoints/`。必须显式设 `SID_CONFIG_DIR`，
 * 且**存/恢复原值**而不是无条件 delete（同进程多文件跑，直接删会抹掉 preload 的兜底）。
 *
 * ## 构造纪律
 * 快照严格按生产时序构造：`createSnapshot(files)` → 改文件。
 * **不要预先建一个「初始」快照**——manager.ts 的 rebuildContentBeforeSnapshot 注释记过这个坑：
 * 生产里 createSnapshot 只在工具**即将**改文件时被调，不会先来一发「记录初始状态」。
 * 按方便断言的顺序构造，会造出一个「快照数比编辑数多一个」的假世界，测出来的东西不成立。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-ckpt-restore-before-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("CheckpointManager.restoreBeforeSnapshot", () => {
  let testDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ckpt-restore-before-files-"));
    manager = new CheckpointManager(
      `restore-before-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      {
        enabled: true,
      },
    );
    await manager.init();
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("单快照（本次复现的真实场景）：回到 s1 之前，磁盘恢复、index 清空", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A原始\n");

    // 生产时序：工具执行前建快照（记录改动前内容），再改文件。
    const s1 = await manager.createSnapshot([a], "edit", "改 A");
    writeFileSync(a, "A改了\n");

    const result = await manager.restoreBeforeSnapshot(s1);

    expect(result).not.toBeNull();
    // 这就是 A1 的现场：修复前这里 files 为空、磁盘停在 A改了。
    expect(result!.files).toEqual([{ filePath: a, action: "restored" }]);
    expect(result!.failedFiles).toEqual([]);
    expect(result!.snapshotsRolledBack).toBe(1);
    expect(readFileSync(a, "utf-8")).toBe("A原始\n");
    expect(manager.listSnapshots()).toHaveLength(0);
  });

  test("同一轮多次改动：回到首个快照之前应撤销全部改动", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");
    const s1 = await manager.createSnapshot([a], "edit", "第一次改 A");
    writeFileSync(a, "A1\n");
    await manager.createSnapshot([a], "edit", "第二次改 A");
    writeFileSync(a, "A2\n");

    const result = await manager.restoreBeforeSnapshot(s1);

    expect(result!.files).toEqual([{ filePath: a, action: "restored" }]);
    expect(result!.failedFiles).toEqual([]);
    expect(readFileSync(a, "utf-8")).toBe("A0\n");
    expect(manager.listSnapshots()).toHaveLength(0);
    // s2 也落在回滚区间内 ⇒ 计入回滚快照数，不是只回滚 s1。
    expect(result!.snapshotsRolledBack).toBe(2);
  });

  test("回到中间点：只撤销 s2 及其之后，index 截断到 s2 之前", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");
    const s1 = await manager.createSnapshot([a], "edit", "改 A 第 1 次");
    writeFileSync(a, "A1\n");
    const s2 = await manager.createSnapshot([a], "edit", "改 A 第 2 次");
    writeFileSync(a, "A2\n");
    await manager.createSnapshot([a], "edit", "改 A 第 3 次");
    writeFileSync(a, "A3\n");

    const result = await manager.restoreBeforeSnapshot(s2);

    expect(readFileSync(a, "utf-8")).toBe("A1\n");
    expect(result!.snapshotsRolledBack).toBe(2); // s2 + s3
    const remaining = manager.listSnapshots();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(s1);
  });

  test("区间内新建的文件：回到区间之前应删除它", async () => {
    const a = join(testDir, "a.txt");
    const b = join(testDir, "b.txt");
    writeFileSync(a, "A0\n");
    const s1 = await manager.createSnapshot([a], "edit", "改 A");
    writeFileSync(a, "A1\n");
    await manager.createSnapshot([b], "write", "新建 B");
    writeFileSync(b, "B1\n");

    const result = await manager.restoreBeforeSnapshot(s1);

    expect(readFileSync(a, "utf-8")).toBe("A0\n");
    expect(existsSync(b)).toBe(false);
    expect(result!.files.find((f) => f.filePath === b)!.action).toBe("deleted");
    expect(result!.failedFiles).toEqual([]);
  });

  /**
   * 这条是 `restoreToSnapshot` 那个已实测缺陷的对照（方案 P4）：
   * b 在 s2 新建、s3 又被 edit，最新条目是 `existedBefore:true, type:diff`。
   * 按「最新条目优先」会走写回分支，重建不出内容后拿到 s2 那条 `content: ""`
   * ⇒ 写出一个**空文件**而不是删掉它。本方法按「区间内最早条目」判断存在性，避开这一点。
   */
  test("新建后又 edit：回到区间之前 b 必须不存在（不是留一个空文件）", async () => {
    const a = join(testDir, "a.txt");
    const b = join(testDir, "b.txt");
    writeFileSync(a, "A0\n");
    const s1 = await manager.createSnapshot([a], "edit", "改 A");
    writeFileSync(a, "A1\n");
    await manager.createSnapshot([b], "write", "新建 B");
    writeFileSync(b, "B1\n");
    await manager.createSnapshot([b], "edit", "改 B");
    writeFileSync(b, "B2\n");

    const result = await manager.restoreBeforeSnapshot(s1);

    expect(existsSync(b)).toBe(false);
    expect(result!.files.find((f) => f.filePath === b)!.action).toBe("deleted");
    expect(result!.failedFiles).toEqual([]);
  });

  /**
   * 区间内首个条目是 `diff`：它的基点必在区间之前。重建目标是**最早条目所在的那个快照**
   * （`rebuildContentAtSnapshot(f, sK)` 得到的正是「产生 sK 那次调用之前」的内容），
   * 不能是「区间前一格」——那样会少 apply 一格 diff，退回到上上次改动之后。
   */
  test("基点在区间之前（diff）：重建出目标时刻内容，不早也不晚", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");
    await manager.createSnapshot([a], "edit", "改 A 第 1 次");
    writeFileSync(a, "A1\n");
    await manager.createSnapshot([a], "edit", "改 A 第 2 次");
    writeFileSync(a, "A2\n");
    const s3 = await manager.createSnapshot([a], "edit", "改 A 第 3 次");
    writeFileSync(a, "A3\n");

    const result = await manager.restoreBeforeSnapshot(s3);

    // s3 存的是「产生 s3 之前」的内容 = A2；回到 s3 之前就是这个 A2。
    expect(readFileSync(a, "utf-8")).toBe("A2\n");
    expect(result!.files).toEqual([{ filePath: a, action: "restored" }]);
    expect(result!.failedFiles).toEqual([]);
  });

  test("二进制文件：回滚后字节完全一致（不做文本有损转换）", async () => {
    const bin = join(testDir, "data.bin");
    // 含 NUL 与非 UTF-8 字节，确保走二进制分支（createSnapshot 按字节判定）
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    writeFileSync(bin, original);
    const s1 = await manager.createSnapshot([bin], "write", "改二进制");
    writeFileSync(bin, new Uint8Array([1, 2, 3]));

    const result = await manager.restoreBeforeSnapshot(s1);

    expect(new Uint8Array(readFileSync(bin))).toEqual(original);
    expect(result!.files).toEqual([{ filePath: bin, action: "restored" }]);
    expect(result!.failedFiles).toEqual([]);
  });

  test("快照不存在：返回 null（与 restoreToSnapshot 同口径）", async () => {
    expect(await manager.restoreBeforeSnapshot("s999")).toBeNull();
  });

  test("未启用：返回 null", async () => {
    const disabled = new CheckpointManager(`disabled-${Date.now()}`, { enabled: false });
    await disabled.init();
    expect(await disabled.restoreBeforeSnapshot("s1")).toBeNull();
  });

  test("写盘失败：进 failedFiles，不抛异常", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");
    const s1 = await manager.createSnapshot([a], "edit", "改 A");

    // 让目标路径变成**目录**：Bun.write 写文件会失败，但不能把整次回滚炸掉。
    unlinkSync(a);
    mkdirSync(a);

    const result = await manager.restoreBeforeSnapshot(s1);

    expect(result).not.toBeNull();
    expect(result!.files).toEqual([]);
    expect(result!.failedFiles).toEqual([a]);
    // index 仍然被截断：失败已通过 failedFiles 显式暴露，不该靠「保留快照」隐式表达。
    expect(manager.listSnapshots()).toHaveLength(0);
  });

  test("nextId 不回退：截断后新快照 id 不复用旧 id", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");
    const s1 = await manager.createSnapshot([a], "edit", "改 A");
    writeFileSync(a, "A1\n");
    await manager.restoreBeforeSnapshot(s1);

    writeFileSync(a, "A2\n");
    const next = await manager.createSnapshot([a], "edit", "再改 A");
    // 旧锚点（file_changes 里的 lastSnapshotId 等）还在仓库外引用 s1，
    // id 复用会让它们误命中新快照，所以 nextId 不回退。
    expect(next).not.toBe(s1);
  });
});
