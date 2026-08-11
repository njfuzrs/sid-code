/**
 * stream-observer 单元测试
 *
 * 覆盖 hang 诊断可观测性的核心行为：
 * - armIneffectiveCheck：超时 fire 后若未 disarm → 发 TimeoutIneffective（缺口 2 进阶，事故指纹）
 * - armIneffectiveCheck：及时 disarm → 不发事件（超时正常生效）
 * - emitHttpConnected：独立 HttpConnected 事件（缺口 6）
 * - emitStreamPhase / 快照：headers_received 更新 http_status/ttfb（缺口 1/6）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initStreamObserver,
  resetStreamObserver,
  armIneffectiveCheck,
  emitHttpConnected,
  emitStreamPhase,
  emitTimeoutFired,
  getStreamSnapshot,
  getActiveStreamSnapshots,
  clearStreamSnapshot,
  clearAllSnapshots,
  cleanupAgentSnapshots,
} from "@sid-code/core/trace/stream-observer.ts";
import { currentSseDumpContext } from "@sid-code/core/llm/sse-chunk-dumper.ts";

// 捕获所有写入的事件
let captured: Array<{ event: string; data: Record<string, unknown> }>;

beforeEach(() => {
  captured = [];
  initStreamObserver("test-session", "/tmp/test-session", (ev) => {
    captured.push({ event: ev.event, data: ev.data });
  });
});

afterEach(() => {
  resetStreamObserver();
});

const eventsOf = (name: string) => captured.filter((e) => e.event === name);

describe("armIneffectiveCheck（缺口 2 进阶）", () => {
  test("未 disarm → 宽限期后发出 TimeoutIneffective", async () => {
    armIneffectiveCheck(13, "turn_hard_timeout", "promise_race_not_settled_after_5s", 30);
    // 不调用 disarm，等待超过宽限期
    await new Promise((r) => setTimeout(r, 80));

    const ineffective = eventsOf("TimeoutIneffective");
    expect(ineffective.length).toBe(1);
    expect(inefFirst(ineffective).layer).toBe("turn_hard_timeout");
    expect(inefFirst(ineffective).index).toBe(13);
    expect(inefFirst(ineffective).reason).toBe("promise_race_not_settled_after_5s");
  });

  test("宽限期内 disarm → 不发出 TimeoutIneffective（超时正常生效）", async () => {
    const disarm = armIneffectiveCheck(13, "idle_timeout", "read_race_not_settled_after_5s", 60);
    // 立即 disarm，模拟 race 已 settle
    disarm();
    await new Promise((r) => setTimeout(r, 100));

    expect(eventsOf("TimeoutIneffective").length).toBe(0);
  });

  test("disarm 幂等 —— 多次调用无副作用", async () => {
    const disarm = armIneffectiveCheck(1, "header_timeout", "fetch_not_settled_after_5s", 30);
    disarm();
    disarm();
    disarm();
    await new Promise((r) => setTimeout(r, 60));
    expect(eventsOf("TimeoutIneffective").length).toBe(0);
  });
});

describe("emitHttpConnected（缺口 6）", () => {
  test("发出独立 HttpConnected 事件，含 status/content_type/ttfb", () => {
    emitHttpConnected(5, {
      status: 200,
      content_type: "text/event-stream",
      ttfb_ms: 1523,
      model: "deepseek-v4-pro",
    });
    const ev = eventsOf("HttpConnected");
    expect(ev.length).toBe(1);
    expect(ev[0].data.index).toBe(5);
    expect(ev[0].data.status).toBe(200);
    expect(ev[0].data.content_type).toBe("text/event-stream");
    expect(ev[0].data.ttfb_ms).toBe(1523);
  });
});

describe("emitStreamPhase 快照更新（缺口 1/6）", () => {
  test("headers_received 更新快照 http_status + ttfb", () => {
    emitStreamPhase(7, "fetch_sent", { model: "m" });
    emitStreamPhase(7, "headers_received", { http_status: 200, ttfb_ms: 800, model: "m" });

    const snap = getStreamSnapshot(7);
    expect(snap?.httpStatusReceived).toBe(true);
    expect(snap?.httpStatus).toBe(200);
    expect(snap?.ttfbMs).toBe(800);
    expect(snap?.phase).toBe("headers_received");

    // StreamPhase 事件也应写出
    expect(eventsOf("StreamPhase").length).toBe(2);
  });

  test("emitTimeoutFired 累积到快照 timeoutsFired", () => {
    emitStreamPhase(9, "sse_consuming", { model: "m" });
    emitTimeoutFired(9, "idle_timeout", { threshold_ms: 1000 });
    emitTimeoutFired(9, "content_progress_timeout", { threshold_ms: 2000 });

    const snap = getStreamSnapshot(9);
    expect(snap?.timeoutsFired).toEqual(["idle_timeout", "content_progress_timeout"]);
    expect(eventsOf("TimeoutFired").length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// B4 — per-agent 状态隔离（附录 A5 判据）
//
// 改造前实测：6 个并行子代理各自第 1 轮 → agentStreamIndex 全为 10001 →
//   活跃快照数 = 1（全部共用同一 key）；其中 1 个 clear 后 = 0（把其他 5 个
//   还在跑的活快照一并清掉）。
// 改造后判据：活跃 = 6；单个 clear 后 = 5；全部 teardown 后 = 0。
// ═══════════════════════════════════════════════════════════════════
describe("B4 per-agent 快照隔离（附录 A5）", () => {
  // 6 个并行子代理各自第 1 轮：turns=1 → agentStreamIndex = 10000 + 1
  const AGENT_STREAM_INDEX = 10001;
  const agentIds = Array.from({ length: 6 }, (_, i) => `subagent-explore-task_${i}`);

  test("6 个并行子代理同 index 不同 agentId → 各自独立快照（改造前为 1）", () => {
    for (const id of agentIds) {
      emitStreamPhase(AGENT_STREAM_INDEX, "fetch_sent", { caller: "sub-agent", model: `m-${id}` }, id);
    }

    expect(getActiveStreamSnapshots().length).toBe(6);
    // 每份快照都能按自己的身份被独立读回，且 index 仍是可解释的轮次号
    for (const id of agentIds) {
      const snap = getStreamSnapshot(AGENT_STREAM_INDEX, undefined, id);
      expect(snap?.agentId).toBe(id);
      expect(snap?.index).toBe(AGENT_STREAM_INDEX);
      expect(snap?.model).toBe(`m-${id}`);
    }
  });

  test("单个子代理重试 clear → 只删自己那份，其余 5 份仍在跑（缺口 A 根治）", () => {
    for (const id of agentIds) {
      emitStreamPhase(AGENT_STREAM_INDEX, "fetch_sent", { caller: "sub-agent", model: "m" }, id);
    }

    clearStreamSnapshot(AGENT_STREAM_INDEX, undefined, agentIds[0]);

    expect(getActiveStreamSnapshots().length).toBe(5);
    expect(getStreamSnapshot(AGENT_STREAM_INDEX, undefined, agentIds[0])).toBeUndefined();
    // 关键断言：其余 5 路的活快照必须还在——否则看门狗读不到快照会误判
    for (const id of agentIds.slice(1)) {
      expect(getStreamSnapshot(AGENT_STREAM_INDEX, undefined, id)).toBeDefined();
    }
  });

  test("cleanupAgentSnapshots 清掉该 agent 全部轮次 → 全部结束后归零（teardown）", () => {
    // 每个子代理跑 3 轮 + 1 个总结轮（20000 命名空间）
    for (const id of agentIds) {
      for (const idx of [10001, 10002, 10003, 20003]) {
        emitStreamPhase(idx, "fetch_sent", { caller: "sub-agent", model: "m" }, id);
      }
    }
    expect(getActiveStreamSnapshots().length).toBe(24);

    // 逐个 teardown：每次应减少 4 份（该 agent 的全部轮次）
    cleanupAgentSnapshots(agentIds[0]);
    expect(getActiveStreamSnapshots().length).toBe(20);

    for (const id of agentIds.slice(1)) cleanupAgentSnapshots(id);
    // A5 判据：全部结束 teardown 后 = 0（没有 teardown 时这里会是 24，即无界增长）
    expect(getActiveStreamSnapshots().length).toBe(0);
  });

  test("teardown 不误伤其他 agent，也不误伤主循环无身份快照", () => {
    emitStreamPhase(5, "fetch_sent", { model: "main" });            // 主循环：无 agentId
    emitStreamPhase(10001, "fetch_sent", { model: "a" }, "agent-a");
    emitStreamPhase(10001, "fetch_sent", { model: "b" }, "agent-b");

    cleanupAgentSnapshots("agent-a");

    expect(getStreamSnapshot(10001, undefined, "agent-a")).toBeUndefined();
    expect(getStreamSnapshot(10001, undefined, "agent-b")).toBeDefined();
    // 主循环那份必须完好——teardown 只按身份匹配，绝不碰无身份 key
    expect(getStreamSnapshot(5)).toBeDefined();
    // 空 agentId 不得触发"清空所有"
    cleanupAgentSnapshots("");
    expect(getActiveStreamSnapshots().length).toBe(2);
  });

  test("主循环 key 逐字节不变：不传 agentId 时与改造前同一把 key", () => {
    emitStreamPhase(7, "fetch_sent", { model: "m" });
    // 三种读法（省略 loopId / 省略 agentId / 都省略）必须命中同一份
    expect(getStreamSnapshot(7)).toBeDefined();
    expect(getStreamSnapshot(7, undefined, undefined)).toBe(getStreamSnapshot(7));
    // 带身份读同一 index 读不到——证明两个命名空间确实隔离
    expect(getStreamSnapshot(7, undefined, "agent-x")).toBeUndefined();
  });

  test("emitTimeoutFired 按身份累积：子代理超时不污染主循环 timeoutsFired", () => {
    emitStreamPhase(10001, "sse_consuming", { model: "main" });                  // 主循环
    emitStreamPhase(10001, "sse_consuming", { model: "sub" }, "agent-a");        // 子代理

    emitTimeoutFired(10001, "fallback_stream_timeout", { threshold_ms: 1000 }, "agent-a");

    expect(getStreamSnapshot(10001, undefined, "agent-a")?.timeoutsFired)
      .toEqual(["fallback_stream_timeout"]);
    // 主循环那份必须仍为空——否则 reopenReason 会把子代理的超时安到主循环头上
    expect(getStreamSnapshot(10001)?.timeoutsFired).toEqual([]);
    // 事件侧带 agent_id 标签，供离线归因
    const fired = eventsOf("TimeoutFired");
    expect(fired.length).toBe(1);
    expect(fired[0].data.agent_id).toBe("agent-a");
  });

  test("StreamPhase 事件：带身份时含 agent_id，主循环事件形状不变", () => {
    emitStreamPhase(3, "fetch_sent", { model: "main" });
    emitStreamPhase(10001, "fetch_sent", { model: "sub" }, "agent-a");

    const evs = eventsOf("StreamPhase");
    expect(evs[0].data.agent_id).toBeUndefined();   // 主循环：不新增字段
    expect(evs[1].data.agent_id).toBe("agent-a");
  });

  test("心跳选取规则：多份活快照时主循环那份可被稳定区分（collector 消费契约）", () => {
    // B4 引入的下游影响：改造前 6 路子代理碰撞成 1 份，collector 心跳取 [0] 恒定
    // 就是那一份；隔离后同时存在多份，取 [0] 会随 Map 插入顺序随机指向某个子代理。
    // collector.ts 因此改为「优先无 agentId 的主循环快照，否则取最早开始的子代理」。
    // 这里钉住该规则依赖的两个前提：agentId 可判别、startedAt 可比较。
    emitStreamPhase(10001, "sse_consuming", { model: "sub-a" }, "agent-a");
    emitStreamPhase(10002, "sse_consuming", { model: "sub-b" }, "agent-b");
    emitStreamPhase(4, "sse_consuming", { model: "main" });     // 主循环最后插入

    const all = getActiveStreamSnapshots();
    expect(all.length).toBe(3);

    // 前提 1：主循环那份能被 agentId === undefined 唯一挑出（不依赖插入顺序）
    const mains = all.filter(s => s.agentId === undefined);
    expect(mains.length).toBe(1);
    expect(mains[0].model).toBe("main");

    // 前提 2：子代理快照都带得上身份，且 startedAt 可用于选最早那份
    const agents = all.filter(s => s.agentId !== undefined);
    expect(agents.length).toBe(2);
    expect(agents.every(s => typeof s.startedAt === "number")).toBe(true);
  });

  test("clearAllSnapshots 兜底覆盖子代理快照（漏 teardown 也不跨 loop 泄漏）", () => {
    const { loopId } = currentSseDumpContext();
    emitStreamPhase(10001, "fetch_sent", { model: "a" }, "agent-a");
    emitStreamPhase(10001, "fetch_sent", { model: "b" }, "agent-b");
    emitStreamPhase(5, "fetch_sent", { model: "main" });
    expect(getActiveStreamSnapshots().length).toBe(3);

    clearAllSnapshots(loopId);
    expect(getActiveStreamSnapshots().length).toBe(0);
  });
});

// ─── 辅助 ───
function inefFirst(list: Array<{ data: Record<string, unknown> }>) {
  return list[0].data as { layer: string; index: number; reason: string };
}
