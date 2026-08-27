/**
 * 漏斗 2 · 权限：`permission_deny` 必须覆盖**全部**鉴权路径（A7.13.2）
 *
 * ## 这个文件防的那个具体形态
 *
 * `logPermissionDeny` 原先只有主循环（`query/tool-executor.ts`）在调。
 * 子代理（`agent/tool-executor.ts`）与 forked agent（`agent/forked-agent.ts`）
 * 各有自己的鉴权分支、各自 `return` error tool_result，**一条埋点都不发** ——
 * 于是「子代理被权限层打残」这个形态在 `permission_deny` 上完全隐身。
 *
 * 这与本仓修过的两笔同构债一模一样：
 *   - `logContextCompact` 的 `trigger:"manual"` 曾零 producer（手动 /compact 真压缩了却不发）
 *   - `logPermissionPrompt` 至今在开发机恒 0（那条是路径没走到，不是接线缺陷）
 * 共同的失效特征：**代码完整、单测通过、那一档的调用点为零**，而没有调用点
 * 不是断言能失败的形态 —— 所以必须专门写一组"每条路径都要出事件"的断言。
 *
 * ## 为什么不能只靠 `instrumentation-sentinel.test.ts`
 *
 * 那个哨兵是**静态**扫描：`logPermissionDeny` 只要在任意一个文件里被调过一次
 * 就算通过。它拦不住"主循环调了、子代理没调"—— 而那正是这次的缺陷形态。
 * 这里是**行为**断言：真的跑一遍每条路径，看事件有没有出来、字段对不对。
 *
 * 隔离说明（CLAUDE.md 测试约定）：本文件不触发任何落盘。
 * 用内存 Sink 截获事件，`__resetAnalyticsForTest` 清理，不实例化 LocalEventBackend。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";
import { executeTools as executeSubAgentTools } from "@sid-code/core/agent/tool-executor.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { EVENT_NAMES } from "@sid-code/core/analytics/events.ts";

/** 收集型 Sink：把门面发出的事件截在内存里，不落盘 */
function captureEvents(): Array<{ name: string; meta: EventMetadata }> {
  const seen: Array<{ name: string; meta: EventMetadata }> = [];
  attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  return seen;
}

function denials(seen: Array<{ name: string; meta: EventMetadata }>) {
  return seen.filter((e) => e.name === EVENT_NAMES.PERMISSION_DENY);
}

