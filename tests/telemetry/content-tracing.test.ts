/**
 * 内容级 tracing（缺陷清单 P1-5）+ Feature Flag 真实消费者（P1-9）测试
 *
 * 测试锁的是**不变量**，不是实现细节。四组不变量对应清单原文的四个设计点：
 *
 *   1. 默认必须关闭（内容级数据的隐私敏感度与常规遥测完全不同）
 *   2. 同一内容全文只发一次（漏掉去重，功能会因成本过高被迫再关掉）
 *   3. 截断上限按**字节**封顶（中文 prompt 是本仓库常态，按字符算会超 3 倍）
 *   4. compact 后 hash 状态清空（否则 span 上留一个指向已失效事件的 hash）
 *
 * 另外两组是这批修复自己的关键约束：
 *   5. 脱敏必须发生在截断**之前**（反了会把横跨截断点的凭证半截裸传出去）
 *   6. flag 关掉能真的关掉功能（P1-9 要的就是「真实消费者」，不是又一个死开关）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TelemetryBus } from "../../src/telemetry/bus.ts";
import {
  isContentTracingEnabled,
  clearContentTracingState,
  truncateToBytes,
  addRequestContent,
  addResponseContent,
  addToolContent,
  getSeenHashCount,
  MAX_CONTENT_BYTES,
  CONTENT_TRACING_FLAG,
} from "../../src/telemetry/content-tracing.ts";
import {
  __resetFeatureFlagsForTest,
  initFeatureFlags,
} from "../../src/analytics/feature-flags.ts";
import { setConfiguredPrivacyLevel } from "../../src/analytics/privacy-level.ts";
import type { SpanData, TelemetryExporter, SpanEvent } from "../../src/telemetry/types.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_SWITCH = "SID_CODE_CONTENT_TRACING";
const FLAG_ENV = `SID_CODE_FLAG_${CONTENT_TRACING_FLAG.toUpperCase()}`;

/** 备份需要改动的环境变量——绝不无条件 delete（同批测试跑在同一进程里，会互相污染） */
const ENV_KEYS = [
  ENV_SWITCH,
  FLAG_ENV,
  "SID_CODE_DISABLE_TELEMETRY",
  "SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
let savedEnv: Record<string, string | undefined> = {};

function createBus(): { bus: TelemetryBus; spans: SpanData[] } {
  const spans: SpanData[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => { spans.push(...batch); },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 1000, flushIntervalMs: 999_999 });
  bus.addExporter(exporter);
  bus.startTrace();
  return { bus, spans };
}

/** 结束 span 并取回它的事件列表 */
async function collectEvents(bus: TelemetryBus, spans: SpanData[]): Promise<SpanEvent[]> {
  await bus.flush();
  return spans.flatMap((s) => s.events);
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  setConfiguredPrivacyLevel(null);
  __resetFeatureFlagsForTest();
  clearContentTracingState();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setConfiguredPrivacyLevel(null);
  __resetFeatureFlagsForTest();
  clearContentTracingState();
});

// ============================================================
// 不变量 1：默认关闭
// ============================================================
describe("内容级 tracing · 默认关闭（设计点 3）", () => {
  test("不配任何环境变量时关闭", () => {
    expect(isContentTracingEnabled()).toBe(false);
  });

  test("环境变量非 '1' 的各种真值写法都不算开启", () => {
    for (const v of ["true", "yes", "0", "", "on", "TRUE"]) {
      process.env[ENV_SWITCH] = v;
      expect(isContentTracingEnabled()).toBe(false);
    }
  });

  test("显式配 1 才开启", () => {
    process.env[ENV_SWITCH] = "1";
    expect(isContentTracingEnabled()).toBe(true);
  });

  test("关闭时不产生任何内容事件——不是「产生了但内容为空」", async () => {
    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat test");
    addRequestContent(span, { system: "你是一个助手", tools: [{ name: "read" }], messages: [{ role: "user", content: "hi" }] });
    addResponseContent(span, { text: "回答" });
    addToolContent(span, { toolInput: { path: "/a" }, toolResponse: { ok: true } });
    span.end();

    const events = await collectEvents(bus, spans);
    expect(events.filter((e) => e.name.startsWith("content."))).toHaveLength(0);
    // 属性侧也不许有残留
    const attrKeys = Object.keys(spans[0]!.attributes);
    expect(attrKeys.filter((k) => k.startsWith("sidcode.content."))).toHaveLength(0);
  });
});

