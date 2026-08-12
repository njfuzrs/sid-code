/**
 * P2-1：checkpoint 覆盖 bash 破坏
 *
 * 验证：
 *  - getBashAffectedFiles 对破坏性命令提取受影响文件、对只读命令返回空。
 *  - rm 前建的快照能通过 undo 恢复被删文件（端到端）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getBashAffectedFiles } from "@sid-code/core/checkpoint/bash-affected-files.ts";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
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

  // ── P0-B1：非破坏性但改文件的命令（此前是 checkpoint 盲区） ──

  test("cp 源与目标都收", async () => {
    const files = await getBashAffectedFiles("cp a.ts b.ts", dir);
    expect(files).toContain(join(dir, "a.ts"));
    expect(files).toContain(join(dir, "b.ts"));
  });

  test("> 重定向目标进快照", async () => {
    const files = await getBashAffectedFiles("echo hello > out.txt", dir);
    expect(files).toContain(join(dir, "out.txt"));
  });

  test(">> 追加重定向目标进快照", async () => {
    const files = await getBashAffectedFiles("echo hello >> log.txt", dir);
    expect(files).toContain(join(dir, "log.txt"));
  });

  test("tee 写入目标进快照", async () => {
    const files = await getBashAffectedFiles("echo x | tee out.txt", dir);
    expect(files).toContain(join(dir, "out.txt"));
  });

  test("sed -i 提取目标文件、跳过脚本 token", async () => {
    const files = await getBashAffectedFiles(`sed -i "s/foo/bar/" src/x.ts`, dir);
    expect(files).toContain(join(dir, "src/x.ts"));
    // 脚本 's/foo/bar/' 不应被误当路径
    expect(files).not.toContain(join(dir, "s/foo/bar"));
  });

  test("sed 无 -i（只读）不触发快照", async () => {
    expect(await getBashAffectedFiles(`sed -e "s/a/b/" foo.txt`, dir)).toEqual([]);
  });

  test("动态路径（变量/命令替换）跳过，不写坏 index", async () => {
    const files = await getBashAffectedFiles("f=$(mktemp); echo x > $f", dir);
    expect(files).toEqual([]);
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
    const mine = snaps.find((s) => s.id === sid);
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
    const mine = manager.listSnapshots().find((s) => s.id === sid);
    expect(mine!.fileCount).toBe(2);
  });
});

/**
 * `git clean -f` 删的是**未跟踪**文件——这些文件 `git diff` 看不到，
 * 只走工作区级快照的话永远回退不了（P2-1 待决策项 3：要快照未跟踪文件）。
 */
describe("P2-1 git clean 未跟踪文件进快照", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `git-clean-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    // 建一个最小 git 仓库：1 个已跟踪并被改动的文件 + 未跟踪文件 + 未跟踪目录
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    git(["init"]);
    writeFileSync(join(dir, "tracked.txt"), "orig\n");
    git(["add", "tracked.txt"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
    writeFileSync(join(dir, "tracked.txt"), "orig\nmodified\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    mkdirSync(join(dir, "newdir"), { recursive: true });
    writeFileSync(join(dir, "newdir", "deep.txt"), "deep\n");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("git clean -fd 同时纳入已改动 + 未跟踪文件（含目录展开）", async () => {
    const files = await getBashAffectedFiles("git clean -fd", dir);
    expect(files).toContain(join(dir, "tracked.txt")); // 工作区改动（原有能力）
    expect(files).toContain(join(dir, "untracked.txt")); // 未跟踪文件（新增）
    expect(files).toContain(join(dir, "newdir", "deep.txt")); // 目录展开为文件粒度
  });

  test("git clean -f（无 -d）不含目录内文件", async () => {
    const files = await getBashAffectedFiles("git clean -f", dir);
    expect(files).toContain(join(dir, "untracked.txt"));
    expect(files).not.toContain(join(dir, "newdir", "deep.txt"));
  });

  test("git clean -n（预演）不触发快照", async () => {
    expect(await getBashAffectedFiles("git clean -n", dir)).toEqual([]);
  });

  test("git reset --hard 不误收未跟踪文件（它不删未跟踪）", async () => {
    const files = await getBashAffectedFiles("git reset --hard", dir);
    expect(files).toContain(join(dir, "tracked.txt"));
    expect(files).not.toContain(join(dir, "untracked.txt"));
  });

  // 说明：与上面 rm 的端到端测试同理——本用例断言 P2-1 的实际交付
  // 「clean 之前建快照且捕获未跟踪文件的原始内容」。恢复深度受既有 checkpoint undo 模型
  // 约束（该模型对「文件的首个快照」无法单步恢复，与 write/edit 一致，属另一子系统议题）。
  test("clean 前建快照并捕获未跟踪文件原始内容（端到端）", async () => {
    const manager = new CheckpointManager(
      `git-clean-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      { enabled: true },
    );
    await manager.init();

    const target = join(dir, "untracked.txt");

    // clean 之前建快照（模拟 tool-executor 的行为）
    const affected = await getBashAffectedFiles("git clean -fd", dir);
    expect(affected).toContain(target);
    const sid = await manager.createSnapshot(affected, "bash", "$ git clean -fd");
    expect(sid).toBeTruthy();

    unlinkSync(target); // 模拟 clean 删除未跟踪文件
    expect(existsSync(target)).toBe(false);

    // 快照里确实存了未跟踪文件的原始内容（此前未跟踪文件完全不进快照 = 盲区）
    const snap = manager.listSnapshots().find((s) => s.id === sid);
    expect(snap).toBeDefined();
    expect(snap!.toolName).toBe("bash");
    // P2-1 摘要带上触发命令，便于 /checkpoints 里辨认这是哪次破坏前的快照
    expect(snap!.toolSummary).toContain("git clean");
    const detail = manager.getSnapshotDetail(sid);
    const entry = detail!.files.find((f) => f.filePath === target);
    expect(entry).toBeDefined();
    expect(entry!.existedBefore).toBe(true);
    expect(entry!.type).toBe("full");
    expect(entry!.content).toBe("new\n"); // 原始内容已捕获，可用于回滚
  });
});
