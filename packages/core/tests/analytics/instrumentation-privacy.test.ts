/**
 * 埋点脱敏与隐私门控行为测试（缺陷清单 P1-6 / P1-7 / P1-8）
 *
 * 与 instrumentation-sentinel.test.ts 分工：那个是**静态**门禁（有没有人调），
 * 这个是**行为**断言（调了之后行为对不对）。两者缺一不可——静态扫描拦不住
 * 「接上了但接错了」，行为测试拦不住「整块被删回去」。
 *
 * 隔离说明（CLAUDE.md 测试约定）：本文件不触发任何落盘。
 * events.ts 门面只调 analytics/index.ts 的 logEvent，未 attach Sink 时事件进内存队列，
 * 不落盘；测试用 __resetAnalyticsForTest 清理。LocalEventBackend 的落盘路径**不实例化**，
 * 只测其 send 的纯数据变换（把 record 构造逻辑与 fs 解耦后可直接断言）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  toolNameFields,
  filePathFields,
  logToolCall,
  logCommandInvoke,
  structuredErrorCode,
  EVENT_NAMES,
} from "@sid-code/core/analytics/events.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { PROTECTED_PREFIX } from "@sid-code/core/analytics/privacy.ts";
import {
  setConfiguredPrivacyLevel,
  isEssentialTrafficOnly,
} from "@sid-code/core/analytics/privacy-level.ts";
import { sendHealthAlerts } from "@sid-code/core/telemetry/provider-health.ts";

/** 收集型 Sink：把门面发出的事件截在内存里，不落盘 */
function captureEvents(): Array<{ name: string; meta: EventMetadata }> {
  const seen: Array<{ name: string; meta: EventMetadata }> = [];
  attachAnalyticsSink({
    logEvent: (name, meta) => seen.push({ name, meta }),
  });
  return seen;
}

describe("P1-6 · 工具名脱敏在门面里强制发生", () => {
  test("MCP 工具名脱敏成 mcp_tool，真名只进 _PROTECTED_ 通道", () => {
    const fields = toolNameFields("mcp__acme_internal__deploy_prod");

    // 明文字段只有脱敏版——非特权后端看不到 acme_internal
    expect(fields.tool_name).toBe("mcp_tool" as any);
    expect(fields.tool_is_mcp).toBe(true);

    // 真实 server / tool 名走受保护通道
    expect(fields[`${PROTECTED_PREFIX}mcp_server`]).toBe("acme_internal" as any);
    expect(fields[`${PROTECTED_PREFIX}mcp_tool`]).toBe("deploy_prod" as any);

    // 关键断言：任何**非** _PROTECTED_ 字段都不得含真实服务名。
    // 这条比逐字段断言更强——将来门面新增明文字段时，漏脱敏会在这里被抓住。
    for (const [key, val] of Object.entries(fields)) {
      if (key.startsWith(PROTECTED_PREFIX)) continue;
      expect(String(val)).not.toContain("acme_internal");
      expect(String(val)).not.toContain("deploy_prod");
    }
  });

  test("内置工具名保持原样（固定枚举，无 PII 风险）", () => {
    expect(toolNameFields("bash").tool_name).toBe("bash" as any);
    expect(toolNameFields("bash").tool_is_mcp).toBe(false);
    // 非 MCP 不产生 _PROTECTED_ 字段
    expect(Object.keys(toolNameFields("bash")).some((k) => k.startsWith(PROTECTED_PREFIX))).toBe(
      false,
    );
  });

  test("文件路径只出扩展名，绝不出路径本身", () => {
    const fields = filePathFields("/Users/alice/work/acme-client/src/secret.ts");
    expect(fields.file_ext).toBe("ts" as any);
    // 路径的任何片段都不得出现
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("acme-client");
    expect(serialized).not.toContain("secret");
  });

  test("无扩展名 / 超长扩展名走安全兜底（防哈希文件名泄露）", () => {
    expect(filePathFields("/tmp/Makefile").file_ext).toBe("none" as any);
    expect(filePathFields("/tmp/f.averyveryverylongext").file_ext).toBe("other" as any);
    // 空值不产生字段
    expect(filePathFields(undefined)).toEqual({});
  });
});

