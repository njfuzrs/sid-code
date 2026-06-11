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

    // 零依赖事件 API:绑定 Sink + 注册后端(spec 17 §3.1 / §3.2)
    // 即使 telemetry.exporters 为空也绑定,使 logEvent 队列得以排空(进入 no-op 后端)。
    await initAnalyticsSink(config, sessionState.sessionId);
  } catch (err: any) {
    log.warn("TELEMETRY", `遥测初始化失败: ${err.message}`);
  }

  // SessionMetrics Hook 注册
  getSessionMetrics().registerHooks(hookSystem);

  return result;
}

/**
 * 初始化零依赖事件 API 的 Sink 与后端(spec 17 §3.1/§3.2/§4.2/§5)。
 * 顺序:
 *   1. 应用配置文件中的隐私级别覆盖
 *   2. 初始化 Feature Flag 系统并接入采样/killswitch/元数据 hook
 *   3. 注册本地后端(JSONL,完整数据)与可选的远程 HTTP 后端(脱敏)
 *   4. 绑定 Sink,排空启动期暂存的 logEvent 事件
 */
async function initAnalyticsSink(config: Config, sessionId: string): Promise<void> {
  const log = getLogger();
  try {
    const { attachAnalyticsSink } = await import("../analytics/index.ts");
    const {
      createAnalyticsSink,
      registerBackend,
      setSamplingHook,
      setKillswitchHook,
      setMetadataHook,
    } = await import("../analytics/sink.ts");
    const { setConfiguredPrivacyLevel, shouldLoadRemoteConfig } = await import(
      "../analytics/privacy-level.ts"
    );

    // 1. 配置文件中的隐私级别覆盖
    const analyticsCfg = (config as any).analytics as
      | import("../config/config.ts").AnalyticsConfig
      | undefined;
    if (analyticsCfg?.privacyLevel) {
      setConfiguredPrivacyLevel(analyticsCfg.privacyLevel);
    }

    // 2. Feature Flag 系统(spec 17 §5.1) + 采样/killswitch/元数据 hook
    if (shouldLoadRemoteConfig()) {
      try {
        const { initFeatureFlags } = await import("../analytics/feature-flags.ts");
        const { getSidHome } = await import("../config/paths.ts");
        initFeatureFlags({
          configDir: getSidHome(),
          remoteEndpoint: analyticsCfg?.featureFlagEndpoint,
          localFlags: analyticsCfg?.flags,
        });

        const { shouldSampleEvent } = await import("../analytics/sampling.ts");
        const { isSinkKilled } = await import("../analytics/killswitch.ts");
        setSamplingHook(shouldSampleEvent);
        setKillswitchHook(isSinkKilled);
      } catch (ffErr: any) {
        log.debug("TELEMETRY", `Feature Flag 初始化跳过: ${ffErr?.message}`);
      }
    }

    // 元数据富化(spec 17 §5.3)
    try {
      const { getEventMetadataFields, primeMetadata } = await import(
        "../analytics/metadata.ts"
      );
      primeMetadata({
        sessionId,
        model: config.model,
        provider: config.provider,
      });
      setMetadataHook(getEventMetadataFields);
    } catch (mdErr: any) {
      log.debug("TELEMETRY", `元数据富化初始化跳过: ${mdErr?.message}`);
    }

    // 3. 注册后端
    // 本地 JSONL 后端:特权,完整数据(含 _PROTECTED_* 字段)
    try {
      const { LocalEventBackend } = await import("../analytics/exporters/local.ts");
      registerBackend(new LocalEventBackend(sessionId));
    } catch (lbErr: any) {
      log.debug("TELEMETRY", `本地事件后端跳过: ${lbErr?.message}`);
    }

    // 远程 HTTP 后端(spec 17 §4.2):非特权,脱敏数据
    if (analyticsCfg?.backends && shouldLoadRemoteConfig()) {
      for (const backendCfg of analyticsCfg.backends) {
        if (backendCfg.type !== "http") continue;
        try {
          const { HttpExporter } = await import("../analytics/exporters/http.ts");
          const { EventDiskCache } = await import("../analytics/disk-cache.ts");
          const { sidPaths } = await import("../config/paths.ts");
          const diskCache = new EventDiskCache({
            cacheDir: sidPaths.telemetry(),
            sessionId,
            maxRetries: 8,
          });
          // 跨会话恢复:重试上次未发送成功的事件
          const exporter = new HttpExporter({
            name: backendCfg.name,
            endpoint: backendCfg.endpoint,
            authHeader: backendCfg.authHeader,
            batchSize: backendCfg.batchSize,
            flushIntervalMs: backendCfg.flushIntervalMs,
            networkTimeoutMs: backendCfg.networkTimeoutMs,
            stripProtected: backendCfg.stripProtected ?? true,
            allowedEvents: backendCfg.allowedEvents
              ? new Set(backendCfg.allowedEvents)
              : undefined,
            diskCache,
          });
          registerBackend(exporter);
          void exporter.recoverFromDisk();
          log.info("TELEMETRY", `远程事件后端已注册: ${backendCfg.name}`);
        } catch (hbErr: any) {
          log.warn("TELEMETRY", `远程事件后端 ${backendCfg.name} 初始化失败: ${hbErr?.message}`);
        }
      }
    }

    // 4. 绑定 Sink,排空启动期事件
    attachAnalyticsSink(createAnalyticsSink());
    log.debug("TELEMETRY", "Analytics Sink 已绑定");
  } catch (err: any) {
    log.warn("TELEMETRY", `Analytics Sink 初始化失败: ${err?.message}`);
  }
}

/** 构建系统提示词 */
export async function buildInitialSystemPrompt(config: Config, tools: import("../tool/types.ts").Tool[]): Promise<string> {
  const log = getLogger();

  if (config.systemPrompt) {
    return config.systemPrompt;
  }

  // 评测隔离：SID_CODE_DISABLE_PROJECT_RULES=1 时不加载 CLAUDE.md（与 app.ts 同步）
  // 防止项目 CLAUDE.md 里的目录结构泄露成 case 锚点答案
  const disableProjectRules = process.env.SID_CODE_DISABLE_PROJECT_RULES === "1";
  const projectRules = disableProjectRules ? null : await (async () => {
    const { loadAllCLAUDEmd } = await import("../config/rules.ts");
    return loadAllCLAUDEmd(process.cwd());
  })();

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
  let memorySystemPrompt: string | undefined;
  try {
    const { MemoryStore } = await import("../memory/store.ts");
    const memStore = new MemoryStore(process.cwd());
    memorySummary = await memStore.generateSummary() || undefined;
    if (memorySummary) {
      log.debug("APP", `加载记忆摘要 (${memorySummary.length} 字符)`);
    }
    // Task 7：记忆系统指令 + MEMORY.md 索引
    const { buildMemorySystemPrompt } = await import("../memory/prompt.ts");
    const indexContent = await memStore.getIndexContent();
    memorySystemPrompt = buildMemorySystemPrompt(indexContent);
  } catch (err) {
    log.warn("APP", `加载记忆失败: ${err}`);
  }

  const { buildSystemPrompt } = await import("../config/system-prompt.ts");
  const { collectIDEContext } = await import("../ide/integration.ts");
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
    memorySystemPrompt,
    preferredLanguage: config.language,
    model: config.model,
    ...collectIDEContext(),
    maxTokens: 180000,
  });
}
