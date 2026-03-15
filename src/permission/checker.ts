/**
 * 权限检查器
 * 12 层权限检查：会话记忆 → 危险命令 → 禁用工具 → 目录白名单/黑名单 → 路径安全 → 敏感文件 → 权限规则 → 模式检查(acceptEdits/plan/dontAsk) → 读操作 → 预授权 → deny-write/always-allow → 用户确认
 * 包含 25 种危险命令模式检测 + 路径遍历/系统目录保护 + 审计日志
 */

import type { Checker, Decision, PermissionRequest, PermissionRule } from "./types.ts";
import type { Config } from "../config/config.ts";
import { checkRules } from "./rules.ts";
import { AuditLogger } from "./audit.ts";
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

/** 会话记忆最大条目数 */
const MAX_SESSION_MEMORY = 1000;

export class PermissionChecker implements Checker {
  private config: Config;
  private preApproved = new Set<string>();
  /** 会话内权限记忆：key = "toolName:inputHash", value = allowed */
  private sessionMemory = new Map<string, boolean>();
  /** 权限规则（从配置文件加载） */
  private rules: PermissionRule | null = null;
  /** 审计日志 */
  private auditLogger: AuditLogger;

  constructor(config: Config, rules?: PermissionRule) {
    this.config = config;
    this.rules = rules || null;
    this.auditLogger = new AuditLogger();
    // 加载预授权工具
    for (const tool of config.allowedTools) {
      this.preApproved.add(tool);
    }
  }

  /** 设置权限规则（支持运行时更新） */
  setRules(rules: PermissionRule): void {
    this.rules = rules;
  }

  /** 生成会话记忆 key */
  private getMemoryKey(req: PermissionRequest): string {
    // 对工具名 + 关键参数做简单 hash
    const input = req.input as any;
    const key = input?.file_path || input?.command || input?.pattern || "";
    return `${req.toolName}:${key}`;
  }

  /** 记住会话内权限决策 */
  rememberDecision(req: PermissionRequest, allowed: boolean): void {
    // 限制记忆大小
    if (this.sessionMemory.size >= MAX_SESSION_MEMORY) {
      // 删除最早的条目
      const firstKey = this.sessionMemory.keys().next().value;
      if (firstKey) this.sessionMemory.delete(firstKey);
    }
    const memKey = this.getMemoryKey(req);
    this.sessionMemory.set(memKey, allowed);
  }

  /** 清除会话记忆 */
  clearSessionMemory(): void {
    this.sessionMemory.clear();
  }

