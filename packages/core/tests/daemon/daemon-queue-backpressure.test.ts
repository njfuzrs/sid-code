/**
 * P1-9（docs-research 20260927）：daemon job 队列无上限、无去重。
 * 修复前：同一周期任务连续到期 40 次、job 都没跑完 → 队列积压 38 份，各带随机 jobId。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "@sid-code/core/daemon/daemon.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sid-daemon-q-"));
  prevHome = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** executor 永不完成：模拟 job 比触发周期慢 */
function stuckDaemon(opts: ConstructorParameters<typeof Daemon>[0] = {}) {
  const d = new Daemon({ maxConcurrent: 2, ...opts }) as any;
  const started: string[] = [];
  d.executor = {
    run: (job: { prompt: string }) => {
      started.push(job.prompt);
      return new Promise(() => {});
    },
  };
  return { d, started };
}

const task = (id: string, over: Partial<CronTask> = {}): CronTask => ({
  id,
  cron: "* * * * *",
  prompt: `p-${id}`,
  createdAt: Date.now(),
  recurring: true,
  durable: true,
  ...over,
});

describe("daemon 队列背压", () => {
  it("周期任务按 task.id 折叠：40 次到期只留 1 份待跑", () => {
    const { d, started } = stuckDaemon();
    for (let i = 0; i < 40; i++) d.enqueueTask(task("same", { prompt: `run-${i}` }));
    expect(started).toEqual(["run-0", "run-1"]);
    expect(d.queue).toHaveLength(1);
    // 折叠保留的是最新一次
    expect(d.queue[0].job.prompt).toBe("run-39");
  });

  it("不同周期任务互不折叠", () => {
    const { d } = stuckDaemon({ maxConcurrent: 1 });
    d.enqueueTask(task("a"));
    d.enqueueTask(task("b"));
    d.enqueueTask(task("c"));
    d.enqueueTask(task("b"));
    expect(d.queue.map((q: any) => q.taskId)).toEqual(["b", "c"]);
  });

  it("一次性任务不折叠（错过即语义损失）", () => {
    const { d } = stuckDaemon({ maxConcurrent: 1 });
    for (let i = 0; i < 4; i++) d.enqueueTask(task("once", { recurring: false }));
    expect(d.queue).toHaveLength(3);
  });

  it("队列有总上限，超限丢弃本次触发", () => {
    const { d } = stuckDaemon({ maxConcurrent: 1, maxQueueLength: 5 });
    for (let i = 0; i < 20; i++) d.enqueueTask(task(`t${i}`, { recurring: false }));
    expect(d.queue).toHaveLength(5);
  });
});
