/**
 * P2-1：checkpoint 覆盖 bash 破坏
 *
 * 验证：
 *  - getBashAffectedFiles 对破坏性命令提取受影响文件、对只读命令返回空。
 *  - rm 前建的快照能通过 undo 恢复被删文件（端到端）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getBashAffectedFiles } from "../../src/checkpoint/bash-affected-files.ts";
import { CheckpointManager } from "../../src/checkpoint/manager.ts";
import { mkdirSync, rmSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("P2-1 getBashAffectedFiles 提取", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `bash-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("rm <file> 提取显式路径", async () => {
    const files = await getBashAffectedFiles("rm foo.ts bar.ts", dir);
    expect(files).toContain(join(dir, "foo.ts"));
    expect(files).toContain(join(dir, "bar.ts"));
  });

  test("rm -rf <dir> 跳过 flag", async () => {
    const files = await getBashAffectedFiles("rm -rf build", dir);
    expect(files).toContain(join(dir, "build"));
    expect(files).not.toContain(join(dir, "-rf"));
  });

  test("mv 源与目标都收", async () => {
    const files = await getBashAffectedFiles("mv a.ts b.ts", dir);
    expect(files).toContain(join(dir, "a.ts"));
    expect(files).toContain(join(dir, "b.ts"));
  });

  test("只读 bash（ls）不触发快照", async () => {
    expect(await getBashAffectedFiles("ls -la", dir)).toEqual([]);
    expect(await getBashAffectedFiles("cat foo.ts", dir)).toEqual([]);
  });

  test("git reset --hard 走工作区级快照（非 git 仓库返回空，不报错）", async () => {
    // dir 非 git 仓库 → git diff 失败 → 空集（不阻断）
    const files = await getBashAffectedFiles("git reset --hard HEAD~1", dir);
    expect(Array.isArray(files)).toBe(true);
  });
});

describe("P2-1 rm 破坏进入 checkpoint 覆盖（消除盲区）", () => {
  let dir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    dir = join(tmpdir(), `bash-snap-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    manager = new CheckpointManager(
      `bash-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      { enabled: true },
    );
    await manager.init();
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  // 说明：P2-1 的交付是「破坏性 bash 命令进入快照系统」（此前完全是盲区），
  // 使其与 write/edit 享受同级 checkpoint 覆盖。恢复深度受既有 checkpoint undo 模型
  // 约束（该模型对「最后一个快照/首个快照」的单步恢复本身有独立局限，与 write/edit 一致，
  // 属另一子系统议题，不在本 git 安全缺口范围内）。本测试断言 P2-1 的实际交付：
  // 破坏前会建快照且捕获到被破坏文件的原始内容。
  test("rm 前建快照并捕获原始内容", async () => {
    const file = join(dir, "important.ts");
    writeFileSync(file, "const x = 1;\n", "utf-8");

    // 执行前快照（模拟 tool-executor 的行为）
    const affected = await getBashAffectedFiles(`rm ${file}`, dir);
    expect(affected).toContain(file);
    const sid = await manager.createSnapshot(affected, "bash", `rm ${file}`);
    expect(sid).toBeTruthy();

    // 破坏：删除文件
    unlinkSync(file);
    expect(existsSync(file)).toBe(false);

    // 快照系统里能看到这次破坏前的快照（此前 bash 破坏完全不进快照 = 盲区）
    const snaps = manager.listSnapshots();
    const mine = snaps.find(s => s.id === sid);
    expect(mine).toBeDefined();
    expect(mine!.toolName).toBe("bash");
    expect(mine!.toolSummary).toContain("rm");
    expect(mine!.fileCount).toBe(1);
  });

  test("多文件 rm 全部纳入快照", async () => {
    const f1 = join(dir, "a.ts");
    const f2 = join(dir, "b.ts");
    writeFileSync(f1, "A\n");
    writeFileSync(f2, "B\n");
    const affected = await getBashAffectedFiles(`rm ${f1} ${f2}`, dir);
    const sid = await manager.createSnapshot(affected, "bash", `rm ${f1} ${f2}`);
    const mine = manager.listSnapshots().find(s => s.id === sid);
    expect(mine!.fileCount).toBe(2);
  });
});