  async check(req: PermissionRequest): Promise<Decision> {
    const log = getLogger();
    const filePath = (req.input as any)?.file_path || "";
    const resource = filePath || (req.input as any)?.command || "";

    // 跳过权限检查模式
    if (this.config.skipPermissions || this.config.yesMode) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(skipPermissions/yesMode)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "allow",
        reason: "skipPermissions/yesMode",
      });
      return { allowed: true };
    }

    // 第 0 层：会话记忆检查（最高优先级）
    const memKey = this.getMemoryKey(req);
    if (this.sessionMemory.has(memKey)) {
      const allowed = this.sessionMemory.get(memKey)!;
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → ${allowed ? "允许" : "拒绝"}(会话记忆)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: allowed ? "allow" : "deny",
        reason: "会话记忆",
      });
      return { allowed };
    }

    // 第 1 层：危险命令拦截（25 种模式）
    if (req.toolName === "bash") {
      const cmd = (req.input as any)?.command || "";
      for (const dp of DANGEROUS_PATTERNS) {
        if (dp.pattern.test(cmd)) {
          log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → ${dp.severity === "critical" ? "拒绝" : "需确认"}(危险命令: ${dp.name})`);
          this.auditLogger.log({
            timestamp: new Date().toISOString(),
            type: "tool_use",
            tool: req.toolName,
            resource: cmd.slice(0, 200),
            decision: dp.severity === "critical" ? "deny" : "deny",
            reason: `危险命令: ${dp.name}`,
            severity: dp.severity,
          });

          if (dp.severity === "critical") {
            return {
              allowed: false,
              reason: `[${dp.severity}] 危险命令被拦截 (${dp.name}): ${cmd.slice(0, 80)}`,
            };
          }

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
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(工具已禁用)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: "工具已被禁用",
      });
      return {
        allowed: false,
        reason: `工具 "${req.toolName}" 已被禁用`,
      };
    }

    // 第 3 层：目录白名单/黑名单检查
    if (filePath) {
      const dirDecision = this.checkDirectoryAccess(filePath);
      if (dirDecision) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → ${dirDecision.allowed ? "允许" : "拒绝"}(目录检查: ${dirDecision.reason})`);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource: filePath,
          decision: dirDecision.allowed ? "allow" : "deny",
          reason: dirDecision.reason,
        });
        return dirDecision;
      }
    }

    // 第 4 层：文件路径安全校验（路径遍历 + 系统目录保护）
    if (filePath && FILE_TOOLS.has(req.toolName)) {
      const pathDecision = this.checkPathSecurity(filePath, req.toolName);
      if (pathDecision) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 拒绝(路径安全: ${pathDecision.reason})`);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource: filePath,
          decision: "deny",
          reason: pathDecision.reason,
        });
        return pathDecision;
      }
    }

    // 第 5 层：敏感文件检查
    if (filePath) {
      for (const pattern of SENSITIVE_FILES) {
        if (pattern.test(filePath)) {
          log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 需确认(敏感文件: ${pattern.source})`);
          this.auditLogger.log({
            timestamp: new Date().toISOString(),
            type: "tool_use",
            tool: req.toolName,
            resource: filePath,
            decision: "deny",
            reason: `敏感文件: ${pattern.source}`,
            severity: "high",
          });
          return {
            allowed: false,
            reason: `敏感文件被拦截: ${filePath}`,
            needsConfirmation: true,
          };
        }
      }
    }

    // 第 6 层：权限规则检查（来自配置文件）
    if (this.rules) {
      const ruleDecision = checkRules(this.rules, req);
      if (ruleDecision) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → ${ruleDecision.allowed ? "允许" : "拒绝"}(规则匹配: ${ruleDecision.reason})`);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource,
          decision: ruleDecision.allowed ? "allow" : "deny",
          reason: ruleDecision.reason,
        });
        return ruleDecision;
      }
    }

    // 第 7 层：plan 模式（只读，拒绝所有写入和 bash）
    if (this.config.permissionMode === "plan") {
      if (READ_ONLY_TOOLS.has(req.toolName)) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan模式+只读工具)`);
        return { allowed: true };
      }
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(plan模式)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: "plan 模式",
      });
      return {
        allowed: false,
        reason: "plan 模式下只允许只读操作",
      };
    }

    // 第 8 层：读操作自动放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(只读工具)`);
      return { allowed: true };
    }

    // 第 9 层：acceptEdits 模式（自动接受文件操作，其他仍需检查）
    if (this.config.permissionMode === "acceptEdits") {
      if (FILE_TOOLS.has(req.toolName)) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(acceptEdits模式)`);
        return { allowed: true };
      }
    }

    // 第 10 层：dontAsk 模式（智能自动决策）
    if (this.config.permissionMode === "dontAsk") {
      // 工作目录内文件写入放行
      if (FILE_TOOLS.has(req.toolName) && filePath) {
        const resolved = path.resolve(filePath);
        const cwd = process.cwd();
        if (resolved.startsWith(cwd)) {
          log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 允许(dontAsk+工作目录)`);
          return { allowed: true };
        }
      }
      // 非危险的 bash 命令放行（危险操作已在第 1 层拦截）
      if (req.toolName === "bash") {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(dontAsk+bash)`);
        return { allowed: true };
      }
    }

    // 第 11 层：预授权工具放行
    if (this.preApproved.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(预授权)`);
      return { allowed: true };
    }

    // 第 12 层：deny-write 模式
    if (this.config.permissionMode === "deny-write") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(deny-write模式)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: "deny-write 模式",
      });
      return {
        allowed: false,
        reason: "deny-write 模式下不允许写操作",
      };
    }

    // 第 13 层：always-allow 模式
    if (this.config.permissionMode === "always-allow") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(always-allow模式)`);
      return { allowed: true };
    }

    // 第 14 层：需要用户确认
    log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 需确认(默认策略)`);
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `工具 "${req.toolName}" 需要用户确认`,
    };
  }

  /**
   * 目录白名单/黑名单检查
   * 黑名单优先于白名单
   */
  private checkDirectoryAccess(filePath: string): Decision | null {
    const resolved = path.resolve(filePath);

    // 黑名单优先
    for (const blocked of this.config.blockedDirectories || []) {
      const normalizedBlocked = path.resolve(blocked);
      if (resolved.startsWith(normalizedBlocked)) {
        return {
          allowed: false,
          reason: `目录被禁止访问: ${blocked}`,
        };
      }
    }

    // 白名单检查（如果配置了白名单）
    const allowedDirs = this.config.allowedDirectories || [];
    if (allowedDirs.length > 0) {
      const allowed = allowedDirs.some(dir => {
        const normalizedDir = path.resolve(dir);
        return resolved.startsWith(normalizedDir);
      });
      if (!allowed) {
        return {
          allowed: false,
          reason: "目录不在白名单中",
        };
      }
    }

    return null;
  }

  /**
   * 文件路径安全校验
   * 检测路径遍历和系统目录访问
   */
  private checkPathSecurity(filePath: string, toolName: string): Decision | null {
    const resolved = path.resolve(filePath);
    if (filePath.includes("..")) {
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

  /** 请求用户确认（用于 REPL 模式，支持 a=always allow） */
  async requestConfirmation(req: PermissionRequest): Promise<{ confirmed: boolean; remember: boolean }> {
    if (this.config.yesMode || this.config.skipPermissions) {
      return { confirmed: true, remember: false };
    }

    const description = req.description || `${req.toolName}: ${JSON.stringify(req.input).slice(0, 100)}`;
    console.log(`\n[权限请求] ${description}`);

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question("允许执行？(y/n/a) [a=本次会话内始终允许] ", (answer) => {
        rl.close();
        const lower = answer.toLowerCase();
        if (lower === "a" || lower === "always") {
          resolve({ confirmed: true, remember: true });
        } else {
          resolve({
            confirmed: lower === "y" || lower === "yes",
            remember: false,
          });
        }
      });
    });
  }
}
