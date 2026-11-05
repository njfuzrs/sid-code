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
import { BarrierGate } from "./barrier.ts";
import { createHash } from "crypto";
import { extname } from "path";

/** 文件内容指纹。用于判定「服务器侧内容」与「磁盘内容」是否已经分叉（带外修改） */
export function contentHash(content: string): string {
  return createHash("sha1").update(content, "utf-8").digest("hex");
}

/**
 * 屏障请求用的 method。
 *
 * 为什么选它：tsls / gopls / rust-analyzer 都实现，返回体小、不产生副作用
 * （`workspace/executeCommand` 有副作用，`$/` 前缀的自定义请求服务器可能不回）。
 * 实测 tsls 5.1.3 上 6000 行文件的往返 60–130ms。
 */
const BARRIER_METHOD = "textDocument/documentSymbol";

/** 读取文件 stat；失败时返回哨兵值（漂移校验会因 mtimeMs 不匹配而多读一次盘，代价可忽略） */
async function statOrUnknown(filePath: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const { stat } = await import("fs/promises");
    const st = await stat(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

/** 服务器侧该文件的已同步状态 */
export interface SentFileState {
  /** 发给服务器的文档版本（didOpen=1，didChange 递增） */
  version: number;
  /** 发给服务器内容的指纹（sha1） */
  hash: string;
  /** 发出 didChange 时磁盘的 mtimeMs；漂移校验的快路径基准 */
  mtimeMs: number;
  /** 发出 didChange 时磁盘的字节数；漂移校验的快路径基准 */
  size: number;
}

/** changeFile 的结果 */
export interface FileSyncResult {
  /** 本次发给服务器的文档版本；无对应服务器或发送失败时 undefined */
  version?: number;
  /**
   * 屏障：resolve true 表示服务器已按序处理完本次变更**且** flush 窗口已越过，
   * 之后到达的推送可判为新代际；false 表示失败/该服务器已关闭屏障（降级为 unverified）。
   */
  barrier?: Promise<boolean>;
}

export class LSPServerManager {
  private servers = new Map<string, LSPServerInstance>();
  /** 扩展名 → 服务器名 路由表 */
  private extensionRoutes = new Map<string, string>();
  /** 已打开文件的已同步状态（版本号 + 内容指纹 + 漂移快路径基准） */
  private openFiles = new Map<string, SentFileState>();
  /** 诊断屏障：didChange 之后紧跟一个廉价请求，用来划定「旧代际已排空」 */
  private barrierGate = new BarrierGate();

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
   *
   * 变更发出后立即挂一个**屏障**（`textDocument/documentSymbol`）：
   * 它的响应到达表示服务器已按序处理完本次变更。屏障 fire-and-forget，不阻塞调用方。
   * 见 barrier.ts 的注释——为什么「屏障」还不够、还要一个 flush 窗口。
   *
   * @returns 版本号 + 屏障 Promise；无对应服务器或发送失败时只返回空对象
   */
  async changeFile(filePath: string, content: string): Promise<FileSyncResult> {
    const instance = this.getServerForFile(filePath);
    if (!instance) return {}; // 无对应 LSP 服务器，静默跳过

    try {
      await instance.ensureStarted();

      const { pathToFileURL } = await import("url");
      const uri = pathToFileURL(filePath).href;
      const languageId = this.getLanguageId(filePath, instance);

      const sentState: Pick<SentFileState, "hash" | "mtimeMs" | "size"> = {
        hash: contentHash(content),
        ...(await statOrUnknown(filePath)),
      };

      const existing = this.openFiles.get(filePath);
      let version: number;
      // 是不是首次打开。**它决定要不要挂屏障**，理由见下方 barrier 处的注释
      let firstOpen = false;
      if (existing === undefined) {
        // 首次打开
        firstOpen = true;
        version = 1;
        instance.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId, version, text: content },
        });
      } else {
        // 后续变更
        version = existing.version + 1;
        instance.sendNotification("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text: content }], // 全量同步
        });
      }
      this.openFiles.set(filePath, { version, ...sentState });

      // 屏障只在 didChange 时挂，**didOpen 不挂**——这不是省一次请求，是正确性要求：
      //
      // 屏障窗口的语义是「didChange 之后仍可能推旧内容的诊断，所以这段统一不收」。
      // 而 didOpen 没有「旧代际」：服务器侧内容就是我们刚发过去的内容，它产生的任何推送
      // 都基于这份内容。给 didOpen 也开窗口的后果是：文件刚打开时 tsserver 还在加载，
      // 屏障请求要排队很久，窗口一旦拖长，首次推送被全部丢掉——而 tsls 只在内容变化时
      // 才重推，于是这个文件**永远拿不到诊断**（比过时更糟）。2026-11-05 e2e E3 实测复现。
      const barrier = firstOpen
        ? undefined
        : this.barrierGate.run(instance.name, () =>
            instance.sendRequest(
              BARRIER_METHOD,
              { textDocument: { uri } },
              this.barrierGate.timeout,
            ),
          );
      return { version, barrier };
    } catch (err: any) {
      getLogger().debug("LSP", `通知文件变更失败 ${filePath}: ${err.message}`);
      return {};
    }
  }

  /** 该文件的服务器侧已同步状态（供带外修改漂移校验）；未同步过时 undefined */
  getSentFileState(filePath: string): SentFileState | undefined {
    return this.openFiles.get(filePath);
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

  /**
   * G6：发送 didSave 通知（write/edit 工具变更后调用）。
   *
   * 部分 LSP 服务器依赖 didSave 而非 didChange 触发完整诊断刷新。仅对已打开文件
   * （openFiles 中有记录）发送——未 didOpen 的文件发 didSave 不合协议。最佳努力，
   * 静默失败。
   */
  saveFile(filePath: string): void {
    const instance = this.getServerForFile(filePath);
    if (!instance || !this.openFiles.has(filePath)) return;
    void import("url").then(({ pathToFileURL }) => {
      instance.sendNotification("textDocument/didSave", {
        textDocument: { uri: pathToFileURL(filePath).href },
      });
    });
  }

  /**
   * 打开文件（LSP 查询工具用，确保文件已 didOpen）。
   *
   * 与 changeFile 的区别：仅在文件**首次**见到时发送 didOpen，已打开则直接返回
   * （不发 didChange）。LSP 查询（definition/references/hover 等）要求目标文件
   * 已在服务器侧打开，否则服务器无该文件的 AST。工具执行前先调用此方法确保打开。
   */
  async openFile(filePath: string, content: string): Promise<void> {
    const instance = this.getServerForFile(filePath);
    if (!instance) return; // 无对应 LSP 服务器，静默跳过

    if (this.openFiles.has(filePath)) return; // 已打开，无需重复 didOpen

    await instance.ensureStarted();
    const { pathToFileURL } = await import("url");
    const uri = pathToFileURL(filePath).href;
    const languageId = this.getLanguageId(filePath, instance);

    // 记下内容指纹：漂移校验要拿它跟磁盘对比，判定「服务器侧内容是否已被带外修改甩开」
    this.openFiles.set(filePath, {
      version: 1,
      hash: contentHash(content),
      ...(await statOrUnknown(filePath)),
    });
    instance.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  /**
   * 通过文件对应的 LSP 服务器发送请求（LSP 查询工具用）。
   *
   * 路由到 getServerForFile 命中的实例并转发请求（带 ContentModified 重试）。
   * 无对应服务器时抛错，由调用方（LSP 工具）转为友好错误信息。
   */
  async sendRequest<T = unknown>(
    filePath: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const instance = this.getServerForFile(filePath);
    if (!instance) throw new Error(`无对应 LSP 服务器: ${filePath}`);
    return instance.sendRequest<T>(method, params, timeoutMs);
  }

  /** 关闭所有服务器 */
  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.servers.values()).map((s) => s.stop().catch(() => {})));
    this.servers.clear();
    this.extensionRoutes.clear();
    this.openFiles.clear();
  }
}
