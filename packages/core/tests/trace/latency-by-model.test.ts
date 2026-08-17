/**
 * latency-by-model.test.ts —— TTFT/TTFB 按 model 分组（§0.1b · 跨网关路由不可比）
 *
 * 核心断言是**反假结论**的：同一 provider 下两条网关路由必须各出一行，
 * 且各自的 TTFB 不被平均掉。这里刻意用实测数据的形状构造样本
 *（`deepseek-v4-pro` ttfb≈484ms/ttft≈3983ms 与 `origin-deepseek-v4-pro`
 * ttfb≈3151ms/ttft≈3329ms），保证测的是真实缺陷而不是想象出来的形状。
 *
 * ⚠️ 变异自证（[[static-scan-misses-indirect-disk-writes]]：新增门禁必做）：
 * 最后一个 describe 把"退回按 provider 汇总"的旧行为显式算出来，断言它确实
 * 产出那个假数（2665ms 量级）—— 若某天有人把实现改回汇总，前面的断言会红，
 * 而这一条证明它们红得有理由。
 */
import { describe, test, expect } from "bun:test";
import {
  aggregateLatencyByModel,
  formatModelLatencyLine,
  ROUTE_BUFFERING_GAP_THRESHOLD,
  type ModelLatencyStats,
} from "@sid-code/core/trace/latency-by-model.ts";
import { percentile } from "@sid-code/core/trace/digest.ts";

/** 造一对 headers_received + first_content 事件（同 index，模拟一次 fetch） */
function fetchPair(
  session: string,
  index: number,
  model: string,
  ttfb: number,
  ttft: number,
  agentId?: string,
) {
  const base = (phase: string, extra: Record<string, unknown>) => ({
    event: "StreamPhase",
    session_id: session,
    data: { index, phase, model, ...(agentId ? { agent_id: agentId } : {}), ...extra },
  });
  return [base("headers_received", { ttfb_ms: ttfb }), base("first_content", { ttft_ms: ttft })];
}

/** 全部走 openai —— 本文件要测的正是"同 provider 内不同路由"这个场景 */
const asOpenai = (model: string) => (model.includes("claude") ? "anthropic" : "openai");

describe("§0.1b：同 provider 下的不同网关路由必须分开出数", () => {
  // 实测形状：两个 model 是同一底层模型走不同网关，且同属 provider openai
  const events = [
    // 抢先回 header 的路由：握手极快，之后干等（gap≈88%）
    ...fetchPair("s1", 0, "deepseek-v4-pro", 484, 3983),
    ...fetchPair("s1", 1, "deepseek-v4-pro", 500, 4000),
    ...fetchPair("s1", 2, "deepseek-v4-pro", 470, 3900),
    // 不缓冲的路由：header 与首字几乎同时（gap≈5%）
    ...fetchPair("s2", 0, "origin-deepseek-v4-pro", 3151, 3329),
    ...fetchPair("s2", 1, "origin-deepseek-v4-pro", 3100, 3300),
    ...fetchPair("s2", 2, "origin-deepseek-v4-pro", 3200, 3350),
  ];

  const stats = aggregateLatencyByModel(events, asOpenai, percentile);

  test("两条路由各成一行，不被合并成一个 provider 级数字", () => {
    expect([...stats.keys()].sort()).toEqual(["deepseek-v4-pro", "origin-deepseek-v4-pro"]);
    // 两行的 provider 相同 —— 这正是"按 provider 聚合会合并"的成因
    expect(stats.get("deepseek-v4-pro")!.provider).toBe("openai");
    expect(stats.get("origin-deepseek-v4-pro")!.provider).toBe("openai");
  });

  test("各路由的 TTFB 保持本路由真值，不被跨路由平均", () => {
    // 抢先回 header 那条：真值 484ms 量级，绝不能是两条路由的中间值
    expect(stats.get("deepseek-v4-pro")!.ttfb_p50).toBe(484);
    // 不缓冲那条：真值 3151ms 量级
    expect(stats.get("origin-deepseek-v4-pro")!.ttfb_p50).toBe(3151);
    // 两者相差近 7 倍 —— 合并后无论取哪个都在描述"另一条路由不存在"
    expect(stats.get("origin-deepseek-v4-pro")!.ttfb_p50!).toBeGreaterThan(
      stats.get("deepseek-v4-pro")!.ttfb_p50! * 6,
    );
  });

  test("gapRatio 是路由缓冲指纹：抢先回 header 的那条超过判据阈值", () => {
    const buffered = stats.get("deepseek-v4-pro")!;
    const direct = stats.get("origin-deepseek-v4-pro")!;
    expect(buffered.gapRatioP50!).toBeGreaterThan(ROUTE_BUFFERING_GAP_THRESHOLD);
    expect(direct.gapRatioP50!).toBeLessThan(ROUTE_BUFFERING_GAP_THRESHOLD);
    // 量级校验：实测两者差 17 倍，这里构造的样本应保持同一数量级差距
    expect(buffered.gapRatioP50! / direct.gapRatioP50!).toBeGreaterThan(10);
  });

  test("TTFT 与样本数逐 model 独立", () => {
    expect(stats.get("deepseek-v4-pro")!.n).toBe(3);
    expect(stats.get("origin-deepseek-v4-pro")!.n).toBe(3);
    expect(stats.get("deepseek-v4-pro")!.ttft_p50).toBe(3983);
  });
});

