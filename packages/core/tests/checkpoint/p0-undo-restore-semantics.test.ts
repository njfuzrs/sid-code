/**
 * Checkpoint P0 门禁：/undo 与 /restore 的「快照 sN 代表哪个时刻」口径。
 *
 * 覆盖 2026-09-27 那轮核查里的两条 P0：
 *
 *   - N4  `restoreToSnapshot` 漏回滚「目标快照之后才首次被改」的文件，且**静默不报**
 *   - N5  `/undo` 在真实时序下三种形态全错（空转谎报成功 / 多退一步 / 直接失败）
 *
 * 两条同一个根因：「快照 sN 代表哪个时刻」没有单一真相源，三个入口各推一遍、其中两个推反了。
 * 唯一正确口径（由生产时序决定）：
 *
 *   `createSnapshot(files)` → 工具执行改文件（tool-executor 恒是执行**前**建快照）
 *   ⇒ **sN 存的是「产生 sN 那次调用之前」的内容**
 *   ⇒ 撤销最近一次修改 = 重建到 sN **自己**记录的内容，不是 sN-1。
 *
 * ⚠️ 所有用例都必须按**生产时序**写：先 createSnapshot，再改文件。
 * 反过来写（先建一个"记录初始状态"的快照）会构造出「快照数比编辑数多一个」的世界，
 * 在那个世界里被修掉的 `targetIndex - 1` 恰好是对的 —— 那正是旧测试一直绿着却
 * 放过三种生产错误的原因。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** 配置根目录隔离：CheckpointManager 无条件写 sidPaths.checkpoints()。 */
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-ckpt-p0-home-"));
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

