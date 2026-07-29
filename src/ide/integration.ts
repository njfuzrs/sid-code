/**
 * IDE 集成入口
 * 负责 IDE 发现 → 连接 → 通知处理器注册 → 断开清理的完整生命周期。
 *
 * 设计原则（对标 spec §2.2）：
 * - IDE 是可选增强：没有 IDE 连接时所有功能正常工作
 * - 容错优先：IDE 断开不影响 sid-code 运行
 * - 协议复用：IDE 作为动态 MCP Server 接入，复用 MCPManager 基础设施
 */

import { findAvailableIDE } from "./detect.ts";
import type { DetectedIDE, IDEConnectionStatus } from "./types.ts";
import { IDESelectionSync } from "./selection.ts";
import { IDEMentionManager } from "./mention.ts";
import type { MCPManager } from "../mcp/manager.ts";
import type { MCPServerConfig } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";

/** IDE MCP server 在 MCPManager 中的固定名称 */
export const IDE_SERVER_NAME = "ide";

/** IDE 集成管理器 */
export class IDEIntegration {
  private mcpManager: MCPManager;
  private cwd: string;
  private discoveryTimeout: number;
  private currentIDE: DetectedIDE | null = null;
  private status: IDEConnectionStatus = null;

  /** 选区同步（Phase 2） */
  readonly selection = new IDESelectionSync();
  /** @提及管理（Phase 2） */
  readonly mentions = new IDEMentionManager();

  constructor(mcpManager: MCPManager, cwd: string, options?: { discoveryTimeout?: number }) {
    this.mcpManager = mcpManager;
    this.cwd = cwd;
    this.discoveryTimeout = options?.discoveryTimeout ?? 30_000;
  }

  /** 获取当前连接状态 */
  getStatus(): { status: IDEConnectionStatus; ideName: string | null } {
    return {
      status: this.status,
      ideName: this.currentIDE?.name ?? null,
    };
  }

  /** 当前连接的 IDE（可能为 null） */
  getCurrentIDE(): DetectedIDE | null {
    return this.currentIDE;
  }

  /**
   * 启动 IDE 自动发现与连接
   * 非阻塞：在后台轮询，发现 IDE 后自动连接。
   * @param force 跳过 shouldAutoConnect 检查（用于 /ide connect 手动触发）
   */
  async startAutoConnect(signal?: AbortSignal, force = false): Promise<void> {
    const log = getLogger();

    if (!force && !shouldAutoConnect()) {
      log.debug("IDE", "自动连接未启用，跳过 IDE 发现");
      return;
    }

    this.status = "pending";
    log.info("IDE", "开始搜索可用 IDE...");

    const ide = await findAvailableIDE(this.cwd, this.discoveryTimeout, signal);

    if (!ide) {
      this.status = null;
      log.debug("IDE", "未发现可用 IDE");
      return;
    }

    await this.connectToIDE(ide);
  }

  /** 手动连接到指定 IDE */
  async connectToIDE(ide: DetectedIDE): Promise<boolean> {
    const log = getLogger();

    try {
      this.status = "pending";
      log.info("IDE", `正在连接 ${ide.name} (${ide.url})...`);

      const transport: MCPServerConfig["transport"] = ide.url.startsWith("ws") ? "ws" : "sse";

      const config: MCPServerConfig = {
        transport,
        url: ide.url,
        authToken: ide.authToken,
        ideName: ide.name,
        ideRunningInWindows: ide.ideRunningInWindows,
        scope: "dynamic",
      };

      await this.mcpManager.addServer(IDE_SERVER_NAME, config);

      if (!this.mcpManager.isConnected(IDE_SERVER_NAME)) {
        this.status = "disconnected";
        log.error("IDE", `连接 ${ide.name} 失败`);
        return false;
      }

      this.currentIDE = ide;
      this.status = "connected";

      // 注册通知处理器（选区 / @提及）
      const client = this.mcpManager.getClient(IDE_SERVER_NAME);
      if (client) {
        this.selection.register(client);
        this.mentions.register(client);
      }

      log.info("IDE", `已连接到 ${ide.name}`);
      return true;
    } catch (err: any) {
      this.status = "disconnected";
      log.error("IDE", `连接 ${ide.name} 失败: ${err.message}`);
      return false;
    }
  }

  /** 断开 IDE 连接 */
  async disconnect(): Promise<void> {
    this.selection.unregister();
    this.mentions.unregister();
    if (this.currentIDE) {
      await this.mcpManager.removeServer(IDE_SERVER_NAME);
      this.currentIDE = null;
      this.status = "disconnected";
    }
  }
}

/**
 * 判断是否应该自动连接 IDE
 * 条件链（对标 Claude Code 的"或"链）：
 * 1. 环境变量指定端口
 * 2. 显式开启自动连接
 * 3. 在 IDE 内置终端中运行
 */
export function shouldAutoConnect(configAutoConnect?: boolean): boolean {
  return !!(
    // --ide flag / settings.json ide.autoConnect 显式开启（与 env 等价，A-4 子集）
    configAutoConnect ||
    process.env.SID_CODE_SSE_PORT ||
    process.env.SID_CODE_AUTO_CONNECT_IDE === "true" ||
    isSupportedTerminal()
  );
}

/** 检查是否在支持的 IDE 内置终端中运行 */
export function isSupportedTerminal(): boolean {
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  return ["vscode", "cursor", "windsurf"].includes(termProgram);
}

