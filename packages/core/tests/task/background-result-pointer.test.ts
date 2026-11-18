/**
 * X3：回程全文指针指向**不会被删除**的落点
 *
 * 病因：`.output` 按回合驱逐（S3 的修法是对的，它是流式工作文件），而完成通知与
 * `task_output` 里「完整内容见 …」的指针指向它。主循环跑完一两个回合后父代理
 * 拿着指针去读，读到的只有墓碑——全文没有任何一处还留着。
 *
 * 修法：超长结论在 `completeAgentTask` 时另存一份到会话目录
 * `trajectories/sessions/<会话>/tool-outputs/`（与同步回程同一个落点、同一套命名规则），
 * 指针改指这份持久副本；落盘失败时明说「全文落盘失败，以上不是完整内容」，
 * 不退回指向一个必定失效的路径。
 *
 * 变异自证：把 `completeAgentTask` 里的 `pointer` 改回 `{}`（不落盘、不传 resultFile）
 * → 本文件第 1、2、4 例变红。
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerTask,
  clearAllTasks,
  getTask,
  updateTask,
  markNotificationsDelivered,
  markMainTurnCompleted,
  evictTerminalTasks,
  dequeuePendingNotifications,
  NOTIFICATION_OUTPUT_MAX_CHARS,
} from "@sid-code/core/task/index.ts";
import { completeAgentTask } from "@sid-code/core/task/agent-task.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import type { LocalAgentTaskState, AgentTaskResult } from "@sid-code/core/task/types.ts";

const SESSION_ID = "sess-x3";

/** 存/恢复 SID_CONFIG_DIR：`bun test` 同批多文件跑在同一进程里，直接 delete 会抹掉 preload 兜底。 */
const originalSidConfigDir = process.env.SID_CONFIG_DIR;

let sidHome: string;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sid-x3-"));
  sidHome = join(workDir, "sidhome");
  process.env.SID_CONFIG_DIR = sidHome;
  clearAllTasks();
  // 队列是进程级单例：清掉上一个用例可能残留的通知
  dequeuePendingNotifications();
});

afterEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
  if (originalSidConfigDir === undefined) {
    delete process.env.SID_CONFIG_DIR;
  } else {
    process.env.SID_CONFIG_DIR = originalSidConfigDir;
  }
  rmSync(workDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalSidConfigDir === undefined) {
    delete process.env.SID_CONFIG_DIR;
  } else {
    process.env.SID_CONFIG_DIR = originalSidConfigDir;
  }
});

/** 造一条后台子代理任务（真实路径走 `createAgentTask`，这里只关心终态写入的行为） */
function makeAgentTask(
  id: string,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: `agent ${id}`,
    startTime: Date.now(),
    outputFile: join(workDir, `${id}.output`),
    outputOffset: 0,
    notified: false,
    agentId: id,
    agentType: "explore",
    prompt: "核查一下",
    isBackgrounded: true,
    // X3 的落盘目录靠它；真实路径由 createAgentTask 从 SubAgentTool.parentSessionId 写入
    parentSessionId: SESSION_ID,
    ...overrides,
  };
}

function buildResult(output: string): AgentTaskResult {
  return {
    output,
    totalToolUseCount: 3,
    totalTokens: 500,
    usage: { inputTokens: 400, outputTokens: 100 },
  };
}

/** 从通知正文里取 `<result>` 的「完整内容见 …」指针 */
function pointerInNotification(xml: string): string | undefined {
  return /完整内容见 (.+?)\]/.exec(xml)?.[1];
}

