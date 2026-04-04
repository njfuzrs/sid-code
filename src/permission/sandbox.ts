/**
 * macOS Seatbelt 沙箱管理器
 * 通过 sandbox-exec 限制 bash 命令的文件系统和网络访问
 * 仅 macOS 平台可用，其他平台降级为无沙箱
 */

import { homedir } from "os";
import { getLogger } from "../debug/logger.ts";

/** 沙箱配置 */
export interface SandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;
  /** 沙箱启用时自动放行 Bash（减少弹窗） */
  autoAllowBashIfSandboxed: boolean;
  /** 允许写入的额外目录 */
  allowedWritePaths: string[];
  /** 允许读取的额外目录 */
  allowedReadPaths: string[];
  /** 网络白名单主机 */
  allowedHosts: string[];
}

/** 沙箱违规事件 */
export interface SandboxViolation {
  timestamp: string;
  type: "fs_read" | "fs_write" | "network";
  path?: string;
  host?: string;
  command: string;
  blocked: boolean;
}

/** 默认沙箱配置 */
export function defaultSandboxConfig(): SandboxConfig {
  return {
    enabled: false,
    autoAllowBashIfSandboxed: true,
    allowedWritePaths: [],
    allowedReadPaths: [],
    allowedHosts: ["localhost"],
  };
}

export class SandboxManager {
  private config: SandboxConfig;
  private violations: SandboxViolation[] = [];
  private workspacePath: string;

  constructor(config: SandboxConfig, workspacePath: string) {
    this.config = config;
    this.workspacePath = workspacePath;
  }

  /** 沙箱是否启用 */
  isEnabled(): boolean {
    return this.config.enabled && process.platform === "darwin";
  }

  /** 是否应该自动放行 Bash */
  shouldAutoAllowBash(): boolean {
    return this.isEnabled() && this.config.autoAllowBashIfSandboxed;
  }

  /** 获取违规记录 */
  getViolations(): SandboxViolation[] {
    return [...this.violations];
  }

  /** 记录违规事件 */
  recordViolation(violation: SandboxViolation): void {
    this.violations.push(violation);
    const log = getLogger();
    log.warn("SANDBOX", `违规: ${violation.type} ${violation.path || violation.host || ""} (${violation.command.slice(0, 60)})`);
  }

  /**
   * 生成 macOS Seatbelt profile
   * 限制文件系统访问：只允许工作区 + 临时目录 + 系统库
   */
  generateSeatbeltProfile(): string {
    const home = homedir();
    const cwd = this.workspacePath;

    const lines: string[] = [
      "(version 1)",
      "(deny default)",
      "",
      ";; 允许进程执行",
      "(allow process-exec)",
      "(allow process-fork)",
      "",
      ";; 允许读取工作目录",
      `(allow file-read* (subpath "${cwd}"))`,
      "",
      ";; 允许写入工作目录",
      `(allow file-write* (subpath "${cwd}"))`,
      "",
      ";; 允许读取系统库和工具链",
      '(allow file-read* (subpath "/usr/lib"))',
      '(allow file-read* (subpath "/usr/bin"))',
      '(allow file-read* (subpath "/usr/local"))',
      '(allow file-read* (subpath "/Library/Developer"))',
      '(allow file-read* (subpath "/Applications/Xcode.app"))',
      "",
      ";; 允许临时目录",
      '(allow file-read* file-write* (subpath "/tmp"))',
      '(allow file-read* file-write* (subpath "/private/tmp"))',
      "",
      ";; 允许读取 HOME 下的工具配置（只读）",
      `(allow file-read* (subpath "${home}/.bun"))`,
      `(allow file-read* (subpath "${home}/.nvm"))`,
      `(allow file-read* (subpath "${home}/.npm"))`,
      `(allow file-read* (subpath "${home}/.cargo"))`,
      "",
      ";; 禁止访问敏感目录",
      `(deny file-read* file-write* (subpath "${home}/.ssh"))`,
      `(deny file-read* file-write* (subpath "${home}/.gnupg"))`,
      `(deny file-read* file-write* (subpath "${home}/.sid-code"))`,
    ];

    // 额外允许的读取路径
    for (const p of this.config.allowedReadPaths) {
      lines.push(`(allow file-read* (subpath "${p}"))`);
    }

    // 额外允许的写入路径
    for (const p of this.config.allowedWritePaths) {
      lines.push(`(allow file-read* file-write* (subpath "${p}"))`);
    }

    // 网络白名单
    lines.push("");
    lines.push(";; 网络访问");
    for (const host of this.config.allowedHosts) {
      lines.push(`(allow network* (remote ip "${host}:*"))`);
    }

    return lines.join("\n");
  }

  /**
   * 包装命令，添加沙箱限制
   * 非 macOS 或未启用时原样返回
   */
  wrapCommand(command: string): string {
    if (!this.isEnabled()) return command;

    const profile = this.generateSeatbeltProfile();
    // 转义单引号
    const escapedProfile = profile.replace(/'/g, "'\\''");
    const escapedCommand = command.replace(/'/g, "'\\''");
    return `sandbox-exec -p '${escapedProfile}' /bin/sh -c '${escapedCommand}'`;
  }
}
