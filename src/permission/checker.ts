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

import type { Checker, Decision, PermissionRequest, PermissionRule, PermissionDecisionReason, PermissionCheckOptions } from "./types.ts";
import type { Config } from "../config/config.ts";
import type { PermissionMode } from "./mode.ts";
import type { PlanModeManager } from "../plan/state.ts";
import type { Tool, PermissionResult, ToolUseContext } from "../tool/types.ts";
import { checkRules } from "./rules.ts";
import type { PathRuleContext } from "./path-rule-matching.ts";
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
import { GIT_DANGER_PATTERNS, normalizeGitGlobalOptions } from "./git-danger-patterns.ts";
import * as path from "node:path";
import * as os from "node:os";

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

  // Git —— 破坏性/难恢复（P0-2，对齐 CC destructiveCommandWarning）。
  // 从 git-danger-patterns.ts 单一事实源展开，避免与 UI 层 danger-detect 两份正则漂移。
  // hardcodedDangerCheck 会按复合命令拆分逐子命令查这些模式，加进此表后自动继承拆分能力。
  ...GIT_DANGER_PATTERNS,
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

/**
 * 只读工具（含低风险工具如 save_memory）。
 * 注意：web_fetch **不在**此列表（P1-2，对齐 CC 方案 A）——网络出站需人类把关，
 * 默认走 ask 而非无条件放行；预授权代码类域名由 web_fetch 自身的 checkPermissions 免确认放行，
 * domain 粒度授权由 WebFetch(domain:x) 规则控制。
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "read_many",
  "save_memory",
  // 2026-08-01（A/B 实测发现）：假设登记表两个工具只写**进程内存**里的 ledger，
  // 全文件零 fs / 网络 / 子进程调用（hypothesis.ts + hypothesis-ledger.ts 均已核对），
  // 且自身 readOnly() 就返回 true。此前不在本表 → 落到 Step 14 默认 ask → 无头模式
  // （-p）直接 deny，实测 11 次 ON 臂运行全部收到「权限拒绝: 非交互模式」，
  // 假设机制在无头/评测/CI 场景**完全失效**且无任何报错，只在日志里留一行。
  // 这也让「防线零触发」类排查极易误判成模型不调工具，而真因是权限层拦死。
  // 注意与 todo_write 的区别：后者 readOnly() 返回 false（会落盘 progress 文件），
  // 其在无头模式被拒是符合设计的，不在本次放行范围内。
  "hypothesis_register",
  "hypothesis_challenge",
]);

/** 会话记忆最大条目数 */
const MAX_SESSION_MEMORY = 1000;

/**
 * acceptEdits 模式下自动放行的文件系统命令（对齐 CC modeValidation.ts ACCEPT_EDITS_ALLOWED_COMMANDS）。
 * 仅当命令的路径参数都在 cwd 内才自动放行；跨 cwd 的 mv/rm 等仍走确认（刻意的攻击面权衡）。
 */