describe("配对规则：按时间序，不按 (session, index)", () => {
  test("同 index 下的多次重试各自配对，不跨 attempt 错配", () => {
    // 实测形态：index=4 下有多组完整 phase 序列（重试复用同一 index）
    const events = [
      ...fetchPair("s1", 4, "m1", 100, 1000), // attempt 1
      ...fetchPair("s1", 4, "m1", 200, 2000), // attempt 2
      ...fetchPair("s1", 4, "m1", 300, 3000), // attempt 3
    ];
    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.n).toBe(3);
    expect(s.unpairedHeaders).toBe(0);
    // 错配的判据：若 attempt1 的 ttfb(100) 配到 attempt3 的 ttft(3000)，
    // gap 会是 96.7%；正确配对下三次 gap 都是 90%
    expect(s.gapRatioP50!).toBeCloseTo(0.9, 2);
  });

  test("headers 没等到 first_content（重试/中断）计入 unpairedHeaders，不硬凑", () => {
    const events = [
      // 一次中断的 fetch：只有 headers
      {
        event: "StreamPhase",
        session_id: "s1",
        data: { index: 0, phase: "headers_received", model: "m1", ttfb_ms: 100 },
      },
      // 紧接着重试成功
      ...fetchPair("s1", 0, "m1", 200, 2000),
    ];
    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.unpairedHeaders).toBe(1);
    expect(s.n).toBe(1);
    // 关键：被配走的必须是重试那次的 ttfb(200)，不是中断那次的 100
    expect(s.ttfb_p50).toBe(200);
  });

  test("会话末尾悬空的 headers（kill/error）也计入未配对", () => {
    const events = [
      ...fetchPair("s1", 0, "m1", 100, 1000),
      {
        event: "StreamPhase",
        session_id: "s1",
        data: { index: 1, phase: "headers_received", model: "m1", ttfb_ms: 999 },
      },
    ];
    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.n).toBe(1);
    expect(s.unpairedHeaders).toBe(1);
    expect(s.ttfb_p50).toBe(100); // 悬空那条的 999 不得进分位数
  });

  test("分组键含 agent_id：子代理与主循环共享 index 空间不得互配", () => {
    // 交错顺序是关键：主循环与子代理同 session 同 index，两个 headers 相邻。
    // 键不含 agent_id 时，子代理的 headers 会把主循环那个挤掉（判成中断），
    // 于是主循环的 first_content 找不到配对 → 少一个 TTFB 样本 + 多一个未闭合。
    const mainPair = fetchPair("s1", 0, "m1", 100, 1000);
    const subPair = fetchPair("s1", 0, "m1", 5000, 6000, "sub-1");
    const events = [mainPair[0]!, subPair[0]!, subPair[1]!, mainPair[1]!];

    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.n).toBe(2);
    // 这两条是判据：不含 agent_id 时分别是 1 和 undefined→只剩 5000 一个样本
    expect(s.unpairedHeaders).toBe(0);
    expect(s.ttfb_p50).toBe(100);
    // 两条 gap（主循环 90%、子代理 16.7%）都在，说明两次都正确配上了
    expect(s.gapRatioP50).toBeCloseTo(0.1667, 3);
    expect(s.gapRatioP95).toBeCloseTo(0.9, 3);
  });

  test("跨会话不互配（同 index 不同 session）", () => {
    const events = [
      {
        event: "StreamPhase",
        session_id: "sA",
        data: { index: 0, phase: "headers_received", model: "m1", ttfb_ms: 100 },
      },
      {
        event: "StreamPhase",
        session_id: "sB",
        data: { index: 0, phase: "first_content", model: "m1", ttft_ms: 9000 },
      },
    ];
    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.n).toBe(1); // ttft 仍计入（它自身有效）
    expect(s.unpairedHeaders).toBe(1); // 但 sA 的 headers 不许配给 sB
    expect(s.ttfb_p50).toBeUndefined(); // 无合法配对 → 不给 TTFB
  });
});

