/**
 * 权限检查器
 * 8 层权限检查：危险命令 → 禁用工具 → 敏感文件 → 读操作 → 预授权 → deny-write → always-allow → 用户确认
 * 包含 15 种危险命令模式检测 + 安全审计日志
 */

import type { Checker, Decision, PermissionRequest } from "./types.ts";
import type { Config } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";
import * as readline from "readline";

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

  // medium: 需要用户确认
  { name: "路径遍历", pattern: /\.\.[\/\\]/, severity: "medium" },
  { name: "后台进程", pattern: /&\s*$/, severity: "medium" },
  { name: "管道到文件覆盖", pattern: />\s*\/etc\//, severity: "medium" },
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

    // 第 1 层：危险命令拦截（15 种模式）
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

    // 第 3 层：敏感文件检查
    const filePath = (req.input as any)?.file_path || "";
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

    // 第 4 层：读操作自动放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      return { allowed: true };
    }

    // 第 5 层：预授权工具放行
    if (this.preApproved.has(req.toolName)) {
      return { allowed: true };
    }

    // 第 6 层：deny-write 模式
    if (this.config.permissionMode === "deny-write") {
      return {
        allowed: false,
        reason: "deny-write 模式下不允许写操作",
      };
    }

    // 第 7 层：always-allow 模式
    if (this.config.permissionMode === "always-allow") {
      return { allowed: true };
    }

    // 第 8 层：需要用户确认
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `工具 "${req.toolName}" 需要用户确认`,
    };
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
