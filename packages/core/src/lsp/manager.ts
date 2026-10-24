/**
 * LSP 系统全局单例与懒初始化
 *
 * 对标 Claude Code 的 manager.ts：
 * - 代数计数器防止过期的异步初始化 Promise 更新状态
 * - 失败后可重试
 * - collectDiagnosticText() 供 Agent 循环每轮注入诊断
 */

import { LSPServerManager } from "./server-manager.ts";
import {
  DiagnosticRegistry,
  MAIN_DIAGNOSTIC_OWNER,
  type CollectStats,
} from "./diagnostic-registry.ts";
import { registerLSPNotificationHandlers, formatDiagnostics } from "./passive-feedback.ts";
import { loadLSPConfigs } from "./config.ts";
import { getLogger } from "../debug/logger.ts";

type InitState = "not-started" | "pending" | "success" | "failed";

let instance: LSPServerManager | undefined;
let diagnosticRegistry: DiagnosticRegistry | undefined;
let initState: InitState = "not-started";
let initGeneration = 0; // 代数计数器（对标 Claude Code）
/** lsp.json 的配置错误摘要（面向用户），并入 getLSPHealthWarning 的一次性告警 */
let configErrors: string[] = [];

export { MAIN_DIAGNOSTIC_OWNER };

/** LSP 诊断注入事件名（events.jsonl）。每次 collect 一条，无论有没有注入。 */
export const LSP_DIAGNOSTICS_EVENT_NAME = "LspDiagnostics";

/**
 * 诊断注入进轨迹的模块级通道。
 *
 * 此前这条链路零埋点，只能 grep raw.jsonl 里的注入文本，看不到四件事：限流截了多少、
 * 过滤后为空而整轮不注入、推送是不是基于旧版本、子代理有没有收到。事后翻轨迹无从证伪。
 * 与 ReadHint 同款：主循环与子代理多处调用，App 在 collector 就绪后注入；未注入或抛错一律静默。
 */
export type LspDiagnosticsTraceSink = (data: Record<string, unknown>) => void;
let diagnosticsSink: LspDiagnosticsTraceSink | null = null;

/** 注入/清除诊断注入埋点通道（null = 关闭，测试收尾复位用） */
export function setLspDiagnosticsTraceSink(s: LspDiagnosticsTraceSink | null): void {
  diagnosticsSink = s;
}

function emitCollectStats(owner: string, stats: CollectStats): void {
  if (!diagnosticsSink) return;
  // 两次 collect 之间什么都没发生：不写，否则每轮都有一条全 0 的事件
  if (stats.outcome === "empty" && stats.publishes === 0) return;
  try {
    diagnosticsSink({
      ...(owner === MAIN_DIAGNOSTIC_OWNER ? {} : { agent_id: owner }),
      outcome: stats.outcome,
      files: stats.files,
      actionable: stats.actionable,
      already_delivered: stats.alreadyDelivered,
      injected: stats.injected,
      carried: stats.carried,
      omitted_info: stats.omittedInfo,
      publishes: stats.publishes,
      publishes_with_version: stats.publishesWithVersion,
      stale_syncing: stats.staleSyncing,
      stale_version: stats.staleVersion,
    });
  } catch {
    /* 度量不影响注入 */
  }
}

/**
 * 初始化 LSP 系统（懒初始化）。
 * 代数计数器防止过期的异步初始化更新状态；失败后可重试。
 */
export function initializeLSP(workspaceFolder: string): void {
  if (instance && initState !== "failed") return;

  // 重置失败状态
  if (initState === "failed") {
    instance = undefined;
    diagnosticRegistry = undefined;
    configErrors = [];
  }

  instance = new LSPServerManager();
  diagnosticRegistry = new DiagnosticRegistry();
  initState = "pending";

  const currentGen = ++initGeneration;

  void loadLSPConfigs(workspaceFolder)
    .then(async ({ configs, errors }) => {
      if (currentGen !== initGeneration) return; // 过期的初始化
      // 配置错误先存下来：即便没有任何可用配置（下面提前 return），用户也该看到
      // "你的 lsp.json 没生效"，而不是以为自己配对了。
      configErrors = errors;
      if (Object.keys(configs).length === 0) {
        initState = "success"; // 无配置也算成功
        return;
      }

      await instance!.initialize(configs);
      registerLSPNotificationHandlers(instance!, diagnosticRegistry!);
      initState = "success";
      getLogger().info("LSP", `LSP 系统初始化完成，${Object.keys(configs).length} 个服务器`);
    })
    .catch((err) => {
      if (currentGen !== initGeneration) return;
      initState = "failed";
      getLogger().error("LSP", `LSP 系统初始化失败: ${err.message}`);
    });
}