// ============================================================
// 不变量 2：隐私级别优先于一切
// ============================================================
describe("内容级 tracing · 隐私级别硬约束", () => {
  test("no-telemetry 下即使显式开启也不发内容", () => {
    process.env[ENV_SWITCH] = "1";
    process.env.SID_CODE_DISABLE_TELEMETRY = "1";
    expect(isContentTracingEnabled()).toBe(false);
  });

  test("essential-traffic 下即使显式开启也不发内容", () => {
    process.env[ENV_SWITCH] = "1";
    process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    expect(isContentTracingEnabled()).toBe(false);
  });

  test("配置文件设的隐私级别同样生效（不只认环境变量）", () => {
    process.env[ENV_SWITCH] = "1";
    setConfiguredPrivacyLevel("no-telemetry");
    expect(isContentTracingEnabled()).toBe(false);
  });

  test("隐私级别优先于 flag——flag 显式开也压不过隐私", () => {
    process.env[ENV_SWITCH] = "1";
    process.env[FLAG_ENV] = "true";
    process.env.SID_CODE_DISABLE_TELEMETRY = "1";
    expect(isContentTracingEnabled()).toBe(false);
  });
});

// ============================================================
// 不变量 6：Feature Flag 是真实消费者（P1-9）
// ============================================================
describe("Feature Flag 真实消费者（P1-9）", () => {
  test("flag 置 false 能真的关掉功能——这就是 P1-9 要的「真实门控」", () => {
    process.env[ENV_SWITCH] = "1";
    expect(isContentTracingEnabled()).toBe(true); // 基线：本地开关已开

    process.env[FLAG_ENV] = "false";
    expect(isContentTracingEnabled()).toBe(false); // flag 否决生效
  });

  test("flag 关掉后连一条内容事件都不产生（行为断言，不只是布尔断言）", async () => {
    process.env[ENV_SWITCH] = "1";
    process.env[FLAG_ENV] = "false";

    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat test");
    addRequestContent(span, { system: "你是一个助手" });
    addResponseContent(span, { text: "回答" });
    span.end();

    const events = await collectEvents(bus, spans);
    expect(events.filter((e) => e.name.startsWith("content."))).toHaveLength(0);
  });

  test("flag 默认放行（本地开关已是默认关闭，flag 的职责是远端紧急刹车）", () => {
    process.env[ENV_SWITCH] = "1";
    // 不配 flag env、无远端配置 → 默认值 true
    expect(isContentTracingEnabled()).toBe(true);
  });

  test("反向断言：flag 置 true 时确实放行，证明门控是 flag 驱动而非常关", () => {
    process.env[ENV_SWITCH] = "1";
    process.env[FLAG_ENV] = "true";
    expect(isContentTracingEnabled()).toBe(true);
  });

  // ── 以下三条锁的是「真实用户配得上」这件事 ──
  // 只认环境变量的 flag 仍是半死的：企业运维不会给每台机器改 env，他们改 settings.json
  // 或下发远端配置。所以配置路径与磁盘缓存路径都必须实测能门控，不能只测 env。

  test("settings.json 的 analytics.flags 能门控（localFlags 路径）", () => {
    process.env[ENV_SWITCH] = "1";
    const dir = mkdtempSync(join(tmpdir(), "sidcode-flag-"));
    initFeatureFlags({ configDir: dir, localFlags: { [CONTENT_TRACING_FLAG]: false } });
    expect(isContentTracingEnabled()).toBe(false);
  });

  test("磁盘缓存能门控——远端下发 false 后离线冷启动也刹得住", () => {
    // 这条覆盖的是真实的运维场景：远端把开关关了，用户重启进程时可能拿不到远端配置
    // （网络不通 / 端点挂了）。若冷启动回落到默认放行，紧急刹车就在最需要的时候失效。
    process.env[ENV_SWITCH] = "1";
    const dir = mkdtempSync(join(tmpdir(), "sidcode-flag-"));
    writeFileSync(
      join(dir, "feature-flags-cache.json"),
      JSON.stringify({ [CONTENT_TRACING_FLAG]: false }),
      "utf-8",
    );
    initFeatureFlags({ configDir: dir });
    expect(isContentTracingEnabled()).toBe(false);
  });

  test("环境变量优先级高于 localFlags（便于临时排查绕过远端配置）", () => {
    process.env[ENV_SWITCH] = "1";
    process.env[FLAG_ENV] = "true";
    const dir = mkdtempSync(join(tmpdir(), "sidcode-flag-"));
    initFeatureFlags({ configDir: dir, localFlags: { [CONTENT_TRACING_FLAG]: false } });
    expect(isContentTracingEnabled()).toBe(true);
  });
});