describe("X3 — 后台超长结论的全文指针指向会话目录下的持久副本", () => {
  test("通知里的指针指向 trajectories/sessions/<会话>/tool-outputs/，而不是 .output", async () => {
    const taskId = "a1";
    const output = "结论文本。".repeat(4000); // > 16,000 字符
    registerTask(makeAgentTask(taskId));

    await completeAgentTask(taskId, buildResult(output));

    const notifs = dequeuePendingNotifications();
    expect(notifs).toHaveLength(1);
    const xml = notifs[0]!.content;
    expect(xml).toContain("已截断");

    const pointer = pointerInNotification(xml);
    expect(pointer).toBeDefined();
    // 落点必须在会话目录下（与同步回程同一个落点），且不是任务 `.output`
    expect(pointer).toContain(join("trajectories", "sessions", SESSION_ID, "tool-outputs"));
    expect(pointer).not.toBe(join(workDir, `${taskId}.output`));
    // 任务状态里记的是同一个路径（task_output 走它）
    expect(getTask(taskId)).toMatchObject({ resultFile: pointer });
  });

  test("不超长的结论不落副本、不给指针（全文已在 <result> 里）", async () => {
    const taskId = "a2";
    const output = "短结论。".repeat(10);
    registerTask(makeAgentTask(taskId));

    await completeAgentTask(taskId, buildResult(output));

    const xml = dequeuePendingNotifications()[0]!.content;
    expect(xml).toContain(output);
    expect(xml).not.toContain("完整内容见");
    const task = getTask(taskId) as LocalAgentTaskState;
    expect(task.resultFile).toBeUndefined();
    expect(task.resultPersistFailed).toBeUndefined();
  });

  test("主循环又跑完两个回合、.output 被驱逐后，指针文件仍在且内容逐字一致", async () => {
    const taskId = "a3";
    const output = "核查报告：".repeat(4000) + "核心结论在最后这一句。";
    expect(Array.from(output).length).toBeGreaterThan(NOTIFICATION_OUTPUT_MAX_CHARS);
    const task = makeAgentTask(taskId);
    registerTask(task);

    await completeAgentTask(taskId, buildResult(output));
    const pointer = pointerInNotification(dequeuePendingNotifications()[0]!.content);
    expect(pointer).toBeDefined();

    // 让面板驻留期与安全阀都过期，再走真实驱逐判据（送达 + 送达后又跑完回合）
    updateTask<LocalAgentTaskState>(taskId, (t) => ({ ...t, endTime: Date.now() - 120_000 }));
    markNotificationsDelivered([taskId]);
    markMainTurnCompleted();
    markMainTurnCompleted();
    evictTerminalTasks();

    // `.output` 确实被删了（S3 的按回合驱逐不动）
    expect(existsSync(task.outputFile)).toBe(false);
    // 指针指向的文件还在，且是完整结论（逐字一致，不是截断版）
    expect(existsSync(pointer!)).toBe(true);
    expect(readFileSync(pointer!, "utf-8")).toBe(output);
  });

  test("落盘失败时正文带「全文落盘失败」标记，且不指向会过期的 .output", async () => {
    const taskId = "a4";
    const output = "超长结论。".repeat(4000);
    // 让 mkdir -p 失败：把 sessions 占位成普通文件 → ENOTDIR
    mkdirSync(join(sidHome, "trajectories"), { recursive: true });
    writeFileSync(join(sidHome, "trajectories", "sessions"), "not a dir");
    registerTask(makeAgentTask(taskId));

    await completeAgentTask(taskId, buildResult(output));

    const xml = dequeuePendingNotifications()[0]!.content;
    expect(xml).toContain("[全文落盘失败，以上不是完整内容]");
    // 不能退回指向 `.output`：那是一个下一两个回合就消失的路径
    expect(pointerInNotification(xml)).toBeUndefined();

    const task = getTask(taskId) as LocalAgentTaskState;
    expect(task.resultFile).toBeUndefined();
    expect(task.resultPersistFailed).toBe(true);
  });
});

describe("X3 — task_output 的全文指针同样指向持久副本", () => {
  test("终态任务的 <result> 截断提示给出会话目录下的副本路径", async () => {
    const taskId = "a5";
    const output = "子代理结论。".repeat(4000);
    registerTask(makeAgentTask(taskId));
    await completeAgentTask(taskId, buildResult(output));
    const resultFile = (getTask(taskId) as LocalAgentTaskState).resultFile!;

    // block=false 走非阻塞分支：任务已终态，直接返回终态快照
    const res = await new TaskOutputTool().execute({ task_id: taskId, block: false } as never);
    const xml = typeof res.output === "string" ? res.output : JSON.stringify(res.output);
    expect(xml).toContain("已截断");
    expect(pointerInNotification(xml)).toBe(resultFile);
  });
});
