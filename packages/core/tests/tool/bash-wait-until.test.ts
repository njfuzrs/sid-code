/**
 * W1.3：后台 bash 的 `wait_until_seconds`（PR 1 验收 T-W1-3 / T-W1-5 的可用部分）
 *
 * ⚠️ 到期 kill（T-W1-5）不在本文件里跑：钳制下限是 60s，等一次真实到期会让单测
 * 多花一分钟。到期路径由 `registerWaitUntil` 的定时器 + `killShellTask(summary)` 覆盖，
 * 其中 kill 的**文案**在下面的用例里直接验证（不依赖真实到期）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "../../src/tool/bash.ts";
import {
  __resetWaitRegistryForTest,
  hasPromisedWait,
  listWaits,
} from "../../src/task/wait-registry.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import { killShellTask } from "../../src/task/shell-task.ts";
import { __resetBackgroundAwaitForTest } from "../../src/task/background-await.ts";

let tool: BashTool;

beforeEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  tool = new BashTool();
});

afterEach(() => {
  clearAllTasks();
  __resetWaitRegistryForTest();
});

describe("W1.3 wait_until_seconds", () => {
  test("T-W1-3 不带 run_in_background 时被忽略，并在结果里明说（不能静默）", async () => {
    const result = await tool.execute({
      command: "echo hi",
      wait_until_seconds: 120,
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("wait_until_seconds 只在 run_in_background=true 时生效");
  });

  test("T-W1-3 钳制到 [60, 3600]：传 30 秒被抬到 60 并写明", async () => {
    const result = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 30,
    });
    const parsed = JSON.parse(result.output) as { task_id: string; message: string };
    expect(parsed.message).toContain("已从 30s 钳制到 60s");
    // 登记为 deadline 源，于是静默也不再被判「不值得等」
    const wait = listWaits().find((w) => w.id === parsed.task_id);
    expect(wait?.promise.kind).toBe("deadline");
    expect(hasPromisedWait()).toBe(true);
    killShellTask(parsed.task_id);
  });

  test("T-W1-5（文案部分）期限 kill 的通知写明「等待期限到」，不是笼统的「已被终止」", async () => {
    const result = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 60,
    });
    const parsed = JSON.parse(result.output) as { task_id: string };
    expect(getTask(parsed.task_id)?.status).toBe("running");
    // 与 registerWaitUntil 的定时器回调传的是同一份 summary 形态
    killShellTask(parsed.task_id, {
      summary: `等待期限到（60 秒），条件未满足，已停止命令 "sleep 30"`,
    });
    expect(getTask(parsed.task_id)?.status).toBe("killed");
  });
});

/**
 * R1：后台 bash 等待登记必须带上对象签名。
 *
 * 走**真实入口**（`BashTool.execute` → `registerWaitUntil` → `registerWait`），
 * 不直调 `registerWait`：这条链断在哪一环都看不出来，而 R1 的缺陷恰恰就在
 * 「入口没调抽取函数」这一环——直调等待表会绕开它、让用例恒绿。
 */
describe("R1 后台 bash 等待登记的对象签名", () => {
  const FIXTURES = join(import.meta.dir, "..", "task", "fixtures", "wait-scripts");

  test("命令是 `bash <脚本>` 时，从脚本正文抽出 PR 号（b0aa0f1e 的真实形态）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-wait-subject-"));
    const script = join(dir, "wait.sh"); // 文件名刻意不含数字：见 wait-subjects.test.ts 的「路径名」用例
    // 用取证会话的原始脚本正文，只在 shebang 后插一行 exit 0：
    // 单测不该真的去查 GitHub（脚本主体是 `gh api` + `sleep 30` 循环），
    // 而 subject 抽取发生在登记时、读的是文件内容，与脚本是否真的跑完无关。
    const body = readFileSync(join(FIXTURES, "b0aa0f1e-wait-pr-779-v1.sh"), "utf8");
    writeFileSync(script, body.replace(/^(#!.*\n)/, "$1exit 0\n"));

    try {
      const result = await tool.execute({
        command: `bash ${script}`,
        run_in_background: true,
        wait_until_seconds: 60,
      });
      const parsed = JSON.parse(result.output) as { task_id: string };
      const wait = listWaits().find((w) => w.id === parsed.task_id);
      expect(wait?.subjects).toContain("gh:pr:779");
      killShellTask(parsed.task_id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("内联 for 循环（ca8d7e5c 的形态）带 subjects 与 commandFamilies", async () => {
    const result = await tool.execute({
      command:
        "for i in $(seq 1 90); do s=$(gh pr view 780 --json state -q .state 2>/dev/null); sleep 20; done",
      run_in_background: true,
      wait_until_seconds: 60,
    });
    const parsed = JSON.parse(result.output) as { task_id: string };
    const wait = listWaits().find((w) => w.id === parsed.task_id);
    expect(wait?.subjects).toContain("gh:pr:780");
    expect(wait?.commandFamilies).toContain("gh_pr_view");
    killShellTask(parsed.task_id);
  }, 15000);

  test("`chmod +x <脚本> && bash <脚本>`（8b8d721f 的真实形态）也抽出 PR 号", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-wait-subject-chmod-"));
    const script = join(dir, "wait.sh"); // 同上：文件名不含数字，避免自然语言规则掩盖脚本展开
    const body = readFileSync(join(FIXTURES, "8b8d721f-wait-pr757.sh"), "utf8");
    writeFileSync(script, body.replace(/^(#!.*\n)/, "$1exit 0\n"));

    try {
      const result = await tool.execute({
        command: `chmod +x ${script} && bash ${script}`,
        run_in_background: true,
        wait_until_seconds: 60,
      });
      const parsed = JSON.parse(result.output) as { task_id: string };
      const wait = listWaits().find((w) => w.id === parsed.task_id);
      expect(wait?.subjects).toContain("gh:pr:757");
      killShellTask(parsed.task_id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("抽不到对象时登记仍然成功（subjects 为空，不阻断等待）", async () => {
    // 方向是「抽不到就为空」：一个读不到的脚本路径不能让本来就是等待的命令登记失败
    const result = await tool.execute({
      command: "bash /tmp/definitely-not-exist-wait-script.sh",
      run_in_background: true,
      wait_until_seconds: 60,
    });
    const parsed = JSON.parse(result.output) as { task_id: string };
    const wait = listWaits().find((w) => w.id === parsed.task_id);
    expect(wait?.promise.kind).toBe("deadline");
    expect(wait?.subjects ?? []).toEqual([]);
    killShellTask(parsed.task_id);
  }, 15000);
});
