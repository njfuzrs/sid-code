/**
 * LSP 代码智能层类型定义
 * 对标 Claude Code 的 src/services/lsp/types
 */

/** LSP 服务器配置 */
export interface LSPServerConfig {
  /** 服务器名称（用于日志和路由） */
  name: string;
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作区目录 */
  workspaceFolder: string;
  /** 文件扩展名 → 语言 ID 映射 */
  extensionToLanguage: Record<string, string>;
  /** 初始化选项（传给 LSP 服务器） */
  initializationOptions?: Record<string, unknown>;
  /** 启动超时（毫秒，默认 30000） */
  startupTimeout?: number;
  /** 最大崩溃重启次数（默认 3） */
  maxRestarts?: number;
}

/** LSP 服务器状态 */
export type LSPServerState = "stopped" | "starting" | "running" | "stopping" | "error";

/** 诊断严重程度 */
export type DiagnosticSeverity = "Error" | "Warning" | "Info" | "Hint";

/** 诊断信息 */
export interface Diagnostic {
  message: string;
  severity: DiagnosticSeverity;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
  code?: string | number;
}

/** 诊断文件 */
export interface DiagnosticFile {
  uri: string;
  diagnostics: Diagnostic[];
}
