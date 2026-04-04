/**
 * 初始化辅助模块
 * 从 app.ts 提取的初始化逻辑：轨迹采集、遥测系统、系统提示词构建
 */

import type { Config } from "../config/config.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SessionState } from "../session/state.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import { getLogger, getSessionMetrics } from "../debug/index.ts";

/** 初始化轨迹采集 */
export async function initTraceCollector(
  config: Config,
  hookSystem: HookSystem,
): Promise<void> {
  const log = getLogger();
  if (!config.trace?.enabled) return;

  try {
    const { TraceCollector } = await import("../trace/collector.ts");
    const traceConfig = config.trace;
    let uploader: import("../trace/collector.ts").TraceUploaderInterface | null = null;

    if (traceConfig.upload?.url && traceConfig.upload?.token) {
      const { UploadManager } = await import("../trace/uploader.ts");
      const uploadMgr = new UploadManager({
        baseUrl: traceConfig.upload.url,
        token: traceConfig.upload.token,
        toolSource: traceConfig.upload.toolSource ?? "sid-code",
        userId: traceConfig.upload.userId,
        deviceId: traceConfig.upload.deviceId,
        maxRetries: traceConfig.upload.maxRetries ?? 5,
        retryBaseMs: traceConfig.upload.retryBaseMs ?? 2000,
        compress: traceConfig.upload.compress ?? true,
        outputDir: traceConfig.outputDir,
      });
      uploadMgr.startHealthCheck(traceConfig.upload.healthCheckIntervalMs ?? 60_000);
      uploader = uploadMgr;
      log.info("TRACE", `上传已启用: ${traceConfig.upload.url}`);
    }

    const collector = new TraceCollector(
      { outputDir: traceConfig.outputDir, maxSessionsRetained: traceConfig.maxSessionsRetained },
      uploader,
    );
    collector.registerHooks(hookSystem);
    log.info("TRACE", "轨迹采集已启用");
  } catch (err: any) {
    log.warn("TRACE", `轨迹采集初始化失败: ${err.message}`);
  }
}

/** 遥测初始化结果 */
export interface TelemetryInitResult {
  tokenMeter?: TokenMeter;
  telemetryProbe?: import("../telemetry/hook-probe.ts").TelemetryHookProbe;
}

/** 初始化遥测系统 */
export async function initTelemetrySystem(
  config: Config,
  hookSystem: HookSystem,
  sessionState: SessionState,
  currentTokenMeter: TokenMeter | undefined,
): Promise<TelemetryInitResult> {
  const log = getLogger();
  const result: TelemetryInitResult = {};

  try {
    const { initTelemetry, getTelemetryBus } = await import("../telemetry/index.ts");
    const telemetryConfig = config.telemetry;
    if (telemetryConfig?.enabled) {
      initTelemetry(telemetryConfig);
      const { TokenMeter } = await import("../telemetry/metrics/token-meter.ts");
      result.tokenMeter = new TokenMeter(
        getTelemetryBus(),
        (model, usage) => sessionState.calculateCost(model, usage),
      );
      log.info("TELEMETRY", `遥测已启用，导出器: ${telemetryConfig.exporters?.map((e: any) => e.type).join(", ") ?? "无"}`);

      const { TelemetryHookProbe } = await import("../telemetry/hook-probe.ts");
      const probe = new TelemetryHookProbe(getTelemetryBus(), result.tokenMeter, {
        model: config.model,
        provider: config.provider,
        sessionId: sessionState.sessionId,
      });
      probe.registerHooks(hookSystem);
      result.telemetryProbe = probe;
      log.info("TELEMETRY", "TelemetryHookProbe 已注册");
    }
  } catch (err: any) {
    log.warn("TELEMETRY", `遥测初始化失败: ${err.message}`);
  }

  // SessionMetrics Hook 注册
  getSessionMetrics().registerHooks(hookSystem);

  return result;
}

/** 构建系统提示词 */
export async function buildInitialSystemPrompt(config: Config, tools: import("../tool/types.ts").Tool[]): Promise<string> {
  const log = getLogger();

  if (config.systemPrompt) {
    return config.systemPrompt;
  }

  const { loadAllCLAUDEmd } = await import("../config/rules.ts");
  const projectRules = await loadAllCLAUDEmd(process.cwd());

  let filePrompt: string | undefined;
  if (config.systemPromptFile) {
    try {
      const content = await Bun.file(config.systemPromptFile).text();
      filePrompt = content;
      log.debug("APP", `加载系统提示词文件: ${config.systemPromptFile}`);
    } catch (err) {
      log.error("APP", `加载系统提示词文件失败: ${err}`);
    }
  }

  let memorySummary: string | undefined;
  try {
    const { MemoryStore } = await import("../memory/store.ts");
    const memStore = new MemoryStore(process.cwd());
    memorySummary = await memStore.generateSummary() || undefined;
    if (memorySummary) {
      log.debug("APP", `加载记忆摘要 (${memorySummary.length} 字符)`);
    }
  } catch (err) {
    log.warn("APP", `加载记忆失败: ${err}`);
  }

  const { buildSystemPrompt } = await import("../config/system-prompt.ts");
  return buildSystemPrompt({
    tools,
    projectRules: projectRules?.rawContent,
    projectRulesPath: projectRules?.sourcePath,
    appendPrompt: config.appendSystemPrompt || undefined,
    filePrompt,
    workingDir: process.cwd(),
    permissionMode: config.permissionMode,
    gitStatus: true,
    memorySummary,
    maxTokens: 180000,
  });
}
