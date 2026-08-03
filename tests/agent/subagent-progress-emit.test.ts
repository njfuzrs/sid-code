/**
 * 子代理进度回灌（emit 侧）单测 —— 治"过程黑盒"的数据源那一半
 *
 * 分工：
 *   - tests/ui/agent-progress-inject.test.ts 测**渲染侧**（快照 → 卡片，档位决策）；
 *   - 本文件测**产出侧**：子代理跑起来后，是否真的每轮把快照推给父工具卡片。
 *
 * 锁住的契约（破掉任何一条，用户就重新回到"1m35s 屏幕上一个字都没有"）：
 * - 每轮回灌一次，不是只在末尾回灌一次（末尾回灌 == 没治黑盒）
 * - recentActivities 跨轮累积成滑动窗口。此前这个字段恒传 `[]`（死字段，方案附2），
 *   而 onTurnEnd 的 info.tools 只是**本轮**的工具——直接拿它当全量就永远只有 1 条。
 * - 累计量（toolUseCount / tokenCount）单调不减，elapsedMs 在推进
 * - 未传 _onProgress 时行为完全不变（后台/swarm/workflow 路径向后兼容）
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "../../src/agent/sub-agent.ts";
import { Registry } from "../../src/tool/registry.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";
import { MAX_RECENT_ACTIVITIES, type AgentProgressSnapshot } from "../../src/agent/progress.ts";

/**
 * 跑满 N 轮的 mock provider：前 N-1 轮各回一个 read 工具调用（每轮读**不同**文件，
 * 这样活动文案逐轮不同，能验证窗口是否真的在累积），末轮回纯文本收尾。
 */
class ReadingProvider implements Provider {
  private turn = 0;
  constructor(private readonly totalTurns: number) {}
  name() { return "mock"; }
  defaultModel() { return "mock-model"; }

  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    this.turn += 1;
    const turn = this.turn;
    yield {
      type: "message_start",
      message: { id: `msg_${turn}`, role: "assistant", usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent;

    if (turn >= this.totalTurns) {
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as StreamEvent;
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } } as StreamEvent;
      yield { type: "content_block_stop", index: 0 } as StreamEvent;
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } } as StreamEvent;
      return;
    }

    // 入参必须经 input_json_delta 下发，不能塞在 content_block_start 的 input 里——
    // 后者会被 agentic-loop 的「空参数 tool_use」保护判为模型漏填参数，注入重试提示而
    // **不执行工具**，于是整条链路（工具 → 活动文案 → 窗口）全程走不到，测试会假红。
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `t${turn}`, name: "read", input: {} },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: `f${turn}.ts` }) },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 5 } } as StreamEvent;
  }
}

/** 假 read 工具：只为驱动多轮循环并让 describeToolActivity 产出「读取 fN.ts」 */
const readTool = {
  name: () => "read",
  description: () => "read",
  inputSchema: () => ({ type: "object", properties: { file_path: { type: "string" } } }),
  readOnly: () => true,
  execute: async () => ({ output: "ok" }),
};

function registryWithRead(): Registry {
  const reg = new Registry();
  reg.register(readTool as any);
  return reg;
}

describe("子代理进度回灌 _onProgress", () => {
  test("每轮回灌一次（不是只在末尾一把回灌）", async () => {
    const provider = new ReadingProvider(4);
    const agent = new SubAgent(provider, "test-model", registryWithRead());
    const snaps: AgentProgressSnapshot[] = [];

    const result = await agent.execute({
      type: "explore",
      description: "黑盒测试",
      prompt: "干活",
      _onProgress: (s) => snaps.push(structuredClone(s)),
    });

    expect(result.success).toBe(true);
    // 4 轮 → 至少 4 次回灌。"只在末尾一次"是本次要治的病，必须 > 1
    expect(snaps.length).toBeGreaterThanOrEqual(4);
  });

  test("recentActivities 跨轮累积成滑动窗口（此前恒为 []，死字段）", async () => {
    const provider = new ReadingProvider(5);
    const agent = new SubAgent(provider, "test-model", registryWithRead());
    const snaps: AgentProgressSnapshot[] = [];

    await agent.execute({
      type: "explore",
      description: "窗口测试",
      prompt: "干活",
      _onProgress: (s) => snaps.push(structuredClone(s)),
    });

    // 关键断言：恒 [] 或"只拿本轮 info.tools"都会让长度停在 0/1
    const maxLen = Math.max(...snaps.map((s) => s.recentActivities.length));
    expect(maxLen).toBeGreaterThan(1);
    expect(maxLen).toBeLessThanOrEqual(MAX_RECENT_ACTIVITIES);

    // 内容是真实活动文案（describeToolActivity 的产物），不是工具名占位
    const last = snaps[snaps.length - 1].recentActivities;
    expect(last.some((a) => a.startsWith("读取 f"))).toBe(true);

    // 窗口保留的是**最近**的：5 轮读 f1..f4，末尾窗口不该还留着 f1
    expect(last).not.toContain("读取 f1.ts");
  });

  test("累计量单调不减，agentType 与耗时随快照带出", async () => {
    const provider = new ReadingProvider(4);
    const agent = new SubAgent(provider, "test-model", registryWithRead());
    const snaps: AgentProgressSnapshot[] = [];

    await agent.execute({
      type: "explore",
      description: "累计量测试",
      prompt: "干活",
      _onProgress: (s) => snaps.push(structuredClone(s)),
    });

    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i].toolUseCount).toBeGreaterThanOrEqual(snaps[i - 1].toolUseCount);
      expect(snaps[i].tokenCount).toBeGreaterThanOrEqual(snaps[i - 1].tokenCount);
    }
    // 末帧应已累计到真实工具次数（4 轮里前 3 轮各一次 read）
    expect(snaps[snaps.length - 1].toolUseCount).toBeGreaterThan(0);
    expect(snaps[snaps.length - 1].tokenCount).toBeGreaterThan(0);
    expect(snaps[snaps.length - 1].agentType).toBe("explore");
    expect(snaps[snaps.length - 1].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("未传 _onProgress 时正常跑完（后台/swarm/workflow 路径向后兼容）", async () => {
    const provider = new ReadingProvider(3);
    const agent = new SubAgent(provider, "test-model", registryWithRead());
    const result = await agent.execute({
      type: "explore",
      description: "兼容测试",
      prompt: "干活",
    });
    expect(result.success).toBe(true);
  });
});
