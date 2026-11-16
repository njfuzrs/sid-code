/**
 * P3：checkpoint 索引分片 + 单文件上限 测试
 *
 * 覆盖方案文档 P3 的两处根因与验收判据：
 * - A. 单文件上限：超限文件不进快照（否则一次 `ls -la` 就能把 79MB 编译产物收进索引）、
 *   登记到 Snapshot.skippedFiles 让命令层能如实告知「这些文件回滚不了」。
 * - B. 索引分片：index.json 只存头，每个快照单独落 snapshots/<id>.json。
 *   **写放大门禁**在下面「新增快照不改写历史分片」那条：它直接断言老分片逐字节未变，
 *   这是「一次快照不再重写全部」的机器判据，不是靠注释承诺。
 * - C. serializedSize 改成增量求和：断言它等于磁盘真实字节（evictBySize 靠它判断）。
 *
 * 另外锁住分片格式带来的新契约：被淘汰 / 被截断 / 被 undo 的快照，分片必须 unlink，
 * 否则下次 init 会把它们从盘上读回来（「重新打开会话，回滚过的快照复活了」）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("P3：checkpoint 索引分片 + 单文件上限", () => {
  let testDir: string;
  let configDir: string;
  let origConfigDir: string | undefined;
  let sessionId: string;
  let ckptDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ckpt-p3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    // 落盘隔离：checkpoint 目录必须落在 tmpdir（同其他 checkpoint 测试的写法）。
    configDir = join(testDir, ".sid-code");
    mkdirSync(configDir, { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = configDir;
    sessionId = `p3-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  /** 分片文件名（按字典序返回，测试里都是 s1..s9 所以等价于序号序） */
  function shardNames(): string[] {
    const dir = join(ckptDir, "snapshots");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  }

  function readHead(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(ckptDir, "index.json"), "utf-8"));
  }

  function readShard(id: string): string {
    return readFileSync(join(ckptDir, "snapshots", `${id}.json`), "utf-8");
  }

  test("分片落盘：index.json 只存头，快照内容落在 snapshots/<id>.json", async () => {
    const m = newManager();
    await m.init();
    const file = join(testDir, "a.txt");
    writeFileSync(file, "hello");

    const id = await m.createSnapshot([file], "write", file);
    expect(id).toBe("s1");

    const head = readHead();
    expect(head.version).toBe(2);
    expect(head.sessionId).toBe(sessionId);
    // 头里不再内联快照——这正是 42MB 索引的成因，必须消失
    expect(head.snapshots).toBeUndefined();
    expect(readFileSync(join(ckptDir, "index.json"), "utf-8").length).toBeLessThan(500);

    expect(shardNames()).toEqual(["s1.json"]);
    const shard = JSON.parse(readShard("s1"));
    expect(shard.id).toBe("s1");
    expect(shard.files[0].filePath).toBe(file);
    expect(shard.files[0].content).toBe("hello");
  });

  test("写放大门禁：新增快照不改写历史分片，index.json 大小不随快照数增长", async () => {
    const m = newManager({ maxTotalSizeMb: 999 });
    await m.init();
    const file = join(testDir, "a.txt");

    writeFileSync(file, "v0");
    await m.createSnapshot([file], "write", "edit 0");

    const firstShardPath = join(ckptDir, "snapshots", "s1.json");
    const firstShardBytes = readFileSync(firstShardPath);
    const firstMtime = statSync(firstShardPath).mtimeMs;
    const headAfterFirst = readFileSync(join(ckptDir, "index.json"), "utf-8");

    for (let i = 1; i <= 5; i++) {
      writeFileSync(file, `v${i}`);
      await m.createSnapshot([file], "write", `edit ${i}`);
    }

    // ① 历史分片逐字节未变（且没被重写：mtime 不动）—— 一次快照只写自己的分片
    expect(readFileSync(firstShardPath)).toEqual(firstShardBytes);
    expect(statSync(firstShardPath).mtimeMs).toBe(firstMtime);

    // ② index.json 只是头：多出来的只有一个 nextId 数字，不随快照数线性增长
    const headAfterSix = readFileSync(join(ckptDir, "index.json"), "utf-8");
    expect(headAfterSix.length).toBeLessThanOrEqual(headAfterFirst.length + 8);

    // ③ 六个快照各自有分片
    expect(shardNames()).toEqual([
      "s1.json",
      "s2.json",
      "s3.json",
      "s4.json",
      "s5.json",
      "s6.json",
    ]);
  });

  test("serializedSize 等于磁盘真实字节（增量统计不虚高也不漏算）", async () => {
    const m = newManager({ maxTotalSizeMb: 999 });
    await m.init();
    const file = join(testDir, "a.txt");
    for (let i = 0; i < 4; i++) {
      writeFileSync(file, "x".repeat(1000 + i * 100));
      await m.createSnapshot([file], "write", `edit ${i}`);
    }

    const size = (m as unknown as { serializedSize(): number }).serializedSize();
    let real = statSync(join(ckptDir, "index.json")).size;
    for (const name of shardNames()) real += statSync(join(ckptDir, "snapshots", name)).size;

    // 分片 + 头的字节和应与落盘内容完全一致（同一份 JSON 既写盘又计量）
    expect(size).toBe(real);
  });

  test("旧内联格式（index.json 内联 snapshots）自动迁移为分片", async () => {
    mkdirSync(ckptDir, { recursive: true });
    const file = join(testDir, "a.txt");
    writeFileSync(
      join(ckptDir, "index.json"),
      JSON.stringify(
        {
          sessionId,
          createdAt: 1700000000000,
          nextId: 3,
          // N8 已废弃字段：迁移时必须一并剥掉，不能原样回写
          latestFullMap: { [file]: "s1" },
          snapshots: [
            {
              id: "s1",
              timestamp: 1,
              toolName: "write",
              toolSummary: file,
              files: [
                {
                  filePath: file,
                  existedBefore: true,
                  type: "full",
                  content: "old-1",
                  compressed: false,
                },
              ],
            },
            {
              id: "s2",
              timestamp: 2,
              toolName: "write",
              toolSummary: file,
              files: [
                {
                  filePath: file,
                  existedBefore: true,
                  type: "full",
                  content: "old-2",
                  compressed: false,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    const m = newManager({ maxTotalSizeMb: 999 });
    await m.init();

    // 内存里历史仍在
    expect(m.listSnapshots().map((s) => s.id)).toEqual(["s1", "s2"]);

    // 磁盘已改成 v2：头 + 分片，旧内联内容不再留在 index.json 里
    const head = readHead();
    expect(head.version).toBe(2);
    expect(head.snapshots).toBeUndefined();
    expect(head.latestFullMap).toBeUndefined();
    expect(readFileSync(join(ckptDir, "index.json"), "utf-8")).not.toContain("old-1");
    expect(shardNames()).toEqual(["s1.json", "s2.json"]);
    expect(readShard("s1")).toContain("old-1");

    // 迁移后的分片能被下一轮 init 正常读回（迁移是幂等的，不是一次性幻觉）
    const m2 = newManager({ maxTotalSizeMb: 999 });
    await m2.init();
    expect(m2.listSnapshots().map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  test("更旧的 files 结构（更早的索引格式）也迁移为分片", async () => {
    mkdirSync(ckptDir, { recursive: true });
    const file = join(testDir, "b.txt");
    writeFileSync(
      join(ckptDir, "index.json"),
      JSON.stringify({
        sessionId,
        createdAt: 1700000000000,
        files: {
          [file]: {
            filePath: file,
            entries: [
              {
                filePath: file,
                timestamp: 1000,
                type: "full",
                content: "legacy-content",
                compressed: false,
              },
            ],
          },
        },
      }),
    );

    const m = newManager();
    await m.init();
    expect(m.listSnapshots().length).toBe(1);
    expect(readHead().version).toBe(2);
    expect(shardNames().length).toBe(1);
    expect(readShard("s1")).toContain("legacy-content");
  });

  test("超过 maxFileSizeMb 的文件不进快照，并登记到 skippedFiles", async () => {
    // 上限设成 0.001MB（≈1KB），造一个 2KB 的大文件 + 一个小文件
    const m = newManager({ maxFileSizeMb: 0.001, maxTotalSizeMb: 999 });
    await m.init();
    const big = join(testDir, "big.bin");
    const small = join(testDir, "small.txt");
    writeFileSync(big, "B".repeat(2048));
    writeFileSync(small, "ok");

    const id = await m.createSnapshot([big, small], "write", "two files");
    expect(id).toBe("s1");

    const detail = m.getSnapshotDetail("s1")!;
    expect(detail.files.map((f) => f.filePath)).toEqual([small]);
    expect(detail.skippedFiles).toEqual([{ filePath: big, bytes: 2048 }]);
    // 大文件内容确实没落进分片（不是"标记跳过但仍然存了"）
    expect(readShard("s1")).not.toContain("BBBB");
  });

  test("全部文件超限时不创建空快照（避免 /undo 谎报成功）", async () => {
    const m = newManager({ maxFileSizeMb: 0.001 });
    await m.init();
    const big = join(testDir, "big.bin");
    writeFileSync(big, "B".repeat(2048));

    await m.createSnapshot([big], "write", "only big");
    expect(m.listSnapshots().length).toBe(0);
    expect(shardNames().length).toBe(0);
  });

  test("负向对照：maxFileSizeMb=0 关闭上限，大文件照常进快照", async () => {
    const m = newManager({ maxFileSizeMb: 0 });
    await m.init();
    const big = join(testDir, "big.bin");
    writeFileSync(big, "B".repeat(2048));

    await m.createSnapshot([big], "write", "big");
    const detail = m.getSnapshotDetail("s1")!;
    expect(detail.files.length).toBe(1);
    expect(detail.skippedFiles).toBeUndefined();
  });

  test("undo 移除的快照分片从盘上消失（重启不复活）", async () => {
    const m = newManager({ maxTotalSizeMb: 999 });
    await m.init();
    const file = join(testDir, "a.txt");
    writeFileSync(file, "before");
    await m.createSnapshot([file], "write", "edit");
    expect(shardNames()).toEqual(["s1.json"]);

    const result = await m.undo();
    expect(result).not.toBeNull();
    expect(shardNames()).toEqual([]);

    // 「重启」= 同一 sessionId 重新 init，不应把 s1 从盘上读回来
    const m2 = newManager({ maxTotalSizeMb: 999 });
    await m2.init();
    expect(m2.listSnapshots().length).toBe(0);
  });

  test("restoreToSnapshot 截断掉的快照分片被删除（重启不复活）", async () => {
    const m = newManager({ maxTotalSizeMb: 999 });
    await m.init();
    const file = join(testDir, "a.txt");
    for (let i = 0; i < 3; i++) {
      writeFileSync(file, `v${i}`);
      await m.createSnapshot([file], "write", `edit ${i}`);
    }
    expect(shardNames()).toEqual(["s1.json", "s2.json", "s3.json"]);

    await m.restoreToSnapshot("s1");
    expect(shardNames()).toEqual(["s1.json"]);

    const m2 = newManager({ maxTotalSizeMb: 999 });
    await m2.init();
    expect(m2.listSnapshots().map((s) => s.id)).toEqual(["s1"]);
  });

  test("per-file 淘汰掉的快照分片被删除（淘汰后不会因为分片残留而膨胀）", async () => {
    const m = newManager({ maxCheckpointsPerFile: 2, maxTotalSizeMb: 999 });
    await m.init();
    const file = join(testDir, "a.txt");
    for (let i = 0; i < 4; i++) {
      writeFileSync(file, `v${i}`);
      await m.createSnapshot([file], "write", `edit ${i}`);
    }

    // 每个快照只含该文件一条 → 淘汰到剩 2 条即剩 2 个快照
    expect(shardNames()).toEqual(["s3.json", "s4.json"]);

    const m2 = newManager({ maxCheckpointsPerFile: 2, maxTotalSizeMb: 999 });
    await m2.init();
    expect(m2.listSnapshots().map((s) => s.id)).toEqual(["s3", "s4"]);
  });

  test("nextId 自愈：头里的 nextId 落后于最大分片序号时，新快照不复用 id", async () => {
    mkdirSync(join(ckptDir, "snapshots"), { recursive: true });
    // 模拟「写完分片、还没写头」时中断：头 nextId=1，盘上已有 s3
    writeFileSync(
      join(ckptDir, "index.json"),
      JSON.stringify({ version: 2, sessionId, createdAt: Date.now(), nextId: 1 }, null, 2),
    );
    writeFileSync(
      join(ckptDir, "snapshots", "s3.json"),
      JSON.stringify({
        id: "s3",
        timestamp: 1,
        toolName: "write",
        toolSummary: "x",
        files: [
          {
            filePath: join(testDir, "x.txt"),
            existedBefore: true,
            type: "full",
            content: "x",
            compressed: false,
          },
        ],
      }),
    );

    const m = newManager();
    await m.init();
    const file = join(testDir, "a.txt");
    writeFileSync(file, "hi");
    const newId = await m.createSnapshot([file], "write", "new");

    expect(newId).toBe("s4"); // 不是 s1（复用会覆盖 s3 的分片）
    expect(m.listSnapshots().map((s) => s.id)).toContain("s3");
    // s3 的分片内容没被 s4 覆盖
    expect(JSON.parse(readShard("s3")).id).toBe("s3");
  });

  test("单个分片损坏只跳过它，其余快照仍可读（分片把损坏变成局部事件）", async () => {
    const m = newManager({ maxTotalSizeMb: 999 });
    await m.init();
    const file = join(testDir, "a.txt");
    writeFileSync(file, "v1");
    await m.createSnapshot([file], "write", "edit 1");
    writeFileSync(file, "v2");
    await m.createSnapshot([file], "write", "edit 2");

    writeFileSync(join(ckptDir, "snapshots", "s1.json"), "{ 坏掉的 json");

    const m2 = newManager({ maxTotalSizeMb: 999 });
    await m2.init();
    // 修之前单文件索引一处损坏 = 整份历史丢弃；分片后只丢坏了的那一片
    expect(m2.listSnapshots().map((s) => s.id)).toEqual(["s2"]);
  });
});
