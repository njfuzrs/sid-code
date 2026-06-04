/**
 * LSPServerManager — 多服务器路由与生命周期编排
 *
 * 对标 Claude Code 的 LSPServerManager：
 * - 按文件扩展名路由到对应 LSP 服务器
 * - 管理文件打开状态（didOpen/didChange/didClose）
 * - 统一启动/关闭所有服务器
 */

import { LSPServerInstance } from "./server-instance.ts";
import type { LSPServerConfig } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { extname } from "path";

export class LSPServerManager {
  private servers = new Map<string, LSPServerInstance>();
  /** 扩展名 → 服务器名 路由表 */
  private extensionRoutes = new Map<string, string>();
  /** 已打开文件的版本号（didChange 递增） */
  private openFiles = new Map<string, number>();

  /** 初始化所有 LSP 服务器（仅构建路由表，懒启动） */
  async initialize(configs: Record<string, LSPServerConfig>): Promise<void> {
    for (const [name, config] of Object.entries(configs)) {
      const instance = new LSPServerInstance(config);
      this.servers.set(name, instance);

      // 构建扩展名路由表
      for (const ext of Object.keys(config.extensionToLanguage)) {
        this.extensionRoutes.set(ext, name);
      }
    }
    getLogger().info("LSP", `已注册 ${this.servers.size} 个 LSP 服务器`);
  }

  /** 获取所有服务器实例 */
  getAllServers(): Map<string, LSPServerInstance> {
    return this.servers;
  }

  /** 根据文件路径路由到对应服务器 */
  getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = extname(filePath);
    const serverName = this.extensionRoutes.get(ext);
    return serverName ? this.servers.get(serverName) : undefined;
  }

  /** 获取文件对应的语言 ID */
  private getLanguageId(filePath: string, instance: LSPServerInstance): string {
    const ext = extname(filePath);
    return instance.config.extensionToLanguage[ext] ?? "plaintext";
  }

  /**
   * 通知 LSP 文件变更（write/edit 工具后调用）。
   * 首次见到文件发送 didOpen，之后发送 didChange。
   */
  async changeFile(filePath: string, content: string): Promise<void> {
    const instance = this.getServerForFile(filePath);
    if (!instance) return; // 无对应 LSP 服务器，静默跳过

    try {
      await instance.ensureStarted();

      const { pathToFileURL } = await import("url");
      const uri = pathToFileURL(filePath).href;
      const languageId = this.getLanguageId(filePath, instance);

      const existingVersion = this.openFiles.get(filePath);
      if (existingVersion === undefined) {
        // 首次打开
        this.openFiles.set(filePath, 1);
        instance.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId, version: 1, text: content },
        });
      } else {
        // 后续变更
        const version = existingVersion + 1;
        this.openFiles.set(filePath, version);
        instance.sendNotification("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text: content }], // 全量同步
        });
      }
    } catch (err: any) {
      getLogger().debug("LSP", `通知文件变更失败 ${filePath}: ${err.message}`);
    }
  }

  /** 关闭文件 */
  closeFile(filePath: string): void {
    const instance = this.getServerForFile(filePath);
    if (!instance || !this.openFiles.has(filePath)) return;

    this.openFiles.delete(filePath);
    void import("url").then(({ pathToFileURL }) => {
      instance.sendNotification("textDocument/didClose", {
        textDocument: { uri: pathToFileURL(filePath).href },
      });
    });
  }

  /** 关闭所有服务器 */
  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.values()).map((s) => s.stop().catch(() => {})),
    );
    this.servers.clear();
    this.extensionRoutes.clear();
    this.openFiles.clear();
  }
}