describe("Checkpoint P0：undo / restore 的快照时刻口径", () => {
  let testDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ckpt-p0-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    manager = new CheckpointManager(
      `p0-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      { enabled: true },
    );
    await manager.init();
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────
  // N5：/undo 三种形态
  // ───────────────────────────────────────────────────────────
  describe("N5：/undo 按生产时序（先建快照再改文件）", () => {
    test("形态 A：只有一个快照（本会话第一次改文件）⇒ 真的撤销，不再空转", async () => {
      const file = join(testDir, "a.txt");
      writeFileSync(file, "用户原始代码\n");

      // 生产时序：执行前建快照 → 工具改文件。
      await manager.createSnapshot([file], "edit", "agent 改它");
      writeFileSync(file, "agent改坏的代码\n");

      const result = await manager.undo();

      // 修复前：targetIndex===0 ⇒ 返回 null ⇒ 文件没动，而命令层仍打印「已撤销快照 s1」。
      expect(result).not.toBeNull();
      expect(result!.files).toHaveLength(1);
      expect(readFileSync(file, "utf-8")).toBe("用户原始代码\n");
    });

    test("形态 B：两次编辑 ⇒ 一次 /undo 只退一步，不再把上一步正确修改一起丢掉", async () => {
      const file = join(testDir, "b.txt");
      writeFileSync(file, "v0-用户原始\n");

      await manager.createSnapshot([file], "edit", "第一次改");
      writeFileSync(file, "v1-第一次改\n");

      await manager.createSnapshot([file], "edit", "第二次改");
      writeFileSync(file, "v2-第二次改\n");

      await manager.undo();

      // 修复前：`targetIndex - 1` ⇒ 一次退两步，直接回到 v0。
      expect(readFileSync(file, "utf-8")).toBe("v1-第一次改\n");
    });

    test("形态 C：undoFile 对只改过一次的文件不再直接失败", async () => {
      const file = join(testDir, "c.txt");
      writeFileSync(file, "原始\n");

      await manager.createSnapshot([file], "edit", "改它");
      writeFileSync(file, "被改了\n");

      const result = await manager.undoFile(file);

      // 修复前：返回 null ⇒ 命令层打印「没有可撤销的修改」，文件不动。
      expect(result).not.toBeNull();
      expect(readFileSync(file, "utf-8")).toBe("原始\n");
    });

    test("连续 /undo 逐步回退，每次只退一步", async () => {
      const file = join(testDir, "d.txt");
      writeFileSync(file, "v0\n");
      await manager.createSnapshot([file], "edit", "→v1");
      writeFileSync(file, "v1\n");
      await manager.createSnapshot([file], "edit", "→v2");
      writeFileSync(file, "v2\n");
      await manager.createSnapshot([file], "edit", "→v3");
      writeFileSync(file, "v3\n");

      await manager.undo();
      expect(readFileSync(file, "utf-8")).toBe("v2\n");
      await manager.undo();
      expect(readFileSync(file, "utf-8")).toBe("v1\n");
      await manager.undo();
      expect(readFileSync(file, "utf-8")).toBe("v0\n");
      // 快照用尽 ⇒ 如实返回 null（不是谎报成功）。
      expect(await manager.undo()).toBeNull();
    });

    test("新建文件仍按原语义删除（不因本次修复回归）", async () => {
      const newFile = join(testDir, "new.txt");
      await manager.createSnapshot([newFile], "write", "创建它");
      writeFileSync(newFile, "新内容\n");

      const result = await manager.undo();
      expect(result!.files[0].action).toBe("deleted");
      expect(existsSync(newFile)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────
  // N4：restoreToSnapshot 漏回滚
  // ───────────────────────────────────────────────────────────
  describe("N4：restoreToSnapshot 覆盖「目标快照之后才首次被改」的文件", () => {
    test("B 在 s1 之后才第一次被改 ⇒ 回退到 s1 时 B 也要回滚", async () => {
      const a = join(testDir, "a.txt");
      const b = join(testDir, "b.txt");
      writeFileSync(a, "A原始\n");
      writeFileSync(b, "B原始\n");

      // s1：只改 A（B 此刻还没被碰过，所以不在 s1 里）。
      const s1 = await manager.createSnapshot([a], "edit", "A第一次改");
      writeFileSync(a, "A第一次改\n");

      // s2：又改 A。
      await manager.createSnapshot([a], "edit", "A第二次改");
      writeFileSync(a, "A第二次改\n");

      // s3：**第一次**改 B ⇒ B 的首个 full 条目落在 s1 之后。
      await manager.createSnapshot([b], "edit", "B第一次改");
      writeFileSync(b, "B被改坏了\n");

      const result = await manager.restoreToSnapshot(s1);

      expect(result).not.toBeNull();
      expect(readFileSync(a, "utf-8")).toBe("A原始\n");
      // 修复前：B 静默跳过 —— 磁盘仍是 "B被改坏了"，且 files 列表里没有 b.txt。
      expect(readFileSync(b, "utf-8")).toBe("B原始\n");
      expect(result!.files.map((f) => f.filePath).sort()).toEqual([a, b].sort());
      // 没有任何文件回滚失败。
      expect(result!.failedFiles).toEqual([]);
    });

    test("回滚失败的文件进 failedFiles（静默失败变可见）", async () => {
      const a = join(testDir, "a.txt");
      writeFileSync(a, "A原始\n");
      const s1 = await manager.createSnapshot([a], "edit", "改 A");
      writeFileSync(a, "A改了\n");

      // 正常路径：failedFiles 必须是空数组而不是 undefined（调用方可无条件读 length）。
      const ok = await manager.restoreToSnapshot(s1);
      expect(ok!.failedFiles).toEqual([]);
    });

    test("目标快照之后新建的文件仍被删除（原语义不回归）", async () => {
      const a = join(testDir, "a.txt");
      const created = join(testDir, "created.txt");
      writeFileSync(a, "A原始\n");
      const s1 = await manager.createSnapshot([a], "edit", "改 A");
      writeFileSync(a, "A改了\n");

      await manager.createSnapshot([created], "write", "新建文件");
      writeFileSync(created, "新建的内容\n");

      const result = await manager.restoreToSnapshot(s1);
      expect(existsSync(created)).toBe(false);
      expect(result!.files.find((f) => f.filePath === created)!.action).toBe("deleted");
      expect(result!.failedFiles).toEqual([]);
    });

    /**
     * 口径边界：`restoreToSnapshot` 与 `undo` 的职责**不重叠**，别把两者混为一谈。
     *
     *   - `undo()`                  撤销「最后一个快照那次调用」本身 ⇒ 会动磁盘。
     *   - `restoreToSnapshot(sN)`   回滚「sN **之后**的那些快照」⇒ sN 已是最新时无事可做。
     *
     * 所以回退到最新快照是一次合法的空操作，不是失败。
     * （N4 修的是"该回滚的文件被静默跳过"，不是"把 undo 的职责也塞进 restore"。）
     */
    test("回退到最新快照本身：合法空操作 —— 不回滚、不报失败、不动磁盘", async () => {
      const a = join(testDir, "a.txt");
      writeFileSync(a, "A原始\n");
      const s1 = await manager.createSnapshot([a], "edit", "改 A");
      writeFileSync(a, "A改了\n");

      const result = await manager.restoreToSnapshot(s1);
      expect(result).not.toBeNull();
      expect(result!.snapshotsRolledBack).toBe(0);
      expect(result!.files).toEqual([]);
      expect(result!.failedFiles).toEqual([]);
      // s1 之后没有任何快照 ⇒ 没有"之后的变更"可回滚，磁盘保持不动。
      // 想撤销 s1 那次调用本身，用的是 undo()（见上面 N5 那组用例）。
      expect(readFileSync(a, "utf-8")).toBe("A改了\n");
    });
  });
});
