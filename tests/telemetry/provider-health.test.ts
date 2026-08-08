/**
 * T15.6：Provider 健康度聚合单测
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateProviderHealth, renderHealthText } from "../../src/telemetry/provider-health.ts";

describe("T15: Provider 健康度聚合", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sid-t15-"));
    sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, events: object[]): void {
    const dir = join(sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(dir, "events.jsonl"), content);
  }

  it("从多个会话聚合 provider 健康指标", () => {
    const now = new Date().toISOString();
    // P0-1：TTFT 现取自 StreamPhase("first_content")（纯净首内容延迟），不再从 AfterModelRaw.ttft_ms 取。
    // first_content 只带 model，经 AfterModelRaw 的 model→provider 映射归因。
    writeSession("session-001", [
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 5000, model: "deepseek" } },
      { event: "StreamPhase", timestamp: now, data: { phase: "first_content", model: "deepseek", ttft_ms: 2000 } },
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 3000, model: "deepseek" } },
      { event: "StreamPhase", timestamp: now, data: { phase: "first_content", model: "deepseek", ttft_ms: 1000 } },
      { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", elapsed_ms: 2000, model: "claude" } },
      { event: "StreamPhase", timestamp: now, data: { phase: "first_content", model: "claude", ttft_ms: 800 } },
    ]);
    writeSession("session-002", [
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 4000, model: "deepseek" } },
      { event: "StreamPhase", timestamp: now, data: { phase: "first_content", model: "deepseek", ttft_ms: 1500 } },
      { event: "RetryTelemetry", timestamp: now, data: { type: "retry", provider: "openai", model: "deepseek" } },
      { event: "RetryTelemetry", timestamp: now, data: { type: "stream_idle_timeout", provider: "openai" } },
    ]);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });

    expect(report.providers.length).toBe(2);

    const openai = report.providers.find(p => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.requests.total).toBe(3);
    expect(openai!.requests.retried).toBe(1);
    expect(openai!.requests.timedOut).toBe(1);
    // TTFT P50: 排序后 [1000, 1500, 2000]，P50 = 1500
    expect(openai!.latency.ttft_p50).toBe(1500);
    // TTFT P95: [1000, 1500, 2000]，P95 = index ceil(3*0.95)-1 = 2 → 2000
    expect(openai!.latency.ttft_p95).toBe(2000);

    const anthropic = report.providers.find(p => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.requests.total).toBe(1);
    expect(anthropic!.latency.ttft_p50).toBe(800);
  });

  it("按 provider 过滤", () => {
    const now = new Date().toISOString();
    writeSession("session-003", [
      { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 3000 } },
      { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", elapsed_ms: 2000 } },
    ]);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir, provider: "anthropic" });
    expect(report.providers.length).toBe(1);
    expect(report.providers[0].provider).toBe("anthropic");
    expect(report.providers[0].requests.total).toBe(1);
  });

  it("成功率 < 95% 时生成 warning 告警", () => {
    const now = new Date().toISOString();
    // 10 个请求中 1 个超时 = 90% 成功率
    const events: object[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ event: "AfterModelRaw", timestamp: now, data: { provider: "openai", elapsed_ms: 3000 } });
    }
    events.push({ event: "RetryTelemetry", timestamp: now, data: { type: "stream_idle_timeout", provider: "openai" } });

    writeSession("session-004", events);
    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });

    const openai = report.providers.find(p => p.provider === "openai");
    expect(openai!.requests.timedOut).toBe(1);
    // 成功率 = (10-0-1)/10 = 90% < 95% → warning
    expect(report.alerts.length).toBeGreaterThan(0);
    expect(report.alerts.some(a => a.severity === "warning" && a.message.includes("成功率"))).toBe(true);
  });

  it("无数据时返回空报告", () => {
    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    expect(report.providers.length).toBe(0);
    expect(report.alerts.length).toBe(0);
  });

  it("P50/P95/P99 计算精度", () => {
    const now = new Date().toISOString();
    // 构造 100 个请求，TTFT 从 100 到 10000（P0-1：TTFT 走 first_content 事件）
    const events: object[] = [];
    for (let i = 1; i <= 100; i++) {
      events.push({ event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: i * 100 } });
      events.push({ event: "StreamPhase", timestamp: now, data: { phase: "first_content", model: "deepseek", ttft_ms: i * 100 } });
    }
    writeSession("session-005", events);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    const openai = report.providers.find(p => p.provider === "openai");
    expect(openai).toBeDefined();
    // P50 ~ 5000 (index 49)
    expect(openai!.latency.ttft_p50).toBe(5000);
    // P95 ~ 9500 (index 94)
    expect(openai!.latency.ttft_p95).toBe(9500);
    // P99 ~ 9900 (index 98)
    expect(openai!.latency.ttft_p99).toBe(9900);
  });

  // T15.5：/trace --health 复用的纯文本渲染器
  it("renderHealthText: 纯文本看板含 provider/成功率, 无 ANSI 码", () => {
    const now = new Date().toISOString();
    const events: object[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({ event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 2000 } });
    }
    writeSession("session-render", events);

    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    const text = renderHealthText(report);

    expect(text).toContain("Provider 健康度");
    expect(text).toContain("openai");
    expect(text).toContain("%"); // 成功率
    // 命令面板固定纯文本：不得含 ANSI 转义序列
    expect(/\x1b\[/.test(text)).toBe(false);
  });

  it("renderHealthText: 无数据时给出提示而非崩溃", () => {
    const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
    const text = renderHealthText(report);
    expect(text).toContain("无数据");
  });

  /**
   * P2-3：TTFT × 缓存命中分桶。
   *
   * ⚠️ 这组用例是**补的回归网**：方案 §P2-3 明写"消费侧 digest.ts 与
   * provider-health.ts 两处必须同步改（刻意同口径）"，但第一版只改了 digest，
   * 本文件此前对 `ttftByCache` **零断言** —— 于是漏改在两个入口都不可见地存在了一天，
   * 而验收表与博客都写着"`trace-digest --health` 输出 hit/miss 两组分位数"。
   *
   * **教训："两处必须同口径"这种约束只靠注释是拦不住的，得有一条测试站在两边。**
   * 下面最后一个用例就是那条对账测试。
   */
  describe("P2-3 TTFT 缓存分桶", () => {
    const now = new Date().toISOString();

    it("Anthropic 族：first_content 自带 cache_hit → 直接分桶，零配对风险", () => {
      writeSession("s-anthropic", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", model: "claude", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-anthropic", data: { phase: "first_content", index: 1, model: "claude", ttft_ms: 800, cache_hit: true, cache_read: 4096 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-anthropic", data: { phase: "first_content", index: 2, model: "claude", ttft_ms: 2400, cache_hit: false, cache_read: 0 } },
      ]);

      const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
      const anthropic = report.providers.find((p) => p.provider === "anthropic")!;
      expect(anthropic.latency.ttftByCache).toBeDefined();
      expect(anthropic.latency.ttftByCache!.hit.count).toBe(1);
      expect(anthropic.latency.ttftByCache!.hit.p50).toBe(800);
      expect(anthropic.latency.ttftByCache!.miss.count).toBe(1);
      expect(anthropic.latency.ttftByCache!.miss.p50).toBe(2400);
      // 自带维度 → 不该有任何弃用/空档
      expect(anthropic.latency.ttftBucketDropped).toBeUndefined();
      expect(anthropic.latency.ttftNoDimension).toBeUndefined();
    });

    it("OpenAI 族：维度在 completed 上，同组数量相等时按顺序配对", () => {
      writeSession("s-openai", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-openai", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 1200 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-openai", data: { phase: "completed", index: 1, model: "deepseek", cache_hit: true, cache_read: 8192 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-openai", data: { phase: "first_content", index: 2, model: "deepseek", ttft_ms: 3600 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-openai", data: { phase: "completed", index: 2, model: "deepseek", cache_hit: false, cache_read: 0 } },
      ]);

      const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
      const openai = report.providers.find((p) => p.provider === "openai")!;
      expect(openai.latency.ttftByCache!.hit.p50).toBe(1200);
      expect(openai.latency.ttftByCache!.miss.p50).toBe(3600);
      expect(openai.latency.ttftBucketDropped).toBeUndefined();
    });

    it("★ 数量不等 → 整组弃用而不是猜（猜错会反转\"缓存是否更快\"的结论）", () => {
      // 同一 (session,index) 里 2 条 first_content 只有 1 条 completed：
      // 说明有一次 fetch 没走到 completed（超时/abort/error）。
      // 任何配法都可能把 A 次的 ttft 配到 B 次的命中状态上 → 宁可整组丢。
      writeSession("s-mismatch", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-mismatch", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 1000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-mismatch", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 9000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-mismatch", data: { phase: "completed", index: 1, model: "deepseek", cache_hit: true, cache_read: 4096 } },
      ]);

      const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
      const openai = report.providers.find((p) => p.provider === "openai")!;
      // 两桶都空 → 整个字段不落（不是落一个 count 全 0 的结构）
      expect(openai.latency.ttftByCache).toBeUndefined();
      expect(openai.latency.ttftBucketDropped).toBe(2);
      // 有带维度的 completed，所以这是真的配对失败，不是历史空档
      expect(openai.latency.ttftNoDimension).toBeUndefined();
    });

    it("★ 老轨迹（completed 不带 cache_hit）记入 noDimension，不混进 dropped", () => {
      // cache_hit 维度 2026-08-08 才上线。之前的轨迹一条都没有这个字段。
      // 把它算进 dropped 会让"这批数据还没有这个维度"显示成"命中状态无法判定"，
      // 读起来像埋点坏了 —— 实测本机 7 天窗口 512 个样本全属此类。
      writeSession("s-legacy", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-legacy", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 1500 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-legacy", data: { phase: "completed", index: 1, model: "deepseek", chunks: 42 } },
      ]);

      const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
      const openai = report.providers.find((p) => p.provider === "openai")!;
      expect(openai.latency.ttftNoDimension).toBe(1);
      expect(openai.latency.ttftBucketDropped).toBeUndefined();
      // 总 TTFT 仍照常统计 —— 分桶失败不该让样本从 p50 里消失
      expect(openai.latency.ttft_p50).toBe(1500);
    });

    it("跨会话不串味：同 index 不同 session 不得互相配对", () => {
      // 本聚合器跨多个会话读 events.jsonl。分组键不含 session_id 时，
      // A 会话 index=1 的 ttft 会配到 B 会话 index=1 的命中状态上。
      writeSession("s-a", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-a", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 500 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-a", data: { phase: "completed", index: 1, model: "deepseek", cache_hit: true } },
      ]);
      writeSession("s-b", [
        { event: "StreamPhase", timestamp: now, session_id: "s-b", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 7000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-b", data: { phase: "completed", index: 1, model: "deepseek", cache_hit: false } },
      ]);

      const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
      const openai = report.providers.find((p) => p.provider === "openai")!;
      // 正确：500 进命中桶、7000 进未命中桶。串味则会得到相反结论（"缓存更慢"）
      expect(openai.latency.ttftByCache!.hit.p50).toBe(500);
      expect(openai.latency.ttftByCache!.miss.p50).toBe(7000);
      expect(openai.latency.ttftBucketDropped).toBeUndefined();
    });

    it("子代理不串味：同 session 同 index 但 agent_id 不同要分开配对", () => {
      // stream-observer.ts 的 B4 注释：子代理与主循环共享 index 空间。
      writeSession("s-agent", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-agent", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 600 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-agent", data: { phase: "completed", index: 1, model: "deepseek", cache_hit: true } },
        { event: "StreamPhase", timestamp: now, session_id: "s-agent", data: { phase: "first_content", index: 1, agent_id: "sub-1", model: "deepseek", ttft_ms: 8000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-agent", data: { phase: "completed", index: 1, agent_id: "sub-1", model: "deepseek", cache_hit: false } },
      ]);

      const report = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir });
      const openai = report.providers.find((p) => p.provider === "openai")!;
      expect(openai.latency.ttftByCache!.hit.p50).toBe(600);
      expect(openai.latency.ttftByCache!.miss.p50).toBe(8000);
      // 不分 agent 会让这两条落进同一组 → 数量对得上但配错（2 vs 2），
      // 得到"命中 600/8000 混在一起"的假分桶。分开后各组 1:1 且无弃用。
      expect(openai.latency.ttftBucketDropped).toBeUndefined();
    });

    it("renderHealthText: 分桶行渲染，且两桶都有样本才给差值", () => {
      writeSession("s-render-bucket", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", model: "claude", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-render-bucket", data: { phase: "first_content", index: 1, model: "claude", ttft_ms: 1000, cache_hit: true } },
        { event: "StreamPhase", timestamp: now, session_id: "s-render-bucket", data: { phase: "first_content", index: 2, model: "claude", ttft_ms: 3000, cache_hit: false } },
      ]);

      const text = renderHealthText(aggregateProviderHealth({ periodMs: 3600_000, sessionsDir }));
      expect(text).toContain("TTFT 命中:1.0s(n=1)");
      expect(text).toContain("未命中:3.0s(n=1)");
      expect(text).toContain("提速 2.0s");
      // 命令面板固定纯文本
      expect(/\x1b\[/.test(text)).toBe(false);
    });

    it("renderHealthText: 单侧无样本时明确说\"不给差值\"，不拿空气做对照", () => {
      writeSession("s-one-side", [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "anthropic", model: "claude", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-one-side", data: { phase: "first_content", index: 1, model: "claude", ttft_ms: 1000, cache_hit: true } },
      ]);

      const text = renderHealthText(aggregateProviderHealth({ periodMs: 3600_000, sessionsDir }));
      expect(text).toContain("未命中:无样本");
      expect(text).toContain("不给差值");
      expect(text).not.toContain("提速");
    });

    /**
     * 对账测试：`provider-health` 与 `digest` 必须对同一份事件给出同一个分桶结论。
     *
     * 这条测试的存在本身就是修复的一部分：两处"刻意同口径"此前只写在注释里，
     * 没有任何机制保证。现在两边都走 `ttft-cache-buckets.ts`，这里再站一道 ——
     * 将来谁把其中一处的逻辑改成第二份实现，这条会红。
     */
    it("★ 与 digest.aggregateProviderStats 同口径（对账，防止再次只改一处）", async () => {
      const { aggregateProviderStats } = await import("../../src/trace/digest.ts");
      const events = [
        { event: "AfterModelRaw", timestamp: now, data: { provider: "openai", model: "deepseek", elapsed_ms: 3000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "first_content", index: 1, model: "deepseek", ttft_ms: 1100 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "completed", index: 1, model: "deepseek", cache_hit: true } },
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "first_content", index: 2, model: "deepseek", ttft_ms: 4200 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "completed", index: 2, model: "deepseek", cache_hit: false } },
        // 一组数量不等的，确保 dropped 也参与对账
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "first_content", index: 3, model: "deepseek", ttft_ms: 2000 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "first_content", index: 3, model: "deepseek", ttft_ms: 2100 } },
        { event: "StreamPhase", timestamp: now, session_id: "s-x", data: { phase: "completed", index: 3, model: "deepseek", cache_hit: true } },
      ];
      writeSession("s-x", events);

      const health = aggregateProviderHealth({ periodMs: 3600_000, sessionsDir })
        .providers.find((p) => p.provider === "openai")!;
      const dig = aggregateProviderStats(events).find((p) => p.provider === "openai")!;

      expect(health.latency.ttftByCache).toEqual(dig.ttftByCache);
      expect(health.latency.ttftBucketDropped).toBe(dig.ttftBucketDropped);
      expect(health.latency.ttftNoDimension).toBe(dig.ttftNoDimension);
      // 断言这次对账不是"两边都是 undefined"的空对账
      expect(dig.ttftByCache).toBeDefined();
      expect(dig.ttftBucketDropped).toBe(2);
    });
  });
});
