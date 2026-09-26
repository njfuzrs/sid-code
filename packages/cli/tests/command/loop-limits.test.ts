/**
 * P0-1 / P0-2：/loop 与 cron 工具共享上限守卫和禁用开关。
 * /loop 直建任务不经 cron_create，所以要单独验证它没绕过 scheduler 层的守卫。
 */

import { describe, test, expect, afterEach } from "bun:test";
import loopCmd from "@sid-code/cli/command/commands/loop/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";
import { resetScheduler, getScheduler } from "@sid-code/core/cron/scheduler.ts";
import { MAX_SESSION_CRON_JOBS, DISABLE_CRON_ENV } from "@sid-code/core/cron/types.ts";

const loadCmd = () => (loopCmd as LocalCommand).load();
const CTX = {} as CommandContext;

let prevDisable: string | undefined;

afterEach(() => {
  resetScheduler();
  if (prevDisable === undefined) delete process.env[DISABLE_CRON_ENV];
  else process.env[DISABLE_CRON_ENV] = prevDisable;
});

describe("/loop 上限与禁用", () => {
  test("固定间隔达到会话上限后拒绝创建", async () => {
    const mod = await loadCmd();
    for (let i = 0; i < MAX_SESSION_CRON_JOBS; i++) {
      const r = await mod.call(`5m 任务${i}`, CTX);
      expect((r as { value: string }).value).toContain("已创建循环任务");
    }
    const overflow = await mod.call("5m 第51个", CTX);
    expect((overflow as { value: string }).value).toContain(
      `已达定时任务上限 (${MAX_SESSION_CRON_JOBS})`,
    );
    expect(getScheduler().listTasks()).toHaveLength(MAX_SESSION_CRON_JOBS);
  });

  test("禁用时列出、固定间隔、动态轮询三种用法都拒绝", async () => {
    prevDisable = process.env[DISABLE_CRON_ENV];
    process.env[DISABLE_CRON_ENV] = "1";
    const mod = await loadCmd();

    for (const args of ["", "5m 巡检", "盯着 CI 直到通过"]) {
      const r = await mod.call(args, CTX);
      expect(r.type).toBe("text");
      expect((r as { value: string }).value).toContain("SID_CODE_DISABLE_CRON");
    }
    // 动态轮询被拒时不能退化成 submit_prompt（那会让模型绕开开关继续建任务）
    const dynamic = await mod.call("盯着 CI 直到通过", CTX);
    expect(dynamic.type).not.toBe("submit_prompt");
    expect(getScheduler().listTasks()).toHaveLength(0);
  });
});
