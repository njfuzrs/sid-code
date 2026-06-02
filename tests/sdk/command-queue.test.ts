/**
 * Phase 2 单测：命令队列（优先级 + 批量合并）
 */

import { describe, test, expect } from "bun:test";
import { CommandQueue, type QueuedCommand } from "../../src/sdk/command-queue.ts";

function prompt(value: string, extra: Partial<QueuedCommand> = {}): QueuedCommand {
  return { mode: "prompt", value, priority: "next", ...extra };
}

describe("CommandQueue 优先级", () => {
  test("now > next > later", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("later", { priority: "later" }));
    q.enqueue(prompt("now", { priority: "now" }));
    q.enqueue(prompt("next", { priority: "next" }));
    expect(q.dequeue()?.value).toBe("now");
    expect(q.dequeue()?.value).toBe("next");
    expect(q.dequeue()?.value).toBe("later");
  });

  test("同优先级稳定 FIFO", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a"));
    q.enqueue(prompt("b"));
    q.enqueue(prompt("c"));
    expect(q.dequeue()?.value).toBe("a");
    expect(q.dequeue()?.value).toBe("b");
    expect(q.dequeue()?.value).toBe("c");
  });
});

describe("CommandQueue 基本操作", () => {
  test("isEmpty / size", () => {
    const q = new CommandQueue();
    expect(q.isEmpty()).toBe(true);
    q.enqueue(prompt("x"));
    expect(q.isEmpty()).toBe(false);
    expect(q.size()).toBe(1);
  });

  test("peek 不移除", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("x"));
    expect(q.peek()?.value).toBe("x");
    expect(q.size()).toBe(1);
  });

  test("dequeue 带过滤器", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w1" }));
    q.enqueue(prompt("b", { workload: "w2" }));
    const got = q.dequeue((c) => c.workload === "w2");
    expect(got?.value).toBe("b");
    expect(q.size()).toBe(1);
  });
});

describe("CommandQueue 批量合并", () => {
  test("连续同 workload 的 prompt 合并", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w" }));
    q.enqueue(prompt("b", { workload: "w" }));
    q.enqueue(prompt("c", { workload: "w" }));
    const batch = q.dequeueBatch();
    expect(batch?.value).toBe("a\n\nb\n\nc");
    expect(q.isEmpty()).toBe(true);
  });

  test("不同 workload 不合并", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w1" }));
    q.enqueue(prompt("b", { workload: "w2" }));
    const batch = q.dequeueBatch();
    expect(batch?.value).toBe("a");
    expect(q.size()).toBe(1);
  });

  test("非 prompt 命令不合并", () => {
    const q = new CommandQueue();
    q.enqueue({ mode: "meta", value: "m", priority: "next" });
    q.enqueue(prompt("p"));
    const batch = q.dequeueBatch();
    expect(batch?.value).toBe("m");
  });

  test("合并后 uuid 取最后一条有 uuid 的", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w", uuid: "u1" }));
    q.enqueue(prompt("b", { workload: "w", uuid: "u2" }));
    const batch = q.dequeueBatch();
    expect(batch?.uuid).toBe("u2");
  });

  test("isMeta 不同不合并", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w", isMeta: false }));
    q.enqueue(prompt("b", { workload: "w", isMeta: true }));
    const batch = q.dequeueBatch();
    expect(batch?.value).toBe("a");
    expect(q.size()).toBe(1);
  });
});
