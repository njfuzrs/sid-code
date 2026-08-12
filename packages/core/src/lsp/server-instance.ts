/**
 * LSPServerInstance — 单服务器生命周期管理
 *
 * 对标 Claude Code 的 LSPServerInstance：
 * - 状态机：stopped → starting → running → stopping / error
 * - 崩溃恢复：自动重启，最多 maxRestarts 次（默认 3）
 * - 请求重试：ContentModified（-32801）等瞬态错误指数退避重试
 * - 懒启动：ensureStarted() 在第一次请求时才启动
 */

import { LSPClient } from "./client.ts";
import type { LSPServerConfig, LSPServerState } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** ContentModified 错误码（LSP 规范） */
const CONTENT_MODIFIED = -32801;
/** 重试退避（毫秒） */
const RETRY_DELAYS = [500, 1000, 2000];

export class LSPServerInstance {
  readonly name: string;
  readonly config: LSPServerConfig;
  private client: LSPClient;
  private _state: LSPServerState = "stopped";
  private crashRecoveryCount = 0;
  private startPromise: Promise<void> | null = null;
  /** 待重新注册的通知处理器（崩溃重启后恢复） */
  private notificationHandlers: Array<{ method: string; handler: (params: unknown) => void }> = [];

  constructor(config: LSPServerConfig) {
    this.name = config.name;
    this.config = config;
    this.client = new LSPClient(config.name);
    this.client.onCrash = () => this.handleCrash();
  }

  get state(): LSPServerState {
    return this._state;
  }

  /** 已发生的崩溃恢复次数（G4：健康状态展示用） */
  get crashCount(): number {
    return this.crashRecoveryCount;
  }

  /** 崩溃次数是否已耗尽重启上限（G4：耗尽后服务器不再自动重启，对用户不可用） */
  get restartsExhausted(): boolean {
    return this.crashRecoveryCount >= (this.config.maxRestarts ?? 3) && this._state === "error";
  }

  /** 懒启动：确保服务器已启动 */
  async ensureStarted(): Promise<void> {
    if (this._state === "running") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /** 启动：初始化 LSP 握手 + capabilities 声明 */
  async start(): Promise<void> {
    const log = getLogger();
    if (this._state === "running" || this._state === "starting") return;

    this._state = "starting";
    try {
      await this.client.start(this.config.command, this.config.args ?? [], {
        env: this.config.env,
        cwd: this.config.workspaceFolder,
      });

      // 重新注册崩溃前的通知处理器
      for (const { method, handler } of this.notificationHandlers) {
        this.client.onNotification(method, handler);
      }

      const timeout = this.config.startupTimeout ?? 30000;
      const { pathToFileURL } = await import("url");
      const rootUri = pathToFileURL(this.config.workspaceFolder).href;

      await this.client.sendRequest(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: this.name }],
          initializationOptions: this.config.initializationOptions,
          capabilities: {
            textDocument: {
              synchronization: { didSave: true, dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: true },
              // G7：声明查询能力，否则服务器可能不返回 definition/references/hover 等结果。
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: {},
              implementation: { linkSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              callHierarchy: { dynamicRegistration: false },
              // codeAction：声明支持 literal 形态 + isPreferred，否则部分服务器只回 Command
              // 或不返回 quickfix。仅 pull 式按需查询用（LSPTool 的 codeAction 操作），不做推送。
              codeAction: {
                codeActionLiteralSupport: {
                  codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
                },
                isPreferredSupport: true,
              },
            },
            workspace: {
              workspaceFolders: true,
              symbol: { dynamicRegistration: false },
              // G8：声明支持 configuration 请求，与 client.ts 的 workspace/configuration 应答配套。
              configuration: true,
            },
          },
        },
        timeout,
      );

      this.client.sendNotification("initialized", {});
      this._state = "running";
      log.info("LSP", `[${this.name}] 已启动`);
    } catch (err: any) {
      this._state = "error";
      log.error("LSP", `[${this.name}] 启动失败: ${err.message}`);
      throw err;
    }
  }

  /** 停止：shutdown → exit → kill */
  async stop(): Promise<void> {
    if (this._state === "stopped") return;
    this._state = "stopping";
    try {
      if (this.client.isRunning()) {
        await this.client.sendRequest("shutdown", undefined, 3000).catch(() => {});
        this.client.sendNotification("exit");
      }
    } catch {
      /* 最佳努力 */
    }
    this.client.stop();
    this._state = "stopped";
  }

  /**
   * 请求：带 ContentModified 重试（指数退避 500ms/1s/2s）
   *
   * @param timeoutMs 单次请求超时。**必须透传**给 client——此前这里不接这个参数，
   *   所有请求一律吃 client.ts 的 30s 默认值，于是"最贵的请求形态"（整文件范围
   *   codeAction）配上"最长的超时"，用户要盯着光秃秃的 `⏺ lsp` 干等 30 秒才看到
   *   「LSP 请求超时」。省略时仍走 client 默认值，行为与改造前一致。
   */
  async sendRequest<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureStarted();

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        return await this.client.sendRequest<T>(method, params, timeoutMs);
      } catch (err: any) {
        lastErr = err;
        // 仅对 ContentModified 重试
        if (err.message?.includes(String(CONTENT_MODIFIED)) && attempt < RETRY_DELAYS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("LSP 请求失败");
  }

  /** 通知：didOpen / didChange / didSave / didClose */
  sendNotification(method: string, params?: unknown): void {
    this.client.sendNotification(method, params);
  }

  /** 注册通知处理器（publishDiagnostics 等） */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.push({ method, handler });
    this.client.onNotification(method, handler);
  }

  // ─── 崩溃恢复 ───

  private handleCrash(): void {
    const log = getLogger();
    const maxRestarts = this.config.maxRestarts ?? 3;

    if (this.crashRecoveryCount >= maxRestarts) {
      log.error("LSP", `[${this.name}] 崩溃次数超过上限 (${maxRestarts})，停止重启`);
      this._state = "error";
      return;
    }

    this.crashRecoveryCount++;
    this._state = "stopped";
    log.warn(
      "LSP",
      `[${this.name}] 第 ${this.crashRecoveryCount}/${maxRestarts} 次崩溃恢复，重启中...`,
    );

    // 重新创建 client 并重启
    this.client = new LSPClient(this.name);
    this.client.onCrash = () => this.handleCrash();
    void this.start().catch((err) => {
      log.error("LSP", `[${this.name}] 崩溃恢复失败: ${err.message}`);
    });
  }
}