/** 获取 LSP 管理器实例（仅初始化成功后返回） */
export function getLSPManager(): LSPServerManager | undefined {
  return initState === "success" ? instance : undefined;
}

/** 获取诊断注册表 */
export function getDiagnosticRegistry(): DiagnosticRegistry | undefined {
  return diagnosticRegistry;
}

/** 当前初始化状态（供调试） */
export function getLSPInitState(): InitState {
  return initState;
}

/**
 * 已注册的 LSP 服务器数量（同步读，供 tool/lsp.ts 的 isEnabled 使用）。
 *
 * 为什么需要它：`initState === "success"` **不代表有服务器可用** ——
 * 上面 initializeLSP 里"无配置也算成功"（一台没装任何 language server 的机器就是这种），
 * 于是仅凭 initState 判定会让 `lsp` 工具常驻工具列表，每轮白付一份工具定义的 token，
 * 而模型看到的是一个**一调用就必然失败**（getServerForFile 未命中 → 安装引导）的工具，
 * 还要额外浪费一轮工具调用。
 *
 * 刻意不复用 getLSPHealth()：那个要遍历所有实例、构造快照数组，而这里只要一个数字，
 * 且调用点在每次工具组装的热路径上。
 */
export function getLSPServerCount(): number {
  return instance?.getAllServers().size ?? 0;
}

/**
 * lsp.json 的配置错误摘要（面向用户）。
 *
 * 与日志的区别：日志给排查者，这个给"以为自己配对了"的用户 —— 见
 * config.ts 的 LSPConfigLoadResult 注释。
 */
export function getLSPConfigErrors(): string[] {
  return configErrors;
}

/** 单个 LSP 服务器的健康快照（G4） */
export interface LSPServerHealth {
  name: string;
  state: import("./types.ts").LSPServerState;
  crashCount: number;
  /** 崩溃重启已耗尽——服务器不再自动恢复，对用户不可用 */
  restartsExhausted: boolean;
}

/** 整个 LSP 系统的健康快照（G4） */
export interface LSPHealth {
  initState: InitState;
  servers: LSPServerHealth[];
}

/**
 * 获取 LSP 系统健康快照（G4：可观测性）。
 *
 * 供 `/doctor` 式命令或状态展示消费——让"服务器启动失败 / 崩溃超限"对用户可见，
 * 而非静默降级后无从排查。无实例时返回当前 initState + 空服务器列表。
 */
export function getLSPHealth(): LSPHealth {
  if (!instance) return { initState, servers: [] };
  const servers: LSPServerHealth[] = [];
  for (const [name, inst] of instance.getAllServers()) {
    servers.push({
      name,
      state: inst.state,
      crashCount: inst.crashCount,
      restartsExhausted: inst.restartsExhausted,
    });
  }
  return { initState, servers };
}

/**
 * 生成一句话的 LSP 健康告警（G4），无异常时返回 null。
 *
 * "异常"= 初始化失败，或任一服务器崩溃重启耗尽 / 处于 error 态。供上层（TUI 状态栏 /
 * 启动后一次性提示）在有问题时才打扰用户，正常时静默。
 */
