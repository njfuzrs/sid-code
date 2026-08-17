/**
 * Span 树成形门禁（三方对比差距清单 §0.3c · PR2）
 *
 * ## 为什么要单独一个文件
 *
 * 「会话根 span 恒不落盘 / 树不成形」这条缺陷被**两次**验收判据放过：
 *
 *  1. 第一次的判据是「`invoke_agent` span 数 != 0」。后来新增了子代理 span
 *     （`hook-probe.ts:handleSubagentStart`），这个数从 0 变成 18 —— 判据翻转了，
 *     但会话根 span 实产仍是 0。**用「某个数不为 0」当判据，会被任何往同一字段
 *     写入的新功能伪装成已修复。**
 *  2. 第二次的判据是
 *     `jq 'select(.parentSpanId==null) | .traceId' | sort -u | wc -l` 对比
 *     `jq '.traceId' | sort -u | wc -l` —— 33 ≈ 34，看着 PASS。
 *     但 `sort -u` 把同一条 trace 下的 **28 个根去重成 1 个**，
 *     于是「每棵树一个根」与「每棵树 28 个根」在这个判据下输出完全相同。
 *
 * 共同的病灶是一个：**用聚合后的数字当判据，会把结构性缺陷聚合掉。**
 * 所以本文件的断言一律对着**未去重的 span 集合**跑结构性检查，
 * 而不是数某个 kind 的个数。判据形态抄 langfuse seeder 的落库断言
 * （`orphan check: every observation should resolve to a trace`）：
 * **断言每个节点都能解析到根，不是数根的个数。**
 *
 * ## 三条断言
 *
 *  ① 每棵树恰好一个根：`根 span 总数 == traceId 数`（**不许 `sort -u`**）
 *  ② 无悬空父：每个 `parentSpanId` 都能在同批数据里解析到 span
 *     （实测曾有 111 个 span 指向 3 个不存在的父 ID）
 *  ③ kind 嵌套合法性：`chat` 不能是 `chat` 的父；
 *     子 span 的 `startTime` 必须落在父的 `[startTime, endTime]` 内
 *
 * ## 做法与自证
 *
 * - 断言对着 `TelemetryBus` 经生产探针（`TelemetryHookProbe` + `HookSystem` 真实
 *   hook 事件）产出的 span 数组跑，**不读用户真实 `~/.sid-code/`**
 *   （见 CONTRIBUTING.md 测试落盘隔离四坑；本文件不 import 任何落盘导出）。
 * - 每条断言都配了**变异自证**：故意造出违规数据，确认检查器会红。
 *   不会红的断言等于没写（见 docs/bugfixes 里静态门禁空转成绿灯那几例）。
 * - 另有一条对照测试直接复现「旧判据会把破损数据判成 PASS」，
 *   把这个教训固化成可执行的反例，而不是只写在文档里。
 *
 * ## 生产路径变异自证的实测结果（2026-08-17）
 *
 * 除了下面那些手工构造的变异，还在**生产路径**上做了一次端到端自证：把
 * `probe.registerHooks()` 挪到 `fireSessionStartEvent()` 之后（即 PR1 修复前的
 * 真实顺序，`handleSessionStart` 从不被调用），跑 3 轮 chat + 3 次工具后实测：
 *
 * ```
 * span 总数=6  根 span 数=6  trace 数=1
 * 会话级 invoke_agent 数=0
 * 判据① 违规明细: ["trace 673939ff… 有 6 个根"]
 * ```
 *
 * 即：判据①在真实缺陷下确实报红，而旧判据（`sort -u` 后 1 == 1）在同一份数据上
 * 显示 PASS。这条门禁抓的是它声称要抓的东西，不是自我感觉。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import type { SpanData, SpanKind, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

// ============================================================
// 检查器：三条结构性判据，各自返回违规明细（空数组 = 通过）
//
// 刻意返回明细而不是布尔：门禁红的时候要能直接指出「哪个 span 挂在哪个不存在的
// 父上」，否则下一个人还得自己写 jq 去定位，多半就把断言注掉了。
// ============================================================

/** ① 每棵树恰好一个根 —— 按 traceId 分组统计根数，不做任何去重 */
function findRootCountViolations(spans: readonly SpanData[]): string[] {
  const rootsByTrace = new Map<string, SpanData[]>();
  const tracesSeen = new Set<string>();
  for (const s of spans) {
    tracesSeen.add(s.traceId);
    if (s.parentSpanId === undefined) {
      const list = rootsByTrace.get(s.traceId) ?? [];
      list.push(s);
      rootsByTrace.set(s.traceId, list);
    }
  }
  const violations: string[] = [];
  for (const traceId of tracesSeen) {
    const roots = rootsByTrace.get(traceId) ?? [];
    if (roots.length !== 1) {
      violations.push(
        `trace ${traceId} 有 ${roots.length} 个根 span（期望恰好 1 个）：` +
          `${roots.map((r) => `${r.kind}/${r.name}`).join(", ") || "无"}`,
      );
    }
  }
  return violations;
}

