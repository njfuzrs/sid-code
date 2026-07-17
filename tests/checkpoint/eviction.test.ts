/**
 * P1-2：checkpoint eviction + 总量上限真正执行 测试
 *
 * 覆盖此前零覆盖的淘汰/上限逻辑：
 * - A. per-file 版本上限（maxCheckpointsPerFile）写时生效，保留窗口内仍可 restore。
 * - diff 链重锚定：被淘汰的最旧条目含 full 时，后续 diff 自动重锚定为新 full，rebuild 内容仍正确。
 * - B. 总量上限（maxTotalSizeMb）写时删到阈值下，且不破坏最近快照。
 * - cleanupOldSessions 总量超限真删最旧 session 目录（不只 warn）。
 * - nextId 淘汰后不回退；latestFullMap 淘汰后正确。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CheckpointManager } from "../../src/checkpoint/manager.ts";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("CheckpointManager 淘汰（P1-2）", () => {
  let testDir: string;
  let configDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `ckpt-evict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    // 把 checkpoints 落到隔离配置目录，避免污染真实 ~/.sid-code。
    configDir = join(testDir, ".sid-code");
    mkdirSync(configDir, { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function newManager(cfg: Record<string, unknown>): CheckpointManager {
    const sessionId = `evict-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new CheckpointManager(sessionId, { enabled: true, ...cfg });
  }

  test("A：同一文件超 maxCheckpointsPerFile 时旧版本被淘汰，保留窗口内仍可 restore", async () => {
    const m = newManager({ maxCheckpointsPerFile: 3, maxTotalSizeMb: 999 });
    await m.init();

    const file = join(testDir, "a.txt");
    // 连续 6 次修改（>3），每次 createSnapshot 前写入新内容 → 快照记录“修改前”内容。
    // 记录每个快照 id 与它保存的“修改前内容”。
    const snapIds: string[] = [];
    const contentAtSnap: string[] = [];
    for (let i = 0; i < 6; i++) {
      const before = `v${i}`;
      writeFileSync(file, before);
      const id = await m.createSnapshot([file], "write", `edit ${i}`);
      snapIds.push(id);
      contentAtSnap.push(before);
    }

    // 该文件条目数应被压到 ≤ 3。
    const stats = m.getStats();
    expect(stats.totalCheckpoints).toBeLessThanOrEqual(3);

    // 保留窗口内（最近的快照）仍可 restore，且内容正确。
    // 最后一个快照保存的是 "v5"（第 6 次修改前的内容）。
    const lastId = snapIds[snapIds.length - 1];
    await m.restoreToSnapshot(lastId);
    expect(readFileSync(file, "utf-8")).toBe("v5");
  });

  test("diff 链重锚定：淘汰含 full 的最旧条目后，存活快照仍能正确 rebuild", async () => {
    const m = newManager({ maxCheckpointsPerFile: 2, maxTotalSizeMb: 999, compressThresholdKb: 999 });
    await m.init();

    const file = join(testDir, "chain.txt");
    const snapIds: string[] = [];
    // 4 次修改：s1=full(v0), s2=diff(v1), s3=diff(v2), s4=diff(v3)。
    // maxCheckpointsPerFile=2 → 淘汰最旧到只剩 2 个。s1(full) 被淘汰前须把 s2/s3 之一重锚定为 full。
    for (let i = 0; i < 4; i++) {
      writeFileSync(file, `line-${i}`);
      snapIds.push(await m.createSnapshot([file], "write", `edit ${i}`));
    }

    const stats = m.getStats();
    expect(stats.totalCheckpoints).toBeLessThanOrEqual(2);

    // 存活的每个快照都能正确 rebuild（重锚定成功的证据）。用只读 rebuild 路径逐个校验——
    // 不能用 restoreToSnapshot 连续验证：它是破坏性的（会删目标之后的快照），第一次调用后链就被截断。
    const surviving = m.listSnapshots(); // 按时间序
    for (const s of surviving) {
      const idxInOriginal = snapIds.indexOf(s.id);
      expect(idxInOriginal).toBeGreaterThanOrEqual(0);
      const rebuilt = await (m as any).rebuildContentAtSnapshot(file, s.id);
      expect(rebuilt).toBe(`line-${idxInOriginal}`);
    }
  });

  test("nextId 淘汰后不回退（单调递增，/restore id 语义稳定）", async () => {
    const m = newManager({ maxCheckpointsPerFile: 2, maxTotalSizeMb: 999 });
    await m.init();

    const file = join(testDir, "n.txt");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `x${i}`);
      ids.push(await m.createSnapshot([file], "write", `e${i}`));
    }
    // 即使前面的快照被淘汰，新分配的 id 必须比历史所有 id 都大（不复用）。
    // 最后一个 id 是 s5。
    expect(ids[ids.length - 1]).toBe("s5");
    // 再建一个，应是 s6，不因淘汰回退。
    writeFileSync(file, "x6");
    const next = await m.createSnapshot([file], "write", "e6");
    expect(next).toBe("s6");
  });

  test("B：总量超 maxTotalSizeMb 时删到阈值下，最近快照仍可 restore", async () => {
    // 极小阈值触发总量淘汰。用大内容放大单快照体积。
    const m = newManager({ maxCheckpointsPerFile: 9999, maxTotalSizeMb: 0.02, compressThresholdKb: 9999 });
    await m.init();

    // 多个不同文件，制造多快照。保留窗口 MIN_KEEP=11，故建 ≥ 15 个确保触发。
    let lastFile = "";
    let lastContent = "";
    for (let i = 0; i < 15; i++) {
      const f = join(testDir, `big-${i}.txt`);
      const content = "Z".repeat(2000) + i;
      writeFileSync(f, content);
      await m.createSnapshot([f], "write", `big ${i}`);
      lastFile = f;
      lastContent = content;
    }

    // 总量应被压到阈值附近（不再无限增长）。至少发生了淘汰：快照数 < 15。
    const snaps = m.listSnapshots();
    expect(snaps.length).toBeLessThan(15);

    // 最近的快照仍可 restore（保留窗口保护）。最后一个快照保存的是 lastFile 修改前内容——
    // 但该文件是新建（existedBefore=false，记录空内容），restore 会删除它。改验证 restore 不报错、返回非空。
    const lastId = snaps[snaps.length - 1].id;
    const res = await m.restoreToSnapshot(lastId);
    expect(res).not.toBeNull();
    void lastFile; void lastContent;
  });

  test("latestFullMap 淘汰后指向存活快照（不指向已删）", async () => {
    const m = newManager({ maxCheckpointsPerFile: 2, maxTotalSizeMb: 999, compressThresholdKb: 999 });
    await m.init();

    const file = join(testDir, "map.txt");
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `c${i}`);
      await m.createSnapshot([file], "write", `e${i}`);
    }

    // 访问内部 index 校验 latestFullMap 一致性（测试白盒，允许 as any）。
    const idx = (m as any).index;
    const liveIds = new Set(idx.snapshots.map((s: any) => s.id));
    for (const [fp, sid] of Object.entries(idx.latestFullMap as Record<string, string>)) {
      // 映射的快照必须仍存活。
      expect(liveIds.has(sid)).toBe(true);
      // 且该快照里该文件确为 full。
      const snap = idx.snapshots.find((s: any) => s.id === sid);
      const f = snap.files.find((x: any) => x.filePath === fp);
      expect(f?.type).toBe("full");
    }
  });

  test("cleanupOldSessions：总量超限真删最旧 session 目录（不只 warn）", async () => {
    const { sidPaths } = await import("../../src/config/paths.ts");
    const root = sidPaths.checkpointsRoot();
    mkdirSync(root, { recursive: true });

    // 造两个“其他 session”目录，各塞一个大 index.json，使总量超阈值。
    const mkOld = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.json"), "Z".repeat(30 * 1024)); // 30KB each
    };
    mkOld("old-session-A");
    mkOld("old-session-B");

    // 让 A 更旧（mtime 更小）：B 后写，A 手动回拨。
    const { utimesSync } = await import("fs");
    const olderTime = new Date(Date.now() - 60_000);
    utimesSync(join(root, "old-session-A"), olderTime, olderTime);

    // 阈值 0.04MB ≈ 40KB，两目录合计 60KB 超限 → 应删最旧的 A。
    const m = newManager({ maxTotalSizeMb: 0.04, maxAgeDays: 9999 });
    await m.init(); // init 内调 cleanupOldSessions

    expect(existsSync(join(root, "old-session-A"))).toBe(false); // 最旧被真删
    expect(existsSync(join(root, "old-session-B"))).toBe(true);  // 较新保留
  });
});
