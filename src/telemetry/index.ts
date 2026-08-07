/**
 * 遥测模块统一入口
 * 初始化 TelemetryBus + 注册导出器
 */

export { TelemetryBus, SpanHandle } from "./bus.ts";
export { TraceContext, generateTraceId, generateSpanId } from "./context.ts";
export { ConsoleExporter } from "./exporters/console.ts";
export { JsonlExporter } from "./exporters/jsonl.ts";
export { OtlpTelemetryExporter } from "./exporters/otlp.ts";
export type { OtlpTelemetryExporterOptions } from "./exporters/otlp.ts";
export { TokenMeter } from "./metrics/token-meter.ts";
export type { TokenUsageRecord, TokenRecordParams, CostCalculator } from "./metrics/token-meter.ts";
export { BudgetTracker } from "./metrics/budget-tracker.ts";
export type { BudgetRule, BudgetAlert, BudgetRuleStatus } from "./metrics/budget-tracker.ts";
export { TelemetryHookProbe } from "./hook-probe.ts";
export type { SpanEnricher } from "./hook-probe.ts";
export type {
  SpanData, SpanEvent, SpanKind, SpanStatus,
  Attributes, AttributeValue, MetricPoint,
  TelemetryExporter, TelemetryConfig, TelemetryExporterConfig,
} from "./types.ts";
export { ATTR } from "./types.ts";

import { TelemetryBus } from "./bus.ts";
import { ConsoleExporter } from "./exporters/console.ts";
import { JsonlExporter } from "./exporters/jsonl.ts";
import { OtlpTelemetryExporter } from "./exporters/otlp.ts";
import type { TelemetryConfig, TelemetryExporterConfig } from "./types.ts";

/** 全局单例 */
let globalBus: TelemetryBus | null = null;

/** 获取全局遥测总线（未初始化时返回禁用的总线） */
export function getTelemetryBus(): TelemetryBus {
  if (!globalBus) {
    globalBus = new TelemetryBus({ enabled: false });
  }
  return globalBus;
}

/** 初始化遥测系统 */
export function initTelemetry(config: Partial<TelemetryConfig>): TelemetryBus {
  const bus = new TelemetryBus(config);

  if (config.enabled && config.exporters) {
    for (const exporterConfig of config.exporters) {
      const exporter = createExporter(exporterConfig);
      if (exporter) bus.addExporter(exporter);
    }
  }

  if (config.enabled) {
    bus.start();
  }

  globalBus = bus;
  return bus;
}

/**
 * 根据配置创建导出器。
 *
 * 新增 case 时记得同步 `types.ts` 的 TelemetryExporterConfig、
 * `config/config.ts` 的同名类型、以及 `config/schema.ts` 的 VALID_EXPORTER_TYPES
 * —— 少改一处就会退化成「配了但被静默跳过」。
 */
function createExporter(config: TelemetryExporterConfig) {
  switch (config.type) {
    case "console":
      return new ConsoleExporter(config.options as any);
    case "jsonl":
      return new JsonlExporter(config.options as any);
    case "otlp":
      return new OtlpTelemetryExporter(config.options as any);
    default:
      return null;
  }
}

/** 关闭遥测系统 */
export async function shutdownTelemetry(): Promise<void> {
  if (globalBus) {
    await globalBus.shutdown();
    globalBus = null;
  }
}