/** ② 无悬空父 —— 每个 parentSpanId 都能在同批数据里解析到 span */
function findDanglingParentViolations(spans: readonly SpanData[]): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const violations: string[] = [];
  for (const s of spans) {
    if (s.parentSpanId === undefined) continue;
    const parent = byId.get(s.parentSpanId);
    if (!parent) {
      violations.push(`${s.kind}/${s.name} 的父 ${s.parentSpanId} 不在同批数据里（悬空）`);
      continue;
    }
    // 父子必须同一条 trace —— 跨 trace 的父引用在 OTel 后端里同样渲染不成树
    if (parent.traceId !== s.traceId) {
      violations.push(
        `${s.kind}/${s.name} 的父 ${s.parentSpanId} 在另一条 trace ` +
          `(${parent.traceId} != ${s.traceId})`,
      );
    }
  }
  return violations;
}

/**
 * ③ kind 嵌套合法性 + 时间自洽
 *
 * 禁止的父→子组合：`chat` 不能是 `chat` 的父（一轮推理不会嵌套另一轮推理；
 * 真出现说明 llmSpan 没被 AfterModel 结束，栈底残留）。
 * `execute_tool` 也不该成为 `chat` 的父（工具 span 在 PostToolUse 里创建即结束）。
 */
const FORBIDDEN_NESTING: ReadonlyArray<[SpanKind, SpanKind]> = [
  ["chat", "chat"],
  ["execute_tool", "chat"],
];

function findNestingViolations(spans: readonly SpanData[]): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const violations: string[] = [];
  for (const s of spans) {
    if (s.parentSpanId === undefined) continue;
    const parent = byId.get(s.parentSpanId);
    if (!parent) continue; // 悬空由 ② 负责报，这里不重复计

    for (const [pk, ck] of FORBIDDEN_NESTING) {
      if (parent.kind === pk && s.kind === ck) {
        violations.push(`非法嵌套：${pk} 不能是 ${ck} 的父（子 span ${s.name}）`);
      }
    }

    // 时间自洽：子 span 的 startTime 必须落在父的 [startTime, endTime] 内。
    // 闭区间：同一毫秒内开始/结束是常态（Date.now() 只有毫秒精度）。
    if (s.startTime < parent.startTime || s.startTime > parent.endTime) {
      violations.push(
        `时间错位：${s.kind}/${s.name} 起于 ${s.startTime}，` +
          `不在父 ${parent.kind}/${parent.name} 的 [${parent.startTime}, ${parent.endTime}] 内`,
      );
    }
  }
  return violations;
}

/** 三条合一，供「跑一遍真实探针再整体体检」用 */
function findSpanTreeViolations(spans: readonly SpanData[]): string[] {
  return [
    ...findRootCountViolations(spans),
    ...findDanglingParentViolations(spans),
    ...findNestingViolations(spans),
  ];
}

