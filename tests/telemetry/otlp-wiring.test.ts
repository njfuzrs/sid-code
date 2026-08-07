/**
 * OTLP 出口「接线」哨兵测试（P0-2 / P0-3）
 *
 * 这两条缺陷的成因不是实现有错，而是**实现写好了但配置层进不去**：
 *   P0-2：telemetry 的 exporter 白名单硬编码只允许 console/jsonl
 *   P0-3：analytics 的 OtlpExporter 有 202 行实现，但 init 分派 `type !== "http"` 直接 continue
 *
 * 所以这里断言的是「配了能到达」，而不是「payload 长什么样」（那部分在
 * otlp-exporter.test.ts）。少了这层断言，下次有人收窄白名单不会有任何测试变红——
 * 这正是原始缺陷能存活到现在的原因。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { initTelemetry, shutdownTelemetry } from "../../src/telemetry/index.ts";
import { OtlpTelemetryExporter } from "../../src/telemetry/exporters/otlp.ts";
import { OtlpExporter } from "../../src/analytics/exporters/otlp.ts";
import { validateConfig } from "../../src/config/schema.ts";

afterEach(async () => {
  await shutdownTelemetry();
});

// ============================================================
// P0-2：telemetry 白名单已拆开
// ============================================================
describe("P0-2 telemetry otlp 导出器可达", () => {
  test("initTelemetry 配 otlp 时真的注册了 OTLP 导出器（不再静默跳过）", () => {
    const bus = initTelemetry({
      enabled: true,
      exporters: [{ type: "otlp", options: { endpoint: "http://localhost:14318" } }],
    });
    // addExporter 是私有的，通过导出行为间接验证：注册成功则 exporters 非空。
    // 这里读私有字段是刻意的——公开 API 没有「列出已注册导出器」的入口，
    // 而这条断言正是防复发的核心，值得破一次封装。
    const exporters = (bus as any).exporters as Array<{ name: string }>;
    expect(exporters.map((e) => e.name)).toContain("otlp");
  });

  test("三种类型可共存：console + jsonl + otlp", () => {
    const bus = initTelemetry({
      enabled: true,
      exporters: [
        { type: "console", options: { verbosity: "off" } },
        { type: "jsonl" },
        { type: "otlp" },
      ],
    });
    const names = ((bus as any).exporters as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(["console", "jsonl", "otlp"]);
  });

  test("未知类型仍被跳过（白名单是放开一项，不是全放开）", () => {
    const bus = initTelemetry({
      enabled: true,
      exporters: [{ type: "not-a-real-exporter" as any }],
    });
    expect((bus as any).exporters).toHaveLength(0);
  });

  test("OTLP 导出器实现 TelemetryExporter 契约（含可选的 exportMetrics）", () => {
    const e = new OtlpTelemetryExporter();
    expect(typeof e.exportSpans).toBe("function");
    // metric 链路必须有出口，否则 bus.flushMetrics 会把它过滤掉
    expect(typeof e.exportMetrics).toBe("function");
    expect(typeof e.shutdown).toBe("function");
    expect(e.name).toBe("otlp");
  });

  test("schema 校验不再把 otlp 判为无效值", () => {
    const result = validateConfig({
      telemetry: { enabled: true, exporters: [{ type: "otlp" }] },
    } as any);
    const exporterWarnings = result.warnings.filter((w) =>
      w.path.startsWith("telemetry.exporters"),
    );
    expect(exporterWarnings).toEqual([]);
  });

  test("schema 仍对真正的无效导出器类型告警", () => {
    const result = validateConfig({
      telemetry: { enabled: true, exporters: [{ type: "carrier-pigeon" }] },
    } as any);
    const warning = result.warnings.find((w) => w.path === "telemetry.exporters[0].type");
    expect(warning).toBeDefined();
    // 告警文案要把 otlp 列进有效值，否则用户照着提示改还是配不出来
    expect(warning!.message).toContain("otlp");
  });
});

// ============================================================
// P0-3：analytics 后端 otlp 可达
// ============================================================
describe("P0-3 analytics otlp 后端可达", () => {
  test("OtlpExporter 满足 SinkBackend 契约，可被 registerBackend 接受", () => {
    const e = new OtlpExporter({ name: "corp-otlp" });
    expect(e.name).toBe("corp-otlp");
    expect(typeof e.accepts).toBe("function");
    expect(typeof e.send).toBe("function");
    expect(typeof e.shutdown).toBe("function");
    // 非特权后端默认脱敏 _PROTECTED_* 字段
    expect(e.stripProtected).toBe(true);
    // init 分派会调这个做跨会话恢复
    expect(typeof e.recoverFromDisk).toBe("function");
  });

  test("schema 校验放开 otlp 类型", () => {
    const result = validateConfig({
      analytics: {
        backends: [{ name: "corp", type: "otlp", endpoint: "http://collector:4318/v1/logs" }],
      },
    } as any);
    expect(result.warnings.filter((w) => w.path.startsWith("analytics.backends"))).toEqual([]);
  });

  test("otlp 后端省略 endpoint 只提示回退，不当成错误", () => {
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      const result = validateConfig({
        analytics: { backends: [{ name: "corp", type: "otlp", endpoint: "" }] },
      } as any);
      const w = result.warnings.find((x) => x.path === "analytics.backends[0].endpoint");
      expect(w).toBeDefined();
      expect(w!.message).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      // 是 warning 不是 error：缺 endpoint 有默认兜底，配置整体仍有效
      expect(result.errors.filter((e) => e.path.startsWith("analytics.backends"))).toEqual([]);
    } finally {
      // 存原值恢复，不无条件 delete（bun test 同批共用进程）
      if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });

  test("http 后端缺 endpoint 仍然告警（没有兜底可用）", () => {
    const result = validateConfig({
      analytics: { backends: [{ name: "corp", type: "http", endpoint: "" }] },
    } as any);
    const w = result.warnings.find((x) => x.path === "analytics.backends[0].endpoint");
    expect(w).toBeDefined();
    expect(w!.message).toContain("不能为空");
  });

  test("未知后端类型仍告警，且文案列出 otlp", () => {
    const result = validateConfig({
      analytics: { backends: [{ name: "corp", type: "ftp", endpoint: "ftp://x" }] },
    } as any);
    const w = result.warnings.find((x) => x.path === "analytics.backends[0].type");
    expect(w).toBeDefined();
    expect(w!.message).toContain("otlp");
  });

  test("endpoint 省略时补全为 OTEL_EXPORTER_OTLP_ENDPOINT + /v1/logs", async () => {
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as any;

    try {
      const e = new OtlpExporter({ name: "corp", endpoint: undefined });
      e.send("tool_used", { tool_name: "Read" } as any);
      await e.flush();
      expect(urls).toEqual(["http://collector:4318/v1/logs"]);
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });
});
