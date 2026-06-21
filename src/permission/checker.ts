/**
 * 权限检查器（三阶段架构）
 *
 * 阶段 1：hasPermissionsInner — 纯规则检查（无副作用）
 *   deny规则 → 危险命令 → 禁用工具 → 路径验证 → ask规则 → safetyCheck(bypass-immune)
 *   → bypass/always-allow模式 → allow规则 → plan/acceptEdits/读操作 → passthrough→ask
 *
 * 阶段 2：check — 后处理（含副作用）
 *   会话记忆快速路径 → 运行内部检查 → denial tracking → dontAsk→deny → 非交互→deny → 熔断检查
 *
 * 阶段 3：resolvePermission — 交互式决策（由上层 agent loop 处理）
 */

import type { Checker, Decision, PermissionRequest, PermissionRule, PermissionDecisionReason } from "./types.ts";
import type { Config } from "../config/config.ts";
import type { PlanModeManager } from "../plan/state.ts";
import type { Tool, PermissionResult, ToolUseContext } from "../tool/types.ts";
import { checkRules } from "./rules.ts";
import { AuditLogger } from "./audit.ts";
import { getLogger } from "../debug/logger.ts";
import { splitCompoundCommand, hasSensitiveRedirection } from "./shell-parser.ts";
import { checkInjectionPatterns } from "./bash-security.ts";
import { PathValidator, normalizeCaseForComparison } from "./path-validator.ts";
import {
  type DenialTrackingState,
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFuse,
} from "./denial-tracking.ts";
import { RuleLoader } from "./rule-loader.ts";
import { getShadowedRulesForTool } from "./shadowed-rules.ts";
import type { SandboxManager } from "./sandbox.ts";
import { BashClassifier } from "./bash-classifier.ts";
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

/** safetyCheck 受保护路径（bypass-immune，即使 always-allow 也不可绕过） */
interface SafetyProtectedPath {
  pattern: string;
  /** 是否允许自动模式的分类器审批（false = 绝对禁止） */
  classifierApprovable: boolean;
  reason: string;
}

//
// ⚠️ 顺序敏感：safetyCheck 首次命中即返回，越具体/越严格的项必须排在越前面。
// 例如 ".sid-code/commands/"（绝对禁止）必须排在 ".sid-code/"（可审批）之前，
// 否则 commands 目录会先命中宽松的父目录规则而被错误放行。
//
const SAFETY_PROTECTED_PATHS: SafetyProtectedPath[] = [
  // ── classifierApprovable: false（绝对禁止，不可自动审批）——最具体、最危险，排最前 ──
  { pattern: ".git/hooks/", classifierApprovable: false, reason: "Git hooks 可执行任意代码" },
  { pattern: ".husky/", classifierApprovable: false, reason: "Husky hooks 可执行任意代码" },
  // 斜杠命令目录：命令体可执行任意 shell，等同 hooks 风险，绝对禁止自动审批
  // （对标 claude-code isClaudeConfigFilePath 对 commands/agents/skills 的精细管控）
  { pattern: ".sid-code/commands/", classifierApprovable: false, reason: "sid-code 斜杠命令可执行任意代码" },
  { pattern: ".sid-code/agents/", classifierApprovable: false, reason: "sid-code 子代理定义影响执行" },
  { pattern: ".sid-code/skills/", classifierApprovable: false, reason: "sid-code Skill 可执行任意代码" },
  { pattern: ".claude/commands/", classifierApprovable: false, reason: "Claude 斜杠命令可执行任意代码" },
  { pattern: ".claude/agents/", classifierApprovable: false, reason: "Claude 子代理定义影响执行" },
  { pattern: ".claude/skills/", classifierApprovable: false, reason: "Claude Skill 可执行任意代码" },
  // 设置文件精细项：settings 可注入 permissionMode/skipPermissions/yesMode 等安全开关，
  // 风险等同上面的 commands/agents/skills，故 classifierApprovable 同样为 false（绝对禁止
  // 自动审批，必须人工确认）。⚠️ 该字段目前仅作语义标记，尚无运行时消费者；命中后无论
  // true/false 结果都是 needsConfirmation。改为 false 是为未来分类器审批接线做前置加固。
  { pattern: ".sid-code/settings.json", classifierApprovable: false, reason: "sid-code 设置文件（可影响安全控制）" },
  { pattern: ".sid-code/settings.local.json", classifierApprovable: false, reason: "sid-code 本地设置文件" },
  { pattern: ".claude/settings.json", classifierApprovable: false, reason: "Claude 设置文件" },
  { pattern: ".claude/settings.local.json", classifierApprovable: false, reason: "Claude 本地设置文件" },
  // ── classifierApprovable: true（分类器可根据上下文判断）——较宽泛的父目录，排后 ──
  { pattern: ".git/", classifierApprovable: true, reason: "Git 仓库内部文件" },
  { pattern: ".sid-code/", classifierApprovable: true, reason: "sid-code 配置目录" },
  { pattern: ".claude/", classifierApprovable: true, reason: "Claude 配置目录" },
  { pattern: ".vscode/", classifierApprovable: true, reason: "VS Code 配置目录" },
  { pattern: ".bashrc", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".zshrc", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".profile", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".bash_profile", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".ssh/", classifierApprovable: true, reason: "SSH 配置目录" },
];