const ACCEPT_EDITS_FS_COMMANDS = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"]);

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
  /** 泛化工具分类器（auto 模式核心，通过 setToolClassifier 注入） */
  private toolClassifier: import("./tool-classifier.ts").ToolClassifier | null = null;
  /** 工作区路径（供 auto 模式分类器使用） */
  private workspacePath: string;
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

  /**
   * P2-1：派生一个覆盖 permissionMode 的新 checker（供 agent frontmatter permissionMode 用）。
   *
   * 为什么派生而非 mutate：并发子代理共享同一主 checker 实例，直接改 this.config.permissionMode
   * 会污染其他子代理/主代理。故浅拷贝 config（仅换 permissionMode），复用同一套 rules/workspace，
   * 并把已注入的运行期协作者（planManager/sandbox/classifier 等）原样搬到新实例——否则派生 checker
   * 丢失 auto 模式分类器 / 沙箱等能力，行为与主 checker 不一致。
   *
   * sessionMemory / preApproved / denialTracking 刻意不共享（各自独立会话记忆），派生实例从干净态起步。
   */
  deriveWithPermissionMode(mode: PermissionMode): PermissionChecker {
    const derivedConfig: Config = { ...this.config, permissionMode: mode };
    const derived = new PermissionChecker(derivedConfig, this.rules ?? undefined, this.workspacePath);
    // 搬运运行期注入的协作者（构造函数不覆盖这些，需显式复制）。
    if (this.planManager) derived.setPlanManager(this.planManager);
    if (this.sandboxManager) derived.setSandboxManager(this.sandboxManager);
    if (this.bashClassifier) derived.setBashClassifier(this.bashClassifier);
    if (this.toolClassifier) derived.setToolClassifier(this.toolClassifier);
    if (this.bridgePermissionDelegate) derived.setBridgePermissionDelegate(this.bridgePermissionDelegate);
    // 运行时扩展的允许目录白名单也一并继承（用户 /add-dir 授权对子代理同样生效）。
    for (const dir of this.getAllowedDirectories()) derived.addAllowedDirectory(dir);
    return derived;
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

  /** 设置泛化工具分类器（auto 模式核心） */
  setToolClassifier(classifier: import("./tool-classifier.ts").ToolClassifier | null): void {
    this.toolClassifier = classifier;
  }

  /** 获取泛化工具分类器 */
  getToolClassifier(): import("./tool-classifier.ts").ToolClassifier | null {
    return this.toolClassifier;
  }

  /** 获取 denial tracking 状态（供 agent loop 读取） */
  getDenialTracking(): DenialTrackingState {
    return this.denialTracking;
  }

  /** 重置 denial tracking（/clear 新一轮对话时调用，由 app.ts 接线） */
  resetDenialTracking(): void {
    this.denialTracking = createDenialTrackingState();
  }

  /**
   * 记录一次「用户在确认弹窗里拒绝」——ask 路径的记账入口。
   *
   * 负收益防线审计发现 1：ask 路径此前**完全不记账**，导致"模型反复请求同一个危险操作、
   * 用户反复点拒绝"这种最典型的死循环反而不会熔断。由上层（tool-executor 拿到用户
   * 拒绝结果后）调用，与 rememberDecision 同一时机。
   */
  recordUserDenial(req: PermissionRequest, reason?: string): void {
    const resource = (req.input as any)?.file_path || (req.input as any)?.command || "";
    this.denialTracking = recordDenial(this.denialTracking, req.toolName, reason || "用户拒绝", resource);
  }

  /**
   * 构造熔断决策（两个调用点共用：hard deny 路径与 ask 后处理路径）。
   *
   * 熔断落地为 needsConfirmation 而非 deny：目的是把"模型在死循环"这件事暴露给用户，
   * 同时保留人工放行的余地。
   */
  private fuseDecision(req: PermissionRequest, resource: string): Decision {
    const log = getLogger();
    const consecutive = this.denialTracking.consecutiveDenials;
    log.warn(
      "PERMISSION",
      `同一操作（${req.toolName} ${String(resource).slice(0, 60)}）连续 ${consecutive} 次被拒绝，熔断→回退人工确认`,
    );
    const decision: Decision = {
      allowed: false,
      needsConfirmation: true,
      reason: `⚠️ 同一操作已连续 ${consecutive} 次被拒绝。模型可能在重复尝试同一操作，请审慎判断。`,
      metadata: { denialTrackingTriggered: true },
      decisionReason: {
        type: "denialTracking",
        consecutiveDenials: consecutive,
        totalDenials: this.denialTracking.totalDenials,
      },
    };
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      type: "tool_use",
      tool: req.toolName,
      resource,
      decision: "deny",
      reason: decision.reason,
      decisionReason: decision.decisionReason,
    });
    return decision;
  }

  constructor(config: Config, rules?: PermissionRule, workspacePath?: string) {
    this.config = config;
    this.rules = rules || null;
    this.workspacePath = workspacePath || process.cwd();
    this.auditLogger = new AuditLogger();
    this.pathValidator = new PathValidator(
      this.workspacePath,
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

  // ── G25：运行时目录白名单增删（转发到内部 pathValidator）──
  // 对标 claude-code /add-dir。用户主动交互（斜杠命令）扩展当前会话可访问目录，
  // 属"用户级授权"，与"项目配置自动扩大白名单"（security.ts:39 禁止）性质不同——
  // 前者是用户显式操作、仅本会话生效，后者是不可信配置自动放大，故此处可做。

  /** 运行时新增允许访问的目录（当前会话生效，去重） */
  addAllowedDirectory(dir: string): void {
    this.pathValidator.addAllowedDirectory(dir);
  }

  /** 运行时移除允许访问的目录，返回是否命中并移除 */
  removeAllowedDirectory(dir: string): boolean {
    return this.pathValidator.removeAllowedDirectory(dir);
  }

  /** 获取当前允许目录白名单（副本） */
  getAllowedDirectories(): string[] {
    return this.pathValidator.getAllowedDirectories();
  }

  /**
   * 获取内部路径校验器实例（供工具层之外的读路径复用同一道防线，如 `@文件` 提及展开）。
   *
   * 返回实例本身而非副本：`addAllowedDirectory`（/add-dir）改的是这个实例，
   * 复制一份会让消费方看不到本会话的运行时授权。
   */
  getPathValidator(): PathValidator {
    return this.pathValidator;
  }

  /** 获取配置（只读，供子代理 checker 工厂复制配置） */
  getConfig(): Readonly<Config> {
    return this.config;
  }

  /**
   * 构造路径规则解析上下文（P0-2）。
   * 文件类工具（read/write/edit）的路径规则前缀（`//` `~/` `/` `./`）需据此归一化。
   * workspaceRoot=项目根；cwd 优先用 bash 显式 cwd 参数（如有），否则工作区根。
   */
  private buildPathRuleContext(req?: PermissionRequest): PathRuleContext {
    const inputCwd = (req?.input as { cwd?: string } | undefined)?.cwd;
    return {
      workspaceRoot: this.workspacePath,
      homeDir: os.homedir(),
      cwd: inputCwd || this.workspacePath,
    };
  }

  /**
   * P1-3：判断 bash 命令在 acceptEdits 模式下是否可自动放行。
   *
   * 对齐 CC modeValidation.ts + pathValidation.ts：复合命令拆分后，**每个**子命令的 baseCmd
   * 都必须是文件系统命令（ACCEPT_EDITS_FS_COMMANDS），**且**其路径参数经校验都在 cwd 内。
   * 任一子命令不满足 → 返回 false（落回 ask）。
   *
   * 注意：危险命令层（Step 2）在 acceptEdits（Step 11）之前，故 `rm -rf /` 等已先被拦，
   * 本方法只处理「逃过危险检测的普通 fs 命令」，保持 bypass-immune 语义不破。
   */
  private canAutoAllowFsCommandInAcceptEdits(command: string): boolean {
    const subCommands = splitCompoundCommand(command);
    if (subCommands.length === 0) return false;

    const cwd = this.workspacePath;
    for (const sub of subCommands) {
      const trimmed = sub.trim();
      if (!trimmed) return false;
      const tokens = trimmed.split(/\s+/);
      const baseCmd = tokens[0];
      // baseCmd 必须是白名单 fs 命令
      if (!ACCEPT_EDITS_FS_COMMANDS.has(baseCmd)) return false;

      // 路径参数（非 - 开头的 token，跳过 baseCmd 本身）都必须在 cwd 内
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok.startsWith("-")) continue; // 跳过选项标志
        // sed 的脚本参数（如 's/a/b/'）不是路径——含 / 但非路径的表达式会被下方 resolve 兜住：
        // 只要 resolve 后不在 cwd 内即 false，脚本表达式通常不在 cwd 内故不会误放行；
        // 保守起见对 sed 的首个非选项参数（脚本）放宽：仅校验其余参数（文件）。
        if (baseCmd === "sed" && i === 1 && !tok.includes("/")) {
          // 形如 sed -i 'expr' file：expr 不含 / 时视为脚本，跳过
          continue;
        }
        const resolved = path.isAbsolute(tok) ? tok : path.resolve(cwd, tok);
        if (!this.pathValidator.isWithinWorkspace(resolved)) {
          return false;
        }
      }
    }
    return true;
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

  /**
   * G21：判断某绝对路径是否被 deny 规则隐藏（供 glob/ls 列举结果过滤用）。
   *
   * 背景：glob/ls 只有文件系统级 ignore（node_modules/.git/dist），不接权限 deny 规则，
   * 被 deny 的敏感文件（如 .env、secrets/**）仍会出现在列表里，只是后续 Read 才被拦。
   * 对标 claude-code：deny 规则让被拒文件从列举结果里隐藏，模型根本看不到。
   *
   * 只做**静态 deny 规则匹配**（read 族），不走完整 check()（无 LLM/交互/副作用），
   * 因此可高频调用于列举过滤而无性能/成本负担。无 deny 规则时恒返回 false（零开销）。
   *
   * 路径形态：deny 模式可能写成相对（`.env*` / `secrets/**`）或绝对，故同时用
   * 绝对路径与工作区相对路径两种形态去匹配，任一命中即视为隐藏。
   *
   * @param absPath 待判定的绝对路径
   * @returns true = 被 deny 规则命中，应从列举结果隐藏
   */
  isPathHidden(absPath: string): boolean {
    const deny = this.rules?.deny;
    if (!deny || deny.length === 0) return false;

    const denyOnly = { deny, allow: [], ask: [] };

    // P0-2：路径规则前缀（`//` `~/` `/` `./`）现由 matchPathRule 统一解析归一化，
    // 不再需要旧的「绝对+工作区相对双候选」workaround——传绝对路径 + pathCtx，
    // matchPathRule 会把规则里的相对/前缀模式 resolve 到同一坐标系后比对。
    const decision = checkRules(
      denyOnly,
      { toolName: "read", input: { file_path: absPath } },
      this.buildPathRuleContext(),
    );
    return !!(decision && !decision.allowed);
  }

  /**
   * 异步初始化：从所有来源加载权限规则（P2-1：单一事实源 = RuleLoader）。
   *
   * 加载顺序与优先级：
   * - 构造器传入的 `rules`（来自 cli.ts loadPermissionRules，B 加载器）仅作**启动占位**，
   *   让 initRules 之前的权限检查有兜底；此处 loadAll 读到真实文件后，以 RuleLoader（A）为准。
   *   为避免 B 的占位 projectSettings 与 A 读到的 projectSettings 重复，先清占位再 loadAll。
   * - cliArg（--allow-tool/--deny-tool）与 flagSettings 从 config 接线（P2-1 补齐的接线缺口）。
   */
  async initRules(): Promise<void> {
    // 清除构造器 B 占位的 projectSettings，避免与 loadAll 读到的真实文件重复计数
    this.ruleLoader.clearSource("projectSettings");

    await this.ruleLoader.loadAll();

    // P2-1：接线 CLI 规则（cliArg 源）——此前 setCliArgRules 零调用者，--allow/deny-tool 从不生效
    const cliAllow = (this.config as { cliAllowRules?: string[] }).cliAllowRules;
    const cliDeny = (this.config as { cliDenyRules?: string[] }).cliDenyRules;
    if ((cliAllow && cliAllow.length) || (cliDeny && cliDeny.length)) {
      this.ruleLoader.setCliArgRules(cliAllow, cliDeny);
    }

    // 同步到旧版 rules 字段（兼容 checkRules 消费）
    this.rules = this.ruleLoader.toPermissionRule();
  }

  /**
   * 从 ruleLoader 重新同步旧版 rules 字段（P2-3）。
   * 供运行时向 ruleLoader 增删规则（如 always-persist 的 addSessionRule）后，
   * 让 checkRules 消费的 this.rules 立即反映最新合并结果。
   */
  refreshRulesFromLoader(): void {
    this.rules = this.ruleLoader.toPermissionRule();
  }

  /** 读取当前合并后的权限规则（P0-3：供 skill 元工具抽取 Skill(name) 规则）。 */
  getRules(): PermissionRule | null {
    return this.rules;
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
    //
    // bash 复合命令需逐子命令拆分匹配（对称于 Step 8 的 checkAllowRules）：
    // 用户配 `deny: ["Bash(curl *)"]` 时，`ls && curl evil.com` 的后段 curl 不应
    // 因 minimatch 前缀不跨 `&&` 而漏匹配。deny 语义与 allow 相反——任一子命令命中
    // deny 规则即整体拒绝（some(deny)，非 every）。
    if (this.rules) {
      const ruleDecision = this.checkDenyRules(req);
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
        // SEC-AUDIT-2026-07-19 P2：敏感文件（凭证类）现在是**硬 deny**，但保留一个
        // 逃生舱——用户在 settings.json 的 permissions.allow 里显式写了
        // `Read(.env)` / `Read(secrets/**)` 这类规则时放行。
        //
        // 为什么只对敏感文件开这个口子，不对系统目录/symlink 逃逸开：
        // 前者是"用户明确知道自己要读哪个凭证文件"的正当场景（部署脚本、配置排查），
        // 后者要么是路径穿越攻击、要么是配置错误，没有"用户本意如此"的合理解释。
        //
        // 关键点：逃生舱是**配置文件里的决定**，不是对话中的一次点击。这正是收紧
        // needsConfirmation → deny 想要的效果（详见 path-validator.ts 第 6 步注释）。
        if (pathResult.sensitiveFile && this.rules) {
          const allowDecision = this.checkAllowRules(req);
          if (allowDecision?.allowed) {
            log.info(
              "PERMISSION",
              `${req.toolName}(${filePath.slice(0, 80)}) → 允许(敏感文件，但命中用户显式 allow 规则)`,
            );
            this.auditLogger.log({
              timestamp: new Date().toISOString(),
              type: "tool_use",
              tool: req.toolName,
              resource,
              decision: "allow",
              reason: `敏感文件经用户显式 allow 规则放行: ${pathResult.reason}`,
            });
            return { ...allowDecision, decisionReason: { type: "rule", rule: "allow", behavior: "allow" } };
          }
        }
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
      const askDecision = checkRules({ deny: [], allow: [], ask: this.rules.ask }, req, this.buildPathRuleContext(req));
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
      const allowDecision = this.checkAllowRules(req);
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
      // P1-3：cwd 内的文件系统 bash 命令（mkdir/touch/rm/rmdir/mv/cp/sed）也自动放行。
      // 危险命令层（Step 2）已在前拦截 rm -rf / 等，跨 cwd 的 mv/rm 由 cwd 路径校验挡下。
      if (req.toolName === "bash") {
        const command = (req.input as { command?: string })?.command ?? "";
        if (command && this.canAutoAllowFsCommandInAcceptEdits(command)) {
          log.info("PERMISSION", `bash(${command.slice(0, 80)}) → 允许(acceptEdits模式+cwd内fs命令)`);
          return { allowed: true, decisionReason: { type: "mode", mode: "acceptEdits" } };
        }
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
  async check(req: PermissionRequest, tool?: Tool, toolContext?: ToolUseContext, options?: PermissionCheckOptions): Promise<Decision> {
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
      // 记账（发现 1）：这条快速路径此前在任何计数之前就 return，导致
      //   - 记忆为 allow 时，该签名的连续拒绝计数不归零（墙已消失却仍算在撞墙）；
      //   - 记忆为 deny 时，反复撞同一面墙完全不被计数。
      // 两者都让熔断判据失真，故在此对称补记。
      this.denialTracking = allowed
        ? recordSuccess(this.denialTracking, req.toolName, resource)
        : recordDenial(this.denialTracking, req.toolName, "会话记忆拒绝", resource);
      return { allowed, decisionReason: { type: "sessionMemory" } };
    }

    // 运行阶段 1 内部检查
    const result = await this.hasPermissionsInner(req, tool, toolContext);

    // ── G2/G3：PreToolUse hook 权限决策注入 ──
    // 安全护栏（对齐 CC toolHooks.ts:386 + 我们既有 yesMode 语义）：
    //   - hook allow 只能把「普通 ask」转为放行；对硬拒绝（!allowed && !needsConfirmation）、
    //     危险命令确认（dangerousCommand）、safetyCheck 确认一律无效——deny/危险命令不被越过。
    //   - hook ask 把「本会放行」强制升级为用户确认（needsConfirmation）。
    if (options?.hookPermissionDecision === "allow") {
      const dr = result.decisionReason?.type;
      const isSafetyConfirmation = dr === "dangerousCommand" || dr === "safetyCheck";
      // 仅普通 ask（needsConfirmation 且非安全类确认）可被 hook allow 放行；硬 deny 不放行
      if (!result.allowed && result.needsConfirmation && !isSafetyConfirmation) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(PreToolUse hook permissionDecision:allow)`);
        this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource,
          decision: "allow",
          reason: "PreToolUse hook allow",
          user_confirmed: false,
        });
        return { allowed: true, decisionReason: { type: "other", reason: "PreToolUse hook allow" } };
      }
      if (!result.allowed) {
        log.info("PERMISSION", `${req.toolName} → PreToolUse hook allow 被安全护栏拦截(${dr})，不放行`);
      }
    } else if (options?.hookPermissionDecision === "ask" && result.allowed) {
      // hook 要求升级确认：把本会自动放行的操作强制转为 needsConfirmation。
      // 非交互/dontAsk 无 UI 通道 → 降级为 deny（对齐既有 ask→deny 语义）。
      if (this.config.permissionMode === "dontAsk" || this.isNonInteractive()) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(PreToolUse hook ask，但无交互通道)`);
        return {
          allowed: false,
          reason: "PreToolUse hook 要求确认，但当前为非交互模式，自动拒绝",
          decisionReason: { type: "other", reason: "PreToolUse hook ask (non-interactive)" },
        };
      }
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 升级确认(PreToolUse hook permissionDecision:ask)`);
      return {
        allowed: false,
        needsConfirmation: true,
        reason: "PreToolUse hook 要求用户确认",
        decisionReason: { type: "other", reason: "PreToolUse hook ask" },
      };
    }

    // allow → 重置 denial tracking
    if (result.allowed) {
      this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
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
    //
    // 熔断检查在此处（return 之前）执行，而非旧实现的 :994（ask 后处理末尾）。
    // 负收益防线审计发现 1 的结构性根因正是这个位置：hard deny 是唯一给计数器记账的路，
    // 却在这里就地 return，永远走不到下方的熔断检查点；而能走到那里的 ask 路径不记账。
    // 现在改为「记账的那条路自己检查」，判据与检查点归位。
    if (!result.needsConfirmation) {
      // 同一操作签名此前已连续被拒达阈值 → 本次熔断为人工确认（而非继续硬拒）。
      // 语义：模型显然在对同一面墙反复撞，交给人判断是放行还是让它换路。
      //
      // 判定放在 recordDenial **之前**：阈值 3 的语义是"前 3 次照常拒绝、第 4 次尝试才熔断"。
      // 若先记账再判定，第 3 次尝试本身就会变成确认弹窗——那时模型只被拒过 2 次，属提前打扰
      // （也与 denial-tracking.ts 文件头反事实表的口径不一致，那张表就是先判定后记账）。
      //
      // dontAsk / 非交互无 UI 通道，熔断成确认等于必然失败，故这两种情形维持原硬拒。
      if (
        shouldFuse(this.denialTracking, req.toolName, resource)
        && this.config.permissionMode !== "dontAsk"
        && !this.isNonInteractive()
      ) {
        return this.fuseDecision(req, resource);
      }
      this.denialTracking = recordDenial(this.denialTracking, req.toolName, result.reason || "", resource);
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
        this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
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

    // auto 模式：分类器判安全则自动批准，否则落到交互确认（needsConfirmation）
    if (this.config.permissionMode === "auto") {
      const toolClassifier = this.getToolClassifier();
      if (toolClassifier?.isAvailable()) {
        try {
          // G7：工具可自报精简语义视图，供分类器降噪/跳过。钩子异常不阻断（回退原始 input）。
          let classifierInput: string | undefined;
          if (typeof tool?.toAutoClassifierInput === "function") {
            try {
              classifierInput = tool.toAutoClassifierInput(req.input);
            } catch {
              classifierInput = undefined;
            }
          }
          const classifyResult = await toolClassifier.classify({
            toolName: req.toolName,
            input: (req.input || {}) as Record<string, unknown>,
            cwd: this.workspacePath,
            classifierInput,
          });
          if (!classifyResult.classifierUnavailable && classifyResult.safe) {
            log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(auto 模式分类器批准: ${classifyResult.reason})`);
            this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
            this.auditLogger.log({
              timestamp: new Date().toISOString(),
              type: "tool_use",
              tool: req.toolName,
              resource,
              decision: "allow",
              reason: `auto 模式分类器批准: ${classifyResult.reason}`,
            });
            return { allowed: true, decisionReason: { type: "mode", mode: "auto" } };
          }
          // 分类器判不安全或不可用：落到下方正常确认流程（needsConfirmation）
          log.info("PERMISSION", `${req.toolName} → auto 模式分类器未放行(${classifyResult.reason})，回退人工确认`);
        } catch (err: any) {
          log.warn("PERMISSION", `auto 模式分类器异常(${err.message})，回退人工确认`);
        }
      }
      // 分类器不可用或未放行 → 返回 needsConfirmation，让上层三路竞争/用户弹窗处理
    }

    // dontAsk 模式：ask → deny（绝不弹窗，对齐 Claude Code 语义）
    if (this.config.permissionMode === "dontAsk") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(dontAsk模式下ask→deny)`);
      this.denialTracking = recordDenial(this.denialTracking, req.toolName, result.reason || "", resource);
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
      this.denialTracking = recordDenial(this.denialTracking, req.toolName, result.reason || "", resource);
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

    // denial tracking 熔断检查：回退人工确认（而非直接 deny）
    // 让用户知道模型在重复尝试同一操作，但仍允许人工审慎判断放行。
    //
    // 这一路仍保留：ask 路径下模型也可能反复撞同一面墙（如 dontAsk 之外的模式里
    // 用户连续拒同一操作后模型再试）。判据已改为「按操作签名的连续拒绝」，
    // 故这里必须把当前请求的 tool/resource 传进去，而不是查全局状态。
    if (shouldFuse(this.denialTracking, req.toolName, resource)) {
      return this.fuseDecision(req, resource);
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

    // ── 第 1.6 道（G4 修复）：sed 权限门 ──
    // 对标 claude-code sedValidation.ts checkSedConstraints：
    //   - s///e / e / w / W / r / R 表达式 → 直接拒绝（执行 shell / 写任意文件）
    //   - sed -i → 把目标文件当**文件写入**做路径校验（PathValidator），
    //     敏感文件/工作区外文件走权限门（同 edit/write），而非仅走"普通 bash 确认"。
    {
      const { detectDangerousSed, detectSedWrite } = await import("../tool/bash/sed-validation.ts");

      // 1) 危险 sed 标志：拒绝（严重性等同 critical/high 硬编码命令）
      const dangerousSed = detectDangerousSed(cmd);
      if (dangerousSed.dangerous) {
        log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(危险sed: ${dangerousSed.reason})`);
        return {
          allowed: false,
          reason: `[sed-danger] ${dangerousSed.reason}: ${cmd.slice(0, 80)}`,
          needsConfirmation: true,
          decisionReason: { type: "dangerousCommand", pattern: `sed:${dangerousSed.reason}`, severity: "high" },
          metadata: { classifiedBy: "sed-validator" },
        };
      }

      // 2) sed -i → 目标文件路径校验（同 write/edit 走 PathValidator）
      const sedWrite = detectSedWrite(cmd);
      if (sedWrite.isSedWrite && sedWrite.targetFile) {
        const { resolve, isAbsolute } = await import("node:path");
        // 相对路径按 bash 实际 cwd 解析：优先 input.cwd（bash 显式 cwd 参数），
        // 否则用全局 getCwd()（追踪 cd 跨命令的目录），与 bash.resolveCwd 一致。
        // 避免 cd subdir 后相对目标被误按启动目录校验。
        let baseCwd: string;
        const inputCwd = (req.input as any)?.cwd;
        if (typeof inputCwd === "string" && inputCwd) {
          baseCwd = inputCwd;
        } else {
          try {
            const { getCwd } = await import("../bootstrap/state.ts");
            baseCwd = getCwd();
          } catch {
            baseCwd = process.cwd();
          }
        }
        const targetPath = isAbsolute(sedWrite.targetFile)
          ? sedWrite.targetFile
          : resolve(baseCwd, sedWrite.targetFile);
        const pathResult = this.pathValidator.validateAccess(targetPath, "write");
        if (!pathResult.allowed) {
          log.info("PERMISSION", `${req.toolName}(sed -i → ${targetPath.slice(0, 80)}) → ${pathResult.needsConfirmation ? "需确认" : "拒绝"}(路径验证: ${pathResult.reason})`);
          return {
            allowed: false,
            reason: `sed -i 目标路径受限: ${pathResult.reason}`,
            needsConfirmation: pathResult.needsConfirmation,
            decisionReason: { type: "pathValidation", reason: pathResult.reason || "" },
            metadata: { classifiedBy: "sed-path-validator", targetFile: sedWrite.targetFile },
          };
        }
      }
    }

    // ── 第二道：LLM 风险分类器（仅当启用且可用；critical 已在上面拦截，这里只处理"看似不危险/中低危"的命令）──
    //   plan 模式（只读）不调用分类器：plan 模式下工具本就受限于只读，再花 LLM 成本判风险无意义（迭代 III 集成点 #3）。
    //   GAP-04：speculativeClassifier 开启时，**跳过此处的同步分类器调用**——分类器改由
    //   tool-executor 的三路竞争并行启动（与 UI 弹窗竞赛），避免"同步等分类器 + 弹窗"的串行叠加。
    //   安全不变式不受影响：第一道 critical 拒绝、第三道硬编码 high/medium 兜底确认仍同步生效，
    //   speculative 路径只能"提前放行需确认命令"，无法放行任何硬编码已知危险命令（弹窗兜底不被绕过）。
    //   代价（仅 opt-in 生效）：分类器对"硬编码判安全但 LLM 判危险"命令的升级拦截，在 speculative
    //   模式下让位给并行竞赛（该场景走弹窗/竞赛兜底）。默认关闭，保守用户行为不变。
    const speculativeMode = (this.config as any).speculativeClassifier === true;
    if (!speculativeMode && this.config.permissionMode !== "plan" && this.bashClassifier?.isAvailable()) {
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
   * deny 规则检查（复合命令感知）——对称于 checkAllowRules，语义相反。
   *
   * 对齐 claude-code bashPermissions：`Bash(curl *)` 这类前缀/glob deny 规则**不能**被
   * `safe && curl evil` 这样的复合命令前缀绕过。minimatch 不跨 `&&`/`||`/`;`/`|`，
   * 整条匹配时 `ls && curl evil.com` 匹配不到 `curl *` 规则 → 用户配置的 deny 被静默绕过。
   *
   * 修复：bash 命令先 splitCompoundCommand 拆成子命令，**任一子命令命中 deny 规则即整体拒绝**
   * （some(deny)，与 allow 的 every 相反）。非 bash 工具保持原逻辑，整条匹配。
   *
   * 说明：内置危险模式检测（Step 2 hardcodedDangerCheck）本就复合命令感知，故 `ls && curl|sh`
   * 这类内置模式不受影响；本修复补的是"用户自定义 deny 规则"对复合命令后段的覆盖缺口。
   */
  private checkDenyRules(req: PermissionRequest): Decision | null {
    if (!this.rules) return null;
    const denyRules = { deny: this.rules.deny, allow: [], ask: [] };
    const pathCtx = this.buildPathRuleContext(req);

    // 非 bash：保持原整条匹配语义（文件类工具走路径前缀解析）
    if (req.toolName !== "bash") {
      return checkRules(denyRules, req, pathCtx);
    }

    const command = (req.input as { command?: string })?.command ?? "";
    const subCommands = splitCompoundCommand(command);

    // 单命令（无 &&/||/;/| 复合）：等价于原逻辑，直接整条匹配
    if (subCommands.length <= 1) {
      return checkRules(denyRules, req, pathCtx);
    }

    // 复合命令：逐子命令校验，任一子命令命中 deny 即整体拒绝（some(deny)）
    for (const sub of subCommands) {
      const subReq: PermissionRequest = {
        ...req,
        input: { ...(req.input as object), command: sub },
      };
      const subDecision = checkRules(denyRules, subReq, pathCtx);
      if (subDecision && !subDecision.allowed) {
        // 命中的 deny 规则针对的是子命令，reason 里带上原始命令上下文更可读
        return subDecision;
      }
    }
    // 没有任何子命令命中 deny
    return null;
  }

  /**
   * allow 规则检查（复合命令感知）。
   *
   * 对齐 claude-code bashPermissions：`Bash(safe *)` 这类前缀/glob allow 规则**不能**放行
   * `safe && evil` 这样的复合命令。否则 `allow: ["Bash(ls *)"]` 会因 `ls *` 的 `*` 贪婪吞掉
   * `ls && ./untrusted.sh` 的后半段而整体放行，形成 allow 越权。
   *
   * 修复：bash 命令先 splitCompoundCommand 拆成子命令，要求**每个子命令都被 allow 覆盖**
   * （every(allow)）才放行；任一子命令不在 allow 覆盖内 → 不放行（落到后续 ask）。
   * 非 bash 工具（file_path/pattern 类）保持原逻辑，整条匹配。
   *
   * 说明：危险命令检测（Step 2）已在本步之前对复合命令拆分逐子命令查危险模式，
   * 故 `ls && curl|sh` 这类会被更早拦下；本修复补的是"逃过危险模式、又非受保护路径写入的
   * 第二条命令"（如 `ls && ./x.sh`、`ls && git push`）被 allow 前缀规则误放行的越权缺口。
   */
  private checkAllowRules(req: PermissionRequest): Decision | null {
    if (!this.rules) return null;
    const allowRules = { deny: [], allow: this.rules.allow, ask: [] };
    const pathCtx = this.buildPathRuleContext(req);

    // 非 bash：保持原整条匹配语义（文件类工具走路径前缀解析）
    if (req.toolName !== "bash") {
      return checkRules(allowRules, req, pathCtx);
    }

    const command = (req.input as { command?: string })?.command ?? "";
    const subCommands = splitCompoundCommand(command);

    // 单命令（无 &&/||/;/| 复合）：等价于原逻辑，直接整条匹配
    if (subCommands.length <= 1) {
      return checkRules(allowRules, req, pathCtx);
    }

    // 复合命令：逐子命令校验，全部命中 allow 才放行（every(allow)）
    for (const sub of subCommands) {
      const subReq: PermissionRequest = {
        ...req,
        input: { ...(req.input as object), command: sub },
      };
      const subDecision = checkRules(allowRules, subReq, pathCtx);
      if (!subDecision || !subDecision.allowed) {
        // 任一子命令不在 allow 覆盖内 → 整体不放行，落到后续 ask
        return null;
      }
    }
    // 所有子命令都被 allow 覆盖
    return { allowed: true };
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
    //
    // ⚠️ 安全：每个子命令**额外**用「剥离 git 全局选项后的归一串」再查一遍。
    // git 允许在子命令之前插入 `-c k=v` / `-C dir` / `--no-pager` 等全局选项
    // （`git -c core.pager=cat reset --hard`），这会把子命令与 `git` 撑开，使所有
    // `\bgit\s+<子命令>` 形态的正则失配 → 危险命令在 acceptEdits/yesMode 下被静默放行。
    // 归一化后双重匹配即可覆盖该绕过（对齐 CC gitCmdRe 的全局选项容错）。
    const subCommands = splitCompoundCommand(cmd);
    const nonPipelinePatterns = DANGEROUS_PATTERNS.filter(dp => !pipelinePatterns.includes(dp));
    for (const subCmd of subCommands) {
      const normalized = normalizeGitGlobalOptions(subCmd);
      const variants = normalized === subCmd ? [subCmd] : [subCmd, normalized];
      for (const dp of nonPipelinePatterns) {
        if (variants.some(v => dp.pattern.test(v))) {
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
        // 字段提取与 rules.ts extractMatchValue 对齐（subagent_type 优先，兼容旧 type）
        const subType = (req.input as any)?.subagent_type || (req.input as any)?.type;
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
