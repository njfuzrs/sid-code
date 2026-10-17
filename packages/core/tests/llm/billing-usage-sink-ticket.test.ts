/**
 * S13（20261016 方案 PR-8）：子代理成本双记 —— usage-sink 入账票据
 *
 * 事故形态：同一批子代理 fetch 走两条入账路 —— ① `usage-sink` 按 `SubAgentResult.usage`
 * `updateUsage`；② provider 发 `BilledRequest`（`accounted=false`）→ app.ts 的 billing
 * observer 经 `shouldChargeBilledRequest` 放行后再 `recordSideCall`。实测 `agent:builtin`
 * 118 条全部双记。
 *
 * 判据挂在**调用实例**上（谁持有 sink 谁开票据），不挂在标签上：hook 子代理同样是
 * `agent:custom` / `agent:summary`，却不经 sink —— 按标签豁免它会全漏。
 * 本文件同时锁住这两个方向：持票据的不再加钱、不持票据的同标签照常加钱。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordBilledRequest,
  addBillingObserver,
  resetBillingSink,
  nextFetchId,
  shouldChargeBilledRequest,
  UsageSinkTicket,
  type BilledRequest,
} from "../../src/llm/billing-sink.ts";
import { withRequestContext } from "../../src/llm/request-context.ts";

/** 模拟 provider 收口：身份从 ALS 取，accounted 按 provider 现有口径算。 */
function providerEmit(agentId: string | undefined, callerLabel: string | undefined): void {
  recordBilledRequest({
    fetchId: nextFetchId(),
    model: "deepseek-v4-pro",
    provider: "openai",
    usage: { inputTokens: 1000, outputTokens: 100 },
    index: 10_001,
    agentId,
    callerLabel,
    accounted: !agentId && !callerLabel,
  });
}

describe("UsageSinkTicket：经 usage-sink 入账的子代理链不再被观察者重复计费", () => {
  let charged: BilledRequest[];

  beforeEach(() => {
    resetBillingSink();
    charged = [];
    // 与 app.ts 的消费侧同口径：只有 shouldChargeBilledRequest 放行的才加钱。
    addBillingObserver((r) => {
      if (shouldChargeBilledRequest(r)) charged.push(r);
    });
  });
  afterEach(() => resetBillingSink());

  test("持票据：agent:builtin / agent:summary 的 fetch 被认领，sink 入账后观察者零加钱", () => {
    const ticket = new UsageSinkTicket();
    withRequestContext(
      {
        turnIndex: 10_001,
        agentId: "sub-1",
        callerLabel: "agent:builtin",
        usageAccounting: ticket,
      },
      () => providerEmit("sub-1", "agent:builtin"),
    );
    withRequestContext(
      {
        turnIndex: 20_001,
        agentId: "sub-1",
        callerLabel: "agent:summary",
        usageAccounting: ticket,
      },
      () => providerEmit("sub-1", "agent:summary"),
    );
    expect(ticket.claimedCount).toBe(2);
    ticket.settle(true);
    expect(charged).toEqual([]);
  });

  test("不持票据（hook 子代理路径）：同为 agent:custom / agent:summary 仍由观察者计费", () => {
    // 反方向：按标签豁免就会在这里漏记 —— 这条用例就是否决「白名单补 agent:*」的依据。
    withRequestContext({ turnIndex: 10_002, agentId: "hook-1", callerLabel: "agent:custom" }, () =>
      providerEmit("hook-1", "agent:custom"),
    );
    withRequestContext({ turnIndex: 20_002, agentId: "hook-1", callerLabel: "agent:summary" }, () =>
      providerEmit("hook-1", "agent:summary"),
    );
    expect(charged.map((r) => r.callerLabel)).toEqual(["agent:custom", "agent:summary"]);
  });

  test("agent:fork 不持票据：照常计费（fork 不走 usage-sink）", () => {
    withRequestContext(
      { turnIndex: 30_001, agentId: "fork:agent:fork", callerLabel: "agent:fork" },
      () => providerEmit("fork:agent:fork", "agent:fork"),
    );
    expect(charged).toHaveLength(1);
  });

  test("sink 没入账（usage 全 0 / 抛错 / 异常出口）：结算时把认领过的 fetch 补交给观察者", () => {
    const ticket = new UsageSinkTicket();
    withRequestContext(
      {
        turnIndex: 10_003,
        agentId: "sub-2",
        callerLabel: "agent:builtin",
        usageAccounting: ticket,
      },
      () => {
        providerEmit("sub-2", "agent:builtin");
        providerEmit("sub-2", "agent:builtin");
      },
    );
    expect(charged).toEqual([]);
    ticket.settle(false);
    expect(charged).toHaveLength(2);
    // 补交的事件恢复为未入账口径
    expect(charged.every((r) => r.accounted === false && r.accountedBy === undefined)).toBe(true);
    // 幂等：二次结算不再补交
    ticket.settle(false);
    expect(charged).toHaveLength(2);
  });

  test("结算之后到达的 fetch（detach 后续跑）不再被认领，由观察者计费", () => {
    const ticket = new UsageSinkTicket();
    ticket.settle(true);
    withRequestContext(
      {
        turnIndex: 10_004,
        agentId: "sub-3",
        callerLabel: "agent:builtin",
        usageAccounting: ticket,
      },
      () => providerEmit("sub-3", "agent:builtin"),
    );
    expect(charged).toHaveLength(1);
  });

  test("主循环不受影响：无 ALS 身份时 accounted=true，观察者不加钱", () => {
    providerEmit(undefined, undefined);
    expect(charged).toEqual([]);
  });
});

