/**
 * RewindManager ↔ 真实 CheckpointManager 集成测试（A1）
 *
 * ## 为什么必须有这条
 * 修之前 `rewind-manager.test.ts` / `p1-rewind-after-compact.test.ts` / `prompt-retraction.test.ts`
 * 都把 `restoreToSnapshot` mock 成固定返回值，**没有一条测试把两层接在一起跑过**。
 * 于是两边各自全绿、接线处语义错位：rewind 的锚点是「本轮首个快照」，而它调的
 * `restoreToSnapshot` 只回滚「该快照之后」——差一格，本轮只改过一次文件时回滚 0 个文件。
 *
 * 这条测试的价值就在于：真实的 CheckpointManager + 真实的 RewindManager，
 * 按**生产时序**接线（registerPoint 在用户输入提交前、createSnapshot 在工具执行前、
 * attachSnapshot 在本轮首个快照建成时），任何一侧的语义漂移都会在这里变红。
 *
 * ## 隔离说明
 * `new CheckpointManager(sessionId)` 无条件写 `sidPaths.checkpoints(sessionId)`。
 * 必须显式设 `SID_CONFIG_DIR`，且存/恢复原值（不要无条件 delete，会抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { RewindManager } from "@sid-code/core/session/rewind-manager.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-rewind-real-ckpt-home-"));
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

describe("RewindManager + 真实 CheckpointManager", () => {
  let testDir: string;
  let cpMgr: CheckpointManager;
  let mgr: RewindManager;
  let msgs: unknown[];

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "rewind-real-ckpt-files-"));
    cpMgr = new CheckpointManager(
      `rewind-real-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      {
        enabled: true,
      },
    );
    await cpMgr.init();

    msgs = [];
    mgr = new RewindManager({
      getMessages: () => msgs,
      setMessages: (m) => {
        msgs = m;
      },
      // 生产接线：CheckpointManager 的 failedFiles 必须透传上去，
      // 折叠成一个数字就等于把「哪些文件没回滚」这条排查线索丢了。
      restoreBeforeSnapshot: async (snapshotId) => {
        const r = await cpMgr.restoreBeforeSnapshot(snapshotId);
        if (!r) return null;
        return { restored: r.files.length, failed: r.failedFiles };
      },
    });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("按轮回退：仅代码回到第 2 轮之前，a 回到第 1 轮结果、b 被删除、对话不动", async () => {
    const a = join(testDir, "a.txt");
    const b = join(testDir, "b.txt");
    writeFileSync(a, "A0\n");

    // ── 第 1 轮 ──
    // 生产时序：registerPoint 在用户输入提交前（此时本轮快照还不存在，锚点留空）。
    const p1 = mgr.registerPoint("轮1", 1);
    msgs.push({ role: "user", content: "轮1" });
    msgs.push({ role: "assistant", content: "答1" });
    // 工具执行前建快照 → onSnapshotCreated 回填本轮首个快照。
    const s1 = await cpMgr.createSnapshot([a], "edit", "改 a");
    mgr.attachSnapshot(s1);
    writeFileSync(a, "A1\n");

    // ── 第 2 轮 ──
    const p2 = mgr.registerPoint("轮2", 2);
    msgs.push({ role: "user", content: "轮2" });
    msgs.push({ role: "assistant", content: "答2" });
    const s2 = await cpMgr.createSnapshot([a], "edit", "再改 a");
    mgr.attachSnapshot(s2);
    writeFileSync(a, "A2\n");
    const s3 = await cpMgr.createSnapshot([b], "write", "新建 b");
    mgr.attachSnapshot(s3); // 幂等：本轮已有锚点，忽略
    writeFileSync(b, "B1\n");

    // 锚点必须是本轮**首个**快照，而不是最后一个。
    expect(mgr.getPoint(p2.id)!.snapshotId).toBe(s2);
    expect(msgs).toHaveLength(4);

    // ── 回到第 2 轮之前（仅代码）──
    const r = await mgr.rewindTo(p2.id, "code", Date.now());

    expect(r).not.toBeNull();
    expect(r!.filesRestored).toBe(2); // a 恢复 + b 删除
    expect(r!.filesFailed).toBe(0);
    expect(r!.fileRestoreSkipped).toBe(false);
    expect(r!.messagesDropped).toBe(0); // 仅代码不动对话
    expect(readFileSync(a, "utf-8")).toBe("A1\n");
    expect(existsSync(b)).toBe(false);
    expect(msgs).toHaveLength(4);

    // ── 再回到第 1 轮之前（对话 + 代码）──
    const r2 = await mgr.rewindTo(p1.id, "conversation-and-code", Date.now());

    expect(r2!.filesRestored).toBe(1);
    expect(r2!.messagesDropped).toBe(4); // 第 1 轮的 messageIndex 是 0
    expect(readFileSync(a, "utf-8")).toBe("A0\n");
    expect(msgs).toHaveLength(0);
    // 回退点也被清理干净（对话已回到最初）。
    expect(mgr.hasPoints()).toBe(false);
  });

  test("本轮没有快照（只读轮）：跳过文件回滚，磁盘不动", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");

    const p = mgr.registerPoint("只读轮", 1);
    msgs.push({ role: "user", content: "只读轮" });
    // 本轮没有任何工具改动 ⇒ 不建快照、也不调 attachSnapshot。
    expect(mgr.getPoint(p.id)!.snapshotId).toBe("");

    const r = await mgr.rewindTo(p.id, "code", Date.now());

    expect(r!.fileRestoreSkipped).toBe(true);
    expect(r!.filesRestored).toBe(0);
    expect(r!.filesFailed).toBe(0);
    expect(readFileSync(a, "utf-8")).toBe("A0\n");
  });

  test("部分失败：failedFiles 经两层透传到 RewindResult.filesFailed", async () => {
    const a = join(testDir, "a.txt");
    writeFileSync(a, "A0\n");

    const p = mgr.registerPoint("轮1", 1);
    const s1 = await cpMgr.createSnapshot([a], "edit", "改 a");
    mgr.attachSnapshot(s1);
    writeFileSync(a, "A1\n");

    // 让磁盘上的目标路径变成目录 ⇒ 恢复写不回，必须进 failedFiles 而不是静默成功。
    rmSync(a);
    const { mkdirSync } = await import("fs");
    mkdirSync(a);

    const r = await mgr.rewindTo(p.id, "code", Date.now());

    expect(r!.filesRestored).toBe(0);
    expect(r!.filesFailed).toBe(1);
    expect(r!.fileRestoreSkipped).toBe(false);
  });
});