// ============================================================
// 生产路径取数：TelemetryHookProbe + 真实 HookSystem 事件
// ============================================================

function createEnabledBus() {
  const spans: SpanData[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => {
      spans.push(...batch);
    },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 1000, flushIntervalMs: 999999 });
  bus.addExporter(exporter);
  return { bus, spans };
}

/** 跑一轮完整的模型调用（BeforeModel → AfterModel） */
async function fireTurn(hookSystem: HookSystem, model: string): Promise<void> {
  const request = { model, messages: [{ role: "user", content: "hello" }] };
  await hookSystem.fireBeforeModelEvent(request);
  await hookSystem.fireAfterModelEvent(request, {
    text: "hi",
    usage: { inputTokens: 100, outputTokens: 50 },
    stop_reason: "end_turn",
    cost_usd: 0.001,
  });
}

/**
 * 跑一个完整会话：根 span → 2 轮 chat → 2 次工具 → 一个子代理（其下再一轮 chat）。
 * 这个形状覆盖到 3 层嵌套，是当前生产能产出的最深树。
 */
async function runSession(probe: TelemetryHookProbe, model: string): Promise<void> {
  const hookSystem = new HookSystem();
  probe.registerHooks(hookSystem);

  await hookSystem.fireSessionStartEvent("startup", { model });
  await fireTurn(hookSystem, model);
  await hookSystem.firePostToolUseEvent(
    "read",
    { file_path: "/tmp/a.ts" },
    { output: "x" },
    false,
    "tool-1",
    { duration_ms: 7 },
  );

  // 子代理：invoke_agent 子 span，其存续期内再跑一轮 chat（深度 3）
  await hookSystem.fireSubagentStartEvent("agent-1", "explore", "parent-session", {
    model,
    provider: "anthropic",
  });
  await fireTurn(hookSystem, model);
  await hookSystem.fireSubagentStopEvent({
    agent_id: "agent-1",
    agent_type: "explore",
    success: true,
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  await fireTurn(hookSystem, model);
  await hookSystem.firePostToolUseEvent(
    "bash",
    { command: "ls" },
    { output: "a" },
    false,
    "tool-2",
    { duration_ms: 3 },
  );
  await hookSystem.fireSessionEndEvent("exit", {
    total_cost_usd: 0.003,
    total_tokens_sent: 300,
    total_tokens_received: 150,
  });
}

// ============================================================
// 变异用的手工 span 构造（自证专用，不走探针）
// ============================================================

let seq = 0;
function makeSpan(overrides: Partial<SpanData> = {}): SpanData {
  seq++;
  const startTime = 1_000_000;
  return {
    traceId: "trace-a",
    spanId: `span-${seq}`,
    name: `span ${seq}`,
    kind: "chat",
    status: "ok",
    startTime,
    endTime: startTime + 100,
    durationMs: 100,
    attributes: {},
    events: [],
    ...overrides,
  };
}

// ============================================================
describe("span 树成形门禁（§0.3c）", () => {
  let bus: TelemetryBus;
  let spans: SpanData[];
  let probe: TelemetryHookProbe;

  beforeEach(() => {
    const created = createEnabledBus();
    bus = created.bus;
    spans = created.spans;
    probe = new TelemetryHookProbe(bus, new TokenMeter(null, () => 0), {
      model: "claude-sonnet-4",
      provider: "anthropic",
      sessionId: "test-session",
    });
  });

  // ── 生产路径：跑真实探针，整棵树体检 ──

  test("单会话：生产探针产出的 span 集合通过三条判据", async () => {
    await runSession(probe, "claude-sonnet-4");
    await bus.flush();

    // 扫描面非空自证：span 一个都没产出时，三条判据会全部"通过"成绿灯
    expect(spans.length).toBeGreaterThan(5);
    expect(findSpanTreeViolations(spans)).toEqual([]);
  });

  test("单会话：根恰好一个，且是会话级 invoke_agent（锁语义不锁计数）", async () => {
    await runSession(probe, "claude-sonnet-4");
    await bus.flush();

    const roots = spans.filter((s) => s.parentSpanId === undefined);
    const traceIds = new Set(spans.map((s) => s.traceId));

    // 判据①的核心形态：不去重比两个总数
    expect(roots.length).toBe(traceIds.size);
    expect(roots.length).toBe(1);

    // 锁语义：根必须是会话级 invoke_agent，不能是子代理那种 invoke_agent。
    // 第一次栽的坑正是「invoke_agent 数 != 0」被子代理 span 顶成 PASS。
    const root = roots[0];
    expect(root.kind).toBe("invoke_agent");
    expect(root.attributes["gen_ai.agent.name"]).toBe("sid-code");
    expect(root.name).toBe("invoke_agent claude-sonnet-4");
  });

  test("多会话：N 条 trace 各自恰好一个根（跨 trace 不串门）", async () => {
    await runSession(probe, "claude-sonnet-4");
    await runSession(probe, "claude-sonnet-4");
    await bus.flush();

    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(2);
    expect(spans.filter((s) => s.parentSpanId === undefined).length).toBe(2);
    expect(findSpanTreeViolations(spans)).toEqual([]);
  });

  test("每个非根 span 都能一路解析到根（langfuse 式 orphan check）", async () => {
    await runSession(probe, "claude-sonnet-4");
    await bus.flush();

    const byId = new Map(spans.map((s) => [s.spanId, s]));
    for (const s of spans) {
      let cursor: SpanData | undefined = s;
      let hops = 0;
      while (cursor?.parentSpanId !== undefined) {
        cursor = byId.get(cursor.parentSpanId);
        expect(cursor).toBeDefined(); // 中途断链 = 悬空父
        hops++;
        expect(hops).toBeLessThan(spans.length); // 成环时兜底，不要死循环
      }
      expect(cursor!.parentSpanId).toBeUndefined();
    }
  });

  test("子代理 chat span 挂在子代理 invoke_agent 下（3 层树确实成形）", async () => {
    await runSession(probe, "claude-sonnet-4");
    await bus.flush();

    const subagent = spans.find(
      (s) => s.kind === "invoke_agent" && s.attributes["sidcode.subagent.id"] === "agent-1",
    );
    expect(subagent).toBeDefined();

    const nested = spans.filter((s) => s.parentSpanId === subagent!.spanId);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.some((s) => s.kind === "chat")).toBe(true);
  });

  // ── 变异自证：故意造违规，确认检查器会红 ──

  test("自证①：同一 trace 里两个根 → 判据①报错", () => {
    const bad = [
      makeSpan({ spanId: "r1", kind: "invoke_agent", parentSpanId: undefined }),
      makeSpan({ spanId: "r2", kind: "chat", parentSpanId: undefined }),
    ];
    const violations = findRootCountViolations(bad);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("有 2 个根");
  });

  test("自证①：一条 trace 一个根不报错（不是恒红的死断言）", () => {
    const good = [
      makeSpan({ spanId: "r1", kind: "invoke_agent", parentSpanId: undefined }),
      makeSpan({ spanId: "c1", kind: "chat", parentSpanId: "r1" }),
    ];
    expect(findRootCountViolations(good)).toEqual([]);
  });

  test("自证②：parentSpanId 指向不存在的 span → 判据②报错", () => {
    const bad = [
      makeSpan({ spanId: "r1", kind: "invoke_agent", parentSpanId: undefined }),
      makeSpan({ spanId: "c1", kind: "chat", parentSpanId: "ghost-parent" }),
    ];
    const violations = findDanglingParentViolations(bad);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("ghost-parent");
    expect(violations[0]).toContain("悬空");
  });

  test("自证②：父在另一条 trace 上 → 同样报错", () => {
    const bad = [
      makeSpan({ traceId: "trace-a", spanId: "r1", kind: "invoke_agent" }),
      makeSpan({ traceId: "trace-b", spanId: "c1", kind: "chat", parentSpanId: "r1" }),
    ];
    const violations = findDanglingParentViolations(bad);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("在另一条 trace");
  });

  test("自证③：chat 成为 chat 的父 → 判据③报错", () => {
    const bad = [
      makeSpan({ spanId: "p1", kind: "chat" }),
      makeSpan({ spanId: "c1", kind: "chat", parentSpanId: "p1" }),
    ];
    const violations = findNestingViolations(bad);
    expect(violations.some((v) => v.includes("非法嵌套"))).toBe(true);
  });

  test("自证③：子 span 起于父结束之后（栈错乱）→ 判据③报错", () => {
    const parent = makeSpan({
      spanId: "p1",
      kind: "invoke_agent",
      startTime: 1000,
      endTime: 2000,
    });
    const child = makeSpan({
      spanId: "c1",
      kind: "chat",
      parentSpanId: "p1",
      startTime: 2500, // 父已结束 500ms
      endTime: 2600,
    });
    const violations = findNestingViolations([parent, child]);
    expect(violations.some((v) => v.includes("时间错位"))).toBe(true);
  });

  test("自证③：同毫秒开始/结束不算错位（闭区间，避免误报）", () => {
    const parent = makeSpan({
      spanId: "p1",
      kind: "invoke_agent",
      startTime: 1000,
      endTime: 1000,
    });
    const child = makeSpan({
      spanId: "c1",
      kind: "execute_tool",
      parentSpanId: "p1",
      startTime: 1000,
      endTime: 1000,
    });
    expect(findNestingViolations([parent, child])).toEqual([]);
  });

  // ── 对照：旧判据在同一份破损数据上会判 PASS ──

  test("旧判据（sort -u 去重）会把「一棵树 28 个根」判成 PASS，新判据不会", () => {
    // 复刻实测形状：一条 trace 下 28 个孤儿根 span
    const broken: SpanData[] = Array.from({ length: 28 }, (_, i) =>
      makeSpan({ traceId: "trace-broken", spanId: `orphan-${i}`, kind: "chat" }),
    );

    // 旧判据：两边都 sort -u 后比条数
    const dedupedRootTraces = new Set(
      broken.filter((s) => s.parentSpanId === undefined).map((s) => s.traceId),
    ).size;
    const dedupedTraces = new Set(broken.map((s) => s.traceId)).size;
    expect(dedupedRootTraces).toBe(dedupedTraces); // 1 == 1 → 旧判据 PASS ❌

    // 新判据：不去重，直接比根总数与 trace 数
    const rootTotal = broken.filter((s) => s.parentSpanId === undefined).length;
    expect(rootTotal).toBe(28);
    expect(rootTotal).not.toBe(dedupedTraces);
    expect(findRootCountViolations(broken).length).toBe(1); // → 新判据 FAIL ✅
  });

  test("旧判据（invoke_agent 数 != 0）会被子代理 span 顶成 PASS", () => {
    // 只有子代理 span、没有会话根：第一次栽的坑
    const onlySubagent = [
      makeSpan({
        spanId: "sub-1",
        kind: "invoke_agent",
        name: "invoke_agent explore",
        attributes: { "gen_ai.agent.name": "subagent:explore", "sidcode.subagent.id": "a1" },
      }),
      makeSpan({ spanId: "c1", kind: "chat", parentSpanId: "sub-1" }),
    ];

    // 旧判据：invoke_agent 数 != 0 → PASS ❌
    expect(onlySubagent.filter((s) => s.kind === "invoke_agent").length).toBeGreaterThan(0);

    // 新判据锁语义：根必须是会话级 invoke_agent（agent.name == "sid-code"）
    const roots = onlySubagent.filter((s) => s.parentSpanId === undefined);
    expect(roots.length).toBe(1);
    expect(roots[0].attributes["gen_ai.agent.name"]).not.toBe("sid-code"); // → FAIL ✅
  });
});