// ============================================================
// 不变量 3：字节截断
// ============================================================
describe("内容级 tracing · 截断按字节封顶（设计点 2）", () => {
  test("短内容不截断且逐字节保持原文", () => {
    const r = truncateToBytes("hello 世界");
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("hello 世界");
  });

  test("纯 ASCII 超限后产物字节数不超过上限", () => {
    const r = truncateToBytes("a".repeat(MAX_CONTENT_BYTES + 5000));
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
  });

  test("中文超限后产物字节数不超过上限——这是与 CC 按字符算的关键分歧点", () => {
    // 30000 个汉字 = 90000 字节。按 UTF-16 长度算只有 30000「字符」，
    // 若按字符数封顶 60K 就完全不会截断，实际发出去 90KB → 后端静默拒收。
    const cn = "中".repeat(30_000);
    const r = truncateToBytes(cn);
    expect(r.originalBytes).toBe(90_000);
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
  });

  test("多字节字符不被切坏——产物里不留 U+FFFD 替换符", () => {
    // emoji 是 4 字节，截断点极可能落在字符中间
    const r = truncateToBytes("😀".repeat(20_000));
    expect(r.truncated).toBe(true);
    expect(r.content).not.toContain("�");
    expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
  });

  test("截断产物带明确标记，消费者能区分「内容就这么短」与「被截了」", () => {
    const r = truncateToBytes("x".repeat(MAX_CONTENT_BYTES * 2));
    expect(r.content).toContain("已截断");
  });

  test("超限内容进 span 时带 content_truncated 标志与原始字节数", async () => {
    process.env[ENV_SWITCH] = "1";
    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat test");
    addResponseContent(span, { text: "长".repeat(30_000) });
    span.end();

    const events = await collectEvents(bus, spans);
    const ev = events.find((e) => e.name === "content.model_output");
    expect(ev).toBeDefined();
    expect(ev!.attributes?.content_truncated).toBe(true);
    expect(ev!.attributes?.content_bytes).toBe(90_000);
  });
});

