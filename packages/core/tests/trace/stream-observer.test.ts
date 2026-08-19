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
      emitStreamPhase(
        AGENT_STREAM_INDEX,
        "fetch_sent",
        { caller: "sub-agent", model: `m-${id}` },
        id,
      );
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
    emitStreamPhase(5, "fetch_sent", { model: "main" }); // 主循环：无 agentId
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
    emitStreamPhase(10001, "sse_consuming", { model: "main" }); // 主循环
    emitStreamPhase(10001, "sse_consuming", { model: "sub" }, "agent-a"); // 子代理

    emitTimeoutFired(10001, "fallback_stream_timeout", { threshold_ms: 1000 }, "agent-a");

    expect(getStreamSnapshot(10001, undefined, "agent-a")?.timeoutsFired).toEqual([
      "fallback_stream_timeout",
    ]);
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
    expect(evs[0].data.agent_id).toBeUndefined(); // 主循环：不新增字段
    expect(evs[1].data.agent_id).toBe("agent-a");
  });

  test("心跳选取规则：多份活快照时主循环那份可被稳定区分（collector 消费契约）", () => {
    // B4 引入的下游影响：改造前 6 路子代理碰撞成 1 份，collector 心跳取 [0] 恒定
    // 就是那一份；隔离后同时存在多份，取 [0] 会随 Map 插入顺序随机指向某个子代理。
    // collector.ts 因此改为「优先无 agentId 的主循环快照，否则取最早开始的子代理」。
    // 这里钉住该规则依赖的两个前提：agentId 可判别、startedAt 可比较。
    emitStreamPhase(10001, "sse_consuming", { model: "sub-a" }, "agent-a");
    emitStreamPhase(10002, "sse_consuming", { model: "sub-b" }, "agent-b");
    emitStreamPhase(4, "sse_consuming", { model: "main" }); // 主循环最后插入

    const all = getActiveStreamSnapshots();
    expect(all.length).toBe(3);

    // 前提 1：主循环那份能被 agentId === undefined 唯一挑出（不依赖插入顺序）
    const mains = all.filter((s) => s.agentId === undefined);
    expect(mains.length).toBe(1);
    expect(mains[0].model).toBe("main");

    // 前提 2：子代理快照都带得上身份，且 startedAt 可用于选最早那份
    const agents = all.filter((s) => s.agentId !== undefined);
    expect(agents.length).toBe(2);
    expect(agents.every((s) => typeof s.startedAt === "number")).toBe(true);
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

// ═══════════════════════════════════════════════════════════════════
// P2 · StreamPhase.attempt —— 修 `(session, index)` 非唯一键
//
// 背景（方案 §0.1c）：重试复用同一 index，实测某会话 index=4 下有 7 组完整 phase
// 序列。没有 attempt 时，dict 式配对会把第 1 次 attempt 的 ttfb 配到第 7 次的 ttft 上，
// 且"负值 0 条"不构成自洽性证明（后一次的 ttft 通常比前一次的 ttfb 大，错配不产生负值）。
// ═══════════════════════════════════════════════════════════════════
describe("StreamPhase.attempt（P2 · 唯一键修复）", () => {
  const phasesOf = () => eventsOf("StreamPhase").map((e) => e.data as Record<string, unknown>);

  test("单次 fetch 的完整 phase 序列共享同一个 attempt", () => {
    emitStreamPhase(4, "fetch_sent", { model: "m" });
    emitStreamPhase(4, "headers_received", { ttfb_ms: 100, model: "m" });
    emitStreamPhase(4, "first_content", { ttft_ms: 900, model: "m" });
    emitStreamPhase(4, "completed", { model: "m" });

    expect(phasesOf().map((d) => d.attempt)).toEqual([1, 1, 1, 1]);
  });

  test("openai 形态：fetch_sent 进位，同 index 的 7 次重试拿到 1..7", () => {
    for (let i = 0; i < 7; i++) {
      emitStreamPhase(4, "fetch_sent", { model: "m" });
      emitStreamPhase(4, "headers_received", { ttfb_ms: 10 * i, model: "m" });
    }
    const headers = phasesOf().filter((d) => d.phase === "headers_received");
    expect(headers.map((d) => d.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("anthropic 形态：无 fetch_sent，靠重复的 headers_received 换代", () => {
    // anthropic.ts 全仓只有 headers_received 与 first_content 两个 emit 点，
    // 没有 fetch_sent —— 不认这个换代信号则 attempt 会永远停在 1。
    emitStreamPhase(4, "headers_received", { ttfb_ms: 50, model: "claude" });
    emitStreamPhase(4, "first_content", { ttft_ms: 800, model: "claude" });
    emitStreamPhase(4, "headers_received", { ttfb_ms: 60, model: "claude" });
    emitStreamPhase(4, "first_content", { ttft_ms: 900, model: "claude" });

    expect(phasesOf().map((d) => d.attempt)).toEqual([1, 1, 2, 2]);
  });

  test("★ 重试前的 clearStreamSnapshot 不得重置 attempt（本实现的要害）", () => {
    // 快照在每次重试前被主动清掉（loop.ts:2588 等，防看门狗误杀）。若 attempt 计数
    // 挂在快照上，就会跟着归零 —— 同一 (session,index) 下出现两个 attempt=1，
    // 键仍不唯一却"看起来像唯一"，比没有这个字段更糟。
    emitStreamPhase(4, "fetch_sent", { model: "m" });
    emitStreamPhase(4, "headers_received", { ttfb_ms: 100, model: "m" });

    clearStreamSnapshot(4); // ← 重试前的真实调用

    emitStreamPhase(4, "fetch_sent", { model: "m" });
    emitStreamPhase(4, "headers_received", { ttfb_ms: 200, model: "m" });

    const attempts = phasesOf().map((d) => d.attempt);
    expect(attempts).toEqual([1, 1, 2, 2]);
    // 判据的核心：清快照后**不允许**再出现一个 attempt=1
    expect(attempts.filter((a) => a === 1).length).toBe(2);
  });

  test("主循环与子代理各自独立计数（共享 index 空间不串号）", () => {
    emitStreamPhase(10001, "fetch_sent", { model: "a" }, "agent-a");
    emitStreamPhase(10001, "fetch_sent", { model: "a" }, "agent-a");
    emitStreamPhase(10001, "fetch_sent", { model: "b" }, "agent-b");

    const byAgent = phasesOf().filter((d) => d.agent_id === "agent-a");
    expect(byAgent.map((d) => d.attempt)).toEqual([1, 2]);
    expect(phasesOf().filter((d) => d.agent_id === "agent-b")[0].attempt).toBe(1);
  });

  test("调用方显式传入的 attempt 优先于推导值（agentic-loop 已在传）", () => {
    // agent/agentic-loop.ts 的 onRetry 拿得到 fallback.ts 的权威 attempt，
    // 那边传什么就落什么，本模块的推导只是兜底。两者同源，不是两套口径。
    emitStreamPhase(10001, "fetch_sent", { model: "m", attempt: 0 }, "agent-a");
    emitStreamPhase(10001, "fetch_sent", { model: "m", attempt: 3 }, "agent-a");

    expect(phasesOf().map((d) => d.attempt)).toEqual([0, 3]);
  });

  test("首个事件不是开场 phase 时归入 attempt=1，而不是 0", () => {
    // 老轨迹 / emit 失败漏了开场时：0 会被读成"第 0 次尝试"，
    // 而事实是"至少发生过一次尝试，只是没观测到开场"。
    emitStreamPhase(4, "first_content", { ttft_ms: 700, model: "m" });
    expect(phasesOf()[0].attempt).toBe(1);
  });

  test("clearAllSnapshots 后同 index 从 1 重新开始（loop 收尾即生命周期终点）", () => {
    const { loopId } = currentSseDumpContext();
    emitStreamPhase(4, "fetch_sent", { model: "m" });
    emitStreamPhase(4, "fetch_sent", { model: "m" });
    clearAllSnapshots(loopId);
    emitStreamPhase(4, "fetch_sent", { model: "m" });

    expect(phasesOf().map((d) => d.attempt)).toEqual([1, 2, 1]);
  });
});

// ─── 辅助 ───
function inefFirst(list: Array<{ data: Record<string, unknown> }>) {
  return list[0].data as { layer: string; index: number; reason: string };
}
