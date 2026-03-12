/**
 * 权限检查器
 * 8 层权限检查：危险命令 → 禁用工具 → 敏感文件 → 读操作 → 预授权 → deny-write → always-allow → 用户确认
 */

import type { Checker, Decision, PermissionRequest } from "./types.ts";
import type { Config } from "../config/config.ts";
import * as readline from "readline";

/** 危险命令模式 */
const DANGEROUS_COMMANDS = [
  /rm\s+(-rf?|--recursive)\s+[\/~]/,
  /rm\s+-rf?\s+\//,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+-R\s+777/,
  /:(){ :\|:& };:/,
  /curl.*\|\s*(bash|sh)/,
  /wget.*\|\s*(bash|sh)/,
];

/** 敏感文件模式 */
const SENSITIVE_FILES = [
  /\.env$/,
  /\.env\./,
  /credentials/i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /\.ssh\//,
  /password/i,
  /secret/i,
];

/** 只读工具 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

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

    // 第 1 层：危险命令拦截
    if (req.toolName === "bash") {
      const cmd = (req.input as any)?.command || "";
      for (const pattern of DANGEROUS_COMMANDS) {
        if (pattern.test(cmd)) {
          return {
            allowed: false,
            reason: `危险命令被拦截: ${cmd.slice(0, 80)}`,
          };
        }
      }
    }

    // 第 2 层：禁用工具检查
    if (this.config.disallowedTools.includes(req.toolName)) {
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
