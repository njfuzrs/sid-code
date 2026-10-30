/**
 * 回归 · C1：心跳把子代理跨越 queryLoop 边界留下的孤儿快照报成「主循环 hang」
 *
 * 实测会话 20261019-114231-fe220250：4 个后台子代理全部结束、主循环已输出汇总之后，
 * heartbeat.txt 仍持续报 `active_request: {index: 10008, phase: "fetch_sent", elapsed_ms: 228602}`
 * 且**无 agent_id**——读心跳的人会得出「主循环卡在 fetch_sent 将近 4 分钟」。
 *
 * 根因三点叠加（见 stream-observer.ts `pickHeartbeatSnapshot` 注释）：
 *   ① provider 层快照 key 无身份维度；
 *   ② loopId 按写入时的 ambient 值取，子代理请求跨越主循环 queryLoop 边界时写进已清理的旧 namespace；
 *   ③ 这把 key 不属于任何一条清理路径。
 *
 * 修复：方向 1（漏斗发起时绑定 loopId + 快照记 ownerAgentId，子代理收尾按它清）
 *     + 方向 2（心跳不把旧 namespace 的无主快照当主循环）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
  getActiveStreamSnapshots,
  clearAllSnapshots,
  cleanupAgentSnapshots,
  pickHeartbeatSnapshot,
} from "@sid-code/core/trace/stream-observer.ts";
import { streamWithResilience } from "@sid-code/core/llm/resilient-stream.ts";
import { setSseDumpContext, currentSseDumpContext } from "@sid-code/core/llm/sse-chunk-dumper.ts";

let savedLoopId: string;
beforeEach(() => {
  savedLoopId = currentSseDumpContext().loopId;
  initStreamObserver("s", "/tmp", () => {});
});
afterEach(() => {
  resetStreamObserver();
  setSseDumpContext(undefined, 0, savedLoopId);
});

/**
 * 模拟 provider：发 fetch_sent（用 ALS 当前 turnIndex，第 4 参 undefined——与 openai.ts 同形），
 * 然后在流中途「主循环换了一个 queryLoop」（被通知唤醒），再继续发事件，最后停在非终态。
 */
function providerCrossingLoopBoundary(onMidStream: () => void): any {
  return {
    name: () => "openai",
    async *sendMessageStream() {
      const idx = currentSseDumpContext().turnIndex;
      emitStreamPhase(idx, "fetch_sent", { model: "m" });
      onMidStream();
      emitStreamPhase(idx, "headers_received", { model: "m" });
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      yield { type: "message_stop" };
    },
  };
}

describe("C1 子代理请求跨越主循环 queryLoop 边界", () => {
  test("子代理收尾后不残留该 index 的非终态快照，心跳不会把它当主循环挑中", async () => {
    const agentId = "sess-sub-au598swfp";
    setSseDumpContext("s", 1, "loop1");

    const gen = streamWithResilience(
      providerCrossingLoopBoundary(() => {
        // 主循环 loop1 结束（clearAllSnapshots）后被通知唤醒，新 queryLoop 登记 loop2
        clearAllSnapshots("loop1");
        setSseDumpContext("s", 1, "loop2");
      }),
      { model: "m", messages: [] } as any,
      undefined,
      { querySource: "agent:builtin" as any, maxRetries: 0, agentId, observerIndex: 10_008 } as any,
    );
    for await (const _ of gen) {
      /* drain */
    }

    // 收尾前：provider 层那份快照必须归属到子代理，而不是冒充主循环
    const before = pickHeartbeatSnapshot(getActiveStreamSnapshots(), "loop2");
    expect(before.picked?.ownerAgentId ?? before.picked?.agentId).toBe(agentId);
    expect(before.ownerOf(before.picked!)).toBe(agentId);

    // 子代理收尾（agentic-loop 的 finally）
    cleanupAgentSnapshots(agentId);
    const left = getActiveStreamSnapshots().filter((s) => s.index === 10_008);
    expect(left).toEqual([]);
    expect(pickHeartbeatSnapshot(getActiveStreamSnapshots(), "loop2").picked).toBeUndefined();
  });

  test("流的全部 provider 写入落在发起时的 loopId 上，不随 ambient 漂移拆成两把 key", async () => {
    setSseDumpContext("s", 1, "loop1");
    const gen = streamWithResilience(
      providerCrossingLoopBoundary(() => setSseDumpContext("s", 1, "loop2")),
      { model: "m", messages: [] } as any,
      undefined,
      {
        querySource: "agent:builtin" as any,
        maxRetries: 0,
        agentId: "a1",
        observerIndex: 10_003,
      } as any,
    );
    for await (const _ of gen) {
      /* drain */
    }
    const snaps = getActiveStreamSnapshots().filter((s) => s.index === 10_003);
    expect(snaps.length).toBe(1);
    expect(snaps[0].loopId).toBe("loop1");
    expect(snaps[0].phase).toBe("headers_received");
  });
});

describe("pickHeartbeatSnapshot（方向 2：治标兜底）", () => {
  test("旧 namespace 的无主非终态快照是孤儿：不当主循环，计入 orphanCount", () => {
    setSseDumpContext("s", 8, "loop1");
    emitStreamPhase(10_008, "fetch_sent", { model: "m" }); // 无任何身份 = 孤儿候选
    setSseDumpContext("s", 3, "loop2");
    const r = pickHeartbeatSnapshot(getActiveStreamSnapshots(), "loop2");
    expect(r.picked).toBeUndefined();
    expect(r.orphanCount).toBe(1);
  });

  test("当前 namespace 的无主快照仍是主循环；子代理快照退为次选", () => {
    setSseDumpContext("s", 3, "loop2");
    emitStreamPhase(10_001, "fetch_sent", { model: "m" }, "sub-x");
    emitStreamPhase(3, "first_content", { model: "m" });
    const r = pickHeartbeatSnapshot(getActiveStreamSnapshots(), "loop2");
    expect(r.picked?.index).toBe(3);
    expect(r.ownerOf(r.picked!)).toBeUndefined();
    expect(r.orphanCount).toBe(0);
  });

  test("终态快照不进候选", () => {
    setSseDumpContext("s", 3, "loop2");
    emitStreamPhase(3, "completed", { model: "m" });
    const r = pickHeartbeatSnapshot(getActiveStreamSnapshots(), "loop2");
    expect(r.picked).toBeUndefined();
    expect(r.liveCount).toBe(0);
  });
});