function makeTool(opts: { name: string; concurrencySafe?: boolean }) {
  return {
    name: () => opts.name,
    description: () => `mock ${opts.name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => opts.concurrencySafe ?? true,
    isConcurrencySafe: () => opts.concurrencySafe ?? true,
    async execute() {
      return { output: `${opts.name} ok` };
    },
  };
}

function makeRegistry(tools: ReturnType<typeof makeTool>[]) {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return { get: (name: string) => byName.get(name) ?? null } as any;
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", id, name, input } as ContentBlock;
}

beforeEach(() => __resetAnalyticsForTest());
afterEach(() => __resetAnalyticsForTest());

describe("子代理路径：权限拒绝必须发 permission_deny", () => {
  test("checker 拒绝 → 出事件，且 context=subagent", async () => {
    const seen = captureEvents();

    const results = await executeSubAgentTools(
      [toolUse("s1", "bash", { command: "pytest" })],
      makeRegistry([makeTool({ name: "bash", concurrencySafe: false })]),
      undefined,
      undefined,
      {
        check: async () => ({
          allowed: false,
          reason: "非交互模式下自动拒绝",
          // smoke-8 那 113 次的真实形态：headless 把 ask 自动拒了
          decisionReason: { type: "other", reason: "非交互模式" },
        }),
      } as any,
    );

    // 前提：确实走到了权限拒绝分支（否则这个测试是空转）
    expect(String((results[0] as any)?.content)).toContain("权限拒绝");

    const d = denials(seen);
    expect(d).toHaveLength(1);
    // context 是这次修复的核心字段：不分路径则子代理的拒绝与主循环混在一桶里
    expect(d[0].meta.execution_context).toBe("subagent" as any);
    // reasonType 透传自 decisionReason.type —— 「headless 自动拒」与「deny 规则生效」
    // 在纯计数上同形而处置相反，这是唯一能分开它们的字段
    expect(d[0].meta.reason_type).toBe("other" as any);
    expect(d[0].meta.tool_name).toBe("bash" as any);
  });

  test("deny 规则命中 → reason_type=rule（与 headless 自动拒区分开）", async () => {
    const seen = captureEvents();

    await executeSubAgentTools(
      [toolUse("s2", "bash", { command: "curl evil.example" })],
      makeRegistry([makeTool({ name: "bash", concurrencySafe: false })]),
      undefined,
      undefined,
      {
        check: async () => ({
          allowed: false,
          reason: "规则拒绝",
          decisionReason: { type: "rule", rule: "bash(curl:*)", behavior: "deny" },
        }),
      } as any,
    );

    const d = denials(seen);
    expect(d).toHaveLength(1);
    expect(d[0].meta.reason_type).toBe("rule" as any);
    // 这一格是「配置按预期生效」，处置是什么都不做 —— 与上一个用例语义相反
    expect(d[0].meta.execution_context).toBe("subagent" as any);
  });

  test("fail-closed 拒绝（漏传 checker）→ 也必须出事件，source=other", async () => {
    // 这条路是本仓修过的一个 P0 缺口的唯一可观测信号：自定义子代理路径漏传
    // permissionChecker，写类操作被 fail-closed 兜住。若它不发埋点，
    // 「调用方漏传检查器」就只能靠读日志发现。
    const seen = captureEvents();

    const results = await executeSubAgentTools(
      [toolUse("s3", "edit", { file_path: "/tmp/x" })],
      makeRegistry([makeTool({ name: "edit", concurrencySafe: false })]),
      undefined,
      undefined,
      undefined, // ← 刻意不传 checker
    );

    expect(String((results[0] as any)?.content)).toContain("fail-closed");

    const d = denials(seen);
    expect(d).toHaveLength(1);
    // source 填 "other" 而非 "rule"：这里根本没有规则参与，是缺依赖时的兜底档。
    // 填 "rule" 会让它在报表里伪装成"配置生效"。
    expect(d[0].meta.source).toBe("other" as any);
    expect(d[0].meta.execution_context).toBe("subagent" as any);
  });

  test("放行时不发 deny 事件（防止把成功也记成拒绝，那会让分母失真）", async () => {
    const seen = captureEvents();

    await executeSubAgentTools(
      [toolUse("s4", "read", { file_path: "/tmp/x" })],
      makeRegistry([makeTool({ name: "read", concurrencySafe: true })]),
      undefined,
      undefined,
      { check: async () => ({ allowed: true }) } as any,
    );

    expect(denials(seen)).toHaveLength(0);
  });
});

describe("字段契约：脱敏与枚举不许退化", () => {
  test("MCP 工具名在 deny 事件里也走脱敏（明文只出 mcp_tool）", async () => {
    // 门面顶部第 1 条硬约束：MCP 工具名含用户私有服务名，明文字段绝不能带。
    // 新增调用点最容易漏的就是这一层 —— 直调 logEvent 就绕过了。
    const seen = captureEvents();

    await executeSubAgentTools(
      [toolUse("s5", "mcp__acme_internal__deploy_prod", {})],
      makeRegistry([makeTool({ name: "mcp__acme_internal__deploy_prod", concurrencySafe: false })]),
      undefined,
      undefined,
      { check: async () => ({ allowed: false, reason: "拒" }) } as any,
    );

    const d = denials(seen);
    expect(d).toHaveLength(1);
    expect(d[0].meta.tool_name).toBe("mcp_tool" as any);
    // 任何非 _PROTECTED_ 字段都不得含真实服务名（比逐字段断言更强：
    // 将来新增明文字段时，漏脱敏会在这里被抓住）
    for (const [key, val] of Object.entries(d[0].meta)) {
      if (key.startsWith("_PROTECTED_")) continue;
      expect(String(val)).not.toContain("acme_internal");
      expect(String(val)).not.toContain("deploy_prod");
    }
  });

  test("不上报 reason 文本 —— 它含规则内容与入参片段（含路径）", async () => {
    const seen = captureEvents();

    await executeSubAgentTools(
      [toolUse("s6", "write", { file_path: "/Users/alice/secret/keys.env" })],
      makeRegistry([makeTool({ name: "write", concurrencySafe: false })]),
      undefined,
      undefined,
      {
        check: async () => ({
          allowed: false,
          reason: "路径验证: 写入路径在工作区外: /Users/alice/secret/keys.env",
          decisionReason: { type: "pathValidation", reason: "工作区外" },
        }),
      } as any,
    );

    const d = denials(seen);
    expect(d).toHaveLength(1);
    // 结构化 type 可以进（固定枚举），但**文本一个字都不许进**
    expect(d[0].meta.reason_type).toBe("pathValidation" as any);
    const serialized = JSON.stringify(d[0].meta);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("keys.env");
    expect(serialized).not.toContain("工作区外");
  });
});
