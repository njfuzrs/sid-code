/**
 * 权限检查器
 * 14 层权限检查：会话记忆 → 危险命令(复合拆分+重定向) → 禁用工具 → 目录白名单/黑名单 → 路径安全(symlink解析+工作区边界) → 敏感文件 → 权限规则 → 模式检查(acceptEdits/plan/dontAsk) → 读操作 → 预授权 → deny-write/always-allow → 用户确认
 * 包含 25 种危险命令模式检测 + 复合命令拆分 + 重定向检测 + 路径遍历/系统目录保护 + 审计日志
 */

import type { Checker, Decision, PermissionRequest, PermissionRule } from "./types.ts";
import type { Config } from "../config/config.ts";
import { checkRules } from "./rules.ts";
import { AuditLogger } from "./audit.ts";
import { getLogger } from "../debug/logger.ts";
import { splitCompoundCommand, hasSensitiveRedirection } from "./shell-parser.ts";
import { PathValidator } from "./path-validator.ts";
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

/** 文件工具（需要路径校验） */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

/** 写操作工具 */
const WRITE_TOOLS = new Set(["write", "edit"]);

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
  /** 路径验证器（统一处理 symlink 解析 + 工作区边界 + 系统目录 + 敏感文件） */
  private pathValidator: PathValidator;

  constructor(config: Config, rules?: PermissionRule, workspacePath?: string) {
    this.config = config;
    this.rules = rules || null;
    this.auditLogger = new AuditLogger();
    this.pathValidator = new PathValidator(
      workspacePath || process.cwd(),
      config.allowedDirectories || [],
      config.blockedDirectories || [],
    );
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

    // 第 1 层：危险命令拦截（25 种模式 + 复合命令拆分 + 重定向检测）
    if (req.toolName === "bash") {
      const cmd = (req.input as any)?.command || "";

      // 1a. 先对整条命令检查跨管道的危险模式（这些模式包含 | 符号）
      const pipelinePatterns = DANGEROUS_PATTERNS.filter(dp =>
        dp.pattern.source.includes("\\|") || dp.name.includes("管道") || dp.name.includes("解码执行") || dp.name.includes("下载并执行")
      );
      for (const dp of pipelinePatterns) {
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

      // 1b. 拆分复合命令，对每个子命令检查其他危险模式
      const subCommands = splitCompoundCommand(cmd);
      const nonPipelinePatterns = DANGEROUS_PATTERNS.filter(dp =>
        !pipelinePatterns.includes(dp)
      );
      for (const subCmd of subCommands) {
        for (const dp of nonPipelinePatterns) {
          if (dp.pattern.test(subCmd)) {
            log.info("PERMISSION", `${req.toolName}(${subCmd.slice(0, 80)}) → ${dp.severity === "critical" ? "拒绝" : "需确认"}(危险命令: ${dp.name})`);
            this.auditLogger.log({
              timestamp: new Date().toISOString(),
              type: "tool_use",
              tool: req.toolName,
              resource: cmd.slice(0, 200),
              decision: dp.severity === "critical" ? "deny" : "deny",
              reason: `危险命令: ${dp.name} (子命令: ${subCmd.slice(0, 80)})`,
              severity: dp.severity,
            });

            if (dp.severity === "critical") {
              return {
                allowed: false,
                reason: `[${dp.severity}] 危险命令被拦截 (${dp.name}): ${subCmd.slice(0, 80)}`,
              };
            }

            return {
              allowed: false,
              reason: `[${dp.severity}] 危险命令需要确认 (${dp.name}): ${subCmd.slice(0, 80)}`,
              needsConfirmation: true,
            };
          }
        }
      }

      // 1c. 重定向检测：检查是否重定向到敏感路径
      const redirectCheck = hasSensitiveRedirection(cmd);
      if (redirectCheck.sensitive) {
        log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(敏感路径重定向: ${redirectCheck.targets.join(", ")})`);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource: cmd.slice(0, 200),
          decision: "deny",
          reason: `重定向到敏感路径: ${redirectCheck.targets.join(", ")}`,
          severity: "high",
        });
        return {
          allowed: false,
          reason: `重定向到敏感路径需要确认: ${redirectCheck.targets.join(", ")}`,
          needsConfirmation: true,
        };
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

    // 第 3 层：统一路径验证（目录黑白名单 + symlink 解析 + 工作区边界 + 系统目录 + 敏感文件）
    if (filePath && FILE_TOOLS.has(req.toolName)) {
      const operation = WRITE_TOOLS.has(req.toolName) ? "write" as const : "read" as const;
      const pathResult = this.pathValidator.validateAccess(filePath, operation);
      if (!pathResult.allowed) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → ${pathResult.needsConfirmation ? "需确认" : "拒绝"}(路径验证: ${pathResult.reason})`);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource: pathResult.resolvedPath,
          decision: "deny",
          reason: pathResult.reason,
          severity: pathResult.needsConfirmation ? "high" : "critical",
        });
        return {
          allowed: false,
          reason: pathResult.reason,
          needsConfirmation: pathResult.needsConfirmation,
        };
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
        const workspace = this.pathValidator.isWithinWorkspace(resolved);
        if (workspace) {
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
    const decision: Decision = {
      allowed: false,
      needsConfirmation: true,
      reason: `工具 "${req.toolName}" 需要用户确认`,
    };

    // 非交互模式处理：ASK_USER 自动转为 DENY
    if (this.isNonInteractive() && decision.needsConfirmation) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(非交互模式)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: `非交互模式下自动拒绝: ${decision.reason}`,
      });
      return {
        allowed: false,
        reason: `非交互模式下自动拒绝: ${decision.reason}`,
      };
    }

    return decision;
  }

  /** 检测是否处于非交互模式 */
  private isNonInteractive(): boolean {
    // print 模式（单次输出）或 maxTurns > 0（批处理模式）视为非交互
    return this.config.print === true || (this.config.maxTurns !== undefined && this.config.maxTurns > 0);
  }

  /** 请求用户确认（用于 REPL 模式，支持 a=always allow） */
  async requestConfirmation(req: PermissionRequest): Promise<{ confirmed: boolean; remember: boolean }> {
    if (this.config.yesMode || this.config.skipPermissions) {
      return { confirmed: true, remember: false };
    }

    const description = req.description || `${req.toolName}: ${JSON.stringify(req.input).slice(0, 100)}`;
    console.log(`\n[权限请求] ${description}`);

    const readline = await import("readline");
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question("允许执行？(y/n/a) [a=本次会话内始终允许] ", (answer: string) => {
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