// ============================================================
// 不变量 4：hash 去重
// ============================================================
describe("内容级 tracing · hash 去重（设计点 1，漏掉它功能会被迫关掉）", () => {
  beforeEach(() => { process.env[ENV_SWITCH] = "1"; });

  test("同一 system prompt 跨多轮只发一次全文", async () => {
    const { bus, spans } = createBus();
    const system = "你是 sid-code 的助手".repeat(100);

    for (let turn = 0; turn < 5; turn++) {
      const span = bus.startSpan("chat", `chat turn${turn}`);
      addRequestContent(span, { system });
      span.end();
    }

    const events = await collectEvents(bus, spans);
    const fullText = events.filter((e) => e.name === "content.system_prompt");
    expect(fullText).toHaveLength(1); // 5 轮，只有 1 次全文
  });

  test("但每轮 span 上都带 hash + preview + length，靠 hash 关联全文", async () => {
    const { bus, spans } = createBus();
    const system = "你是 sid-code 的助手";

    for (let turn = 0; turn < 3; turn++) {
      const span = bus.startSpan("chat", `chat turn${turn}`);
      addRequestContent(span, { system });
      span.end();
    }

    await bus.flush();
    expect(spans).toHaveLength(3);
    const hashes = spans.map((s) => s.attributes["sidcode.content.system_prompt_hash"]);
    expect(hashes.every((h) => typeof h === "string" && (h as string).length === 12)).toBe(true);
    expect(new Set(hashes).size).toBe(1); // 同内容 → 同 hash
    // preview 与长度每轮都有——不必回查全文事件就能看出个大概
    expect(spans[2]!.attributes["sidcode.content.system_prompt_preview"]).toBe(system);
    expect(spans[2]!.attributes["sidcode.content.system_prompt_bytes"]).toBeGreaterThan(0);
  });

  test("system prompt 变了要重新发一次全文", async () => {
    const { bus, spans } = createBus();
    const s1 = bus.startSpan("chat", "chat 1");
    addRequestContent(s1, { system: "版本 A" });
    s1.end();
    const s2 = bus.startSpan("chat", "chat 2");
    addRequestContent(s2, { system: "版本 B" });
    s2.end();

    const events = await collectEvents(bus, spans);
    expect(events.filter((e) => e.name === "content.system_prompt")).toHaveLength(2);
  });

  test("工具 schema 按**单个工具**去重：新增一个工具不会把其余全部重发", async () => {
    const { bus, spans } = createBus();
    const read = { name: "read", description: "读文件" };
    const write = { name: "write", description: "写文件" };

    const s1 = bus.startSpan("chat", "chat 1");
    addRequestContent(s1, { tools: [read, write] });
    s1.end();

    // 第二轮多了一个工具——若按列表整体 hash，read/write 会被重发
    const s2 = bus.startSpan("chat", "chat 2");
    addRequestContent(s2, { tools: [read, write, { name: "bash", description: "跑命令" }] });
    s2.end();

    const events = await collectEvents(bus, spans);
    const schemas = events.filter((e) => e.name === "content.tool_schema");
    expect(schemas).toHaveLength(3); // read + write + bash，而不是 2 + 3 = 5
  });

  test("MCP 工具名在事件属性里已脱敏，不裸传用户私有服务名", async () => {
    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat 1");
    addRequestContent(span, { tools: [{ name: "mcp__acme_internal__deploy", description: "d" }] });
    span.end();

    const events = await collectEvents(bus, spans);
    const schema = events.find((e) => e.name === "content.tool_schema");
    expect(schema!.attributes?.tool_name).toBe("mcp_tool");
    expect(String(schema!.attributes?.tool_name)).not.toContain("acme_internal");
  });

  test("消息只发增量：重复的历史消息不再重发", async () => {
    const { bus, spans } = createBus();
    const m1 = { role: "user", content: "第一条" };
    const m2 = { role: "assistant", content: "第二条" };
    const m3 = { role: "user", content: "第三条" };

    const s1 = bus.startSpan("chat", "chat 1");
    addRequestContent(s1, { messages: [m1, m2] });
    s1.end();
    const s2 = bus.startSpan("chat", "chat 2");
    addRequestContent(s2, { messages: [m1, m2, m3] }); // 全量历史 + 1 条新的
    s2.end();

    await bus.flush();
    // 第二轮总量 3、新增 1
    expect(spans[1]!.attributes["sidcode.content.messages_total"]).toBe(3);
    expect(spans[1]!.attributes["sidcode.content.messages_new"]).toBe(1);

    const events = spans.flatMap((s) => s.events).filter((e) => e.name === "content.new_messages");
    expect(events).toHaveLength(2);
    expect(events[1]!.attributes?.message_count).toBe(1);
    expect(String(events[1]!.attributes?.content)).toContain("第三条");
    expect(String(events[1]!.attributes?.content)).not.toContain("第一条");
  });

  test("工具入参/结果**不**去重——重复调用本身就是要观察的现象", async () => {
    const { bus, spans } = createBus();
    for (let i = 0; i < 3; i++) {
      const span = bus.startSpan("execute_tool", "execute_tool read");
      addToolContent(span, { toolInput: { path: "/same.ts" }, toolResponse: { content: "同样的内容" } });
      span.end();
    }

    const events = await collectEvents(bus, spans);
    // 模型连读同一个文件 3 次是「原地打转」的信号，去重会把这个信号抹掉
    expect(events.filter((e) => e.name === "content.tool_input")).toHaveLength(3);
    expect(events.filter((e) => e.name === "content.tool_result")).toHaveLength(3);
  });
});

