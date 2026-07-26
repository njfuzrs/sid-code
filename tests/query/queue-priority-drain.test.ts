/**
 * P1-G6：用户输入排队的三优先级端到端语义（验收标准直译）
 *
 * 方案 §3 P1-G6 验收标准：
 *   「流式中排 3 条（1 now + 2 next），回合结束后 now 先发」
 *   「提示按优先级分组显示」
 *
 * useMessageQueue 的 drain 是「每次 Idle 只取队首一条 user-input」——所以"now 先发"
 * 这件事完全取决于队列内核的排序 + dequeueFirstByKind 的取首语义。本文件按 hook 的实际
 * drain 方式（逐条 dequeueFirstByKind("user-input")）复现发送次序，而不是断言内部实现细节。
 *
 * 另覆盖分组计数逻辑（hook 里 queuedByPriority 的派生规则）与 ↑ 弹回编辑的取队尾语义。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  enqueueCommand,
  dequeueFirstByKind,
  dequeueLastByKind,
  getQueueSnapshot,
  __resetForTest,
} from "../../src/query/message-queue-manager.ts";

/** 模拟 useMessageQueue 的入队（默认 next 级）。 */
function enqueueUserInput(text: string, priority: "now" | "next" | "later" = "next") {
  enqueueCommand({ priority, kind: "user-input", payload: text });
}

/** 模拟 hook 的逐条 drain：每次 Idle 取队首一条，直到取空。返回实际发送次序。 */
function drainAsHookWould(): string[] {
  const sent: string[] = [];
  for (;;) {
    const c = dequeueFirstByKind("user-input");
    if (!c) break;
    sent.push(String(c.payload));
  }
  return sent;
}

/** 复刻 hook 里 queuedByPriority 的派生（一次遍历，只计 user-input）。 */
function deriveCounts() {
  const counts = { now: 0, next: 0, later: 0 };
  let total = 0;
  for (const c of getQueueSnapshot()) {
    if (c.kind !== "user-input") continue;
    total++;
    counts[c.priority]++;
  }
  return { total, counts };
}

describe("P1-G6 排队输入三优先级发送次序", () => {
  beforeEach(() => __resetForTest());
  afterEach(() => __resetForTest());

  test("验收标准：1 now + 2 next，now 先发", () => {
    // 用户在流式中依次敲了 3 条，now 是最后敲的（最容易暴露"只按 FIFO"的实现）
    enqueueUserInput("普通1");
    enqueueUserInput("普通2");
    enqueueUserInput("插队", "now");

    expect(drainAsHookWould()).toEqual(["插队", "普通1", "普通2"]);
  });

  test("later 排在所有 next 之后", () => {
    enqueueUserInput("延后", "later");
    enqueueUserInput("普通1");
    enqueueUserInput("插队", "now");
    enqueueUserInput("普通2");

    expect(drainAsHookWould()).toEqual(["插队", "普通1", "普通2", "延后"]);
  });

  test("同优先级严格 FIFO（插队之间也保持敲入顺序）", () => {
    enqueueUserInput("插队A", "now");
    enqueueUserInput("插队B", "now");
    enqueueUserInput("插队C", "now");

    expect(drainAsHookWould()).toEqual(["插队A", "插队B", "插队C"]);
  });

  test("默认优先级是 next（省略参数等价普通排队）", () => {
    enqueueUserInput("显式next", "next");
    enqueueUserInput("省略参数");
    enqueueUserInput("插队", "now");

    expect(drainAsHookWould()).toEqual(["插队", "显式next", "省略参数"]);
  });

  test("后台任务通知（later 级、非 user-input）不被用户输入通道 drain 走", () => {
    enqueueUserInput("用户输入");
    enqueueCommand({ priority: "later", kind: "task-notification", payload: { id: "t1" } });

    expect(drainAsHookWould()).toEqual(["用户输入"]);
    // 通知仍在队列里，留给 queryLoop 回合边界处理
    expect(getQueueSnapshot().some((c) => c.kind === "task-notification")).toBe(true);
  });
});

describe("P1-G6 分组计数（提示分组展示的数据来源）", () => {
  beforeEach(() => __resetForTest());
  afterEach(() => __resetForTest());

  test("按优先级分别计数，总数为三者之和", () => {
    enqueueUserInput("n1", "now");
    enqueueUserInput("m1");
    enqueueUserInput("m2");
    enqueueUserInput("l1", "later");

    const { total, counts } = deriveCounts();
    expect(counts).toEqual({ now: 1, next: 2, later: 1 });
    expect(total).toBe(4);
    expect(counts.now + counts.next + counts.later).toBe(total);
  });

  test("非 user-input 命令不计入排队条数（通知不该显示成'已排队 N 条输入'）", () => {
    enqueueUserInput("m1");
    enqueueCommand({ priority: "later", kind: "task-notification", payload: {} });

    const { total, counts } = deriveCounts();
    expect(total).toBe(1);
    expect(counts.later).toBe(0);
  });

  test("全为默认级时 now/later 计数为 0（此时 UI 不做分组展示）", () => {
    enqueueUserInput("m1");
    enqueueUserInput("m2");
    const { counts } = deriveCounts();
    expect(counts.now).toBe(0);
    expect(counts.later).toBe(0);
  });
});

describe("P2-G6 ↑ 弹回编辑取队尾", () => {
  beforeEach(() => __resetForTest());
  afterEach(() => __resetForTest());

  test("弹回的是最近入队那条（刚敲错想改的直觉），取出即移除", () => {
    enqueueUserInput("早先那条");
    enqueueUserInput("刚敲的");

    const popped = dequeueLastByKind("user-input");
    expect(popped?.payload).toBe("刚敲的");
    // 队列里只剩早先那条
    expect(drainAsHookWould()).toEqual(["早先那条"]);
  });

  test("队列空时返回 undefined（hook 侧转成 null → 落回历史检索）", () => {
    expect(dequeueLastByKind("user-input")).toBeUndefined();
  });

  test("弹回不误取后台通知", () => {
    enqueueCommand({ priority: "later", kind: "task-notification", payload: {} });
    expect(dequeueLastByKind("user-input")).toBeUndefined();
  });
});
