/**
 * P1-G2b：分叉会话继承 checkpoint 历史
 *
 * 背景：`--fork-session` 的新会话 logical id 是全新的 → checkpoint 目录为空目录，
 * 新会话 /undo / /restore 够不到分叉前的任何编辑（方案 §3 验收标准此前不成立）。
 *
 * 覆盖：
 *  - 继承后新会话能 listSnapshots 到源的全部快照，并 restoreToSnapshot 真正回滚文件；
 *  - 深拷贝语义：继承后两会话独立演进，新会话再 snapshot / undo 不污染源会话；
 *  - 快照 id 不重排（/restore <id> 在分叉前后指向同一逻辑快照）；
 *  - 边界：源不存在 / 源为空 / 当前已有快照 / 自继承 → 安全返回 0，不破坏现有索引。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CheckpointManager } from "../../src/checkpoint/manager.ts";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("P1-G2b checkpoint 分叉继承", () => {
  let workDir: string;
  let homeDir: string;
  let origConfigDir: string | undefined;
  let seq = 0;

  /** 造独立 session id，避免同一进程内 id 撞车。 */
  const sid = (tag: string) => `fork-inherit-${tag}-${Date.now()}-${seq++}`;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    workDir = join(tmpdir(), `cp-fork-work-${stamp}`);
    homeDir = join(tmpdir(), `cp-fork-home-${stamp}`);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(homeDir, "checkpoints"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = homeDir;
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    for (const d of [workDir, homeDir]) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  /** 造一个带 N 个快照的源会话：每次改文件前建快照。 */
  async function seedSource(srcId: string, versions: string[]): Promise<string> {
    const file = join(workDir, "target.ts");
    writeFileSync(file, versions[0], "utf-8");
    const mgr = new CheckpointManager(srcId, { enabled: true });
    await mgr.init();
    for (let i = 1; i < versions.length; i++) {
      await mgr.createSnapshot([file], "edit", `第 ${i} 次编辑`);
      writeFileSync(file, versions[i], "utf-8");
    }
    return file;
  }

  test("继承后新会话看得到源的全部快照，且能真正回滚文件", async () => {
    const srcId = sid("src");
    const file = await seedSource(srcId, ["v0", "v1", "v2"]);
    expect(readFileSync(file, "utf-8")).toBe("v2");

    const forkedId = sid("dst");
    const forked = new CheckpointManager(forkedId, { enabled: true });
    await forked.init();
    expect(forked.listSnapshots().length).toBe(0); // 分叉会话初始为空——这正是此前的缺口

    const n = await forked.inheritFrom(srcId);
    expect(n).toBe(2);
    expect(forked.listSnapshots().length).toBe(2);

    // 关键断言：新会话回滚到第一个快照，文件真的回到 v0。
    const first = forked.listSnapshots()[0];
    const result = await forked.restoreToSnapshot(first.id);
    expect(result).not.toBeNull();
    expect(readFileSync(file, "utf-8")).toBe("v0");
  });

  test("快照 id 不重排：继承后 id 与源一一对应", async () => {
    const srcId = sid("src");
    await seedSource(srcId, ["a", "b", "c", "d"]);
    const src = new CheckpointManager(srcId, { enabled: true });
    await src.init();
    const srcIds = src.listSnapshots().map((s) => s.id);

    const forked = new CheckpointManager(sid("dst"), { enabled: true });
    await forked.init();
    await forked.inheritFrom(srcId);

    expect(forked.listSnapshots().map((s) => s.id)).toEqual(srcIds);
  });

  test("深拷贝：继承后新会话新增快照不影响源会话", async () => {
    const srcId = sid("src");
    const file = await seedSource(srcId, ["x0", "x1"]);

    const forkedId = sid("dst");
    const forked = new CheckpointManager(forkedId, { enabled: true });
    await forked.init();
    await forked.inheritFrom(srcId);
    expect(forked.listSnapshots().length).toBe(1);

    // 分叉侧继续演进
    await forked.createSnapshot([file], "edit", "分叉后的编辑");
    expect(forked.listSnapshots().length).toBe(2);

    // 源侧重新加载：仍是 1 个快照，未被污染
    const srcReloaded = new CheckpointManager(srcId, { enabled: true });
    await srcReloaded.init();
    expect(srcReloaded.listSnapshots().length).toBe(1);
  });

  test("深拷贝：新会话 undo 不回写源会话索引", async () => {
    const srcId = sid("src");
    const file = await seedSource(srcId, ["y0", "y1", "y2"]);

    const forked = new CheckpointManager(sid("dst"), { enabled: true });
    await forked.init();
    await forked.inheritFrom(srcId);
    await forked.undo();
    expect(forked.listSnapshots().length).toBe(1);

    const srcReloaded = new CheckpointManager(srcId, { enabled: true });
    await srcReloaded.init();
    expect(srcReloaded.listSnapshots().length).toBe(2); // 源不受影响
    void file;
  });

  test("边界：源会话不存在 → 返回 0，新会话保持空且可用", async () => {
    const forked = new CheckpointManager(sid("dst"), { enabled: true });
    await forked.init();
    expect(await forked.inheritFrom("根本不存在的会话id")).toBe(0);
    expect(forked.listSnapshots().length).toBe(0);
  });

  test("边界：当前已有快照 → 拒绝插入式继承，返回 0 且原快照不动", async () => {
    const srcId = sid("src");
    const file = await seedSource(srcId, ["p0", "p1", "p2"]);

    const forked = new CheckpointManager(sid("dst"), { enabled: true });
    await forked.init();
    await forked.createSnapshot([file], "edit", "分叉会话自己的快照");
    const before = forked.listSnapshots().map((s) => s.id);

    expect(await forked.inheritFrom(srcId)).toBe(0);
    expect(forked.listSnapshots().map((s) => s.id)).toEqual(before);
  });

  test("边界：自继承（源=自身）直接返回 0", async () => {
    const id = sid("self");
    const file = await seedSource(id, ["s0", "s1"]);
    const mgr = new CheckpointManager(id, { enabled: true });
    await mgr.init();
    expect(await mgr.inheritFrom(id)).toBe(0);
    expect(mgr.listSnapshots().length).toBe(1); // 未被清空/翻倍
    void file;
  });

  test("边界：源会话 checkpoint 为空 → 返回 0", async () => {
    const srcId = sid("empty");
    const src = new CheckpointManager(srcId, { enabled: true });
    await src.init(); // 建了目录/索引但没有任何快照

    const forked = new CheckpointManager(sid("dst"), { enabled: true });
    await forked.init();
    expect(await forked.inheritFrom(srcId)).toBe(0);
  });

  test("checkpoint 关闭时继承是 no-op（返回 0）", async () => {
    const srcId = sid("src");
    await seedSource(srcId, ["q0", "q1"]);
    const forked = new CheckpointManager(sid("dst"), { enabled: false });
    await forked.init();
    expect(await forked.inheritFrom(srcId)).toBe(0);
  });

  test("继承结果落盘：重开新会话仍看得到继承来的快照", async () => {
    const srcId = sid("src");
    await seedSource(srcId, ["r0", "r1", "r2"]);

    const forkedId = sid("dst");
    const forked = new CheckpointManager(forkedId, { enabled: true });
    await forked.init();
    await forked.inheritFrom(srcId);

    // 模拟进程重启：同 id 重新 init，从磁盘索引读回
    const reopened = new CheckpointManager(forkedId, { enabled: true });
    await reopened.init();
    expect(reopened.listSnapshots().length).toBe(2);
  });
});