// ============================================================
// 不变量 5：compact 后清状态
// ============================================================
describe("内容级 tracing · compact 后清 hash 状态（设计点 4）", () => {
  beforeEach(() => { process.env[ENV_SWITCH] = "1"; });

  test("clearContentTracingState 之后同一 system prompt 会重发全文", async () => {
    const { bus, spans } = createBus();
    const system = "压缩前后都一样的 system prompt";

    const s1 = bus.startSpan("chat", "chat 1");
    addRequestContent(s1, { system });
    s1.end();

    // 模拟 compact
    clearContentTracingState();

    const s2 = bus.startSpan("chat", "chat 2");
    addRequestContent(s2, { system });
    s2.end();

    const events = await collectEvents(bus, spans);
    // 不清状态的话这里只有 1 条，span 上却带着 hash → 拿着 hash 找不到内容
    expect(events.filter((e) => e.name === "content.system_prompt")).toHaveLength(2);
  });

  test("清空后 hash 计数归零", () => {
    const { bus } = createBus();
    const span = bus.startSpan("chat", "chat 1");
    addRequestContent(span, { system: "x", tools: [{ name: "read" }] });
    span.end();
    expect(getSeenHashCount()).toBeGreaterThan(0);

    clearContentTracingState();
    expect(getSeenHashCount()).toBe(0);
  });

  test("runPostCompact 是 auto 与手动压缩共同的收尾点——清理挂在那里才不漏手动路径", async () => {
    // 这条是结构断言：防止后续维护把清理搬回 auto-compact 的三个出口，
    // 那样手动 /compact 就不清了，而「只有手动压缩后 hash 不失效」极难被想到去查。
    const src = await Bun.file("src/query/compact/post-compact.ts").text();
    expect(src).toContain("clearContentTracingState");
  });
});

// ============================================================
// 不变量 7：脱敏在截断之前
// ============================================================
describe("内容级 tracing · 脱敏（顺序：先脱敏再截断）", () => {
  beforeEach(() => { process.env[ENV_SWITCH] = "1"; });

  test("内容里的密钥被脱敏后才进 span", async () => {
    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat 1");
    addResponseContent(span, { text: 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' });
    span.end();

    const events = await collectEvents(bus, spans);
    const body = String(events.find((e) => e.name === "content.model_output")!.attributes?.content);
    expect(body).toContain("*");
    expect(body).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  test("横跨截断点的凭证不会被切成半截裸传——先截断再脱敏就会漏", async () => {
    const { bus, spans } = createBus();
    const secret = 'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    // 把凭证放在恰好跨越字节上限的位置：前面塞到只剩几十字节
    const padding = "a".repeat(MAX_CONTENT_BYTES - 20);
    const span = bus.startSpan("chat", "chat 1");
    addResponseContent(span, { text: padding + secret });
    span.end();

    const events = await collectEvents(bus, spans);
    const body = String(events.find((e) => e.name === "content.model_output")!.attributes?.content);
    // 关键断言：产物里绝不能出现密钥明文的任何一段可辨识前缀
    expect(body).not.toContain("wJalrXUtnFEMI");
  });

  test("工具入参里的路径与内容也过脱敏", async () => {
    const { bus, spans } = createBus();
    const span = bus.startSpan("execute_tool", "execute_tool bash");
    addToolContent(span, {
      toolInput: { command: 'curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' },
    });
    span.end();

    const events = await collectEvents(bus, spans);
    const body = String(events.find((e) => e.name === "content.tool_input")!.attributes?.content);
    expect(body).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

// ============================================================
// 健壮性：旁路绝不影响主流程
// ============================================================
describe("内容级 tracing · 旁路健壮性", () => {
  beforeEach(() => { process.env[ENV_SWITCH] = "1"; });

  test("循环引用不抛异常", () => {
    const { bus } = createBus();
    const span = bus.startSpan("chat", "chat 1");
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => addRequestContent(span, { system: circular })).not.toThrow();
    expect(() => addToolContent(span, { toolInput: circular })).not.toThrow();
    span.end();
  });

  test("空 / undefined 载荷不产生空事件", async () => {
    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat 1");
    addRequestContent(span, {});
    addResponseContent(span, {});
    addToolContent(span, {});
    span.end();

    const events = await collectEvents(bus, spans);
    expect(events.filter((e) => e.name.startsWith("content."))).toHaveLength(0);
  });

  test("空字符串文本不产生事件（区别于「内容为空的事件」）", async () => {
    const { bus, spans } = createBus();
    const span = bus.startSpan("chat", "chat 1");
    addResponseContent(span, { text: "" });
    span.end();

    const events = await collectEvents(bus, spans);
    expect(events.filter((e) => e.name === "content.model_output")).toHaveLength(0);
  });
});
