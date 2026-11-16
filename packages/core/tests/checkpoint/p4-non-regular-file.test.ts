/**
 * P4：非普通文件不进快照 + `/undo` 死循环 测试
 *
 * 根因（回源码核过，方案文档里的行号已过期）：
 * - 止新：`createSnapshot` 用 `Bun.file(p).exists()` 判「路径是否存在」，而它的真实语义是
 *   「**是不是一个可读的普通文件**」——目录、`/dev/null` 一律返回 false（本机 bun 1.4.2 实测）。
 *   于是这些目标被记成「新建文件 + 空内容」，回退时 `unlinkSync` 必然失败。
 * - 兼容：`undo` 的 N5 判据只看「results 为空 ⇒ 失败」，把「本来就没有可回滚目标」
 *   也判成失败 ⇒ 保留快照 ⇒ 下次 `/undo` 还撤同一个 ⇒ **永久卡死**。
 *
 * 本文件锁住的判据：
 * 1. 止新——目录 / 设备 / 软链不进快照，且登记进 skippedFiles（reason: "non-regular"）
 * 2. 兼容——历史坏条目（盘上已有的 old 分片）不让 `/undo` 卡死，也不让 `/restore` 报假失败
 * 3. 负向——真失败（重建不出内容）仍然保留快照 + 返回 null（N5 不回归）
 * 4. 锁定 Bun 行为——`Bun.file().exists()` 对目录/设备返回 false 是本次修复的前提
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Windows 上没有 /dev/null，相关用例直接跳过（CI 双平台，不能写死跳过整份文件）。 */
const hasDevNull = existsSync("/dev/null");