// ─── 全局单例（供命令 / app 初始化 / 工具 hook 共享） ───

let singleton: IDEIntegration | null = null;

/**
 * 获取（或惰性创建）全局 IDEIntegration 单例。
 * 首次调用时需提供 mcpManager 与 cwd；后续调用返回同一实例。
 */
export function getIDEIntegration(
  mcpManager?: MCPManager,
  cwd?: string,
  options?: { discoveryTimeout?: number },
): IDEIntegration | null {
  if (singleton) return singleton;
  if (!mcpManager || !cwd) return null;
  singleton = new IDEIntegration(mcpManager, cwd, options);
  return singleton;
}

/** 重置单例（测试用） */
export function resetIDEIntegration(): void {
  singleton = null;
}

/**
 * 收集当前 IDE 上下文（选区 + @提及）。
 * 无 IDE 连接或无有效数据时返回空对象。
 *
 * 注意：@提及为消费语义——调用一次后清空（避免重复注入）。
 *
 * ⚠ **不要用它喂 buildSystemPrompt**。IDE 上下文是会话中途才产生、且随用户每次
 * 操作变化的动态内容，塞进 system prompt 静态前缀有两个问题：
 *   ① 时序：连接是后台异步的（findAvailableIDE 以 1s 轮询重试至 30s 超时），
 *      而 buildInitialSystemPrompt 只在启动瞬间跑一次 → 那一刻必然还没连上；
 *   ② 缓存：选区每变一次就换一次静态前缀 → 每次都击穿 prompt cache。
 * 正路径是 {@link drainIDEContextDelta}，经 reminderParts 走 user 消息动态注入
 * （与 MCP server instructions 同一模式）。本函数保留供 /ide 状态展示与测试使用。
 */
export function collectIDEContext(): { ideSelection?: string; ideMention?: string } {
  if (!singleton || singleton.getStatus().status !== "connected") {
    return {};
  }

  const result: { ideSelection?: string; ideMention?: string } = {};

  const selection = singleton.selection.formatForAttachment();
  if (selection) result.ideSelection = selection;

  const mentions = singleton.mentions.consumeMentions();
  if (mentions.length > 0) {
    result.ideMention = mentions
      .map((m) => {
        const range = m.lineStart != null
          ? `:${m.lineStart + 1}${m.lineEnd != null ? `-${m.lineEnd + 1}` : ""}`
          : "";
        return `  - ${m.filePath}${range}`;
      })
      .join("\n");
  }

  return result;
}

// ─── IDE 上下文增量注入（对标 MCP server instructions 的 delta 模式）───

/**
 * 上次已注入的选区指纹。用于去重：选区没变就不重复注入（模型已经看到过），
 * 变了才注入新的一份。null 表示尚未注入过任何选区。
 *
 * 只存指纹不存正文：选区正文可能很大，没必要为去重再持有一份。
 */
let lastInjectedSelectionKey: string | null = null;

/** 选区指纹：文件 + 行范围 + 正文长度 + 正文本身（用后者兜住同位置改内容） */
function selectionKey(text: string): string {
  return `${text.length}:${text}`;
}

/**
 * 取一次待注入的 IDE 上下文增量（每轮 query loop 开始时调用）。
 *
 * 返回 null 表示本轮无新增内容。两类内容的语义不同：
 *   - **选区**：状态型。同一份选区只注入一次；用户改选区后再注入新的一份。
 *     选区自带 5 分钟 TTL（见 selection.ts），过期后视为无选区。
 *   - **@提及**：事件型（消费语义）。有就注入并清空，不做跨轮去重。
 *
 * 与直接塞 system prompt 的区别：本函数在**每轮**被调用，因此 IDE 何时连上都能
 * 赶上（不再依赖"启动瞬间已连接"这个几乎不可能成立的前提），且注入落在 user
 * 消息尾部而非静态前缀 → 不击穿 prompt cache。
 */
export function drainIDEContextDelta(): string | null {
  if (!singleton || singleton.getStatus().status !== "connected") {
    // 未连接（含断开）：复位指纹，重连后重新注入当前选区
    lastInjectedSelectionKey = null;
    return null;
  }

  const parts: string[] = [];

  const selection = singleton.selection.formatForAttachment();
  if (selection) {
    const key = selectionKey(selection);
    if (key !== lastInjectedSelectionKey) {
      lastInjectedSelectionKey = key;
      parts.push(`<ide-selection>\n${selection}\n</ide-selection>`);
    }
  } else {
    // 选区被清空 / TTL 过期：复位，下次有选区时（即使内容与上次相同）重新注入
    lastInjectedSelectionKey = null;
  }

  const mentions = singleton.mentions.consumeMentions();
  if (mentions.length > 0) {
    const lines = mentions
      .map((m) => {
        const range = m.lineStart != null
          ? `:${m.lineStart + 1}${m.lineEnd != null ? `-${m.lineEnd + 1}` : ""}`
          : "";
        return `  - ${m.filePath}${range}`;
      })
      .join("\n");
    parts.push(`<ide-mentions>\n用户在 IDE 中引用了以下代码位置：\n${lines}\n</ide-mentions>`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** 复位增量注入状态（测试用；生产中断开连接会自动复位） */
export function _resetIDEContextDeltaForTesting(): void {
  lastInjectedSelectionKey = null;
}
