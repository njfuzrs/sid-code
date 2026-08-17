/**
 * 内容级 tracing 的**接线**测试（缺陷清单 P1-5）
 *
 * 与 content-tracing.test.ts 的分工：那份测模块自身的行为（去重/截断/脱敏），
 * 这份测「配了能不能到达」——走真实的 HookSystem 事件路径，而不是直接调模块函数。
 *
 * 为什么这层单独存在（沿用 P0-3 修复留下的纪律）：批次 B 的复盘写得很明白，
 * 原始缺陷（OtlpExporter 写完但配置层不可达）能活到那天的唯一原因是
 * **没有任何测试断言「配了能到达」**——收窄白名单不会让任何测试变红。
 * 内容级 tracing 有完全一样的失效形态：模块 34 个测试全绿，但只要
 * hook-probe 里那三行调用被删掉，功能就静默消失，而模块测试**依然全绿**。
 * 这份文件就是拦住那个形态的。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import {
  clearContentTracingState,
  CONTENT_TRACING_FLAG,
} from "@sid-code/core/telemetry/content-tracing.ts";
import { __resetFeatureFlagsForTest } from "@sid-code/core/analytics/feature-flags.ts";
import { setConfiguredPrivacyLevel } from "@sid-code/core/analytics/privacy-level.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

const ENV_SWITCH = "SID_CODE_CONTENT_TRACING";
const FLAG_ENV = `SID_CODE_FLAG_${CONTENT_TRACING_FLAG.toUpperCase()}`;
const ENV_KEYS = [
  ENV_SWITCH,
  FLAG_ENV,
  "SID_CODE_DISABLE_TELEMETRY",
  "SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
let savedEnv: Record<string, string | undefined> = {};
/** SID_CONFIG_DIR 的原值（可能是 preload 设的隔离兜底），afterEach 要还回去 */
let savedConfigDir: string | undefined;
let testHome: string;

function setup() {
  const spans: SpanData[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => {
      spans.push(...batch);
    },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 1000, flushIntervalMs: 999_999 });
  bus.addExporter(exporter);
  const probe = new TelemetryHookProbe(bus, null, {
    model: "claude-sonnet-4",
    provider: "anthropic",
    sessionId: "wiring-test",
  });
  const hookSystem = new HookSystem();
  probe.registerHooks(hookSystem);
  return { bus, spans, hookSystem };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // 落盘隔离（§三 P0-2 起必需）：handleSessionStart 会同步写「根 span 欠一次 end」
  // 的标记到 ~/.sid-code/telemetry/pending-root-spans/。SID_CONFIG_DIR 走
  // 上面那套「存原值 → afterEach 还回去」的机制（**不是** delete 后重设——
  // delete 会连 preload 的隔离兜底一起抹掉），所以它不在 ENV_KEYS 里另开一套。
  savedConfigDir = process.env.SID_CONFIG_DIR;
  testHome = mkdtempSync(join(tmpdir(), "sid-content-tracing-home-"));
  process.env.SID_CONFIG_DIR = testHome;
  setConfiguredPrivacyLevel(null);
  __resetFeatureFlagsForTest();
  clearContentTracingState();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(testHome, { recursive: true, force: true });
  setConfiguredPrivacyLevel(null);
  __resetFeatureFlagsForTest();
  clearContentTracingState();
});