export function getLSPHealthWarning(): string | null {
  const health = getLSPHealth();
  if (health.initState === "failed") {
    return "LSP 系统初始化失败，代码智能功能不可用（可用 LSP 工具时也会降级）。";
  }
  const broken = health.servers.filter((s) => s.restartsExhausted || s.state === "error");
  if (broken.length > 0) {
    const detail = broken
      .map(
        (s) => `${s.name}（崩溃 ${s.crashCount} 次${s.restartsExhausted ? "，已停止重启" : ""}）`,
      )
      .join("、");
    return `LSP 服务器异常：${detail}。相关语言的代码智能功能可能不可用。`;
  }
  // 配置错误排在服务器异常之后：后者是"已经在用但坏了"，更紧急；
  // 但配置错误也必须有出口，否则 best-effort 降级对用户完全不可见。
  if (configErrors.length > 0) {
    return `LSP 配置有 ${configErrors.length} 处问题被跳过：${configErrors.join("；")}`;
  }
  return null;
}

/**
 * 通知 LSP 文件变更（write/edit 工具后调用）。
 * LSP 未就绪时静默跳过。
 */
export async function notifyFileChanged(filePath: string, content: string): Promise<void> {
  const manager = getLSPManager();
  if (!manager) return;
  await manager.changeFile(filePath, content);
}

/**
 * 编辑/写入文件后，把最新内容同步给 LSP 的完整编排（主循环与子代理共用）。
 *
 * 提取自 query/tool-executor.ts 的 notifyLSPFileChange，消除主循环与子代理两套重复实现：
 *   1. beginEdit（**同步，先于任何 await**）：登记归属者，清该文件的旧诊断，进入同步窗口。
 *      调用方是 fire-and-forget 的，旧实现在 await readFile 之后才清，下一轮 collect
 *      可能抢在前面，把编辑前的诊断注入给模型。
 *   2. changeFile：发 didChange（首次见到文件则 didOpen），让服务器看到最新内容。
 *   3. endEdit（finally）：结束同步窗口，记下发出的版本号。
 *   4. saveFile：补发 didSave——部分服务器（pylsp、gopls 某些配置）依赖 didSave 触发完整诊断。
 *
 * LSP 未启用时不读盘直接返回。全程 best-effort：任何失败只记 debug 日志，绝不阻断工具执行。
 *
 * @param filePath 被编辑/写入的文件绝对路径
 * @param owner 诊断归属者：主循环传 MAIN_DIAGNOSTIC_OWNER（默认），子代理传自己的 agentId
 */
export async function syncFileToLSP(
  filePath: string,
  owner: string = MAIN_DIAGNOSTIC_OWNER,
): Promise<void> {
  if (!filePath) return;
  const manager = getLSPManager();
  const registry = getDiagnosticRegistry();
  if (!manager) return; // LSP 未启用，避免无谓读盘
  let uri: string | undefined;
  let seq = 0;
  let sentVersion: number | undefined;
  try {
    const { pathToFileURL } = require("url");
    uri = pathToFileURL(filePath).href as string;
    if (registry) seq = registry.beginEdit(uri, owner);
  } catch {
    uri = undefined; // 畸形路径：不登记，照常同步
  }
  try {
    const { readFile } = await import("fs/promises");
    const content = await readFile(filePath, "utf-8");
    sentVersion = await manager.changeFile(filePath, content);
  } catch (e) {
    getLogger().debug("LSP", `文件变更同步失败（不影响工具执行）: ${(e as Error)?.message}`);
  } finally {
    if (registry && uri) registry.endEdit(uri, seq, sentVersion);
  }
  if (sentVersion !== undefined) manager.saveFile(filePath);
}

/**
 * 子代理结束时把它名下文件的诊断归属转给主循环（见 DiagnosticRegistry.releaseOwner）。
 * LSP 未就绪时静默跳过。
 */
export function releaseDiagnosticOwner(owner: string): void {
  if (!owner || owner === MAIN_DIAGNOSTIC_OWNER) return;
  getDiagnosticRegistry()?.releaseOwner(owner);
}