describe("P1-6 · 端到端：埋点发出的事件不含裸工具名", () => {
  beforeEach(() => __resetAnalyticsForTest());
  afterEach(() => __resetAnalyticsForTest());

  test("logToolCall 经门面后，明文字段无 MCP 服务名、无文件路径", () => {
    const seen = captureEvents();
    logToolCall("mcp__customer_crm__fetch", "/Users/bob/private/deal.md");

    expect(seen.length).toBe(1);
    expect(seen[0]!.name).toBe(EVENT_NAMES.TOOL_CALL);

    // 剥离受保护字段后（= 非特权后端所见），不得残留任何敏感串
    const publicView = Object.fromEntries(
      Object.entries(seen[0]!.meta).filter(([k]) => !k.startsWith(PROTECTED_PREFIX)),
    );
    const serialized = JSON.stringify(publicView);
    expect(serialized).not.toContain("customer_crm");
    expect(serialized).not.toContain("bob");
    expect(serialized).not.toContain("deal");
    expect(serialized).toContain("mcp_tool"); // 脱敏版在
    expect(serialized).toContain("md"); // 扩展名在
  });

  test("自定义命令名进 _PROTECTED_ 通道，明文只出 custom 占位", () => {
    const seen = captureEvents();
    logCommandInvoke({
      commandName: "acme-deploy-prod",
      isBuiltin: false,
      commandType: "prompt",
      hasArgs: true,
    });

    expect(seen[0]!.meta.command_name).toBe("custom" as any);
    expect(seen[0]!.meta[`${PROTECTED_PREFIX}command_name`]).toBe("acme-deploy-prod" as any);
  });

  test("内置命令名明文上报（固定枚举，是分析所需且无 PII）", () => {
    const seen = captureEvents();
    logCommandInvoke({
      commandName: "compact",
      isBuiltin: true,
      commandType: "local",
      hasArgs: false,
    });
    expect(seen[0]!.meta.command_name).toBe("compact" as any);
    expect(seen[0]!.meta[`${PROTECTED_PREFIX}command_name`]).toBeUndefined();
  });
});

describe("错误码只取结构化字段，不解析 message 文本", () => {
  test("读 code / status / errno", () => {
    expect(structuredErrorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(structuredErrorCode({ status: 429 })).toBe("http_429");
    expect(structuredErrorCode({ errno: -2 })).toBe("errno_-2");
  });

  test("只有 message 时返回 undefined（不从文本里挖）", () => {
    // 关键：错误文本常带路径/命令行/密钥片段，绝不能被当成 error_code 上报
    expect(
      structuredErrorCode(new Error("failed to read /Users/alice/.ssh/id_rsa")),
    ).toBeUndefined();
  });

  test("超长 code 视为不可信，不上报", () => {
    expect(structuredErrorCode({ code: "x".repeat(64) })).toBeUndefined();
  });
});

describe("P1-8 · essential-traffic 拦住绕过 sink 的外发通道", () => {
  const savedEnv = process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

  beforeEach(() => {
    setConfiguredPrivacyLevel(null);
    delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  });

  afterEach(() => {
    setConfiguredPrivacyLevel(null);
    // 存/恢复而非无条件 delete：bun test 同批多文件跑在同一进程，
    // 无条件删会抹掉别的测试或 preload 设的值（CLAUDE.md 测试约定第 1 条）。
    if (savedEnv === undefined) delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    else process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = savedEnv;
  });

  test("告警 webhook 在 essential-traffic 下被拦截（不发起网络请求）", async () => {
    process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    expect(isEssentialTrafficOnly()).toBe(true);

    // 用一个必然连不通的地址：若门控失效而真发了请求，会走到 fetch 失败分支，
    // 返回的 error 不会是我们的门控原因——据此区分「被拦住」与「发了但失败」。
    const result = await sendHealthAlerts(
      {
        alerts: [{ severity: "warn", message: "probe" }],
      } as any,
      { webhookUrl: "http://127.0.0.1:1/should-never-be-called" },
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain("essential-traffic");
  });

  test("default 级别下不被门控拦截（拦截是级别驱动，不是常关）", async () => {
    setConfiguredPrivacyLevel("default");
    const result = await sendHealthAlerts(
      { alerts: [{ severity: "warn", message: "probe" }] } as any,
      { webhookUrl: "http://127.0.0.1:1/unreachable", timeoutMs: 300 },
    );
    // 门控没拦 → 真去发了 → 因地址不可达而失败。
    // 断言「失败原因不是门控」，即证明这条路在 default 下是通的。
    expect(result.sent).toBe(false);
    expect(result.error ?? "").not.toContain("essential-traffic");
  });

  test("无告警时静默跳过（门控不改变原有短路语义）", async () => {
    const result = await sendHealthAlerts({ alerts: [] } as any, {
      webhookUrl: "http://127.0.0.1:1/x",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBeUndefined();
  });
});
