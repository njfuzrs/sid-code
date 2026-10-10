/**
 * B43：durable 任务的写盘 / 驱动权 / 认领 / 授权。
 *
 * 复现的原缺陷（修复前全部为真）：
 *   1. 项目里没有 `.sid-code/` → 抢调度锁 ENOENT 被吞 → 任务只在内存，工具回「已持久化」
 *   2. daemon 在场 → 会话放弃驱动 → 同上，任务不写盘，daemon 也永远看不见
 *   3. daemon 只在启动时读一次任务文件，运行期间新建的任务不会被触发
 *   4. 两个进程各拿内存 Map 全量覆盖写盘，后写的抹掉先写的
 *   5. 驱动权交接窗口里两边都可能触发同一任务
 *   6. 项目文件（可随 git 进来）里的任务无需本机授权即被无人值守执行
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Scheduler } from "@sid-code/core/cron/scheduler.ts";
import { readDurableTasks, durableFilePath } from "@sid-code/core/cron/durable-store.ts";
import { isDurableTaskGranted } from "@sid-code/core/cron/durable-grants.ts";
import { listDurableProjects } from "@sid-code/core/daemon/durable-projects.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";

let home: string;
let project: string;
let prevHome: string | undefined;
const schedulers: Scheduler[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sid-b43-home-"));
  project = mkdtempSync(join(tmpdir(), "sid-b43-proj-"));
  prevHome = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = home;
});

afterEach(() => {
  for (const s of schedulers) s.stop();
  schedulers.length = 0;
  if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function make(over: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
  const fired: CronTask[] = [];
  const s = new Scheduler({
    onFire: (p) => fired.push({ prompt: p } as CronTask),
    onFireTask: (t) => fired.push(t),
    isLoading: () => false,
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    workspaceDir: project,
    isDaemonRunning: () => false,
    checkIntervalMs: 60_000,
    ...over,
  });
  schedulers.push(s);
  return { s, fired };
}

function task(id: string, over: Partial<CronTask> = {}): CronTask {
  return {
    id,
    cron: "0 0 1 1 *",
    prompt: `p-${id}`,
    createdAt: Date.now(),
    recurring: false,
    durable: true,
    workspaceDir: project,
    ...over,
  };
}

const check = (s: Scheduler) => (s as any).check();

describe("写盘与驱动权解耦", () => {
  it("项目里没有 .sid-code/ 也能写盘，且会话能拿到驱动权", () => {
    expect(existsSync(join(project, ".sid-code"))).toBe(false);
    const { s } = make();
    s.start();
    expect(s.addDurableTask(task("a"))).toBe(true);
    expect(readDurableTasks(project).map((t) => t.id)).toEqual(["a"]);
    check(s);
    expect(s.isDrivingDurable()).toBe(true);
  });

  it("daemon 在场时会话不驱动，但任务照样写盘", () => {
    const { s } = make({ isDaemonRunning: () => true });
    s.start();
    check(s);
    expect(s.isDrivingDurable()).toBe(false);
    expect(s.addDurableTask(task("b"))).toBe(true);
    expect(readDurableTasks(project).map((t) => t.id)).toEqual(["b"]);
  });

  it("同项目第二个会话（没抢到锁）建的任务也写盘", () => {
    const a = make();
    a.s.start();
    check(a.s);
    const b = make();
    b.s.start();
    check(b.s);
    expect(a.s.isDrivingDurable()).toBe(true);
    expect(b.s.isDrivingDurable()).toBe(false);
    expect(b.s.addDurableTask(task("c"))).toBe(true);
    expect(readDurableTasks(project).map((t) => t.id)).toContain("c");
  });

  it("driveDurable:false 的宿主（-p / bridge）永不驱动", () => {
    const { s } = make({ driveDurable: false });
    s.start();
    check(s);
    expect(s.isDrivingDurable()).toBe(false);
  });

  it("写盘成功即登记 durable-projects（任何入口，不只 cron_create）", () => {
    const { s } = make();
    s.addDurableTask(task("d"));
    expect(listDurableProjects()).toContain(project);
  });

  it("写盘失败抛错，不进内存（调用方必须报错而不是回「已持久化」）", () => {
    // 让 .sid-code 成为一个文件：mkdir / 写盘必然失败
    writeFileSync(join(project, ".sid-code"), "not a dir");
    const { s } = make();
    expect(() => s.addDurableTask(task("e"))).toThrow();
    expect(s.listTasks().find((t) => t.id === "e")).toBeUndefined();
  });
});

describe("磁盘是唯一事实源", () => {
  it("两个实例交替新建，互不覆盖", () => {
    const a = make();
    const b = make();
    a.s.addDurableTask(task("x1"));
    b.s.addDurableTask(task("y1"));
    a.s.addDurableTask(task("x2"));
    expect(
      readDurableTasks(project)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["x1", "x2", "y1"]);
  });

  it("一个实例删除另一个实例建的任务", () => {
    const a = make();
    const b = make();
    a.s.addDurableTask(task("z"));
    expect(b.s.removeTask("z")).toBe(true);
    expect(readDurableTasks(project)).toEqual([]);
    expect(a.s.listTasks().find((t) => t.id === "z")).toBeUndefined();
  });

  it("daemon 运行期间新建的任务，下一轮检查就会被触发", () => {
    const daemon = make({ daemonMode: true });
    daemon.s.start();
    expect(daemon.fired).toHaveLength(0);

    const session = make({ isDaemonRunning: () => true });
    session.s.addDurableTask(task("late", { fireAt: Date.now() - 1, cron: "" }));

    check(daemon.s);
    expect(daemon.fired.map((t) => t.id)).toEqual(["late"]);
    expect(readDurableTasks(project)).toEqual([]);
  });

  it("删掉 .sid-code 下不存在的任务时不在 cwd 建目录", () => {
    const { s } = make();
    expect(s.removeTask("nope")).toBe(false);
    expect(existsSync(join(project, ".sid-code", "scheduled_tasks.json"))).toBe(false);
  });

  it("任务文件损坏时不覆盖成空（写操作抛错）", () => {
    mkdirSync(join(project, ".sid-code"));
    writeFileSync(durableFilePath(project), "{broken");
    const { s } = make();
    expect(() => s.addDurableTask(task("f"))).toThrow();
    expect(readFileSync(durableFilePath(project), "utf-8")).toBe("{broken");
  });
});

describe("认领：交接窗口不双触发", () => {
  it("两个驱动者同时看到到期的一次性任务，只有一个触发", () => {
    const creator = make();
    creator.s.addDurableTask(task("once", { fireAt: Date.now() - 1, cron: "" }));

    const d1 = make({ daemonMode: true });
    const d2 = make({ daemonMode: true });
    // 两边都把任务读进缓存（模拟交接窗口里各自认为自己是驱动者）
    (d1.s as any).refreshDurable();
    (d2.s as any).refreshDurable();
    (d1.s as any).fireOnce((d1.s as any).durableTasks.get("once"), Date.now(), false, "T");
    (d2.s as any).fireOnce((d2.s as any).durableTasks.get("once"), Date.now(), false, "T");
    expect(d1.fired.length + d2.fired.length).toBe(1);
  });

  it("循环任务：一方触发推进 lastFiredAt 后，另一方的认领失败", () => {
    const creator = make();
    creator.s.addDurableTask(task("loop", { recurring: true, cron: "* * * * *" }));
    const d1 = make({ daemonMode: true });
    const d2 = make({ daemonMode: true });
    (d1.s as any).refreshDurable();
    (d2.s as any).refreshDurable();
    const now = Date.now();
    (d1.s as any).fireOnce((d1.s as any).durableTasks.get("loop"), now, true, "T");
    (d2.s as any).fireOnce((d2.s as any).durableTasks.get("loop"), now, true, "T");
    expect(d1.fired.length + d2.fired.length).toBe(1);
    expect(readDurableTasks(project)[0].lastFiredAt).toBe(now);
  });

  it("durable 循环任务不论谁驱动都不按 7 天过期", () => {
    const old = Date.now() - 10 * 24 * 3600_000;
    const { s, fired } = make();
    s.addDurableTask(
      task("aged", { recurring: true, cron: "* * * * *", createdAt: old, lastFiredAt: old }),
    );
    s.start();
    check(s);
    expect(fired).toHaveLength(1);
    expect(readDurableTasks(project).map((t) => t.id)).toEqual(["aged"]);
  });
});

describe("本机授权", () => {
  it("本机创建的任务已授权", () => {
    const { s } = make();
    s.addDurableTask(task("g"));
    expect(isDurableTaskGranted(project, readDurableTasks(project)[0])).toBe(true);
  });

  it("项目文件里直接出现的任务（如随 git 进来）不执行", () => {
    mkdirSync(join(project, ".sid-code"));
    writeFileSync(
      durableFilePath(project),
      JSON.stringify([task("foreign", { fireAt: Date.now() - 1, cron: "" })]),
    );
    const { s, fired } = make({ daemonMode: true });
    // daemon 发现项目靠注册表；这里直接登记，排除「没发现」这个变量
    require("@sid-code/core/daemon/durable-projects.ts").registerDurableProject(project);
    s.start();
    check(s);
    expect(fired).toHaveLength(0);
    // 不执行也不删：留给用户自己判断
    expect(readDurableTasks(project).map((t) => t.id)).toEqual(["foreign"]);
  });

  it("创建后被改过 prompt / allowedTools 的任务不执行", () => {
    const { s } = make();
    s.addDurableTask(task("h", { fireAt: Date.now() - 1, cron: "" }));
    const tampered = readDurableTasks(project).map((t) => ({
      ...t,
      allowedTools: ["bash"],
    }));
    writeFileSync(durableFilePath(project), JSON.stringify(tampered));
    const d = make({ daemonMode: true });
    d.s.start();
    check(d.s);
    expect(d.fired).toHaveLength(0);
  });

  it("推进 lastFiredAt 不让授权失效", () => {
    const { s, fired } = make();
    s.addDurableTask(
      task("i", { recurring: true, cron: "* * * * *", createdAt: Date.now() - 3600_000 }),
    );
    s.start();
    check(s);
    expect(fired).toHaveLength(1);
    expect(isDurableTaskGranted(project, readDurableTasks(project)[0])).toBe(true);
  });
});