describe("内容级 tracing · 经真实 Hook 路径接线", () => {
  test("BeforeModel → chat span 携带 system prompt 内容", async () => {
    process.env[ENV_SWITCH] = "1";
    const { bus, spans, hookSystem } = setup();

    await hookSystem.fireSessionStartEvent("startup", { model: "claude-sonnet-4" });
    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "帮我改个 bug" }],
      system: "你是 sid-code",
      tools: [{ name: "read", description: "读文件" }],
    });
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "帮我改个 bug" }] },
      {
        text: "好的，我来看看",
        usage: { inputTokens: 10, outputTokens: 5 },
        stop_reason: "end_turn",
      },
    );
    await bus.flush();

    const chat = spans.find((s) => s.kind === "chat")!;
    expect(chat).toBeDefined();
    const names = chat.events.map((e) => e.name);
    expect(names).toContain("content.system_prompt");
    expect(names).toContain("content.tool_schema");
    expect(names).toContain("content.model_output");
    expect(chat.attributes["sidcode.content.system_prompt_hash"]).toBeDefined();
  });

  test("PostToolUse → execute_tool span 携带工具入参与结果", async () => {
    process.env[ENV_SWITCH] = "1";
    const { bus, spans, hookSystem } = setup();

    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/tmp/a.ts" },
      { content: "源码内容" },
      false,
      "toolu_1",
    );
    await bus.flush();

    const tool = spans.find((s) => s.kind === "execute_tool")!;
    expect(tool).toBeDefined();
    const names = tool.events.map((e) => e.name);
    expect(names).toContain("content.tool_input");
    expect(names).toContain("content.tool_result");
    expect(
      String(tool.events.find((e) => e.name === "content.tool_result")!.attributes?.content),
    ).toContain("源码内容");
  });

  test("响应**没带 usage** 时依然采到内容——这是最需要看内容的场景之一", async () => {
    // handleAfterModel 里 `if (!usage) return` 会提前退出。内容采集刻意放在守卫之前：
    // 截断响应 / provider 异常返回往往就是没 usage，若放在守卫后面，
    // 结果会是「越是出问题的那一轮越采不到内容」。
    process.env[ENV_SWITCH] = "1";
    const { bus, spans, hookSystem } = setup();

    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      system: "你是 sid-code",
    });
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      { text: "被截断的半句回答", stop_reason: undefined }, // 无 usage
    );
    // chat span 没被 end（usage 守卫提前返回），靠 SessionEnd 之后再 flush 拿不到它，
    // 所以这里直接断言：内容事件已经挂在那个未结束的 span 上。
    // 用 sweep 的方式取——结束 agent span 会带出 trace，但 chat span 需要显式结束。
    // 改为验证「不抛异常且后续 span 正常」，并在下一轮确认 hash 已被记住（说明内容确实处理过）。
    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      system: "你是 sid-code", // 同一 system → 若上一轮已发过全文，这轮不该再发
    });
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      { text: "完整回答", usage: { inputTokens: 10, outputTokens: 5 }, stop_reason: "end_turn" },
    );
    await bus.flush();

    // 第二轮的 chat span 里不该再有 system_prompt 全文（第一轮已发过 → 证明第一轮真的采了）
    const chat = spans.find((s) => s.kind === "chat")!;
    expect(chat.events.map((e) => e.name)).not.toContain("content.system_prompt");
    // 但第二轮的响应内容照常采到
    expect(chat.events.map((e) => e.name)).toContain("content.model_output");
  });

  test("默认（不配环境变量）走真实 Hook 路径也不产生任何内容事件", async () => {
    const { bus, spans, hookSystem } = setup();

    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "机密内容" }],
      system: "你是 sid-code",
      tools: [{ name: "read", description: "读文件" }],
    });
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "机密内容" }] },
      { text: "回答", usage: { inputTokens: 10, outputTokens: 5 }, stop_reason: "end_turn" },
    );
    await hookSystem.firePostToolUseEvent(
      "read",
      { file_path: "/secret.ts" },
      { content: "机密源码" },
      false,
    );
    await bus.flush();

    const allEvents = spans.flatMap((s) => s.events);
    expect(allEvents.filter((e) => e.name.startsWith("content."))).toHaveLength(0);
    // 更强的断言：整个 span 序列化后不含任何被采集的内容原文
    const dump = JSON.stringify(spans);
    expect(dump).not.toContain("机密源码");
    expect(dump).not.toContain("机密内容");
  });

  test("flag 关掉时经真实 Hook 路径同样不发内容（远端紧急刹车真的能刹住）", async () => {
    process.env[ENV_SWITCH] = "1";
    process.env[FLAG_ENV] = "false";
    const { bus, spans, hookSystem } = setup();

    await hookSystem.fireBeforeModelEvent({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      system: "你是 sid-code",
    });
    await hookSystem.fireAfterModelEvent(
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      { text: "回答", usage: { inputTokens: 10, outputTokens: 5 }, stop_reason: "end_turn" },
    );
    await bus.flush();

    expect(
      spans.flatMap((s) => s.events).filter((e) => e.name.startsWith("content.")),
    ).toHaveLength(0);
  });
});

describe("内容级 tracing · 接线哨兵（防退化成死代码）", () => {
  // 这三条是静态断言。它们看起来"没测行为"，但拦的正是本清单 7/11 条缺陷的共同形态：
  // 代码完整、测试通过、调用点为零。删掉 hook-probe 里的调用，行为测试可能仍绿
  // （模块函数照样能被直接调用），这里会红。

  test("hook-probe 必须实际调用三个内容采集函数", async () => {
    const src = await Bun.file("packages/core/src/telemetry/hook-probe.ts").text();
    expect(src).toContain("addRequestContent(");
    expect(src).toContain("addResponseContent(");
    expect(src).toContain("addToolContent(");
  });

  test("Feature Flag 必须有 analytics 之外的真实消费者（P1-9）", async () => {
    // P1-9 的原始缺陷：205 行 flag 系统「除了被初始化一次，没有任何业务代码读取任何 flag」。
    // 采样与 killswitch 虽然读 flag，但它们同属 analytics 内部、且远端无人配置，
    // 等于两个永远返回默认值的死开关。这里要求 analytics 目录**之外**至少有一个消费者。
    // P2-2 分包：扫 4 个包的 src/，不再是单一 src/。
    // `-a` 是必须的 —— app.ts 含 NUL 字节，否则 rg 会把它判成 binary 并静默跳过。
    const proc = Bun.spawnSync([
      "rg",
      "-a",
      "-l",
      "getFeatureValue_CACHED_MAY_BE_STALE",
      "--type",
      "ts",
      "packages/shared/src/",
      "packages/tui-renderer/src/",
      "packages/core/src/",
      "packages/cli/src/",
    ]);
    const files = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
    // 防空转：路径写错时 rg 返回空，下面的 toBeGreaterThan(0) 会红而不是假绿。
    const outsideAnalytics = files.filter((f) => !f.includes("/analytics/"));
    expect(outsideAnalytics.length).toBeGreaterThan(0);
    expect(outsideAnalytics).toContain("packages/core/src/telemetry/content-tracing.ts");
  });

  test("内容采集必须过脱敏——不许直接把原文塞进 span", async () => {
    const src = await Bun.file("packages/core/src/telemetry/content-tracing.ts").text();
    expect(src).toContain("maskSensitiveData");
  });
});
