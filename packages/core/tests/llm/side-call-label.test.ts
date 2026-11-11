/**
 * D10：后台 fork 的辅助调用标签必须能分出「哪个任务在花钱」。
 *
 * ## 缺陷形态
 *
 * `runForkedAgent` 把 `querySource` 写死成 `agent:fork`（任务身份只在 `agentId`
 * 里，形如 `fork:memory-extract`）。billing 观察者原先优先取 `callerLabel`，
 * 于是 `getSideStats().byLabel` 里只剩一个 `agent:fork` 桶——记忆抽取、会话记忆、
 * 记忆巩固、旁路问答全塌在一起，看不到「钱是哪个任务花的」。
 *
 * ## 为什么这条测试放在纯函数上
 *
 * 判据只有一份实现（`sideCallLabelOf`），app.ts 的 billing 观察者直接调它。
 * 在纯函数上断言，能覆盖全部分支且不需要构造整个 App 实例；跨层链路
 * （observer → recordSideCall → byLabel）由 T-A5 之后的运行时验证兜。
 */

import { test, expect, describe } from "bun:test";
import { sideCallLabelOf } from "../../src/llm/billing-sink.ts";

describe("D10：辅助调用标签（sideCallLabelOf）", () => {
  test("fork 的泛化 callerLabel 让位给 agentId", () => {
    expect(sideCallLabelOf({ callerLabel: "agent:fork", agentId: "fork:memory-extract" })).toBe(
      "fork:memory-extract",
    );
    expect(
      sideCallLabelOf({ callerLabel: "agent:fork", agentId: "fork:session-memory-update" }),
    ).toBe("fork:session-memory-update");
    // 记忆巩固 / 旁路问答也走同一条 fork 通道，必须各自可分
    expect(sideCallLabelOf({ callerLabel: "agent:fork", agentId: "fork:auto-dream" })).toBe(
      "fork:auto-dream",
    );
  });

  test("具体的 callerLabel 保持不变", () => {
    // 这些标签本身已经说明「谁在花钱」，不能被 agentId 顶掉
    expect(sideCallLabelOf({ callerLabel: "title_generation" })).toBe("title_generation");
    expect(sideCallLabelOf({ callerLabel: "memory_recall", agentId: "x" })).toBe("memory_recall");
    expect(sideCallLabelOf({ callerLabel: "compact" })).toBe("compact");
  });

  test("其余 agent:* 分类标签不替换（只登记了 agent:fork）", () => {
    // agent:builtin / agent:custom / agent:summary 是稳定分类标签，
    // 它们的 agentId 不比标签本身更好读，换掉只会平移 byLabel / digest 的分组口径。
    expect(sideCallLabelOf({ callerLabel: "agent:builtin", agentId: "sub-1" })).toBe(
      "agent:builtin",
    );
    expect(sideCallLabelOf({ callerLabel: "agent:custom", agentId: "sub-2" })).toBe("agent:custom");
    expect(sideCallLabelOf({ callerLabel: "agent:summary", agentId: "sub-3" })).toBe(
      "agent:summary",
    );
  });

  test("只有 agentId 时退化为 agent:<agentId>", () => {
    expect(sideCallLabelOf({ agentId: "fork:x" })).toBe("agent:fork:x");
  });

  test("两者都没有时是 provider-billed", () => {
    expect(sideCallLabelOf({})).toBe("provider-billed");
    // 泛化标签但没有 agentId：回落原语义（不能丢标签）
    expect(sideCallLabelOf({ callerLabel: "agent:fork" })).toBe("agent:fork");
  });
});
