/**
 * IDE 集成相关类型定义
 * 对标 Claude Code 的 src/utils/ide.ts
 */

/** Lockfile 内容格式（IDE 扩展写入 ~/.sid-code/ide/<port>.lock） */
export interface IDELockfileContent {
  /** IDE 打开的工作区目录 */
  workspaceFolders?: string[];
  /** IDE 进程 PID（用于过期清理） */
  pid?: number;
  /** IDE 名称（VS Code / Cursor / JetBrains 等） */
  ideName?: string;
  /** 传输协议 */
  transport?: "ws" | "sse";
  /** 是否运行在 Windows 上（WSL 场景） */
  runningInWindows?: boolean;
  /** 认证令牌 */
  authToken?: string;
}

/** 检测到的 IDE 信息 */
export interface DetectedIDE {
  /** 连接 URL（ws://127.0.0.1:<port> 或 http://127.0.0.1:<port>） */
  url: string;
  /** IDE 名称 */
  name: string;
  /** 监听端口 */
  port: number;
  /**
   * IDE 进程 PID（仅当进程仍存活时才有值）。
   * 用于多个窗口打开同一工作区时的消歧：lockfile 的 PID 落在我们进程的祖先链上，
   * 说明这个窗口就是启动我们的那个。
   */
  pid?: number;
  /** 认证令牌 */
  authToken?: string;
  /** 是否运行在 Windows 上 */
  ideRunningInWindows?: boolean;
}

/** IDE 连接状态 */
export type IDEConnectionStatus = "connected" | "disconnected" | "pending" | null;