describe("无样本时不落假数（0 会被读成「0 毫秒」）", () => {
  test("老轨迹只有 first_content、没有 headers_received → TTFB 全 undefined", () => {
    const events = [
      {
        event: "StreamPhase",
        session_id: "s1",
        data: { index: 0, phase: "first_content", model: "m1", ttft_ms: 1000 },
      },
    ];
    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.n).toBe(1);
    expect(s.ttft_p50).toBe(1000);
    expect(s.ttfb_p50).toBeUndefined();
    expect(s.gapRatioP50).toBeUndefined();
  });

  test("ttft<=0 或 model 缺失的事件被丢弃，且不留悬空 pending", () => {
    const events = [
      {
        event: "StreamPhase",
        session_id: "s1",
        data: { index: 0, phase: "headers_received", model: "m1", ttfb_ms: 100 },
      },
      {
        event: "StreamPhase",
        session_id: "s1",
        data: { index: 0, phase: "first_content", model: "m1", ttft_ms: 0 },
      },
      // 下一次 fetch 必须能正常配对（上一个 pending 已让位）
      ...fetchPair("s1", 0, "m1", 700, 7000),
    ];
    const s = aggregateLatencyByModel(events, asOpenai, percentile).get("m1")!;
    expect(s.n).toBe(1);
    expect(s.ttfb_p50).toBe(700);
    expect(s.unpairedHeaders).toBe(1);
  });

  test("非 StreamPhase 事件与其他 phase 一律忽略", () => {
    const events = [
      { event: "AfterModelRaw", data: { provider: "openai", model: "m1", elapsed_ms: 5000 } },
      { event: "StreamPhase", session_id: "s1", data: { index: 0, phase: "completed" } },
      { event: "StreamPhase", session_id: "s1", data: { index: 0, phase: "fetch_sent" } },
    ];
    expect(aggregateLatencyByModel(events, asOpenai, percentile).size).toBe(0);
  });
});

describe("渲染：TTFB 必须与 gap 同行，超阈值显式点破", () => {
  const make = (over: Partial<ModelLatencyStats> = {}): ModelLatencyStats => ({
    provider: "openai",
    n: 3,
    ttft_p50: 3983,
    ttfb_p50: 484,
    gapRatioP50: 0.8785,
    unpairedHeaders: 0,
    ...over,
  });

  test("gap 超阈值时点明「网关抢先回 header」", () => {
    const line = formatModelLatencyLine("deepseek-v4-pro", make());
    expect(line).toContain("TTFB P50=0.5s");
    expect(line).toContain("88%");
    expect(line).toContain("网关抢先回 header");
  });

  test("gap 未超阈值时只给比值，不加告警措辞", () => {
    const line = formatModelLatencyLine("origin-deepseek-v4-pro", make({ gapRatioP50: 0.05 }));
    expect(line).toContain("缓冲 5%");
    expect(line).not.toContain("网关抢先回 header");
  });

  test("无 TTFB 样本时整段省略，不显示 0.0s", () => {
    const line = formatModelLatencyLine(
      "m1",
      make({ ttfb_p50: undefined, gapRatioP50: undefined }),
    );
    expect(line).not.toContain("TTFB");
    expect(line).not.toContain("0.0s");
    expect(line).toContain("TTFT P50=4.0s");
  });

  test("unpairedHeaders 写出来但措辞中性（重试/中断是预期行为）", () => {
    const line = formatModelLatencyLine("m1", make({ unpairedHeaders: 4 }));
    expect(line).toContain("未闭合 4");
    expect(line).toContain("重试/中断");
  });
});

describe("变异自证：证明旧的「按 provider 汇总」确实产出假数", () => {
  test("跨路由汇总 TTFB 既不描述路由 A 也不描述路由 B", () => {
    // 用实测比例构造：231 次抢先回 header 的 + 99 次不缓冲的
    const events = [
      ...Array.from({ length: 231 }, (_, i) =>
        fetchPair("s1", i, "deepseek-v4-pro", 484, 3983),
      ).flat(),
      ...Array.from({ length: 99 }, (_, i) =>
        fetchPair("s2", i, "origin-deepseek-v4-pro", 3151, 3329),
      ).flat(),
    ];
    const stats = aggregateLatencyByModel(events, asOpenai, percentile);

    // 分组后：两条路由各自真值
    expect(stats.get("deepseek-v4-pro")!.ttfb_p50).toBe(484);
    expect(stats.get("origin-deepseek-v4-pro")!.ttfb_p50).toBe(3151);

    // 现在手算"如果退回按 provider 汇总"会得到什么 —— 这就是本 PR 要消灭的数
    const allTtfbs = [...Array(231).fill(484), ...Array(99).fill(3151)].sort((a, b) => a - b);
    const merged = percentile(allTtfbs, 0.5)!;
    // 汇总值等于其中一条路由的值（多数派），于是少数派那条路由被彻底抹掉 ——
    // 无论落在哪一侧，它都在描述"另一条路由不存在"，这正是假结论的形态
    expect(merged).toBe(484);
    expect(merged).not.toBe(stats.get("origin-deepseek-v4-pro")!.ttfb_p50);

    // 而 p95 会落到另一侧，于是同一个 provider 的 p50/p95 描述的是两条不同的路由 ——
    // 这个数对（484, 3151）读起来像"尾部慢"，实际是"两条路由"
    expect(percentile(allTtfbs, 0.95)!).toBe(3151);
  });
});
