/**
 * Phase 2 单测：命令队列（优先级 + 批量合并）
 */

import { describe, test, expect } from "bun:test";
import { CommandQueue, type QueuedCommand } from "@sid-code/core/sdk/command-queue.ts";

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

  test("缺陷 10：合并出的新对象重新入队，排在同优先级末尾而不是插到队首", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w" }));
    q.enqueue(prompt("b", { workload: "w" }));
    const merged = q.dequeueBatch()!;
    q.enqueue(prompt("x"));
    q.enqueue(prompt("y"));
    q.enqueue(merged);
    expect([q.dequeue(), q.dequeue(), q.dequeue()].map((c) => c?.value)).toEqual([
      "x",
      "y",
      "a\n\nb",
    ]);
  });

  test("缺陷 10：交错入队多种优先级，同优先级内保持 FIFO", () => {
    const q = new CommandQueue();
    const order = ["l1:later", "n1:next", "w1:now", "l2:later", "n2:next", "w2:now", "n3:next"];
    for (const s of order) {
      const [v, p] = s.split(":");
      q.enqueue(prompt(v, { priority: p as QueuedCommand["priority"] }));
    }
    const out: string[] = [];
    while (!q.isEmpty()) out.push(q.dequeue()!.value);
    expect(out).toEqual(["w1", "w2", "n1", "n2", "n3", "l1", "l2"]);
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

  test("缺陷 9：合并后 mergedUuids 携带全部 uuid（按入队顺序，跳过无 uuid 的）", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w", uuid: "A" }));
    q.enqueue(prompt("b", { workload: "w" }));
    q.enqueue(prompt("c", { workload: "w", uuid: "C" }));
    const batch = q.dequeueBatch();
    expect(batch?.mergedUuids).toEqual(["A", "C"]);
    expect(batch?.uuid).toBe("C");
  });

  test("缺陷 9：未合并的单条命令原样返回，不带 mergedUuids", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { uuid: "A" }));
    expect(q.dequeueBatch()).toEqual(prompt("a", { uuid: "A" }));
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

/**
 * stream-json 输入路径下每条 user 消息都入队为 mode=prompt、priority=next，
 * workload / isMeta 都不设，于是「三项判据」恒真——任意两条连续 prompt 都会合并。
 * 合并把两条独立输入拼成一次 submitMessage，无头分发只看得到整串的第一段：
 * 命令在前就吞掉提问，命令在后就整串当提问、命令不执行。两种顺序都要守。
 */
describe("CommandQueue：斜杠命令不参与批量合并", () => {
  test("命令在前：后续提问不被吞成命令参数", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("/compact"));
    q.enqueue(prompt("帮我看下 README"));
    expect(q.dequeueBatch()?.value).toBe("/compact");
    expect(q.dequeueBatch()?.value).toBe("帮我看下 README");
  });

  test("命令在后：不被并进前一条提问", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("帮我看下 README"));
    q.enqueue(prompt("/compact"));
    expect(q.dequeueBatch()?.value).toBe("帮我看下 README");
    expect(q.dequeueBatch()?.value).toBe("/compact");
  });

  test("命令夹在中间：三段各自成轮（head 与 next 两侧都判）", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("a", { workload: "w" }));
    q.enqueue(prompt("/compact", { workload: "w" }));
    q.enqueue(prompt("b", { workload: "w" }));
    expect(q.dequeueBatch()?.value).toBe("a");
    expect(q.dequeueBatch()?.value).toBe("/compact");
    expect(q.dequeueBatch()?.value).toBe("b");
  });

  test("前导空白的命令同样独占（与 parseSlashCommand 的 trim 口径一致）", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("  /model opus"));
    q.enqueue(prompt("普通提问"));
    expect(q.dequeueBatch()?.value).toBe("  /model opus");
    expect(q.dequeueBatch()?.value).toBe("普通提问");
  });

  test("两条连续命令不合并", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("/compact"));
    q.enqueue(prompt("/model opus"));
    expect(q.dequeueBatch()?.value).toBe("/compact");
    expect(q.dequeueBatch()?.value).toBe("/model opus");
  });

  test("/tmp 这类真实路径也独占（判据是首字符，不查注册表）", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("看看这个文件"));
    q.enqueue(prompt("/tmp/a.txt"));
    expect(q.dequeueBatch()?.value).toBe("看看这个文件");
    expect(q.dequeueBatch()?.value).toBe("/tmp/a.txt");
  });

  test("独占不破坏其后的正常合并", () => {
    const q = new CommandQueue();
    q.enqueue(prompt("/model opus", { workload: "w" }));
    q.enqueue(prompt("a", { workload: "w" }));
    q.enqueue(prompt("b", { workload: "w" }));
    expect(q.dequeueBatch()?.value).toBe("/model opus");
    expect(q.dequeueBatch()?.value).toBe("a\n\nb");
  });
});