describe("P4：非普通文件不进快照 + /undo 死循环", () => {
  let testDir: string;
  let configDir: string;
  let origConfigDir: string | undefined;
  let sessionId: string;
  let ckptDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ckpt-p4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    // 落盘隔离：checkpoint 目录必须落在 tmpdir（同其他 checkpoint 测试的写法）。
    configDir = join(testDir, ".sid-code");
    mkdirSync(configDir, { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = configDir;
    sessionId = `p4-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ckptDir = join(configDir, "checkpoints", sessionId);
  });

  afterEach(() => {
    // 存/恢复原值而不是 delete：同批测试共用进程，delete 会抹掉 preload 兜底。
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function newManager(cfg: Record<string, unknown> = {}): CheckpointManager {
    return new CheckpointManager(sessionId, { enabled: true, ...cfg });
  }

  /**
   * 手工写一份「历史快照」——模拟修复前的老版本已经落盘的坏条目。
   *
   * 必须走盘上构造，不能调 `createSnapshot`：止新之后它根本不会产生这种快照了，
   * 而「兼容历史数据」正是要验证的另一半。
   */
  function writeLegacyShard(
    snapshots: Array<{
      id: string;
      files: Array<{
        filePath: string;
        existedBefore: boolean;
        content?: string;
        /** 写 diff 条目而不写 full —— 用来构造「没有 full 基点可重建」的真失败。 */
        type?: "full" | "diff";
      }>;
    }>,
  ): void {
    mkdirSync(join(ckptDir, "snapshots"), { recursive: true });
    writeFileSync(
      join(ckptDir, "index.json"),
      JSON.stringify({
        version: 2,
        sessionId,
        createdAt: 1700000000000,
        nextId: snapshots.length + 1,
      }),
    );
    for (const snap of snapshots) {
      writeFileSync(
        join(ckptDir, "snapshots", `${snap.id}.json`),
        JSON.stringify({
          id: snap.id,
          timestamp: 1700000000000,
          toolName: "bash",
          toolSummary: "ls 2>/dev/null",
          files: snap.files.map((f) => {
            const type = f.type ?? "full";
            return {
              filePath: f.filePath,
              existedBefore: f.existedBefore,
              type,
              ...(type === "full"
                ? { content: f.content ?? "", compressed: false }
                : { diff: { ops: [{ type: "insert", lines: ["x"] }] } }),
            };
          }),
        }),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. 锁定 Bun 行为：本次修复的前提
  // ─────────────────────────────────────────────────────────────

  test("前提锁定：Bun.file().exists() 对目录/设备返回 false，对软链返回 true（跟随）", async () => {
    const dir = join(testDir, "a-dir");
    mkdirSync(dir);
    const real = join(testDir, "real.txt");
    writeFileSync(real, "x");
    const link = join(testDir, "link.txt");
    symlinkSync(real, link);

    // 这两个 false 正是「把目录/设备记成新建文件」的直接原因
    expect(await Bun.file(dir).exists()).toBe(false);
    expect(await Bun.file(real).exists()).toBe(true);
    // 软链跟随 target ⇒ 若不改用 lstat，写入会写穿链接
    expect(await Bun.file(link).exists()).toBe(true);
    if (hasDevNull) {
      expect(await Bun.file("/dev/null").exists()).toBe(false);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 2. 止新：非普通文件不入快照
  // ─────────────────────────────────────────────────────────────

  test("止新：目录不入快照，登记到 skippedFiles（reason: non-regular）", async () => {
    const m = newManager();
    await m.init();
    const dir = join(testDir, "sub");
    mkdirSync(dir);
    const file = join(testDir, "a.txt");
    writeFileSync(file, "hello");

    const id = await m.createSnapshot([dir, file], "bash", "rm -rf sub");
    expect(id).toBe("s1");

    const detail = m.getSnapshotDetail("s1")!;
    // 真文件照常进快照，目录被跳过
    expect(detail.files.map((f) => f.filePath)).toEqual([file]);
    expect(detail.skippedFiles).toEqual([{ filePath: dir, bytes: 0, reason: "non-regular" }]);
    // 目录没被当成「新建文件 + 空内容」记进来（那才是卡死的根）
    expect(detail.files.some((f) => f.filePath === dir)).toBe(false);
  });

  test("止新：全是非普通文件时不创建空快照（从源头消灭纯噪音快照）", async () => {
    const m = newManager();
    await m.init();
    const dir = join(testDir, "sub");
    mkdirSync(dir);

    const id = await m.createSnapshot([dir], "bash", "mkdir sub");
    // 返回空串而不是那个已自增但未入列的幽灵 id：调用方 `if (snapshotId)` 就不会
    // 把一个索引里不存在的 s<N> 记成回退锚点（记了之后拿它回退必然失败）。
    expect(id).toBe("");
    // 不建快照 ⇒ 未来不会有「按 /undo 只消耗快照却什么都没撤」的空转
    expect(m.listSnapshots().length).toBe(0);
    expect(existsSync(join(ckptDir, "snapshots", "s1.json"))).toBe(false);
  });

  test("止新：软链不入快照，target 内容保持原样（不写穿）", async () => {
    const m = newManager();
    await m.init();
    const target = join(testDir, "target.txt");
    writeFileSync(target, "original");
    const link = join(testDir, "link.txt");
    symlinkSync(target, link);

    await m.createSnapshot([link], "write", "edit link");
    // 软链不算普通文件 ⇒ 不进快照 ⇒ 未来回滚不会往链接路径写
    expect(m.listSnapshots().length).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe("original");
  });

  // ─────────────────────────────────────────────────────────────
  // 3. 兼容：历史坏条目不让 /undo 卡死
  // ─────────────────────────────────────────────────────────────

  test("兼容：纯噪音快照（只有 /dev/null）被消耗，不再永久卡住", async () => {
    if (!hasDevNull) return;
    // s1 = 历史坏条目；s2 = 真改动。修复前 undo 会永远停在 s2 上失败。
    const realFile = join(testDir, "real.txt");
    writeFileSync(realFile, "changed");
    writeLegacyShard([
      {
        id: "s1",
        files: [{ filePath: realFile, existedBefore: true, content: "before" }],
      },
      { id: "s2", files: [{ filePath: "/dev/null", existedBefore: false }] },
    ]);

    const m = newManager();
    await m.init();
    expect(m.listSnapshots().map((s) => s.id)).toEqual(["s1", "s2"]);

    const result = await m.undo();
    // 一次 /undo 越过噪音快照，落到真有可回滚目标的 s1 上
    expect(result).not.toBeNull();
    expect(result!.snapshotId).toBe("s1");
    expect(result!.files.map((f) => f.filePath)).toEqual([realFile]);
    expect(readFileSync(realFile, "utf-8")).toBe("before");
    // 两个快照都被消耗（s2 是噪音，s1 真的撤了）
    expect(m.listSnapshots()).toEqual([]);
  });

  test("兼容：只有噪音快照时返回 null，但快照被消耗（下一次不再重复撞同一堵墙）", async () => {
    if (!hasDevNull) return;
    writeLegacyShard([{ id: "s1", files: [{ filePath: "/dev/null", existedBefore: false }] }]);

    const m = newManager();
    await m.init();
    // 没有可回滚目标 ⇒ 命令层如实说「没有可撤销的修改」
    expect(await m.undo()).toBeNull();
    // 但快照已消耗：这正是「下次能前进」与「永久卡死」的分界
    expect(m.listSnapshots()).toEqual([]);
    // 设备文件毫发无损（从没被 unlink 过）
    expect(existsSync("/dev/null")).toBe(true);
  });

  test("兼容：混杂快照里真文件照常回滚，/dev/null 不被误记成失败", async () => {
    if (!hasDevNull) return;
    const realFile = join(testDir, "real.txt");
    writeFileSync(realFile, "changed");
    writeLegacyShard([
      {
        id: "s1",
        files: [
          { filePath: "/dev/null", existedBefore: false },
          { filePath: realFile, existedBefore: true, content: "before" },
        ],
      },
    ]);

    const m = newManager();
    await m.init();
    const result = await m.undo();
    expect(result).not.toBeNull();
    // 只有真文件出现在结果里：/dev/null 既不算成功也不算失败
    expect(result!.files).toEqual([{ filePath: realFile, action: "restored" }]);
    expect(readFileSync(realFile, "utf-8")).toBe("before");
  });

  test("兼容：restoreToSnapshot 不把历史坏条目记成 failedFiles", async () => {
    if (!hasDevNull) return;
    const realFile = join(testDir, "real.txt");
    writeFileSync(realFile, "changed");
    // 回滚区间必须**非空**：目标是 s1，区间 = [s2]，s2 里那条 /dev/null 才会被真正处理。
    // （若把坏条目放在目标快照自己身上，区间为空、循环不进，这条断言会恒绿什么都测不到。）
    writeLegacyShard([
      { id: "s1", files: [{ filePath: realFile, existedBefore: true, content: "before" }] },
      { id: "s2", files: [{ filePath: "/dev/null", existedBefore: false }] },
    ]);

    const m = newManager();
    await m.init();
    const result = await m.restoreToSnapshot("s1");
    expect(result).not.toBeNull();
    // /dev/null 删不掉，但它不是可回滚目标 ⇒ 不进失败清单（修复前会被记成回滚失败）
    expect(result!.failedFiles).toEqual([]);
  });

  test("兼容：restoreBeforeSnapshot（/rewind 用的入口）同样跳过历史坏条目", async () => {
    if (!hasDevNull) return;
    const realFile = join(testDir, "real.txt");
    writeFileSync(realFile, "changed");
    // s1 里 /dev/null 是坏条目；s2 是真改动。
    // rewind 到 s1「之前」⇒ 回滚区间 = [s1, s2]，两个条目都会过一遍。
    writeLegacyShard([
      { id: "s1", files: [{ filePath: "/dev/null", existedBefore: false }] },
      { id: "s2", files: [{ filePath: realFile, existedBefore: true, content: "before" }] },
    ]);

    const m = newManager();
    await m.init();
    const result = await m.restoreBeforeSnapshot("s1");
    expect(result).not.toBeNull();
    // /dev/null 不算失败，真文件照常回滚
    expect(result!.failedFiles).toEqual([]);
    expect(readFileSync(realFile, "utf-8")).toBe("before");
  });

  // ─────────────────────────────────────────────────────────────
  // 4. N5 不回归：真失败仍然保留快照 + 返回 null
  // ─────────────────────────────────────────────────────────────

  test("N5 不回归：真失败（重建不出内容）仍返回 null 并保留快照供重试", async () => {
    // existedBefore=true 且是 diff、但盘上没有任何 full 基点 ⇒ rebuildContentAtSnapshot
    // 往前找不到 full（baseSnapshotIndex === -1）⇒ 返回 null。这是真失败，
    // 绝不能被「没有可回滚目标」的新判据吃掉（那会让用户以为撤销成功、其实什么都没回）。
    writeLegacyShard([
      {
        id: "s1",
        files: [{ filePath: join(testDir, "gone.txt"), existedBefore: true, type: "diff" }],
      },
    ]);

    const m = newManager();
    await m.init();
    expect(await m.undo()).toBeNull();
    // 保留快照 —— 用户可以修好后重试，而不是被悄悄消耗掉
    expect(m.listSnapshots().map((s) => s.id)).toEqual(["s1"]);
  });

  test("N5 不回归：一次 /undo 只退一个真快照，不因跳过逻辑多退", async () => {
    const a = join(testDir, "a.txt");
    const b = join(testDir, "b.txt");
    writeFileSync(a, "a2");
    writeFileSync(b, "b2");
    writeLegacyShard([
      { id: "s1", files: [{ filePath: a, existedBefore: true, content: "a1" }] },
      { id: "s2", files: [{ filePath: b, existedBefore: true, content: "b1" }] },
    ]);

    const m = newManager();
    await m.init();
    const r1 = await m.undo();
    expect(r1!.snapshotId).toBe("s2");
    expect(readFileSync(b, "utf-8")).toBe("b1");
    // s1 还没动
    expect(readFileSync(a, "utf-8")).toBe("a2");

    const r2 = await m.undo();
    expect(r2!.snapshotId).toBe("s1");
    expect(readFileSync(a, "utf-8")).toBe("a1");
  });
});
