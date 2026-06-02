/**
 * 命令队列测试（Task 3）
 */

import { describe, test, expect } from "bun:test";
import { CommandQueue } from "../../src/command/queue.ts";

describe("CommandQueue", () => {
  test("默认 enqueue 为 next 优先级，FIFO 出队", () => {
    const q = new CommandQueue();
    q.enqueue({ value: "a", mode: "prompt" });
    q.enqueue({ value: "b", mode: "prompt" });
    expect(q.dequeue()?.value).toBe("a");
    expect(q.dequeue()?.value).toBe("b");
    expect(q.dequeue()).toBeUndefined();
  });

  test("now 优先级插队到 next 之前", () => {
    const q = new CommandQueue();
    q.enqueue({ value: "next1", mode: "prompt" });
    q.enqueue({ value: "now1", mode: "slash", priority: "now" });
    expect(q.dequeue()?.value).toBe("now1");
    expect(q.dequeue()?.value).toBe("next1");
  });

  test("系统通知默认 later，排在用户输入之后", () => {
    const q = new CommandQueue();
    q.enqueueNotification({ value: "notif", mode: "prompt" });
    q.enqueue({ value: "user", mode: "prompt" });
    expect(q.dequeue()?.value).toBe("user");
    expect(q.dequeue()?.value).toBe("notif");
  });

  test("三级优先级顺序 now > next > later", () => {
    const q = new CommandQueue();
    q.enqueueNotification({ value: "later", mode: "prompt" });
    q.enqueue({ value: "next", mode: "prompt" });
    q.enqueue({ value: "now", mode: "slash", priority: "now" });
    expect(q.dequeue()?.value).toBe("now");
    expect(q.dequeue()?.value).toBe("next");
    expect(q.dequeue()?.value).toBe("later");
  });

  test("peek 不移除元素", () => {
    const q = new CommandQueue();
    q.enqueue({ value: "a", mode: "prompt" });
    expect(q.peek()?.value).toBe("a");
    expect(q.length).toBe(1);
  });

  test("clear 清空队列", () => {
    const q = new CommandQueue();
    q.enqueue({ value: "a", mode: "prompt" });
    q.enqueue({ value: "b", mode: "prompt" });
    q.clear();
    expect(q.length).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  test("subscribe 在入队/出队时通知", () => {
    const q = new CommandQueue();
    let count = 0;
    const unsub = q.subscribe(() => count++);
    q.enqueue({ value: "a", mode: "prompt" }); // +1
    q.dequeue(); // +1
    expect(count).toBe(2);
    unsub();
    q.enqueue({ value: "b", mode: "prompt" }); // 已取消订阅，不计
    expect(count).toBe(2);
  });

  test("snapshot 返回当前队列副本", () => {
    const q = new CommandQueue();
    q.enqueue({ value: "a", mode: "prompt" });
    const snap = q.snapshot();
    expect(snap.length).toBe(1);
    q.enqueue({ value: "b", mode: "prompt" });
    // snapshot 是副本，不随后续变化
    expect(snap.length).toBe(1);
  });
});