/**
 * 防漂移门禁：凡持有 usage-sink 的子代理调用方，必须给子代理挂入账票据。
 *
 * 现有 `billing-self-reported-labels.test.ts` 按「既 recordSideCall 又 streamWithResilience」
 * 扫链，对 `agent:*` 结构性失明（sub-agent.ts 不调前者，`?? "agent:builtin"` 也不匹配
 * `querySource:\s*"` 正则）。这里换一个形状：凡**调用** sink（`this.usageSink(`）的文件，
 * 必须同时开票据 —— 漏了就是本次事故那个双记。
 */
describe("门禁：调用 usage-sink 的子代理链必须开入账票据", () => {
  const SRC = join(import.meta.dir, "../../src");
  const SINK_CALLERS = ["agent/tool.ts", "agent/custom.ts", "tool/workflow.ts"];

  test("三个 sink 调用方都开了票据（或经 runner 的 accountsUsage 声明）", () => {
    for (const rel of SINK_CALLERS) {
      const src = readFileSync(join(SRC, rel), "utf-8");
      // 前提自证：它确实调用 sink，否则这条断言是空转
      expect(src.includes("this.usageSink(")).toBe(true);
      const opensTicket =
        src.includes("new UsageSinkTicket()") || /accountsUsage:\s*this\.usageSink/.test(src);
      expect({ rel, opensTicket }).toEqual({ rel, opensTicket: true });
    }
  });

  test("票据经 buildBaseLoopConfig 进入两条 runAgentLoop 路径，并透传到漏斗主流与总结轮", () => {
    const sub = readFileSync(join(SRC, "agent/sub-agent.ts"), "utf-8");
    expect(sub).toMatch(/usageAccounting:\s*this\.usageAccounting/);
    const loop = readFileSync(join(SRC, "agent/agentic-loop.ts"), "utf-8");
    // 主流 + 总结轮两处
    expect(loop.match(/usageAccounting:\s*config\.usageAccounting/g)?.length).toBe(2);
    const funnel = readFileSync(join(SRC, "llm/resilient-stream.ts"), "utf-8");
    expect(funnel).toMatch(/usageAccounting:\s*opts\.usageAccounting/);
  });

  test("hook 子代理执行器不开票据（它不经 sink，开了就漏记）", () => {
    const app = readFileSync(join(SRC, "../../cli/src/app.ts"), "utf-8");
    const start = app.indexOf("setAgentHookExecutor(");
    expect(start).toBeGreaterThan(0);
    const block = app.slice(start, start + 2500);
    expect(block.includes("setUsageAccounting")).toBe(false);
  });
});
