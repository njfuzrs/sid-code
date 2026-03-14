/**
 * 权限检查器
 * 9 层权限检查：危险命令 → 禁用工具 → 路径安全 → 敏感文件 → 读操作 → 预授权 → deny-write → always-allow → 用户确认
 * 包含 25 种危险命令模式检测 + 路径遍历/系统目录保护 + 安全审计日志
 */

import type { Checker, Decision, PermissionRequest } from "./types.ts";
import type { Config } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";
import * as readline from "readline";
import * as path from "node:path";

/** 危险命令模式（对标 Claude Code 15 种） */
interface DangerousPattern {
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium";
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // critical: 直接拒绝，不允许确认
  { name: "递归删除根目录", pattern: /rm\s+(-[rf]*\s+)*\/($|\s)/, severity: "critical" },
  { name: "递归删除家目录", pattern: /rm\s+(-[rf]*\s+)*~/, severity: "critical" },
  { name: "磁盘擦除", pattern: /dd\s+if=\/dev\/(zero|random|urandom)/i, severity: "critical" },
  { name: "格式化磁盘", pattern: /mkfs\./, severity: "critical" },
  { name: "写入块设备", pattern: />\s*\/dev\/sd/, severity: "critical" },
  { name: "Fork 炸弹", pattern: /:()\s*\{.*:\|:.*&.*\}\s*;/, severity: "critical" },
  { name: "下载并执行", pattern: /(curl|wget).*\|\s*(sh|bash|python|perl|ruby)/, severity: "critical" },