/**
 * 收集待投递的诊断，格式化为附件文本。
 * 供主循环每轮注入 system-reminder 使用。
 *
 * 严重度过滤（对标方案风险缓解项）：逐条只保留 Error / Warning，Hint / Info 不注入，
 * 末尾附一行被省略的条数——避免对模型刷无关紧要的提示、浪费 token。过滤后若一条都
 * 不剩则整批跳过（返回 null），保持"有真问题才打扰"的克制。
 *
 * 每个消费者只拿自己编辑过的文件（归属见 DiagnosticRegistry），主循环还额外拿到
 * 已结束子代理转交的文件、以及只被 lsp 工具打开过的文件在基线之后新出现的诊断。
 *
 * @param owner 诊断归属者：主循环传 MAIN_DIAGNOSTIC_OWNER（默认），子代理传自己的 agentId
 * @returns 格式化文本，无可操作诊断时返回 null
 */
export function collectDiagnosticText(owner: string = MAIN_DIAGNOSTIC_OWNER): string | null {
  const registry = getDiagnosticRegistry();
  if (!registry) return null;

  // 严重度过滤在 registry 内、**限流之前**完成：旧实现在这里过滤，Hint 已经占掉了
  // 30 条名额。评估会话 ce7ea52e 实测 120 次注入里 606 条 Hint 混在 443 条 Error 中。
  const { files, stats } = registry.collectDiagnostics(owner);
  emitCollectStats(owner, stats);
  if (files.length === 0) return null;

  const notes: string[] = [];
  if (stats.carried > 0) {
    notes.push(`另有 ${stats.carried} 条 Error/Warning 超出单次上限，将在后续轮次补发`);
  }
  if (stats.omittedInfo > 0) notes.push(`另有 ${stats.omittedInfo} 条提示（Hint/Info）已省略`);
  const text = formatDiagnostics(files);
  return notes.length > 0 ? `${text}\n（${notes.join("；")}）` : text;
}

/**
 * 清除指定文件的诊断状态（pending / delivered / latest）。
 *
 * 对标 Claude Code 的 clearDeliveredDiagnosticsForFile。编辑路径走 syncFileToLSP 的
 * beginEdit（它内部会清），这里留给不经编辑同步的调用方。LSP 未就绪时静默跳过。
 */
export function clearDiagnosticsForFile(filePath: string): void {
  const registry = getDiagnosticRegistry();
  if (!registry) return;
  try {
    const { pathToFileURL } = require("url");
    registry.clearForFile(pathToFileURL(filePath).href);
  } catch {
    // 路径转 URL 失败（极少数畸形路径）静默忽略，绝不影响主流程
  }
}

/**
 * 等待 LSP 系统就绪（LSP 查询工具执行前调用）。
 *
 * 工具调用时服务器可能仍在初始化（initState=pending），直接发请求会失败。
 * 此函数轮询 initState：success 立即返回 true；failed / not-started 立即返回 false；
 * pending 则等待至 success 或超时。对标 Claude Code 的 waitForInitialization。
 *
 * @param timeoutMs 最长等待毫秒数（默认 10s）
 * @returns 是否就绪
 */
export function waitForLSPReady(timeoutMs = 10000): Promise<boolean> {
  if (initState === "success") return Promise.resolve(true);
  if (initState === "failed" || initState === "not-started") return Promise.resolve(false);

  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (initState === "success") {
        clearInterval(timer);
        resolve(true);
      } else if (initState === "failed" || Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

/** 重新初始化（插件刷新时调用） */
export function reinitializeLSP(workspaceFolder: string): void {
  if (initState === "not-started") return;

  // 最佳努力关闭旧实例
  if (instance) void instance.shutdown().catch(() => {});

  instance = undefined;
  diagnosticRegistry = undefined;
  initState = "not-started";
  initGeneration++;
  configErrors = [];

  initializeLSP(workspaceFolder);
}

/** 关闭 LSP 系统 */
export async function shutdownLSP(): Promise<void> {
  initGeneration++; // 使任何在途初始化失效
  if (instance) await instance.shutdown();
  instance = undefined;
  diagnosticRegistry = undefined;
  initState = "not-started";
  configErrors = [];
}

/** 重置单例（测试用） */
export function resetLSPForTest(): void {
  instance = undefined;
  diagnosticRegistry = undefined;
  initState = "not-started";
  initGeneration++;
  configErrors = [];
}
