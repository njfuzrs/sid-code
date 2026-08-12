/**
 * P1-3：drainInbox 注入契约 单测
 *
 * 双向通信的「读」那一半：team.ts 把成员 mailbox 的 drain 回调塞进 SubAgentTask.drainInbox，
 * sub-agent 在每轮 onBeforeTurn 里消费，把消息作为 user 消息注入子代理上下文。
 *
 * 锁住的契约（这几条一旦破掉，成员就"收不到"leader/peer 的消息，且不会有任何报错）：
 * - 首轮不 drain（首轮已带初始任务，重复注入等于把任务说两遍）
 * - 第 2 轮起每轮 drain 一次，消息包成 <system-reminder>[团队消息] …
 * - drain 抛错不阻断本轮（通信故障不该拖垮成员执行）
 * - 未声明 drainInbox 时行为完全不变（向后兼容）
 * - 与 message-queue 的 drainAgentMessages 并列消费，互不吞掉对方
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { Message, SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/**
 * 每轮记录收到的完整消息序列，跑满 N 轮后 end_turn。
 * 前 N-1 轮回 tool_use（驱动 runAgentLoop 继续下一轮），末轮回纯文本收尾。
 */
class TurnRecordingProvider implements Provider {
  /** 每轮 send 时 provider 侧看到的 messages 快照（深拷贝，避免后续变更污染断言） */
  readonly seen: Message[][] = [];

  constructor(private readonly totalTurns: number) {}

  name() {
    return "mock";
  }
  defaultModel() {
    return "mock-model";
  }

  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.seen.push(JSON.parse(JSON.stringify(params.messages ?? [])));
    const turn = this.seen.length;
    const isLast = turn >= this.totalTurns;

    yield {
      type: "message_start",
      message: {
        id: `msg_${turn}`,
        role: "assistant",
        usage: { inputTokens: 10, outputTokens: 0 },
      },
    } as StreamEvent;

    if (isLast) {
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "完成" },
      } as StreamEvent;
      yield { type: "content_block_stop", index: 0 } as StreamEvent;
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { outputTokens: 5 },
      } as StreamEvent;
      return;
    }

    // 非末轮：回一个 noop 工具调用，让 loop 继续下一轮
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `t${turn}`, name: "noop", input: {} },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { outputTokens: 5 },
    } as StreamEvent;
  }
}

/** 无副作用工具，仅用于驱动多轮循环 */
const noopTool = {
  name: () => "noop",
  description: () => "noop",
  inputSchema: () => ({ type: "object", properties: {} }),
  readOnly: () => true,
  execute: async () => ({ output: "ok" }),
};

function registryWithNoop(): Registry {
  const reg = new Registry();
  reg.register(noopTool as any);
  return reg;
}

/** 把 provider 某一轮看到的消息拍平成纯文本，便于子串断言 */
function flatten(messages: Message[]): string {
  return messages
    .map((m) =>
      Array.isArray(m.content)
        ? m.content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n")
        : String(m.content ?? ""),
    )
    .join("\n---\n");
}

/** 统计某段文本在整段消息里出现的次数（验证"每轮只注入一次"用） */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// 深度计数已改为 ALS（depth-context.ts），每次 execute 自带作用域，无需手动复位静态量。

