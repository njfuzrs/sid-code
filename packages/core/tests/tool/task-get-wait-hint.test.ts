/**
 * F3 补（20261019 双投递 follow-up）：bg_task_get 的提示文案不得把模型推回「再阻塞一次」。
 *
 * #362 首版只改了 description，同文件里 schema 描述、timeout hint、not_ready hint 仍在教
 * 「用 block=true 等 / 再次调用继续等」——模型调用时离这几处最近，description 的劝告会被抵消。
 * 基线会话 senfhxhhe 正是「阻塞满 600s → 再调一次」的形态。
 *
 * block 默认值**不改**（P1-3 防轮询原语，见 task-get.ts schema 注释），这里只锁文案出路。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registerTask, clearAllTasks } from "@sid-code/core/task/index.ts";
import { TaskGetTool } from "@sid-code/core/tool/task-get.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

function runningTask(id: string): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: `排查 ${id}`,
    startTime: Date.now(),
    outputFile: `/tmp/${id}.output`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    agentType: "explore",
    prompt: "p",
    isBackgrounded: true,
  };
}

/** 任何一处出现这些说法，都等于教模型「再阻塞一次」 */
const RE_BLOCK_AGAIN = /再次调用本工具继续等|加大 timeout|要等它完成请用 block=true/;

beforeEach(() => clearAllTasks());
afterEach(() => clearAllTasks());

describe("bg_task_get 提示文案出路是「等通知」", () => {
  test("timeout hint 不建议再阻塞，指向 task-notification", async () => {
    registerTask(runningTask("g1"));
    const r = await new TaskGetTool().execute({ task_id: "g1", block: true, timeout: 50 });
    expect(r.output).toContain("timeout");
    expect(r.output).not.toMatch(RE_BLOCK_AGAIN);
    expect(r.output).toContain("task-notification");
  });

  test("not_ready hint 不建议用 block=true 等", async () => {
    registerTask(runningTask("g2"));
    const r = await new TaskGetTool().execute({ task_id: "g2", block: false });
    expect(r.output).toContain("not_ready");
    expect(r.output).not.toMatch(RE_BLOCK_AGAIN);
    expect(r.output).toContain("task-notification");
  });

  test("schema 的 block 描述不再声称「问一次即可拿到结果」", () => {
    const schema = JSON.stringify(new TaskGetTool().inputSchema());
    expect(schema).not.toContain("问一次即可拿到结果");
    expect(schema).toContain("自动通知");
  });
});
