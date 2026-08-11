/**
 * LSP 系统全局单例与懒初始化
 *
 * 对标 Claude Code 的 manager.ts：
 * - 代数计数器防止过期的异步初始化 Promise 更新状态
 * - 失败后可重试
 * - collectDiagnosticAttachment() 供 Agent 循环每轮注入诊断
 */

import { LSPServerManager } from "./server-manager.ts";
import { DiagnosticRegistry } from "./diagnostic-registry.ts";
import { registerLSPNotificationHandlers, formatDiagnostics } from "./passive-feedback.ts";
import { loadLSPConfigs } from "./config.ts";
import { getLogger } from "../debug/logger.ts";

type InitState = "not-started" | "pending" | "success" | "failed";

let instance: LSPServerManager | undefined;
let diagnosticRegistry: DiagnosticRegistry | undefined;
let initState: InitState = "not-started";
let initGeneration = 0; // 代数计数器（对标 Claude Code）

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
  }

  instance = new LSPServerManager();
  diagnosticRegistry = new DiagnosticRegistry();
  initState = "pending";

  const currentGen = ++initGeneration;

  void loadLSPConfigs(workspaceFolder)
    .then(async (configs) => {
      if (currentGen !== initGeneration) return; // 过期的初始化
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
      .map((s) => `${s.name}（崩溃 ${s.crashCount} 次${s.restartsExhausted ? "，已停止重启" : ""}）`)
      .join("、");
    return `LSP 服务器异常：${detail}。相关语言的代码智能功能可能不可用。`;
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
 * 提取自 query/tool-executor.ts 的 notifyLSPFileChange，消除主循环与子代理两套重复实现，
 * 也让子代理路径（此前完全不通知 LSP）能复用同一套正确编排：
 *   1. clearDiagnosticsForFile：清该文件的跨轮次去重缓存，让服务器基于新内容重推的诊断
 *      能作为"新诊断"再次投递（否则修复后诊断不消失 / 过时错误驻留）。
 *   2. changeFile：发 didChange（首次见到文件则 didOpen），让服务器看到最新内容。
 *   3. saveFile：补发 didSave——部分服务器（pylsp、gopls 某些配置）依赖 didSave 触发完整诊断。
 *
 * LSP 未启用时不读盘直接返回。全程 best-effort：任何失败只记 debug 日志，绝不阻断工具执行。
 *
 * @param filePath 被编辑/写入的文件绝对路径
 */
export async function syncFileToLSP(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    if (!getLSPManager()) return; // LSP 未启用，避免无谓读盘
    const { readFile } = await import("fs/promises");
    const content = await readFile(filePath, "utf-8");
    clearDiagnosticsForFile(filePath);
    await notifyFileChanged(filePath, content);
    getLSPManager()?.saveFile(filePath);
  } catch (e) {
    getLogger().debug(
      "LSP",
      `文件变更同步失败（不影响工具执行）: ${(e as Error)?.message}`,
    );
  }
}

/**
 * 收集待投递的诊断，格式化为附件文本。
 * 供主循环每轮注入 system-reminder 使用。
 *
 * 严重度过滤（对标方案风险缓解项）：仅当本批诊断含 Error / Warning 时才注入，
 * 纯 Hint / Info 不注入——避免对模型刷无关紧要的提示、浪费 token。过滤后若只剩
 * Hint/Info 则整批跳过（返回 null），保持"有真问题才打扰"的克制。
 *
 * @param scopeFilePaths 可选的文件作用域（绝对路径）。传入时只收集这些文件的诊断，
 *   且只清空这些文件的 pending——供并发子代理隔离消费，避免与主循环 / 其它子代理互相偷诊断。
 *   不传时收集并清空全部 pending（主循环行为，保持不变）。
 * @returns 格式化文本，无诊断或仅含 Hint/Info 时返回 null
 */
export function collectDiagnosticText(scopeFilePaths?: Iterable<string>): string | null {
  const registry = getDiagnosticRegistry();
  if (!registry) return null;

  // 文件路径 → file:// URI（registry 内部以 URI 为 key）。畸形路径静默跳过。
  let scopeUris: string[] | undefined;
  if (scopeFilePaths) {
    const { pathToFileURL } = require("url");
    scopeUris = [];
    for (const p of scopeFilePaths) {
      try {
        scopeUris.push(pathToFileURL(p).href);
      } catch { /* 畸形路径跳过 */ }
    }
    // 显式传了作用域但没有一个合法 URI → 不误退化为全量消费，直接返回 null。
    if (scopeUris.length === 0) return null;
  }

  const files = registry.collectDiagnostics(scopeUris);
  if (files.length === 0) return null;

  // 仅保留含 Error/Warning 的文件；Hint/Info 不足以构成注入理由。
  const hasActionable = files.some((f) =>
    f.diagnostics.some((d) => d.severity === "Error" || d.severity === "Warning"),
  );
  if (!hasActionable) return null;

  return formatDiagnostics(files);
}

/**
 * 清除指定文件的已投递诊断记录（write/edit 工具编辑文件后调用）。
 *
 * 对标 Claude Code 的 clearDeliveredDiagnosticsForFile：编辑后旧诊断可能已失效，
 * 清除 delivered 缓存让服务器重新推送的诊断能作为"新诊断"再次投递，避免
 * 修复后的诊断被跨轮次去重永久过滤、或过时错误持续驻留。LSP 未就绪时静默跳过。
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

  initializeLSP(workspaceFolder);
}

/** 关闭 LSP 系统 */
export async function shutdownLSP(): Promise<void> {
  initGeneration++; // 使任何在途初始化失效
  if (instance) await instance.shutdown();
  instance = undefined;
  diagnosticRegistry = undefined;
  initState = "not-started";
}

/** 重置单例（测试用） */
export function resetLSPForTest(): void {
  instance = undefined;
  diagnosticRegistry = undefined;
  initState = "not-started";
  initGeneration++;
}
