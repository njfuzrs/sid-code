/**
 * 多代理 F6：两个进程跑同名团队，后写者不能用自己的旧快照抹掉先写者的认领。
 * 「另一个进程」用真 bun 子进程扮演：它 load 同一个文件、认领、落盘。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __clearStructuredTasks,
  createStructuredTask,
  getStructuredTask,
  updateStructuredTask,
} from "@sid-code/core/task/structured-task-store.ts";
import {
  claimNextTeamTask,
  persistTeamTasks,
  teamTasksPath,
} from "@sid-code/core/task/team-task-store.ts";

const TEAM = "race-team";
const STORE = join(import.meta.dir, "../../src/task/team-task-store.ts");
let dir: string;

beforeEach(() => {
  __clearStructuredTasks();
  dir = mkdtempSync(join(tmpdir(), "sid-team-race-"));
});
afterEach(() => {
  __clearStructuredTasks();
  rmSync(dir, { recursive: true, force: true });
});

/** 另一个进程：load → 认领一个任务 → 落盘。返回它认领的任务 id。 */
function otherProcessClaims(owner: string): string {
  const code = `import { loadTeamTasks, claimNextTeamTask } from ${JSON.stringify(STORE)};
loadTeamTasks(${JSON.stringify(TEAM)}, ${JSON.stringify(dir)});
const t = claimNextTeamTask(${JSON.stringify(TEAM)}, ${JSON.stringify(owner)}, ${JSON.stringify(dir)});
console.log(t ? t.id : "");`;
  const r = Bun.spawnSync(["bun", "-e", code], {
    env: { ...process.env, SID_CONFIG_DIR: dir },
  });
  return r.stdout.toString().trim();
}

function diskTasks(): Record<string, { status: string; owner?: string }> {
  const parsed = JSON.parse(readFileSync(teamTasksPath(TEAM, dir), "utf-8"));
  return Object.fromEntries(parsed.tasks.map((t: any) => [t.id, t]));
}

function seed(): void {
  for (const s of ["1", "2", "3"]) {
    createStructuredTask({ subject: s, description: s, metadata: { team: TEAM } });
  }
  persistTeamTasks(TEAM, dir);
}

describe("团队任务跨进程一致性", () => {
  it("本进程持旧快照认领时，不会认领别的进程已认领的任务，也不抹掉它", () => {
    seed();
    expect(otherProcessClaims("procB")).toBe("1");

    // 本进程内存里任务 1 仍是 pending（旧快照）
    const mine = claimNextTeamTask(TEAM, "procA", dir);
    expect(mine?.id).toBe("2");

    const disk = diskTasks();
    expect(disk["1"]).toMatchObject({ status: "in_progress", owner: "procB" });
    expect(disk["2"]).toMatchObject({ status: "in_progress", owner: "procA" });
    expect(disk["3"]!.status).toBe("pending");
    // 内存也同步到了别的进程的认领
    expect(getStructuredTask("1")?.owner).toBe("procB");
  });

  it("本进程完成任务后落盘，不会把别的进程的认领标回 pending", () => {
    seed();
    const mine = claimNextTeamTask(TEAM, "procA", dir);
    expect(mine?.id).toBe("1");
    expect(otherProcessClaims("procB")).toBe("2");

    updateStructuredTask("1", { status: "completed" });
    persistTeamTasks(TEAM, dir);

    const disk = diskTasks();
    expect(disk["1"]!.status).toBe("completed");
    expect(disk["2"]).toMatchObject({ status: "in_progress", owner: "procB" });
  });

  it("本进程更新过的任务不被磁盘上的旧版本回滚", () => {
    seed();
    updateStructuredTask("3", { status: "completed" });
    persistTeamTasks(TEAM, dir);
    expect(diskTasks()["3"]!.status).toBe("completed");
    expect(getStructuredTask("3")?.status).toBe("completed");
  });
});
