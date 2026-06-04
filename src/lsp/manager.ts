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
 * 收集待投递的诊断，格式化为附件文本。
 * 供 buildSystemPrompt 的 diagnostics 字段使用。
 * @returns 格式化文本，无诊断时返回 null
 */
export function collectDiagnosticText(): string | null {
  const registry = getDiagnosticRegistry();
  if (!registry) return null;

  const files = registry.collectDiagnostics();
  if (files.length === 0) return null;

  return formatDiagnostics(files);
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
