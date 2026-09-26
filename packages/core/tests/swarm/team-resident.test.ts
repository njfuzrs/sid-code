/**
 * P2-5：常驻协作会话。
 *
 * 一次性批（默认）里成员做完自己的活、认领完池子就退出，run() 随之返回。
 * 常驻模式成员做完后**挂起**：新任务出现就醒过来认领，收到 shutdown_request 才退出，
 * leader 也能在它挂起期间裁决它提交的计划。
 *
 * 这里锁四件事：
 * - 不开 resident 时行为不变（池空即退，不挂起）；
 * - 开了之后，成员空闲挂起，leader 中途建的新任务会被认领并执行；
 * - leader 发 shutdown_request 后成员退出，并回 shutdown_response；
 * - 全部任务完成且全员空闲时，run() 自己收尾，不需要调用方手动 shutdown。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TeamManager, type TeamOptions, type TeammateSpec } from "@sid-code/core/swarm/team.ts";
import {
  createStructuredTask,
  __clearStructuredTasks,
} from "@sid-code/core/task/structured-task-store.ts";

let dir: string;
/** 每个成员实际执行过的任务描述（顺序即认领顺序） */
let executed: string[];

class RecordingSubAgent {
  static fromRegistry() {
    return new RecordingSubAgent();
  }
  async execute(task: any, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return { success: false, output: "被中止" };
    const label = String(task?.description ?? "");
    executed.push(label);
    return { success: true, output: `${label} 完成` };
  }
}

function makeTeam(teamName: string, members: TeammateSpec[], extra?: Partial<TeamOptions>) {
  return new TeamManager({
    teamName,
    members,
    providerRegistry: {} as any,
    toolRegistry: {} as any,
    baseDir: dir,
    timeoutMs: 10_000,
    // 轮询调快，测试不用等默认的 200ms 一拍
    residentPollMs: 20,
    ...extra,
  });
}

async function runWithRecording(team: TeamManager) {
  const mod = await import("@sid-code/core/agent/sub-agent.ts");
  const orig = mod.SubAgent.fromRegistry;
  mod.SubAgent.fromRegistry = RecordingSubAgent.fromRegistry as any;
  try {
    return await team.run(undefined, 0);
  } finally {
    mod.SubAgent.fromRegistry = orig;
  }
}

beforeEach(() => {
  __clearStructuredTasks();
  dir = mkdtempSync(join(tmpdir(), "sid-team-resident-"));
  executed = [];
});

afterEach(() => {
  __clearStructuredTasks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("常驻协作会话", () => {
  test("默认（一次性批）池空即退，不挂起", async () => {
    const team = makeTeam("once", [{ name: "a", type: "task", task: "做自己的活" }]);
    const startedAt = Date.now();
    const results = await runWithRecording(team);
    // 挂起的话会一直等到硬超时（10s）；正常应在 1s 内返回
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(results[0].success).toBe(true);
    expect(executed).toHaveLength(1);
  });

  test("常驻成员做完后挂起，leader 中途派的新任务会被认领执行", async () => {
    const team = makeTeam("live", [{ name: "a", type: "task", task: "先做这个" }], {
      resident: true,
    });

    const runPromise = runWithRecording(team);

    // 等成员把自己的活做完、进入挂起（executed 里出现它的任务）
    await waitFor(() => executed.length >= 1);

    // 挂起期间 leader 往共享池丢一个新任务
    createStructuredTask({
      subject: "追加的活",
      description: "成员挂起之后才出现",
      metadata: { team: "live" },
    });

    const results = await runPromise;
    expect(results[0].success).toBe(true);
    // 自己的活 + 认领的追加任务。执行标签是 `[team] name → #id`，认领事实看输出与计数。
    expect(executed).toHaveLength(2);
    expect(results[0].output).toContain("认领任务 #");
    expect(results[0].output).toContain("追加的活");
    expect(results[0].claimedTaskCount).toBe(1);
  });

  test("leader 发 shutdown_request 后挂起的成员退出并回确认", async () => {
    const team = makeTeam("stop", [{ name: "a", type: "task", task: "做完就等" }], {
      resident: true,
    });

    const runPromise = runWithRecording(team);
    await waitFor(() => executed.length >= 1);

    // 成员已挂起。手动 shutdown 它（不走「全部完成」的自动收尾，因为没有新任务，
    // 自动收尾也会发 shutdown——这里验证的是成员对 shutdown_request 的响应本身）。
    const sent = team.sendToMember("a", "到此为止", "shutdown_request");
    expect(sent).toBe(true);

    const results = await runPromise;
    expect(results[0].success).toBe(true);
    // 成员回了 shutdown_response
    const replies = team.getLeaderMessages().filter((m) => m.kind === "shutdown_response");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].from).toBe("a");
  });

  test("全部任务完成后 run() 自行收尾，无需调用方 shutdown", async () => {
    const team = makeTeam(
      "auto",
      [
        { name: "a", type: "task", task: "任务A" },
        { name: "b", type: "task", task: "任务B" },
      ],
      { resident: true },
    );
    const startedAt = Date.now();
    const results = await runWithRecording(team);
    // 两个成员都做完后自动收尾，不应拖到硬超时
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(executed).toHaveLength(2);
  });

  test("挂起期间收到的 plan_approval_response 被回灌，下一次任务能读到", async () => {
    // 挂起等待会 drain 成员收件箱来找 shutdown_request。非 shutdown 的消息
    // （比如 leader 的计划裁决）必须回灌，否则成员真正开始下一个任务时
    // drainInbox 拿不到它——裁决被挂起等待悄悄吃掉了。
    const inboxDuringSecondTask: string[] = [];
    class InboxSpySubAgent {
      static fromRegistry() {
        return new InboxSpySubAgent();
      }
      async execute(task: any, signal?: AbortSignal): Promise<any> {
        if (signal?.aborted) return { success: false, output: "被中止" };
        const label = String(task?.description ?? "");
        executed.push(label);
        // 第二段任务执行时，把 drainInbox 读到的内容记下来
        if (label.includes("→")) {
          const drained = task?.drainInbox?.() ?? [];
          inboxDuringSecondTask.push(...drained);
        }
        return { success: true, output: `${label} 完成` };
      }
    }

    const team = makeTeam("plan", [{ name: "a", type: "task", task: "先做" }], {
      resident: true,
    });
    const mod = await import("@sid-code/core/agent/sub-agent.ts");
    const orig = mod.SubAgent.fromRegistry;
    mod.SubAgent.fromRegistry = InboxSpySubAgent.fromRegistry as any;
    try {
      const runPromise = team.run(undefined, 0);
      await waitFor(() => executed.length >= 1);

      // 成员已挂起。先发计划裁决（会被挂起等待 drain 到），再派新任务唤醒它。
      team.sendToMember("a", "approve", "plan_approval_response");
      createStructuredTask({
        subject: "批准后的活",
        description: "该看到批准",
        metadata: { team: "plan" },
      });

      const results = await runPromise;
      expect(results[0].success).toBe(true);
    } finally {
      mod.SubAgent.fromRegistry = orig;
    }

    // 裁决没被挂起等待吃掉：成员执行第二段任务时 drainInbox 读到了它
    expect(inboxDuringSecondTask.some((m) => m.includes("plan_approval_response"))).toBe(true);
    expect(inboxDuringSecondTask.some((m) => m.includes("approve"))).toBe(true);
  });
});

/** 轮询直到条件成立，超时抛错（避免测试挂死到 team 硬超时才失败）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}
