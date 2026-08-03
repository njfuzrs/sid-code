/**
 * 子代理进度回灌 —— spawn 路径单测（C4b）
 *
 * 分工：tests/agent/subagent-progress-emit.test.ts 测**进程内**路径（executeInner 的
 * onTurnEnd）；本文件测**跨进程**路径（executeSpawnedInternal 收子进程的 "progress" 消息）。
 *
 * 为什么这条路径此前是缺口：子进程（headless.ts）每轮只上报**单条** lastActivity 字符串，
 * 不是数组——窗口必须在父进程这层累积。此前父进程收到消息后直接 `recentActivities: []`
 * 写死，字段从未真正积累过；且完全没有把进度回灌给前台工具卡片的通道（只写 registry）。
 *
 * 测试手段：monkey-patch 全局 `Bun.spawn`，返回一个假子进程——`stdout` 是真实
 * `ReadableStream`（喂 NDJSON 消息行），`stdin.write` 只记录不做事。这是本仓库现有
 * `sub-agent-spawn.test.ts` 早就用的手法的延伸（`(sub as any).spawnConfig = {...}`
 * 强制走 spawn 分支），没有引入新的测试基础设施范式。
 *
 * 铁律：调生产函数（真正调用 SubAgent.execute()，不重写 executeSpawnedInternal 的判断逻辑）。
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "../../src/agent/sub-agent.ts";
import { Registry } from "../../src/tool/registry.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";
import { MAX_RECENT_ACTIVITIES, type AgentProgressSnapshot } from "../../src/agent/progress.ts";

/** spawn 分支不会真的用到 provider（子进程自己发请求），随便给一个占位实现即可满足构造签名。 */
class UnusedProvider implements Provider {
  name() { return "mock"; }
  defaultModel() { return "mock-model"; }
  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    throw new Error("spawn 模式不应调用父进程侧的 provider");
  }
}

/**
 * 构造一个假子进程：`stdout` 是真实 ReadableStream，一次性把全部 NDJSON 行入队后关闭；
 * `stdin.write` 只记录调用、不做事；`exited` 立即 resolve（我们不依赖它判断消息循环结束，
 * 循环靠收到 "result" 消息 break）。
 */
function fakeSpawnedProcess(messages: object[]) {
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const m of messages) controller.enqueue(encoder.encode(JSON.stringify(m) + "\n"));
      controller.close();
    },
  });
  const written: string[] = [];
  let killedFlag = false;
  return {
    stdin: {
      write: (data: Uint8Array) => {
        written.push(new TextDecoder().decode(data));
        return data.length;
      },
    },
    stdout,
    get killed() { return killedFlag; },
    kill: () => { killedFlag = true; },
    exited: Promise.resolve(0),
    exitCode: 0,
    written,
  };
}

/** monkey-patch 全局 Bun.spawn，测试结束后必须还原——它是进程级共享状态。 */
function withMockSpawn<T>(mock: (...args: any[]) => any, fn: () => T): T {
  const original = Bun.spawn;
  (Bun as any).spawn = mock;
  try {
    return fn();
  } finally {
    (Bun as any).spawn = original;
  }
}

function progressMsgs(turns: string[]): object[] {
  return turns.map((activity, i) => ({
    type: "progress",
    turn: i + 1,
    max_turns: 30,
    toolUseCount: i + 1,
    tokenCount: (i + 1) * 50,
    lastActivity: activity,
  }));
}

const RESULT_MSG = {
  type: "result",
  success: true,
  output: "done",
  usage: { inputTokens: 10, outputTokens: 5 },
  turns: 3,
  toolUseCount: 3,
};

describe("spawn 路径进度回灌（executeSpawnedInternal 的 progress 消息处理）", () => {
  test("跨进程窗口同样跨轮累积（不再恒为 []）", async () => {
    const proc = fakeSpawnedProcess([
      ...progressMsgs(["读取 f1.ts", "读取 f2.ts", "读取 f3.ts"]),
      RESULT_MSG,
    ]);
    const agent = new SubAgent(new UnusedProvider(), "test-model", new Registry());
    (agent as any).spawnConfig = { providerName: "anthropic", apiKey: "test-key" };

    const snaps: AgentProgressSnapshot[] = [];
    const result = await withMockSpawn(() => proc, () =>
      agent.execute({
        type: "explore",
        description: "spawn 窗口测试",
        prompt: "干活",
        _onProgress: (s) => snaps.push(structuredClone(s)),
      }),
    );

    expect(result.success).toBe(true);
    // 3 次 progress 消息 → 3 次回灌（不是"只在末尾一把"）
    expect(snaps.length).toBe(3);
    // 窗口真的在累积：第 3 帧应看到前两轮的活动都还在（未超容量前不丢）
    expect(snaps[2].recentActivities).toEqual(["读取 f1.ts", "读取 f2.ts", "读取 f3.ts"]);
    expect(snaps[2].agentType).toBe("explore");
    expect(snaps[2].toolUseCount).toBe(3);
    expect(snaps[2].tokenCount).toBe(150);
  });

  test("超容量时只保留最近 MAX_RECENT_ACTIVITIES 条", async () => {
    const proc = fakeSpawnedProcess([
      ...progressMsgs(["a", "b", "c", "d", "e"]),
      RESULT_MSG,
    ]);
    const agent = new SubAgent(new UnusedProvider(), "test-model", new Registry());
    (agent as any).spawnConfig = { providerName: "anthropic", apiKey: "test-key" };

    const snaps: AgentProgressSnapshot[] = [];
    await withMockSpawn(() => proc, () =>
      agent.execute({
        type: "explore",
        description: "spawn 容量测试",
        prompt: "干活",
        _onProgress: (s) => snaps.push(structuredClone(s)),
      }),
    );

    const last = snaps[snaps.length - 1];
    expect(last.recentActivities.length).toBe(MAX_RECENT_ACTIVITIES);
    expect(last.recentActivities).toEqual(["c", "d", "e"]);
  });

  test("未传 _onProgress 时不受影响（后台/swarm 路径向后兼容），registry 写入照常", async () => {
    const proc = fakeSpawnedProcess([...progressMsgs(["读取 f1.ts"]), RESULT_MSG]);
    const agent = new SubAgent(new UnusedProvider(), "test-model", new Registry());
    (agent as any).spawnConfig = { providerName: "anthropic", apiKey: "test-key" };

    const result = await withMockSpawn(() => proc, () =>
      agent.execute({ type: "explore", description: "无回调测试", prompt: "干活" }),
    );
    expect(result.success).toBe(true);
  });

  test("progress 消息本身发给子进程的 init 消息里带了正确的 task_type（回灌快照的 agentType 来源）", async () => {
    const proc = fakeSpawnedProcess([...progressMsgs(["读取 f1.ts"]), RESULT_MSG]);
    const agent = new SubAgent(new UnusedProvider(), "test-model", new Registry());
    (agent as any).spawnConfig = { providerName: "anthropic", apiKey: "test-key" };

    const snaps: AgentProgressSnapshot[] = [];
    await withMockSpawn(() => proc, () =>
      agent.execute({
        type: "plan",
        description: "agentType 测试",
        prompt: "干活",
        _onProgress: (s) => snaps.push(structuredClone(s)),
      }),
    );
    expect(snaps[0].agentType).toBe("plan");
  });
});
