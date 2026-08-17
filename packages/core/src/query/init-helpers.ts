/**
 * 初始化辅助模块
 * 从 app.ts 提取的初始化逻辑：轨迹采集、遥测系统、系统提示词构建
 */

import type { Config } from "../config/config.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SessionState } from "../session/state.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import { getLogger, getSessionMetrics } from "../debug/index.ts";

/** 初始化轨迹采集，返回 collector 实例（供 engine 异常路径持久化） */
export async function initTraceCollector(
  config: Config,
  hookSystem: HookSystem,
): Promise<import("../trace/collector.ts").TraceCollector | null> {
  const log = getLogger();
  if (!config.trace?.enabled) return null;

  try {
    const { TraceCollector } = await import("../trace/collector.ts");
    const traceConfig = config.trace;
    let uploader: import("../trace/collector.ts").TraceUploaderInterface | null = null;

    // P1-8：essential-traffic 门控。轨迹上传是**非必要外发**（把本机 traj/raw/events
    // 整份传到远端平台），必须受最严格隐私级别约束。
    //
    // ⚠️ 这里的缺陷与清单文档描述的位置**不同**，别照文档改错地方：文档说
    // 「essential-traffic 静默无效、行为与 default 完全一致」，实测不成立——
    // privacy-level.ts:43 的 isTelemetryDisabled() 判的是 `!== "default"`，已覆盖
    // essential-traffic，sink.ts 的事件通道早就被拦住了。真正漏的是**不走 sink 的
    // 那两条外发通道**：轨迹上传（本处）与告警 webhook（provider-health.ts）。
    // 它们只看自己的开关，从不问隐私级别——配了 essential-traffic 的用户以为
    // 限制了数据外发，实际整份轨迹照传。这类缺陷比崩溃危险，因为它静默。
    const { isEssentialTrafficOnly } = await import("../analytics/privacy-level.ts");
    if (traceConfig.upload?.url && traceConfig.upload?.token && isEssentialTrafficOnly()) {
      log.info("TRACE", "隐私级别为 essential-traffic，轨迹上传已禁用（仅本地留存）");
    } else if (traceConfig.upload?.url && traceConfig.upload?.token) {
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
        deleteAfterUpload: traceConfig.upload.deleteAfterUpload ?? false,
        outputDir: traceConfig.outputDir,
        // §6.4：传入模型定价列表，使上传前 cost 校正能用权威 pricing 重算
        availableModels: config.availableModels,
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
    return collector;
  } catch (err: any) {
    log.warn("TRACE", `轨迹采集初始化失败: ${err.message}`);
    return null;
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
      result.tokenMeter = new TokenMeter(getTelemetryBus(), (model, usage) =>
        sessionState.calculateCost(model, usage),
      );
      log.info(
        "TELEMETRY",
        `遥测已启用，导出器: ${telemetryConfig.exporters?.map((e: any) => e.type).join(", ") ?? "无"}`,
      );

      const { TelemetryHookProbe } = await import("../telemetry/hook-probe.ts");
      const probe = new TelemetryHookProbe(getTelemetryBus(), result.tokenMeter, {
        model: config.model,
        provider: config.provider,
        sessionId: sessionState.sessionId,
      });
      probe.registerHooks(hookSystem);
      result.telemetryProbe = probe;
      log.info("TELEMETRY", "TelemetryHookProbe 已注册");

      // ── §三 P0-2：重建上一批未正常收尾的会话根 span ──
      //
      // 位置有两条硬约束，都不是风格问题：
      //  1. 必须在**本会话 fire SessionStart 之前** —— 那之后本会话自己的标记就落盘了，
      //     会被当成残留重建一遍。pid 存活判定挡得住，但不该依赖兜底。
      //     调用点在 app.ts 里被 initTelemetrySystem / fireSessionStartEvent 的顺序
      //     保证（那条时序不变量由 PR1 建立，见 app.ts 的注释与
      //     cli/tests/app/session-start-probe-wiring.test.ts 的静态门禁）。
      //  2. 必须在 `probe.registerHooks` 之后没有强制要求，但放这里能保证
      //     「遥测确实启用」——bus 未启用时 enqueueSpan 直接 return，扫一遍纯属白费。
      try {
        const { recoverPendingRootSpans } = await import("../telemetry/root-span-recovery.ts");
        const bus = getTelemetryBus();
        const r = recoverPendingRootSpans({
          enqueue: (span) => bus.enqueueSpan(span),
          availableModels: config.availableModels,
        });
        if (r.recovered > 0 || r.pruned > 0) {
          log.debug(
            "TELEMETRY",
            `根 span 重建: 重建 ${r.recovered} / 跳过存活 ${r.skippedAlive} / 清理过期 ${r.pruned}`,
          );
        }
      } catch (err: any) {
        // 重建失败只是少了历史会话的根 span，绝不影响本会话启动
        log.debug("TELEMETRY", `根 span 重建跳过: ${err?.message}`);
      }
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
    const { setConfiguredPrivacyLevel, shouldLoadRemoteConfig } =
      await import("../analytics/privacy-level.ts");

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
      const { getEventMetadataFields, primeMetadata } = await import("../analytics/metadata.ts");
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

    // 远程后端(spec 17 §4.2):非特权,脱敏数据。
    // 两种 type 走不同 exporter,但共用磁盘缓存与跨会话恢复能力:
    //   http → HttpExporter(自定义 JSON 批量端点)
    //   otlp → OtlpExporter(标准 OTLP/HTTP logs 协议)
    // 新增 type 必须同步 config.ts 的 AnalyticsBackendConfig 与 schema.ts 的校验白名单。
    if (analyticsCfg?.backends && shouldLoadRemoteConfig()) {
      for (const backendCfg of analyticsCfg.backends) {
        if (backendCfg.type !== "http" && backendCfg.type !== "otlp") continue;
        try {
          const { EventDiskCache } = await import("../analytics/disk-cache.ts");
          const { sidPaths } = await import("../config/paths.ts");
          const diskCache = new EventDiskCache({
            cacheDir: sidPaths.telemetry(),
            sessionId,
            maxRetries: 8,
          });
          const allowedEvents = backendCfg.allowedEvents
            ? new Set(backendCfg.allowedEvents)
            : undefined;

          let exporter: import("../analytics/sink.ts").SinkBackend & {
            recoverFromDisk(): Promise<void>;
          };
          if (backendCfg.type === "otlp") {
            const { OtlpExporter } = await import("../analytics/exporters/otlp.ts");
            exporter = new OtlpExporter({
              name: backendCfg.name,
              // 省略时由 OtlpExporter 回退到 OTEL_EXPORTER_OTLP_ENDPOINT
              endpoint: backendCfg.endpoint || undefined,
              authHeader: backendCfg.authHeader,
              batchSize: backendCfg.batchSize,
              flushIntervalMs: backendCfg.flushIntervalMs,
              networkTimeoutMs: backendCfg.networkTimeoutMs,
              stripProtected: backendCfg.stripProtected ?? true,
              allowedEvents,
              diskCache,
            });
          } else {
            const { HttpExporter } = await import("../analytics/exporters/http.ts");
            exporter = new HttpExporter({
              name: backendCfg.name,
              endpoint: backendCfg.endpoint,
              authHeader: backendCfg.authHeader,
              batchSize: backendCfg.batchSize,
              flushIntervalMs: backendCfg.flushIntervalMs,
              networkTimeoutMs: backendCfg.networkTimeoutMs,
              stripProtected: backendCfg.stripProtected ?? true,
              allowedEvents,
              diskCache,
            });
          }

          registerBackend(exporter);
          // 跨会话恢复:重试上次未发送成功的事件
          void exporter.recoverFromDisk();
          log.info("TELEMETRY", `远程事件后端已注册: ${backendCfg.name} (type=${backendCfg.type})`);
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

/**
 * 构建系统提示词
 *
 * @param onSectionTokens §12 P0-1：分段 token 记账回调，透传给 buildSystemPrompt。
 *   供 /context 把「记忆/CLAUDE.md」从系统提示词总量里拆成独立类别。
 */
export async function buildInitialSystemPrompt(
  config: Config,
  tools: import("../tool/types.ts").LegacyTool[],
  denyRulesSummary?: string,
  onSectionTokens?: (s: import("../config/system-prompt.ts").PromptSectionTokens) => void,
): Promise<string> {
  const log = getLogger();

  if (config.systemPrompt) {
    return config.systemPrompt;
  }

  // 评测隔离：SID_CODE_DISABLE_PROJECT_RULES=1 时不加载 CLAUDE.md（与 app.ts 同步）
  // 防止项目 CLAUDE.md 里的目录结构泄露成 case 锚点答案
  const disableProjectRules = process.env.SID_CODE_DISABLE_PROJECT_RULES === "1";
  const projectRules = disableProjectRules
    ? null
    : await (async () => {
        const { loadAllCLAUDEmd } = await import("../config/rules.ts");
        // activeFiles 不在此处传：loadAllCLAUDEmd 内部按自己算出的 projectRoot 自动采集
        // （见该函数 §2.5）。调用点手传会让 5 个入口各算一次 projectRoot、且新入口必然漏传。
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
    memorySummary = (await memStore.generateSummary()) || undefined;
    if (memorySummary) {
      log.debug("APP", `加载记忆摘要 (${memorySummary.length} 字符)`);
    }
    // Task 7：记忆系统指令 + MEMORY.md 索引
    const { buildMemorySystemPrompt } = await import("../memory/prompt.ts");
    const indexContent = await memStore.getIndexContent();

    // E.11：团队记忆启用时，把团队 MEMORY.md 索引一并注入，模型才能 Read 团队记忆。
    // 否则团队记忆只写不读，模型在会话里根本不知道团队知识存在。
    // 注意：直接读 config.teamMemory，不走 runtime 单例——本函数早于 app.ts
    // 的 setTeamMemoryOptions 执行，此刻单例尚未注入。
    let teamIndexContent: string | null = null;
    try {
      const { isTeamMemoryEnabled } = await import("../memory/team/paths.ts");
      if (isTeamMemoryEnabled(config.teamMemory)) {
        const { getTeamIndexContent } = await import("../memory/team/store.ts");
        teamIndexContent = await getTeamIndexContent(process.cwd());
      }
    } catch (err) {
      log.debug("APP", `团队记忆索引注入跳过: ${(err as Error)?.message}`);
    }

    memorySystemPrompt = buildMemorySystemPrompt(indexContent, teamIndexContent);
  } catch (err) {
    log.warn("APP", `加载记忆失败: ${err}`);
  }

  const { buildSystemPrompt } = await import("../config/system-prompt.ts");
  const { collectSkillListingEntries } = await import("../skill/listing.ts");
  // G12：加载激活的输出风格（配置态稳定，注入静态缓存区）
  let outputStyleContent: string | undefined;
  try {
    const { getActiveOutputStyleContent } = await import("../config/output-styles.ts");
    outputStyleContent = getActiveOutputStyleContent(config.outputStyle) || undefined;
  } catch {
    /* 加载失败静默降级 */
  }
  return buildSystemPrompt({
    tools,
    projectRules: projectRules?.rawContent,
    projectRulesPath: projectRules?.sourcePath,
    appendPrompt: config.appendSystemPrompt || undefined,
    filePrompt,
    outputStyleContent,
    workingDir: process.cwd(),
    permissionMode: config.permissionMode,
    gitStatus: true,
    memorySummary,
    memorySystemPrompt,
    preferredLanguage: config.language,
    model: config.model,
    availableModels: config.availableModels,
    // 缺口 E：把 SkillTool 摘要收集进 system prompt（接通此前死代码 generateSkillListingAttachment）
    skillEntries: collectSkillListingEntries(tools),
    // 缺口 D：deny 规则约束摘要（前置告知模型哪些操作必被拒绝）
    denyRulesSummary,
    // 审计第 22 条：IDE 选区/@提及**不再**从这里注入。
    // 原先 `...collectIDEContext()` 在此展开，但 IDE 连接是后台异步的（轮询至 30s 超时），
    // 而本函数只在启动瞬间跑一次 → 那一刻 status 必然还不是 connected，恒返回 {}；
    // 两处 rebuildSystemPrompt 也不采集，净效果是 IDE 上下文基本永远进不了模型。
    // 现改走 query loop 每轮的 reminderParts（drainIDEContextDelta），既解决时序
    // 又不把易变内容塞进静态前缀击穿 prompt cache。
    // §12 P0-1：分段记账（记忆/CLAUDE.md）上报给 /context
    onSectionTokens,
    // 不再写死 maxTokens：交由 buildSystemPrompt 按模型 contextWindow 的 90% 动态推导
  });
}
