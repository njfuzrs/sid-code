/**
 * R8：期限到的等待要带上「期限内最后看到什么」，并把这条事实写回重挂的回执。
 *
 * ⚠️ 到期的钳制下限是 60s，真等一次会让单测多花一分钟。所以这里调的是定时器
 * **同一个收口函数** `expireDeadlineShellTask`（`registerWaitUntil` 的 timer 只有
 * 一行 `void task.expireDeadlineShellTask(...)`），走的是线上那条路——`bash.ts`
 * 里再没有任何一处自己拼 kill 参数。
 *
 * 落盘隔离：BashTool 会把输出写进 `getSidHome()/tasks/`，所以每个用例都把
 * `SID_CONFIG_DIR` 重定向到 tmpdir（见 CONTRIBUTING「测试约定」）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "../../src/tool/bash.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import { killShellTask } from "../../src/task/shell-task.ts";
import { expireDeadlineShellTask } from "../../src/task/deadline-expiry.ts";
import { getTaskOutputTail } from "../../src/task/disk-output.ts";
import {
  __resetWaitRegistryForTest,
  formatPriorDeadlineExpiryNote,
  recordDeadlineExpiryFact,
} from "../../src/task/wait-registry.ts";
import { dequeuePendingNotifications, takeTrailingLines } from "../../src/task/notification.ts";
import { __resetBackgroundAwaitForTest } from "../../src/task/background-await.ts";

let tool: BashTool;
let tmpHome: string;
const originalConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-r8-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  tool = new BashTool();
});

afterEach(() => {
  clearAllTasks();
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 轮询到条件成立（子进程 spawn 有延迟，不等就会读到空文件） */
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待条件超时");
}

/** 起一个后台等待任务，返回 task_id 与通知文本（从统一队列里 drain 出来的） */
async function startWait(
  command: string,
  waitUntilSeconds: number,
): Promise<{ taskId: string; message: string }> {
  const result = await tool.execute({
    command,
    run_in_background: true,
    wait_until_seconds: waitUntilSeconds,
  });
  const parsed = JSON.parse(result.output) as { task_id: string; message: string };
  return { taskId: parsed.task_id, message: parsed.message };
}

function notificationText(): string {
  return dequeuePendingNotifications()
    .map((n) => n.content)
    .join("\n");
}

describe("R8 验收 1：期限到的通知带输出尾部", () => {
  test("通知含 <output-tail>，内容等于输出文件最后 5 行", async () => {
    const command =
      "printf 'line-1\\nline-2\\nline-3\\nline-4\\nline-5\\nline-6\\nline-7\\nline-8\\n'; sleep 30";
    const { taskId } = await startWait(command, 60);
    // 等 8 行全部落盘，否则读到的是半截
    await waitFor(async () => (await getTaskOutputTail(taskId, 4096))?.includes("line-8") ?? false);

    await expireDeadlineShellTask(taskId, { clamped: 60, command });

    expect(getTask(taskId)?.status).toBe("killed");
    const xml = notificationText();
    expect(xml).toContain("<status>killed</status>");
    expect(xml).toContain("等待期限到（60 秒），条件未满足");
    const matched = xml.match(/<output-tail untrusted="true">([\s\S]*?)<\/output-tail>/);
    expect(matched).not.toBeNull();
    // 最后 5 行，不是全部 8 行（窗口再大也不许整段灌进通知）
    expect(matched![1]).toBe("line-4\nline-5\nline-6\nline-7\nline-8");
  });

  test("期限内什么都没输出时，通知里不出现 output-tail 段", async () => {
    const command = "sleep 30";
    const { taskId } = await startWait(command, 60);
    const outputFile = getTask(taskId)!.outputFile;
    await waitFor(() => existsSync(outputFile));

    await expireDeadlineShellTask(taskId, { clamped: 60, command });

    const xml = notificationText();
    expect(xml).toContain("<status>killed</status>");
    // 空段只会让模型以为输出读丢了：宁可不写，也不写一个空壳
    expect(xml).not.toContain("<output-tail");
  });

  test("普通 kill（非期限到）不带 output-tail", async () => {
    const { taskId } = await startWait("printf 'mid-flight\\n'; sleep 30", 60);
    await waitFor(
      async () => (await getTaskOutputTail(taskId, 1024))?.includes("mid-flight") ?? false,
    );

    killShellTask(taskId); // 等价于用户 Ctrl+F / task_stop

    const xml = notificationText();
    expect(xml).toContain("<status>killed</status>");
    expect(xml).not.toContain("<output-tail");
  });
});

describe("R8 验收 2：同对象重挂时点破「期限不是问题所在」", () => {
  test("曾有期限到终态 → 新回执写明上一次的最后输出，并指出问题在退出条件", async () => {
    // 第一次：等 PR #779，脚本一直报同一个状态（模型「等法没有退出条件」的形态）
    const firstCommand = "printf 'state: OPEN\\n'; sleep 30  # 等 PR #779";
    const first = await startWait(firstCommand, 60);
    await waitFor(
      async () => (await getTaskOutputTail(first.taskId, 1024))?.includes("state: OPEN") ?? false,
    );
    // 定时器走的就是这个调用（subjects 来自 plan 抽取，这里显式给同一份）
    await expireDeadlineShellTask(first.taskId, {
      clamped: 60,
      command: firstCommand,
      subjects: ["gh:pr:779"],
    });

    // 第二次：同对象重挂，期限从 60 加到 1800
    const second = await startWait("sleep 30  # 等 PR #779 的 CI", 1800);
    expect(second.message).toContain(
      `上一个盯 gh:pr:779 的等待 ${first.taskId} 在期限内的最后输出是：state: OPEN。`,
    );
    expect(second.message).toContain("如果状态一直在变，问题在退出条件，不在期限长短。");
    killShellTask(second.taskId);
  });

  test("没有期限到历史的对象重挂时不写这条事实", async () => {
    const { taskId, message } = await startWait("sleep 30  # 等 PR #1234", 600);
    expect(message).not.toContain("问题在退出条件");
    killShellTask(taskId);
  });

  test("事实按对象隔离：别的对象的期限到不会串到本对象", async () => {
    recordDeadlineExpiryFact(["gh:pr:779"], "sjgm4oq76", "state: OPEN\n");

    expect(formatPriorDeadlineExpiryNote(["gh:pr:779"])).toContain("sjgm4oq76");
    expect(formatPriorDeadlineExpiryNote(["gh:pr:1234"])).toBe("");
    expect(formatPriorDeadlineExpiryNote(undefined)).toBe("");
  });

  test("读不到尾部 / 没有对象签名时不记录空事实", () => {
    recordDeadlineExpiryFact(["gh:pr:779"], "t1", null);
    recordDeadlineExpiryFact(["gh:pr:779"], "t2", "\n\n");
    recordDeadlineExpiryFact(undefined, "t3", "state: OPEN\n");
    expect(formatPriorDeadlineExpiryNote(["gh:pr:779"])).toBe("");
  });

  test("takeTrailingLines：去尾部空行、保留中间空行、按行数截断", () => {
    expect(takeTrailingLines("a\nb\n", 1)).toBe("b");
    expect(takeTrailingLines("a\n\nb\n\n", 2)).toBe("\nb");
    expect(takeTrailingLines("", 5)).toBe("");
    expect(takeTrailingLines("   \n\n", 5)).toBe("");
  });
});
