/**
 * P2-3：/loop 解析尾随 every 子句。
 *
 * CC 的写法是 `/loop review new PRs every 2 hours`（间隔在句尾）。
 * 修之前 sid 只看第一个 token，首 token 不是间隔就整句落进动态轮询，
 * 句尾的 every 被当成任务正文的一部分——用户要的 2 小时循环永远不会建。
 *
 * 三分支都要锁：尾随 every 建 cron、前导间隔不回归、两者都没有才落动态轮询。
 * 另外锁两个容易误伤的边界：任务正文里的 every 不是间隔、不整除的间隔降级提示。
 */

import { describe, test, expect, afterEach } from "bun:test";
import loopCmd from "@sid-code/cli/command/commands/loop/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";
import { resetScheduler, getScheduler } from "@sid-code/core/cron/scheduler.ts";

const loadCmd = () => (loopCmd as LocalCommand).load();
const CTX = {} as CommandContext;

afterEach(() => {
  resetScheduler();
});

const text = (r: { type: string; value?: string }) => r.value ?? "";

describe("/loop 间隔解析", () => {
  test("尾随 every：/loop review PRs every 2 hours → 2 小时循环 cron，任务正文不含 every", async () => {
    const mod = await loadCmd();
    const r = await mod.call("review PRs every 2 hours", CTX);
    expect(r.type).toBe("text");
    expect(text(r as { type: string; value: string })).toContain("已创建循环任务");
    expect(text(r as { type: string; value: string })).toContain("每2 小时");
    const tasks = getScheduler().listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].cron).toBe("0 */2 * * *");
    expect(tasks[0].prompt).toBe("review PRs");
    expect(tasks[0].recurring).toBe(true);
  });

  test("尾随 every 的分钟单位：every 5 minutes → */5 cron", async () => {
    const mod = await loadCmd();
    const r = await mod.call("check the build every 5 minutes", CTX);
    expect(text(r as { type: string; value: string })).toContain("已创建循环任务");
    const tasks = getScheduler().listTasks();
    expect(tasks[0].cron).toBe("*/5 * * * *");
    expect(tasks[0].prompt).toBe("check the build");
  });

  test("前导间隔不回归：/loop 5m check build 仍建 */5 cron", async () => {
    const mod = await loadCmd();
    const r = await mod.call("5m check build", CTX);
    expect(text(r as { type: string; value: string })).toContain("已创建循环任务");
    const tasks = getScheduler().listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].cron).toBe("*/5 * * * *");
    expect(tasks[0].prompt).toBe("check build");
  });

  test("无间隔 → 动态轮询（submit_prompt），不建 cron", async () => {
    const mod = await loadCmd();
    const r = await mod.call("盯着 CI 直到通过", CTX);
    expect(r.type).toBe("submit_prompt");
    expect(getScheduler().listTasks()).toHaveLength(0);
  });

  test("任务正文里的 every 不在句尾 → 不当间隔，落动态轮询", async () => {
    const mod = await loadCmd();
    const r = await mod.call("review every PR in the queue", CTX);
    expect(r.type).toBe("submit_prompt");
    expect(getScheduler().listTasks()).toHaveLength(0);
  });

  test("尾随 every 的间隔无法用 cron 表达 → 提示降级，不建任务", async () => {
    const mod = await loadCmd();
    // 7 分钟不能整除 60，intervalToCron 返回 null
    const r = await mod.call("check deploy every 7 minutes", CTX);
    expect(r.type).toBe("text");
    expect(text(r as { type: string; value: string })).toContain("无法用 cron 周期精确表达");
    expect(getScheduler().listTasks()).toHaveLength(0);
  });
});