  // high: 拒绝但允许用户确认
  { name: "sudo 命令", pattern: /sudo\s+/, severity: "high" },
  { name: "命令替换注入", pattern: /`[^`]*`|\$\([^)]*\)/, severity: "high" },
  { name: "递归权限修改", pattern: /chmod\s+-R\s+(777|666)/, severity: "high" },
  { name: "递归所有者修改", pattern: /chown\s+-R\s+/, severity: "high" },
  { name: "环境变量覆盖", pattern: /export\s+(PATH|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/, severity: "high" },

  // critical: 编码绕过执行
  { name: "base64 解码执行", pattern: /base64\s+(-d|--decode).*\|\s*(sh|bash|python|perl|ruby)/, severity: "critical" },
  { name: "xxd 解码执行", pattern: /xxd\s+-r.*\|\s*(sh|bash|python|perl|ruby)/, severity: "critical" },
  { name: "Python exec 执行", pattern: /python[23]?\s+-c\s+.*exec\s*\(/, severity: "critical" },
  { name: "Perl system 执行", pattern: /perl\s+-e\s+.*system\s*\(/, severity: "critical" },

  // high: 数据外传 + 敏感信息读取
  { name: "curl POST 数据外传", pattern: /curl\s+.*(-X\s*POST|--data|--data-binary|-d\s)/, severity: "high" },
  { name: "nc 管道外传", pattern: /\|\s*nc\s+/, severity: "high" },
  { name: "读取 shell 历史", pattern: /cat\s+.*\.(bash_history|zsh_history|history)/, severity: "high" },
  { name: "读取 SSH 密钥", pattern: /cat\s+.*\.ssh\/(id_rsa|id_ed25519|id_dsa|authorized_keys)/, severity: "high" },

  // medium: 需要用户确认
  { name: "路径遍历", pattern: /\.\.[\/\\]/, severity: "medium" },
  { name: "后台进程", pattern: /&\s*$/, severity: "medium" },
  { name: "管道到文件覆盖", pattern: />\s*\/etc\//, severity: "medium" },
  { name: "清除命令历史", pattern: /history\s+-c|>\s*.*\.(bash_history|zsh_history)/, severity: "medium" },
  { name: "修改 crontab", pattern: /crontab\s+(-e|-r|-l)/, severity: "medium" },
];

/** 敏感文件模式 */
const SENSITIVE_FILES = [
  /\.env$/,
  /\.env\..+/,
  /credentials/i,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /password/i,
  /secret/i,
  /\.aws\/config/,
  /\.kube\/config/,
  /token\.json/i,
];

/** 文件工具（需要路径校验） */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

/** 系统目录保护（写入拦截） */
const PROTECTED_WRITE_DIRS = [
  "/etc/", "/usr/", "/bin/", "/sbin/", "/boot/",
  "/proc/", "/sys/", "/dev/", "/var/log/",
  "/System/", "/Library/",
];

/** 系统目录保护（读取拦截） */
const PROTECTED_READ_DIRS = ["/proc/", "/sys/", "/dev/"];

/** 只读工具 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

/** 安全审计日志 */
function auditLog(
  event: string,
  severity: string,
  details: Record<string, unknown>,
): void {
  const log = getLogger();
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    severity,
    ...details,
  };
  log.warn("SECURITY", `[审计] ${event}`, entry);
}

export class PermissionChecker implements Checker {
  private config: Config;
  private preApproved = new Set<string>();

  constructor(config: Config) {
    this.config = config;
    // 加载预授权工具
    for (const tool of config.allowedTools) {
      this.preApproved.add(tool);
    }
  }

  async check(req: PermissionRequest): Promise<Decision> {
    // 跳过权限检查模式
    if (this.config.skipPermissions || this.config.yesMode) {
      return { allowed: true };
    }

    // 第 1 层：危险命令拦截（25 种模式）
    if (req.toolName === "bash") {
      const cmd = (req.input as any)?.command || "";
      for (const dp of DANGEROUS_PATTERNS) {
        if (dp.pattern.test(cmd)) {
          auditLog("dangerous_command_detected", dp.severity, {
            pattern: dp.name,
            command: cmd.slice(0, 200),
            toolName: req.toolName,
          });

          if (dp.severity === "critical") {
            // critical: 直接拒绝，不允许确认
            return {
              allowed: false,
              reason: `[${dp.severity}] 危险命令被拦截 (${dp.name}): ${cmd.slice(0, 80)}`,
            };
          }

          // high/medium: 需要用户确认
          return {
            allowed: false,
            reason: `[${dp.severity}] 危险命令需要确认 (${dp.name}): ${cmd.slice(0, 80)}`,
            needsConfirmation: true,
          };
        }
      }
    }

    // 第 2 层：禁用工具检查
    if (this.config.disallowedTools.includes(req.toolName)) {
      auditLog("disallowed_tool", "high", { toolName: req.toolName });
      return {
        allowed: false,
        reason: `工具 "${req.toolName}" 已被禁用`,
      };
    }

    // 第 3 层：文件路径安全校验（路径遍历 + 系统目录保护）
    const filePath = (req.input as any)?.file_path || "";
    if (filePath && FILE_TOOLS.has(req.toolName)) {
      const pathDecision = this.checkPathSecurity(filePath, req.toolName);
      if (pathDecision) return pathDecision;
    }

    // 第 4 层：敏感文件检查
    if (filePath) {
      for (const pattern of SENSITIVE_FILES) {
        if (pattern.test(filePath)) {
          auditLog("sensitive_file_access", "high", {
            filePath,
            toolName: req.toolName,
            pattern: pattern.source,
          });
          return {
            allowed: false,
            reason: `敏感文件被拦截: ${filePath}`,
            needsConfirmation: true,
          };
        }
      }
    }

    // 第 5 层：读操作自动放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      return { allowed: true };
    }

    // 第 6 层：预授权工具放行
    if (this.preApproved.has(req.toolName)) {
      return { allowed: true };
    }

    // 第 7 层：deny-write 模式
    if (this.config.permissionMode === "deny-write") {
      return {
        allowed: false,
        reason: "deny-write 模式下不允许写操作",
      };
    }

    // 第 8 层：always-allow 模式
    if (this.config.permissionMode === "always-allow") {
      return { allowed: true };
    }

    // 第 9 层：需要用户确认
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `工具 "${req.toolName}" 需要用户确认`,
    };
  }

  /**
   * 文件路径安全校验
   * 检测路径遍历和系统目录访问
   */
  private checkPathSecurity(filePath: string, toolName: string): Decision | null {
    // 路径遍历检测：resolve 后对比原路径
    const resolved = path.resolve(filePath);
    if (filePath.includes("..")) {
      auditLog("path_traversal_detected", "medium", {
        filePath,
        resolved,
        toolName,
      });
      return {
        allowed: false,
        reason: `路径遍历被拦截: ${filePath}`,
        needsConfirmation: true,
      };
    }

    // 系统目录保护（写入）
    if (toolName === "write" || toolName === "edit") {
      for (const protectedDir of PROTECTED_WRITE_DIRS) {
        if (resolved.startsWith(protectedDir)) {
          auditLog("system_dir_write_blocked", "high", {
            filePath: resolved,
            protectedDir,
            toolName,
          });
          return {
            allowed: false,
            reason: `系统目录写入被拦截: ${resolved}`,
            needsConfirmation: true,
          };
        }
      }
    }

    // 系统目录保护（读取）
    if (toolName === "read") {
      for (const protectedDir of PROTECTED_READ_DIRS) {
        if (resolved.startsWith(protectedDir)) {
          auditLog("system_dir_read_blocked", "medium", {
            filePath: resolved,
            protectedDir,
            toolName,
          });
          return {
            allowed: false,
            reason: `系统目录读取被拦截: ${resolved}`,
            needsConfirmation: true,
          };
        }
      }
    }

    return null;
  }

  /** 请求用户确认（用于 REPL 模式） */
  async requestConfirmation(req: PermissionRequest): Promise<boolean> {
    if (this.config.yesMode || this.config.skipPermissions) {
      return true;
    }

    const description = req.description || `${req.toolName}: ${JSON.stringify(req.input).slice(0, 100)}`;
    console.log(`\n[权限请求] ${description}`);

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question("允许执行？(y/n) ", (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      });
    });
  }
}