describe("drainInbox 注入时机", () => {
  test("首轮不 drain（避免与初始任务重复），第 2 轮起才调用", async () => {
    const provider = new TurnRecordingProvider(3);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    /** 记录每次 drain 被调用时是第几轮（用 provider.seen.length 推断） */
    const drainTurns: number[] = [];
    const result = await agent.execute({
      type: "task",
      description: "收件箱测试",
      prompt: "干活",
      drainInbox: () => {
        drainTurns.push(provider.seen.length + 1);
        return [];
      },
    });

    expect(result.success).toBe(true);
    // 3 轮里只有第 2、3 轮 drain（首轮跳过）
    expect(drainTurns).toEqual([2, 3]);
  });

  test("drain 出的消息包成 [团队消息] system-reminder 注入下一轮上下文", async () => {
    const provider = new TurnRecordingProvider(2);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    let sent = false;
    const result = await agent.execute({
      type: "task",
      description: "注入测试",
      prompt: "初始任务描述",
      drainInbox: () => {
        if (sent) return [];
        sent = true;
        return ["来自 leader(review)：接口先别动，等我确认"];
      },
    });

    expect(result.success).toBe(true);
    // 首轮上下文里不该有团队消息（drain 尚未发生）
    expect(flatten(provider.seen[0])).not.toContain("团队消息");
    // 第 2 轮上下文里出现，且带 system-reminder 包装与原文
    const turn2 = flatten(provider.seen[1]);
    expect(turn2).toContain("<system-reminder>");
    expect(turn2).toContain("[团队消息]");
    expect(turn2).toContain("接口先别动，等我确认");
  });

  test("多条消息同轮全部注入，按 drain 返回顺序", async () => {
    const provider = new TurnRecordingProvider(2);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    let sent = false;
    await agent.execute({
      type: "task",
      description: "多条测试",
      prompt: "干活",
      drainInbox: () => {
        if (sent) return [];
        sent = true;
        return ["来自 alice：第一条", "来自 bob：第二条"];
      },
    });

    const turn2 = flatten(provider.seen[1]);
    expect(turn2).toContain("第一条");
    expect(turn2).toContain("第二条");
    expect(turn2.indexOf("第一条")).toBeLessThan(turn2.indexOf("第二条"));
  });

  test("消息只注入一次，不会在后续每轮重复回灌", async () => {
    const provider = new TurnRecordingProvider(4);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    let sent = false;
    await agent.execute({
      type: "task",
      description: "去重测试",
      prompt: "干活",
      drainInbox: () => {
        if (sent) return [];
        sent = true;
        return ["来自 leader：只说一次"];
      },
    });

    // 最后一轮的上下文包含全部历史消息，其中"只说一次"应恰好出现 1 次
    const lastTurn = flatten(provider.seen[provider.seen.length - 1]);
    expect(countOccurrences(lastTurn, "只说一次")).toBe(1);
  });
});

describe("drainInbox 容错与向后兼容", () => {
  test("drain 抛错不阻断本轮，子代理照常跑完", async () => {
    const provider = new TurnRecordingProvider(3);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    let calls = 0;
    const result = await agent.execute({
      type: "task",
      description: "容错测试",
      prompt: "干活",
      drainInbox: () => {
        calls++;
        throw new Error("mailbox 读取失败");
      },
    });

    expect(result.success).toBe(true);
    // 抛错不该让后续轮次停止调用（通信恢复后仍能收到消息）
    expect(calls).toBe(2);
    // 失败的 drain 不该往上下文塞任何团队消息段
    expect(flatten(provider.seen[provider.seen.length - 1])).not.toContain("[团队消息]");
  });

  test("未声明 drainInbox 时行为不变（不注入任何团队消息段）", async () => {
    const provider = new TurnRecordingProvider(3);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    const result = await agent.execute({
      type: "task",
      description: "兼容测试",
      prompt: "干活",
    });

    expect(result.success).toBe(true);
    for (const turn of provider.seen) {
      expect(flatten(turn)).not.toContain("[团队消息]");
    }
  });

  test("drain 返回空数组时不注入空消息（避免刷幻影 user 消息）", async () => {
    const provider = new TurnRecordingProvider(3);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    await agent.execute({
      type: "task",
      description: "空数组测试",
      prompt: "干活",
      drainInbox: () => [],
    });

    // 每轮消息数应只由 assistant/tool_result 推进，不含额外的团队消息 user 消息
    const last = flatten(provider.seen[provider.seen.length - 1]);
    expect(last).not.toContain("<system-reminder>\n[团队消息]");
  });
});

describe("drainInbox 与主代理消息队列并列消费", () => {
  test("两条通道同轮各自注入，互不吞掉（前缀区分来源）", async () => {
    const { injectMessageToAgent } = await import("@sid-code/core/agent/message-queue.ts");
    const { createAgentTask } = await import("@sid-code/core/task/agent-task.ts");

    // 预创建 task，拿到 taskId 后往主代理消息队列投一条
    const created = createAgentTask({
      agentType: "task",
      prompt: "干活",
      description: "并列消费测试",
    });
    injectMessageToAgent(created.taskState.id, "主代理插话：优先处理登录");

    const provider = new TurnRecordingProvider(2);
    const agent = new SubAgent(provider, "test-model", registryWithNoop());

    let sent = false;
    await agent.execute({
      type: "task",
      description: "并列消费测试",
      prompt: "干活",
      _taskId: created.taskState.id,
      _abortController: created.abortController,
      drainInbox: () => {
        if (sent) return [];
        sent = true;
        return ["来自 bob：数据库 schema 我改完了"];
      },
    });

    const turn2 = flatten(provider.seen[1]);
    // 主代理消息与团队消息都在，且各自带来源前缀
    expect(turn2).toContain("[主代理消息]");
    expect(turn2).toContain("优先处理登录");
    expect(turn2).toContain("[团队消息]");
    expect(turn2).toContain("数据库 schema 我改完了");
  });
});
