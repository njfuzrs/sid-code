/**
 * 观测缺口 PR1 · T2：回滚进轨迹（Rewind）
 *
 * 「回滚率」是最直接的返工信号，此前四个入口一条事件都不落。本文件的断言锁两件事：
 *   1. **一次用户动作恰好一条**——埋在 CheckpointManager 层会让一次面板回滚记两条
 *      （rewindTo 内部也调 restoreToSnapshot），埋漏了则 `/rewind <n>` 整条不记；
 *   2. **空转与未命中要能分辨**：`nothing`（没东西可退）与 `snapshot_miss`
 *      （有快照 id 但恢复返回 null，D5 那个缺陷的复发计数）是两种完全不同的返工信号。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RewindManager, type RewindDeps } from "@sid-code/core/session/rewind-manager.ts";
import { setRewindTraceSink, REWIND_EVENT_NAME } from "@sid-code/core/session/rewind-telemetry.ts";

type Captured = Record<string, unknown>;
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  setRewindTraceSink((data) => captured.push(data));
});

afterEach(() => {
  setRewindTraceSink(null);
});

function makeDeps(initialMsgs: unknown[] = [], opts: { restoreResult?: number | null } = {}) {
  let messages = [...initialMsgs];
  const restoreCalls: string[] = [];
  const deps: RewindDeps = {
    getMessages: () => messages,
    setMessages: (m) => {
      messages = [...m];
    },
    restoreToSnapshot: async (id) => {
      restoreCalls.push(id);
      return opts.restoreResult === undefined ? 2 : opts.restoreResult;
    },
  };
  return { deps, restoreCalls };
}

describe("T2 面板回滚（dialog）", () => {
  it("mode=conversation：一条，outcome=ok，对话确实被截断", async () => {
    const h = makeDeps(["m0", "m1"]);
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);
    h.deps.setMessages(["m0", "m1", "m2", "m3"]);

    const result = await mgr.rewindTo(1, "conversation", 2000);

    expect(result?.messagesDropped).toBe(2);
    expect(captured).toHaveLength(1);
    expect(captured[0].via).toBe("dialog");
    expect(captured[0].mode).toBe("conversation");
    expect(captured[0].outcome).toBe("ok");
    expect(captured[0].messages_dropped).toBe(2);
    expect(captured[0].files_restored).toBe(0);
    expect(h.restoreCalls).toHaveLength(0);
  });

  it("mode=code：restoreToSnapshot 被调也只有一条（不因内部调用多记）", async () => {
    const h = makeDeps(["m0"]);
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);
    mgr.attachSnapshot("snap-1");

    const result = await mgr.rewindTo(1, "code", 2000);

    expect(h.restoreCalls).toEqual(["snap-1"]);
    expect(result?.filesRestored).toBe(2);
    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe("code");
    expect(captured[0].files_restored).toBe(2);
    expect(captured[0].has_snapshot).toBe(true);
    expect(captured[0].outcome).toBe("ok");
  });

  it("mode=conversation-and-code：一条，同时记对话与文件两个数", async () => {
    const h = makeDeps(["m0"]);
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);
    mgr.attachSnapshot("snap-1");
    h.deps.setMessages(["m0", "m1"]);

    await mgr.rewindTo(1, "conversation-and-code", 2000);

    expect(captured).toHaveLength(1);
    expect(captured[0].mode).toBe("conversation-and-code");
    expect(captured[0].files_restored).toBe(2);
    expect(captured[0].messages_dropped).toBe(1);
  });

  it("点不存在 → outcome=nothing（空转也是事件，否则回滚率分母偏斜）", async () => {
    const h = makeDeps(["m0"]);
    const mgr = new RewindManager(h.deps);

    const result = await mgr.rewindTo(99, "conversation", 2000);

    expect(result).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("nothing");
    expect(captured[0].mode).toBe("conversation");
  });

  it("有快照 id 但恢复返回 null → outcome=snapshot_miss（D5 复发计数）", async () => {
    const h = makeDeps(["m0"], { restoreResult: null });
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);
    mgr.attachSnapshot("snap-gone");

    await mgr.rewindTo(1, "code", 2000);

    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("snapshot_miss");
    expect(captured[0].file_restore_skipped).toBe(true);
    expect(captured[0].has_snapshot).toBe(true);
  });

  it("本轮没有快照、只回代码 → 什么都没做，outcome=nothing（不是 snapshot_miss）", async () => {
    const h = makeDeps(["m0"]);
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);

    await mgr.rewindTo(1, "code", 2000);

    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("nothing");
    expect(captured[0].has_snapshot).toBe(false);
  });

  it("对话锚点失效 → outcome=nothing 且 conversation_unavailable=true", async () => {
    const h = makeDeps(["m0"]);
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);
    mgr.onMessagesCompacted();

    await mgr.rewindTo(1, "conversation", 2000);

    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("nothing");
    expect(captured[0].conversation_unavailable).toBe(true);
  });
});

describe("T2 事件名与 sink 生命周期", () => {
  it("事件名常量是消费侧共用的那个字符串", () => {
    expect(REWIND_EVENT_NAME).toBe("Rewind");
  });

  it("sink 未注入时回滚照常工作（埋点是旁路）", async () => {
    setRewindTraceSink(null);
    const h = makeDeps(["m0"]);
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("第一轮", 1000);
    h.deps.setMessages(["m0", "m1"]);

    const result = await mgr.rewindTo(1, "conversation", 2000);
    expect(result?.messagesDropped).toBe(1);
    expect(captured).toHaveLength(0);
  });
});