/** 文件工具（需要路径校验） */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

/** 写操作工具 */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** 只读工具（含低风险工具如 save_memory） */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "read_many", "web_fetch", "save_memory"]);

/** 会话记忆最大条目数 */
const MAX_SESSION_MEMORY = 1000;

/** Plan Mode 下额外允许的工具（在 READ_ONLY_TOOLS 基础上） */
const PLAN_MODE_EXTRA_TOOLS = new Set([
  "enter_plan_mode",
  "exit_plan_mode",
  "sub_agent",
]);

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
  /** Plan Mode 管理器（可选，运行时注入） */
  private planManager: PlanModeManager | null = null;
  /** Denial Tracking 熔断状态 */
  private denialTracking: DenialTrackingState = createDenialTrackingState();
  /** 多来源规则加载器 */
  private ruleLoader: RuleLoader;
  /** 进入 plan 模式前的权限模式（退出时恢复） */
  private prePlanMode: string | null = null;
  /** 沙箱管理器（可选） */
  private sandboxManager: SandboxManager | null = null;
  /** LLM 命令风险分类器（第二道防线，默认不启用；通过 setBashClassifier 注入） */
  private bashClassifier: BashClassifier | null = null;
  /** Bridge 远程权限代理（可选，Bridge 模式下注入；签名对齐 PermissionProxy.requestPermission） */
  private bridgePermissionDelegate: ((req: {
    toolName: string;
    toolInput: unknown;
    description: string;
    dangerLevel: string;
  }) => Promise<boolean>) | null = null;

  /** 设置 Bridge 远程权限代理（null 清除，回退到本地确认） */
  setBridgePermissionDelegate(
    delegate: ((req: {
      toolName: string;
      toolInput: unknown;
      description: string;
      dangerLevel: string;
    }) => Promise<boolean>) | null,
  ): void {
    this.bridgePermissionDelegate = delegate;
  }

  /** 设置 Plan Mode 管理器 */
  setPlanManager(manager: PlanModeManager): void {
    this.planManager = manager;
  }

  /** 记录进入 plan 前的模式（供 plan 继承 bypass 使用） */
  setPrePlanMode(mode: string): void {
    this.prePlanMode = mode;
  }

  /** 清除 prePlanMode（退出 plan 时调用） */
  clearPrePlanMode(): void {
    this.prePlanMode = null;
  }

  /** 设置沙箱管理器 */
  setSandboxManager(manager: SandboxManager): void {
    this.sandboxManager = manager;
  }

  /** 获取沙箱管理器 */
  getSandboxManager(): SandboxManager | null {
    return this.sandboxManager;
  }

  /** 设置 LLM 命令风险分类器（null 清除，回退纯硬编码检测） */
  setBashClassifier(classifier: BashClassifier | null): void {
    this.bashClassifier = classifier;
  }

  /** 获取 LLM 命令风险分类器 */
  getBashClassifier(): BashClassifier | null {
    return this.bashClassifier;
  }

  /** 获取 denial tracking 状态（供 agent loop 读取） */
  getDenialTracking(): DenialTrackingState {
    return this.denialTracking;
  }

  /** 重置 denial tracking（新一轮对话时调用） */
  resetDenialTracking(): void {
    this.denialTracking = createDenialTrackingState();
  }

  constructor(config: Config, rules?: PermissionRule, workspacePath?: string) {
    this.config = config;
    this.rules = rules || null;
    this.auditLogger = new AuditLogger();
    this.pathValidator = new PathValidator(
      workspacePath || process.cwd(),
      config.allowedDirectories || [],
      config.blockedDirectories || [],
    );
    this.ruleLoader = new RuleLoader(workspacePath);
    // 加载预授权工具
    for (const tool of config.allowedTools) {
      this.preApproved.add(tool);
    }
    // 如果传入了旧版规则，导入到 ruleLoader 中
    if (rules) {
      this.ruleLoader.importFromPermissionRule(rules, "projectSettings");
    }
  }

  /** 获取多来源规则加载器（供外部集成） */
  getRuleLoader(): RuleLoader {
    return this.ruleLoader;
  }

  /**
   * 获取与指定工具相关的阴影规则（供权限确认对话框展示不可达规则提示）。
   * 对标 claude-code 的 "Unreachable Rules"：deny 遮蔽=blocked，ask 遮蔽=shadowed。
   * 异常时返回空数组——阴影提示是增强信息，绝不能因它阻断权限流程。
   */
  getShadowedRulesForTool(toolName: string): import("./shadowed-rules.ts").ShadowedRule[] {
    try {
      const rules = this.ruleLoader.getAllRules();
      if (rules.length < 2) return [];
      return getShadowedRulesForTool(rules, toolName);
    } catch (err) {
      getLogger().warn("PERMISSION", `阴影规则检测失败(忽略): ${err}`);
      return [];
    }
  }

  /**
   * 缺口 D：描述当前生效的"前置禁止"约束（deny 规则 + 禁用工具），供 system prompt 注入。
   *
   * 根因：deny / disallowedTools 清单从不进任何模型通道，模型只有调用后吃到"权限拒绝"
   * 才知道，会反复尝试被禁操作、浪费轮次。把这些静态配置态约束前置告知，让模型不再撞墙。
   *
   * 只描述"配置态、会话内稳定"的约束（deny 规则 + disallowedTools）；不含运行时危险命令
   * 分类器（那是动态判定，无法前置枚举）。无任何约束时返回 ""（调用方据此不注入空块）。
   *
   * @returns 多行约束摘要文本；无约束时为空字符串
   */
  describeDenyRules(): string {
    const lines: string[] = [];

    // 禁用工具（config.disallowedTools，checker.ts:343 据此拒绝）
    const disallowed = this.config.disallowedTools ?? [];
    if (disallowed.length > 0) {
      lines.push(`- 禁用工具（调用必被拒绝）：${disallowed.join("、")}`);
    }

    // deny 规则（this.rules.deny，checker.ts:327 据此拒绝）。
    // 形如 "Edit(.env*)" / "Bash(rm *)"，直接透传给模型即可——这正是它需要避开的模式。
    const deny = this.rules?.deny ?? [];
    if (deny.length > 0) {
      lines.push(`- 禁止的操作模式（匹配即被拒绝）：${deny.join("、")}`);
    }

    if (lines.length === 0) return "";
    return lines.join("\n");
  }

  /** 异步初始化：加载设置文件中的规则 */
  async initRules(): Promise<void> {
    await this.ruleLoader.loadAll();
    // 同步到旧版 rules 字段（兼容）
    this.rules = this.ruleLoader.toPermissionRule();
  }

  /** 设置权限规则（支持运行时更新，同步到 ruleLoader） */
  setRules(rules: PermissionRule): void {
    this.rules = rules;
    // 同步到 ruleLoader（作为 projectSettings 来源）
    this.ruleLoader.clearSource("projectSettings");
    this.ruleLoader.importFromPermissionRule(rules, "projectSettings");
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

  /**
   * 阶段 1：内部规则检查（纯逻辑，无副作用）
   * 检查顺序对齐 Claude Code：
   *   deny规则 → 危险命令 → 禁用工具 → 路径验证 → ask规则
   *   → safetyCheck(bypass-immune) → bypass/always-allow模式
   *   → allow规则 → plan/acceptEdits/读操作 → passthrough→ask
   */
  private async hasPermissionsInner(req: PermissionRequest, tool?: Tool, toolContext?: ToolUseContext): Promise<Decision> {
    const log = getLogger();
    const filePath = (req.input as any)?.file_path || "";
    const resource = filePath || (req.input as any)?.command || "";

    // Step 1: deny 规则（工具级）
    if (this.rules) {
      const ruleDecision = checkRules({ deny: this.rules.deny, allow: [], ask: [] }, req);
      if (ruleDecision && !ruleDecision.allowed) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(deny规则: ${ruleDecision.reason})`);
        return { ...ruleDecision, decisionReason: { type: "rule", rule: ruleDecision.reason || "", behavior: "deny" } };
      }
    }

    // Step 2: 危险命令拦截（硬编码 25 种模式 + 结构性注入防护 + 复合命令拆分 + 重定向检测 + LLM 风险分类）
    //   ⚠️ checkDangerousCommand 已为 async（内含 LLM 分类器调用），调用点必须 await——
    //   否则返回的 Promise 恒为 truthy，危险命令检测会被错误短路。
    if (req.toolName === "bash") {
      const dangerResult = await this.checkDangerousCommand(req);
      if (dangerResult) return dangerResult;
    }

    // Step 3: 禁用工具检查
    if (this.config.disallowedTools.includes(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(工具已禁用)`);
      return {
        allowed: false,
        reason: `工具 "${req.toolName}" 已被禁用`,
        decisionReason: { type: "other", reason: "工具已被禁用" },
      };
    }

    // Step 3.5: Plan Mode 计划文件提前放行（W11.D4：解锁 plan capability eval）
    //
    // 背景：src/plan/prompt.ts 教 LLM 用 write 写计划文件到 ~/.sid-code/plans/plan-*.md，
    // 但默认计划文件在工作区外，Step 4 路径验证会先拒，Step 9 checkPlanMode 的 isPlanFile
    // 放行逻辑永远走不到。本步骤在 Step 4 之前判断：plan mode + write/edit 计划文件 → 提前放行。
    //
    // 安全：精确匹配 planManager.getPlanFilePath()（不接受路径前缀匹配），避免目录遍历。
    if (
      this.config.permissionMode === "plan" &&
      (req.toolName === "write" || req.toolName === "edit") &&
      filePath &&
      this.planManager?.isPlanFile(filePath)
    ) {
      log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 允许(plan模式+计划文件提前放行)`);
      return { allowed: true, decisionReason: { type: "mode", mode: "plan+plan-file" } };
    }

    // Step 4: 统一路径验证（目录黑白名单 + symlink 解析 + 工作区边界 + 系统目录 + 敏感文件）
    if (filePath && FILE_TOOLS.has(req.toolName)) {
      const operation = WRITE_TOOLS.has(req.toolName) ? "write" as const : "read" as const;
      const pathResult = this.pathValidator.validateAccess(filePath, operation);
      if (!pathResult.allowed) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → ${pathResult.needsConfirmation ? "需确认" : "拒绝"}(路径验证: ${pathResult.reason})`);
        return {
          allowed: false,
          reason: pathResult.reason,
          needsConfirmation: pathResult.needsConfirmation,
          decisionReason: { type: "pathValidation", reason: pathResult.reason || "" },
        };
      }
    }

    // Step 5: ask 规则（工具级）
    if (this.rules) {
      const askDecision = checkRules({ deny: [], allow: [], ask: this.rules.ask }, req);
      if (askDecision && !askDecision.allowed && askDecision.needsConfirmation) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 需确认(ask规则: ${askDecision.reason})`);
        return { ...askDecision, decisionReason: { type: "rule", rule: askDecision.reason || "", behavior: "ask" } };
      }
    }

    // Step 5.5: 工具级 checkPermissions（passthrough 语义）
    if (tool?.checkPermissions) {
      const toolPermResult = await tool.checkPermissions(req.input, toolContext!);
      if (toolPermResult.behavior === "deny") {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(工具级checkPermissions: ${toolPermResult.message})`);
        return {
          allowed: false,
          reason: `工具拒绝: ${toolPermResult.message}`,
          decisionReason: { type: "other", reason: `工具级checkPermissions: ${toolPermResult.message}` },
        };
      }
      if (toolPermResult.behavior === "ask") {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 需确认(工具级checkPermissions: ${toolPermResult.message})`);
        return {
          allowed: false,
          needsConfirmation: true,
          reason: `工具要求确认: ${toolPermResult.message}`,
        };
      }
      if (toolPermResult.behavior === "allow") {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(工具级checkPermissions)`);
        return { allowed: true };
      }
      // passthrough: 工具没有意见，继续后续检查
    }

    // Step 6: safetyCheck（bypass-immune，即使 always-allow 也不可绕过）
    if (WRITE_TOOLS.has(req.toolName) && filePath) {
      const safetyResult = this.safetyCheck(filePath);
      if (!safetyResult.safe) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 需确认(safetyCheck: ${safetyResult.reason})`);
        return {
          allowed: false,
          needsConfirmation: true,
          reason: `[安全检查] ${safetyResult.reason}`,
          decisionReason: { type: "safetyCheck", reason: safetyResult.reason!, classifierApprovable: safetyResult.classifierApprovable },
          metadata: { classifierApprovable: safetyResult.classifierApprovable },
        };
      }
    }

    // Step 7: 沙箱自动放行（沙箱启用时 bash 命令可自动放行，减少弹窗）
    if (
      req.toolName === "bash" &&
      this.sandboxManager?.shouldAutoAllowBash()
    ) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(沙箱保护下自动放行)`);
      return { allowed: true, decisionReason: { type: "other", reason: "沙箱保护下自动放行" } };
    }

    // Step 8: bypass/always-allow 模式（safetyCheck 之后才检查，确保关键路径不被绕过）
    if (this.config.permissionMode === "always-allow") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(always-allow模式)`);
      return { allowed: true, decisionReason: { type: "mode", mode: "always-allow" } };
    }

    // Step 8: allow 规则（工具级）
    if (this.rules) {
      const allowDecision = checkRules({ deny: [], allow: this.rules.allow, ask: [] }, req);
      if (allowDecision && allowDecision.allowed) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(allow规则)`);
        return { ...allowDecision, decisionReason: { type: "rule", rule: "allow", behavior: "allow" } };
      }
    }

    // Step 9: plan 模式（代码级强制只读，计划文件例外）
    if (this.config.permissionMode === "plan") {
      return this.checkPlanMode(req, filePath, resource);
    }

    // Step 10: 读操作自动放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(只读工具)`);
      return { allowed: true };
    }

    // Step 11: acceptEdits 模式（自动接受文件操作，其他仍需检查）
    if (this.config.permissionMode === "acceptEdits") {
      if (FILE_TOOLS.has(req.toolName)) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(acceptEdits模式)`);
        return { allowed: true, decisionReason: { type: "mode", mode: "acceptEdits" } };
      }
    }

    // Step 12: 预授权工具放行
    if (this.preApproved.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(预授权)`);
      return { allowed: true };
    }

    // Step 13: deny-write 模式
    if (this.config.permissionMode === "deny-write") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(deny-write模式)`);
      return {
        allowed: false,
        reason: "deny-write 模式下不允许写操作",
        decisionReason: { type: "mode", mode: "deny-write" },
      };
    }

    // Step 14: passthrough → ask（默认需要用户确认）
    log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 需确认(默认策略)`);
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `工具 "${req.toolName}" 需要用户确认`,
    };
  }

  /**
   * 阶段 2：后处理（含副作用：会话记忆、denial tracking、模式后处理）
   * 这是对外暴露的 check() 方法
   */
  async check(req: PermissionRequest, tool?: Tool, toolContext?: ToolUseContext): Promise<Decision> {
    const log = getLogger();
    const resource = (req.input as any)?.file_path || (req.input as any)?.command || "";

    // 跳过权限检查模式
    //   skipPermissions（--dangerously-skip-permissions）：用户显式要求"完全跳过"，原样放行。
    //   ⚠️ yesMode（--yes）不再在此早退——它的语义是"自动批准需确认操作，但仍阻止危险命令"
    //   （见 config/attachments.ts yesMode 提示词）。早退会跳过 hasPermissionsInner 的危险命令
    //   检测与 LLM 风险分类，违背该语义。yesMode 改为在下方 ask 阶段对"普通 ask"自动批准。
    if (this.config.skipPermissions) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(skipPermissions)`);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "allow",
        reason: "skipPermissions",
      });
      return { allowed: true };
    }

    // 会话记忆快速路径
    const memKey = this.getMemoryKey(req);
    if (this.sessionMemory.has(memKey)) {
      const allowed = this.sessionMemory.get(memKey)!;
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → ${allowed ? "允许" : "拒绝"}(会话记忆)`);
      return { allowed, decisionReason: { type: "sessionMemory" } };
    }

    // 运行阶段 1 内部检查
    const result = await this.hasPermissionsInner(req, tool, toolContext);

    // allow → 重置 denial tracking
    if (result.allowed) {
      this.denialTracking = recordSuccess(this.denialTracking);
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "allow",
        reason: result.reason,
        decisionReason: result.decisionReason,
      });
      return result;
    }

    // deny（非 ask）→ 记录 denial tracking
    if (!result.needsConfirmation) {
      this.denialTracking = recordDenial(this.denialTracking, req.toolName, result.reason || "");
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: result.reason,
        decisionReason: result.decisionReason,
        classifiedBy: result.metadata?.classifiedBy as ("hardcoded" | "llm" | "both" | undefined),
        llmRisk: result.metadata?.llmRisk as (string | undefined),
      });
      return result;
    }

    // ask → 模式后处理

    // yesMode（--yes）：自动批准"普通 ask"，但危险命令触发的确认仍然拦截
    //   （见 config/attachments.ts："所有需要确认的操作将自动批准。仍然会阻止危险命令。"）
    //   文档迭代 III 第 2 点明确针对 bash 命令："LLM 分类器放行的命令才自动执行，高风险仍需确认"。
    //   不放行来源：dangerousCommand（硬编码/LLM 判定的危险命令）、safetyCheck（.git/hooks 等可执行代码路径）。
    //   注意：pathValidation（如工作区外写入）属常规确认，yesMode 照常自动批准——不在"危险命令"范畴。
    if (this.config.yesMode) {
      const dr = result.decisionReason?.type;
      const isSafetyConfirmation = dr === "dangerousCommand" || dr === "safetyCheck";
      if (!isSafetyConfirmation) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(yesMode 自动批准普通 ask)`);
        this.denialTracking = recordSuccess(this.denialTracking);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource,
          decision: "allow",
          reason: "yesMode 自动批准",
          user_confirmed: false,
        });
        return { allowed: true, decisionReason: { type: "mode", mode: "yesMode" } };
      }
      // 危险来源的确认：yesMode 不放行，落到下方非交互/熔断/正常确认流程（高风险仍拦）
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → yesMode 不放行危险命令确认(${dr})`);
    }

    // dontAsk 模式：ask → deny（绝不弹窗，对齐 Claude Code 语义）
    if (this.config.permissionMode === "dontAsk") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(dontAsk模式下ask→deny)`);
      this.denialTracking = recordDenial(this.denialTracking, req.toolName, result.reason || "");
      const dontAskDecision: Decision = {
        allowed: false,
        reason: `dontAsk 模式下自动拒绝: ${result.reason}`,
        decisionReason: { type: "mode", mode: "dontAsk" },
      };
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: dontAskDecision.reason,
        decisionReason: dontAskDecision.decisionReason,
      });
      return dontAskDecision;
    }

    // 非交互模式：ask → deny
    if (this.isNonInteractive()) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(非交互模式)`);
      this.denialTracking = recordDenial(this.denialTracking, req.toolName, result.reason || "");
      const nonInteractiveDecision: Decision = {
        allowed: false,
        reason: `非交互模式下自动拒绝: ${result.reason}`,
        decisionReason: { type: "other", reason: "非交互模式" },
      };
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: nonInteractiveDecision.reason,
        decisionReason: nonInteractiveDecision.decisionReason,
      });
      return nonInteractiveDecision;
    }

    // denial tracking 熔断检查
    if (shouldFuse(this.denialTracking)) {
      log.warn("PERMISSION", `连续 ${this.denialTracking.consecutiveDenials} 次被拒绝，触发熔断`);
      const fuseDecision: Decision = {
        allowed: false,
        reason: `连续 ${this.denialTracking.consecutiveDenials} 次被拒绝，请换一种方式完成任务`,
        metadata: { denialTrackingTriggered: true },
        decisionReason: {
          type: "denialTracking",
          consecutiveDenials: this.denialTracking.consecutiveDenials,
          totalDenials: this.denialTracking.totalDenials,
        },
      };
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: fuseDecision.reason,
        decisionReason: fuseDecision.decisionReason,
      });
      return fuseDecision;
    }

    return result;
  }

  /**
   * safetyCheck：bypass-immune 的关键路径保护
   * 即使在 always-allow 模式下也不可绕过
   */
  private safetyCheck(filePath: string): { safe: boolean; reason?: string; classifierApprovable: boolean } {
    const resolved = path.resolve(filePath);
    // 大小写归一化比较：macOS/Windows 大小写不敏感文件系统下，
    // ".ClAuDe/settings.json" 与 ".claude/settings.json" 指向同一文件，
    // 必须归一化后再比对（对标 path-validator normalizeCaseForComparison）。
    const basename = normalizeCaseForComparison(path.basename(resolved));
    const relativePath = normalizeCaseForComparison(resolved); // 用绝对路径（全小写）匹配

    for (const sp of SAFETY_PROTECTED_PATHS) {
      const patternLower = normalizeCaseForComparison(sp.pattern);
      // 目录模式：检查路径是否包含该目录
      if (patternLower.endsWith("/")) {
        const dirName = patternLower.slice(0, -1); // 去掉尾部 /
        const sepLower = normalizeCaseForComparison(path.sep);
        if (relativePath.includes(`/${dirName}/`) || relativePath.includes(`${sepLower}${dirName}${sepLower}`)) {
          return { safe: false, reason: sp.reason, classifierApprovable: sp.classifierApprovable };
        }
      } else {
        // 文件模式：检查文件名 或 路径尾缀（后者支持 ".sid-code/settings.json" 这类带目录的精确项）
        if (basename === patternLower || relativePath.endsWith(`/${patternLower}`)) {
          return { safe: false, reason: sp.reason, classifierApprovable: sp.classifierApprovable };
        }
      }
    }

    return { safe: true, classifierApprovable: true };
  }

  /**
   * 危险命令检查（从 check 中提取）
   *
   * 三道防线（对标 claude-code：硬编码只是性能优化，真正决策可由 LLM 做）：
   *   第一道 硬编码预检（hardcodedDangerCheck）：critical → 直接拒绝（不进 LLM）
   *   第二道 LLM 风险分类器（可选启用）：理解命令意图，覆盖编码/混淆/间接执行绕过
   *   第三道 硬编码兜底：LLM 不可用时回退到硬编码 high/medium 检测结果
   */
  private async checkDangerousCommand(req: PermissionRequest): Promise<Decision | null> {
    const log = getLogger();
    const cmd = (req.input as any)?.command || "";

    // ── 第一道：硬编码预检 ──
    const hard = this.hardcodedDangerCheck(cmd);

    // critical 命令直接拒绝，绝不交给 LLM（明显危险，省一次调用，且不可被 LLM 误放）
    if (hard && hard.severity === "critical") {
      log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 拒绝(危险命令: ${hard.name})`);
      return {
        allowed: false,
        reason: `[critical] 危险命令被拦截 (${hard.name}): ${cmd.slice(0, 80)}`,
        decisionReason: { type: "dangerousCommand", pattern: hard.name, severity: "critical" },
        metadata: { classifiedBy: "hardcoded" },
      };
    }

    // ── 第 1.5 道：结构性注入/混淆校验（纯逻辑、零成本，在 LLM 分类之前拦截 misparsing）──
    const injectionFinding = checkInjectionPatterns(cmd);
    if (injectionFinding) {
      log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(注入防护: ${injectionFinding.id})`);
      return {
        allowed: false,
        reason: `[injection:${injectionFinding.id}] ${injectionFinding.message}: ${cmd.slice(0, 80)}`,
        needsConfirmation: true,
        decisionReason: { type: "dangerousCommand", pattern: `injection:${injectionFinding.id}`, severity: "high" },
        metadata: { classifiedBy: "injection-validator", injectionId: injectionFinding.id },
      };
    }

    // ── 第二道：LLM 风险分类器（仅当启用且可用；critical 已在上面拦截，这里只处理"看似不危险/中低危"的命令）──
    //   plan 模式（只读）不调用分类器：plan 模式下工具本就受限于只读，再花 LLM 成本判风险无意义（迭代 III 集成点 #3）。
    if (this.config.permissionMode !== "plan" && this.bashClassifier?.isAvailable()) {
      const classifyResult = await this.bashClassifier.classify({
        command: cmd,
        cwd: process.cwd(),
        description: req.description,
        signal: (req as any).signal,
      });

      // 分类器可用且给出明确判断
      if (!classifyResult.classifierUnavailable) {
        if (!classifyResult.safe) {
          const isHard = classifyResult.risk === "critical" || classifyResult.risk === "high";
          log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → ${isHard ? "拒绝" : "需确认"}(LLM风险分类: ${classifyResult.risk})`);
          return {
            allowed: false,
            reason: `[LLM:${classifyResult.risk}] ${classifyResult.reason}`,
            needsConfirmation: !isHard, // critical/high → 直接拒绝；medium → 需确认
            decisionReason: { type: "dangerousCommand", pattern: `LLM:${classifyResult.risk}`, severity: classifyResult.risk },
            metadata: {
              classifiedBy: hard ? "both" : "llm",
              llmRisk: classifyResult.risk,
              llmReason: classifyResult.reason,
              latencyMs: classifyResult.latencyMs,
            },
          };
        }
        // 分类器判定安全：仍需让硬编码 high/medium 命中走兜底确认（安全底线由硬编码托底，
        // 避免 LLM 误把硬编码已知危险命令放过）→ 落到下方第三道
        log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → LLM判定安全(risk=${classifyResult.risk})，继续硬编码兜底`);
      }
      // classifierUnavailable=true → 静默回退第三道硬编码兜底
    }

    // ── 第三道：硬编码兜底（LLM 未启用/不可用，或 LLM 判安全但硬编码命中 high/medium）──
    if (hard) {
      log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(危险命令: ${hard.name})`);
      return {
        allowed: false,
        reason: `[${hard.severity}] 危险命令需要确认 (${hard.name}): ${cmd.slice(0, 80)}`,
        needsConfirmation: true,
        decisionReason: { type: "dangerousCommand", pattern: hard.name, severity: hard.severity },
        metadata: { classifiedBy: "hardcoded" },
      };
    }

    // 重定向检测（独立于上述模式）
    const redirectCheck = hasSensitiveRedirection(cmd);
    if (redirectCheck.sensitive) {
      log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(敏感路径重定向: ${redirectCheck.targets.join(", ")})`);
      return {
        allowed: false,
        reason: `重定向到敏感路径需要确认: ${redirectCheck.targets.join(", ")}`,
        needsConfirmation: true,
        metadata: { classifiedBy: "hardcoded" },
      };
    }

    return null; // 无危险
  }

  /**
   * 硬编码危险模式检测（纯逻辑，无副作用）——从原 checkDangerousCommand 的三步内联逻辑抽出。
   *
   * 检测流程：
   *   1a. 整条命令检查跨管道危险模式（curl|bash、base64 -d|sh 等）
   *   1b. 拆分复合命令，对每个子命令检查其余模式
   * 返回首个命中的模式（name + severity），未命中返回 null。重定向检测仍由调用方单独处理。
   */
  private hardcodedDangerCheck(cmd: string): { name: string; severity: "critical" | "high" | "medium" } | null {
    // 1a. 跨管道危险模式（对整条命令）
    const pipelinePatterns = DANGEROUS_PATTERNS.filter(dp =>
      dp.pattern.source.includes("\\|") || dp.name.includes("管道") || dp.name.includes("解码执行") || dp.name.includes("下载并执行")
    );
    for (const dp of pipelinePatterns) {
      if (dp.pattern.test(cmd)) {
        return { name: dp.name, severity: dp.severity };
      }
    }

    // 1b. 拆分复合命令，对每个子命令检查其余模式
    const subCommands = splitCompoundCommand(cmd);
    const nonPipelinePatterns = DANGEROUS_PATTERNS.filter(dp => !pipelinePatterns.includes(dp));
    for (const subCmd of subCommands) {
      for (const dp of nonPipelinePatterns) {
        if (dp.pattern.test(subCmd)) {
          return { name: dp.name, severity: dp.severity };
        }
      }
    }

    return null;
  }

  /**
   * Plan 模式检查（从 check 中提取）
   * 支持 plan 继承 bypass：如果进入 plan 前是 always-allow，则 plan 模式下也自动放行
   */
  private checkPlanMode(req: PermissionRequest, filePath: string, resource: string): Decision {
    const log = getLogger();

    // plan 继承 bypass：如果 prePlanMode 是 always-allow，则自动放行（safetyCheck 已在上层拦截）
    if (this.prePlanMode === "always-allow") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan继承always-allow)`);
      return { allowed: true, decisionReason: { type: "mode", mode: "plan+bypass" } };
    }

    // 只读工具直接放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan模式+只读工具)`);
      return { allowed: true };
    }

    // Plan Mode 专用工具放行
    if (PLAN_MODE_EXTRA_TOOLS.has(req.toolName)) {
      if (req.toolName === "sub_agent") {
        const subType = (req.input as any)?.type;
        if (subType && subType !== "explore") {
          log.info("PERMISSION", `${req.toolName}(type=${subType}) → 拒绝(plan模式只允许explore子代理)`);
          return { allowed: false, reason: "计划模式下只允许 explore 类型的子代理" };
        }
      }
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan模式+专用工具)`);
      return { allowed: true };
    }

    // 允许 write/edit 操作计划文件
    if ((req.toolName === "write" || req.toolName === "edit") && filePath && this.planManager) {
      if (this.planManager.isPlanFile(filePath)) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 允许(plan模式+计划文件)`);
        return { allowed: true };
      }
    }

    log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(plan模式)`);
    return {
      allowed: false,
      reason: "计划模式下只允许只读操作",
      decisionReason: { type: "mode", mode: "plan" },
    };
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

    // Bridge 模式：转发给远程客户端决策（远程不支持"始终允许"，故 remember=false）
    if (this.bridgePermissionDelegate) {
      const allowed = await this.bridgePermissionDelegate({
        toolName: req.toolName,
        toolInput: req.input,
        description,
        dangerLevel: (req as any).dangerLevel ?? "unknown",
      });
      return { confirmed: allowed, remember: false };
    }

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
