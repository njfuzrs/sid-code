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

import type {
  Checker,
  Decision,
  PermissionRequest,
  PermissionRule,
  PermissionCheckOptions,
  PermissionDecisionReason,
} from "./types.ts";
import type { Config } from "../config/config.ts";
import type { PermissionMode } from "./mode.ts";
import type { PlanModeManager } from "../plan/state.ts";
import type { Tool, ToolUseContext } from "../tool/types.ts";
import { checkRules, extractMatchValue } from "./rules.ts";
import type { PathRuleContext } from "./path-rule-matching.ts";
import { AuditLogger } from "./audit.ts";
import { getLogger } from "../debug/logger.ts";
import { splitCompoundCommand, hasSensitiveRedirection } from "./shell-parser.ts";
import { splitCommandStructure } from "./shell-structure.ts";
import {
  isPipelineFilterStage,
  parseLiteralCdTarget,
  resolveCdTarget,
} from "./allow-composition.ts";
import {
  expandShellCommand,
  extractBashWriteTargets,
  listInvokedPrograms,
  type ShellCommandExpansion,
} from "./shell-command-variants.ts";
import { detectStructuredCriticalDanger, type DangerousFinding } from "./dangerous-command.ts";
import { isToolNameListed } from "../tool/tool-name-aliases.ts";
import { checkInjectionPatterns } from "./bash-security.ts";
import { PathValidator, normalizeCaseForComparison } from "./path-validator.ts";
import { SAFETY_PROTECTED_PATHS, stripWorktreeContainerPrefix } from "./safety-protected-paths.ts";
import {
  type DenialTrackingState,
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFuse,
  denialSignature,
  DENIAL_LIMITS,
} from "./denial-tracking.ts";
import { recordDefenseTrigger } from "../telemetry/metrics/defense-metrics.ts";
import { RuleLoader } from "./rule-loader.ts";
import { getShadowedRulesForTool } from "./shadowed-rules.ts";
import type { SandboxManager } from "./sandbox.ts";
import { BashClassifier } from "./bash-classifier.ts";
import { GIT_DANGER_PATTERNS, normalizeGitGlobalOptions } from "./git-danger-patterns.ts";
import * as path from "node:path";
import { getAgentRoot, getAgentCwd, getIsolatedWorktree } from "../bootstrap/cwd-context.ts";
import * as os from "node:os";

/** 危险命令模式（对标 Claude Code 15 种） */
interface DangerousPattern {
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium";
}

/** 提权程序：出现在程序位置即命中 high「sudo 命令」 */
const PRIVILEGE_PROGRAMS = new Set(["sudo", "doas"]);
/** tokenize 不可信（引号未闭合）时的回退正则，即修前的原文判据 */
const SUDO_FALLBACK_RE = /sudo\s+/;

/**
 * 「sudo 命令」判定：子命令的**程序位置**是 sudo / doas（沿 wrapper 链与 find -exec 往下找）。
 *
 * 修前是对子命令原文跑 `/sudo\s+/`，`grep -n "…\|sudo 命令\|…" checker.ts`、`grep -rn sudo docs`
 * 这类只是**提到** sudo 的命令全部命中 high。#443 认为 high 误报「只是多一次确认，有出口」，
 * 这在无头模式下不成立：ask 直接落成 deny（harness-bench P3v 实测）。
 *
 * 输入是 expandShellCommand 的 variants（已展开 sh -c / eval / 命令替换内层），
 * 所以 `bash -c "sudo id"` 照样覆盖。**不能**用 commands[].program：展开时 sudo 被当
 * wrapper 剥掉了，commands 里看不到它。
 *
 * 名字与级别保持「sudo 命令」/ high 不变，遥测与既有断言都认这个名字。
 */
function detectPrivilegeEscalation(variants: readonly string[]): DangerousFinding | null {
  for (const sub of variants) {
    const programs = listInvokedPrograms(sub);
    const hit =
      programs === null
        ? SUDO_FALLBACK_RE.test(sub)
        : programs.some((p) => PRIVILEGE_PROGRAMS.has(p));
    if (hit) return { name: "sudo 命令", severity: "high" };
  }
  return null;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // critical: 直接拒绝，不允许确认
  //
  // ⚠️ 10 条 critical 已迁到结构化判定（dangerous-command.ts），**不要加回正则表**：
  // 「递归删除根目录 / 家目录」「磁盘擦除」「格式化磁盘」「写入块设备」「下载并执行」
  // 「base64 / xxd 解码执行」「Python exec / Perl system」都是关于**程序名 + 参数值**的
  // 判断，写成对命令原文的正则必然两头错：
  //   - 误报（硬拒且管线内无出口）：`git commit -m "rm -rf /"`、`grep 'curl x | sh'`、
  //     `rm -rf ~/Downloads/old`、heredoc 正文；
  //   - 漏报（always-allow 下放行）：`rm -rf '/'`、`rm -Rf /`、`rm --recursive --force /`、
  //     `rm -rf $HOME`、`mkfs -t ext4 /dev/sdb`、`dd of=… if=…`。
  // 2026-10-26 的探针实测见 .agents/notes/implemented/bug-fix/2026-10-26-危险命令按token判定.md。
  //
  // Fork 炸弹保留原文正则：它对完整形态要求很严（`echo ':(){ :|:& };:'` 实测不误报），
  // token 化没有收益。
  { name: "Fork 炸弹", pattern: /:()\s*\{.*:\|:.*&.*\}\s*;/, severity: "critical" },

  // high: 拒绝但允许用户确认
  // 「sudo 命令」不在正则表里：按程序位置判（detectPrivilegeEscalation），见那里的注释。
  { name: "命令替换注入", pattern: /`[^`]*`|\$\([^)]*\)/, severity: "high" },
  { name: "递归权限修改", pattern: /chmod\s+-R\s+(777|666)/, severity: "high" },
  { name: "递归所有者修改", pattern: /chown\s+-R\s+/, severity: "high" },
  {
    name: "环境变量覆盖",
    pattern: /export\s+(PATH|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/,
    severity: "high",
  },

  // high: 数据外传 + 敏感信息读取
  {
    name: "curl POST 数据外传",
    pattern: /curl\s+.*(-X\s*POST|--data|--data-binary|-d\s)/,
    severity: "high",
  },
  { name: "nc 管道外传", pattern: /\|\s*nc\s+/, severity: "high" },
  {
    name: "读取 shell 历史",
    pattern: /\b(cat|head|tail|less|more|rg|grep)\b.*\.(bash_history|zsh_history|history)/,
    severity: "high",
  },
  // P1-1：读类命令 × 敏感路径，不再只认 `cat` + 特定文件名。
  // `head ~/.ssh/id_rsa` / `rg -n . ~/.ssh/id_rsa` / `cat .env` 修前全部放行。
  {
    name: "读取 SSH 密钥",
    pattern:
      /\b(cat|head|tail|less|more|rg|grep|awk|sed|nl|od|hexdump|xxd|strings)\b.*(\.ssh\/|id_rsa|id_ed25519|id_dsa|id_ecdsa|authorized_keys)/,
    severity: "high",
  },
  {
    name: "读取敏感凭证文件",
    pattern:
      /\b(cat|head|tail|less|more|rg|grep|awk|sed|nl|od|hexdump|xxd|strings)\b.*(\.env($|[\s./])|\.aws\/(credentials|config)|\.kube\/config|\.docker\/config\.json|\.git-credentials|\.netrc|\.npmrc|\.pypirc)/,
    severity: "high",
  },

  // medium: 需要用户确认
  // 数据主权整改 PR-B（P1-9）：整体转储环境变量。上面的「读取敏感凭证文件」只认读类命令 +
  // 文件路径，而 `env` / `printenv` 一条命令就把 shell 里所有 *_API_KEY 打进工具输出 →
  // 进上下文 → 进轨迹（落盘脱敏是唯一兜底，且规则必有漏网）。
  // 只拦**转储**形态：裸 `env`（可带 -0）、任意 `printenv`；`env FOO=1 cmd` 这种用 env
  // 设置变量再执行命令的常见写法不拦。按子命令匹配，所以 `env | grep KEY` 同样命中。
  {
    name: "转储环境变量",
    pattern: /^\s*(?:printenv\b.*|env(?:\s+-0)?\s*)$/,
    severity: "medium",
  },
  { name: "路径遍历", pattern: /\.\.[\/\\]/, severity: "medium" },
  { name: "后台进程", pattern: /&\s*$/, severity: "medium" },
  { name: "管道到文件覆盖", pattern: />\s*\/etc\//, severity: "medium" },
  {
    name: "清除命令历史",
    pattern: /history\s+-c|>\s*.*\.(bash_history|zsh_history)/,
    severity: "medium",
  },
  { name: "修改 crontab", pattern: /crontab\s+(-e|-r|-l)/, severity: "medium" },

  // Git —— 破坏性/难恢复（P0-2，对齐 CC destructiveCommandWarning）。
  // 从 git-danger-patterns.ts 单一事实源展开，避免与 UI 层 danger-detect 两份正则漂移。
  // hardcodedDangerCheck 会按复合命令拆分逐子命令查这些模式，加进此表后自动继承拆分能力。
  ...GIT_DANGER_PATTERNS,
];

/** 文件工具（需要路径校验）。notebook_edit 路径字段是 notebook_path，见 extractFilePath。 */
const FILE_TOOLS = new Set(["read", "write", "edit", "notebook_edit"]);

/**
 * P1-1：敏感文件硬 deny 不能只覆盖 read 工具。
 * grep / read_many 的 `path` 指向凭证文件时，走同一道 PathValidator。
 * 全树搜索（无 path / path 是目录）在工具执行层按 isPathHidden ∪ isSensitivePath 过滤。
 */
const PATH_VALIDATED_READ_TOOLS = new Set(["grep", "read_many"]);

/** 写操作工具。notebook_edit 整文件原子写盘，与 write/edit 同属 safetyCheck 守卫对象。 */
const WRITE_TOOLS = new Set(["write", "edit", "notebook_edit"]);

/**
 * 从请求抽出用于路径校验 / safetyCheck 的文件路径。
 * notebook_edit 的字段是 `notebook_path`，不是 `file_path`；漏这一层会让
 * Step 4 / Step 6 整段跳过（P0-2）。一处抽取，别在各步骤各写一次。
 */
function extractFilePath(req: PermissionRequest): string {
  const input = req.input as
    | {
        file_path?: unknown;
        notebook_path?: unknown;
        path?: unknown;
      }
    | undefined;
  const raw = input?.file_path || input?.notebook_path || input?.path || "";
  return typeof raw === "string" ? raw : "";
}

/**
 * P1-2：会话记忆的资源部分。空串表示「禁止写入 / 命中记忆」。
 *
 * - 写工具（write/edit/notebook_edit）不做 always 会话记忆：同路径不同内容会串味
 *   （批准过改注释，再写入 hook 脚本免确认）。
 * - grep 必须同时有 path 和 pattern，否则「工作区搜 password」会放行 `/etc/passwd`。
 * - web_fetch 用完整 URL，不用规则匹配的 `domain:`（同域不同路径会串）。
 * - 空资源（三个字段都缺、notebook/web_fetch 无目标）禁止记忆。
 */
function extractMemoryResource(req: PermissionRequest): string {
  const tool = req.toolName.toLowerCase();
  const input = (req.input ?? {}) as Record<string, unknown>;
  if (tool === "write" || tool === "edit" || tool === "notebook_edit") return "";
  if (tool === "read_many") return "";
  if (tool === "web_fetch") {
    return typeof input.url === "string" ? input.url : "";
  }
  if (tool === "grep") {
    const pathVal = typeof input.path === "string" ? input.path : "";
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (!pathVal || !pattern) return "";
    return `${pathVal}\0${pattern}`;
  }
  return extractMatchValue(req);
}

/**
 * 阶段一给出的确认是否属于「危险来源」：dangerousCommand / safetyCheck。
 * yesMode、auto、hook allow 三处必须共用——复制粘贴会漏抄（P0-1 就是 auto 漏了这道）。
 */
function isSafetyConfirmation(reason: PermissionDecisionReason | undefined): boolean {
  const t = reason?.type;
  return t === "dangerousCommand" || t === "safetyCheck" || t === "destructiveTool";
}

/**
 * auto 分类器是否允许发言。safetyCheck 命中且 classifierApprovable === false
 * （hooks / commands / settings）时分类器结果直接丢弃——这是字段存在的唯一理由。
 * classifierApprovable: true 的项（.git/、.bashrc）才允许分类器放行。
 */
function classifierMayApprove(reason: PermissionDecisionReason | undefined): boolean {
  if (!reason) return true;
  if (reason.type === "dangerousCommand" || reason.type === "destructiveTool") return false;
  if (reason.type === "safetyCheck") return reason.classifierApprovable === true;
  return true;
}

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
  // 2026-10-02（B22，同一形态第二次）：MCP 工具默认延迟加载（registry.isToolDeferred），
  // tool_search 是把它们调进上下文的**唯一入口**。它只改 registry 的激活集，不碰 fs /
  // 网络 / 子进程，readOnly() 也是 true；不在本表 → 无头模式与子代理一律 deny。
  // 实测：配了 6 个 MCP、5 个连上（88 个工具），模型主动 `tool_search("context7")`
  // 两次都被「非交互模式自动拒绝」，最后退回 web_fetch；本机历史 70+ 会话 mcp__ 调用 0 次。
  // 放行它不等于放行 MCP 工具：被调出来的 mcp__* 每次调用仍各自走权限判定。
  "tool_search",
  // 只列出已连接 server 的资源元数据（内存里的 serverStates），同样零副作用。
  // 对照：ReadMcpResource 会把 blob 落盘、且返回外部不可信内容，**刻意不放行**。
  "ListMcpResources",
]);

/** 会话记忆最大条目数 */
const MAX_SESSION_MEMORY = 1000;

/**
 * 无头会话的**本地记账工具**白名单：只写本地进度/任务账本，不碰工作区、网络、子进程。
 *
 * 2026-10-26：`todo_write` 此前在无头模式被拒（`isNonInteractive()` 把 ask 落成 deny），
 * 而计划批准消息（`plan/prompt.ts` 的 `buildPlanApprovedMessage`）**强制**要求第一步调它。
 * 两处规则在 `-p` 下直接矛盾：每一份计划进入执行阶段的第一步必然失败，
 * 实测一次 plan 无头实跑就此把整个执行阶段报废（`todo_write` 被拒 → 模型转成只读交付）。
 * 不止 plan：`acceptEdits` 无头会话同样被拒（acceptEdits 分支只放行 `FILE_TOOLS`）。
 *
 * 为什么**不复用** `READ_ONLY_TOOLS`：那个集合被三处共用——主链 Step 10、
 * plan 模式（`checkPlanMode`）、deny-write 模式（Step 13）。往里加 `todo_write`
 * 会同时放宽 plan 与 deny-write 两条语义，副作用面远超「无头会话」这一条。
 * 本集合只在「无头 + 已经走到 ask」这一条路径上生效，其余模式一条都没变。
 *
 * 判据（加新工具到本表前逐条核）：① 不写工作区文件；② 不出网；③ 不起子进程；
 * ④ 只改进程内账本或 `~/.sid-code/` 下的进度文件。任一条不满足就**不要**加。
 */
const HEADLESS_LOCAL_LEDGER_TOOLS = new Set(["todo_write", "task_create", "task_update"]);

/**
 * acceptEdits 模式下自动放行的文件系统命令（对齐 CC modeValidation.ts ACCEPT_EDITS_ALLOWED_COMMANDS）。
 * 仅当命令的路径参数都在 cwd 内才自动放行。
 * P1-3：`rm`/`rmdir`/`mv` 不在白名单——`rm -rf .` 的 `.` resolve 后就是 cwd，
 * isWithinWorkspace 为 true，会把工作区（cwd 恰好是家目录时更糟）直接删掉。
 */
const ACCEPT_EDITS_FS_COMMANDS = new Set(["mkdir", "touch", "cp", "sed"]);
/** 即使被加回白名单也不得自动放行（第二道闸，防名单回潮）。 */
const ACCEPT_EDITS_DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "mv"]);

/** Plan Mode 下额外允许的工具（在 READ_ONLY_TOOLS 基础上） */
const PLAN_MODE_EXTRA_TOOLS = new Set(["enter_plan_mode", "exit_plan_mode", "sub_agent"]);

/**
 * bash 权限判定所用的工作目录：input.cwd（bash 显式参数）> getCwd()（追踪 cd，子代理里读
 * ALS）。与 BashTool.resolveCwd 的前两级同口径；sed 目标解析与 LLM 分类器共用这一份，
 * 曾经一处用 getCwd()、一处用 process.cwd()，隔离子代理里两者分别是 worktree 与主仓。
 */
async function resolveBashCwdForCheck(req: PermissionRequest): Promise<string> {
  const inputCwd = (req.input as { cwd?: unknown } | undefined)?.cwd;
  if (typeof inputCwd === "string" && inputCwd) return inputCwd;
  try {
    const { getCwd } = await import("../bootstrap/state.ts");
    return getCwd();
  } catch {
    return process.cwd();
  }
}

export class PermissionChecker implements Checker {
  private config: Config;
  private preApproved = new Set<string>();
  /** 派生来源（子代理 checker 指向主 checker；主 checker 为 undefined） */
  private parentChecker?: PermissionChecker;
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
  /** 沙箱管理器（可选） */
  private sandboxManager: SandboxManager | null = null;
  /** LLM 命令风险分类器（第二道防线，默认不启用；通过 setBashClassifier 注入） */
  private bashClassifier: BashClassifier | null = null;
  /** 泛化工具分类器（auto 模式核心，通过 setToolClassifier 注入） */
  private toolClassifier: import("./tool-classifier.ts").ToolClassifier | null = null;
  /** 工作区路径（供 auto 模式分类器使用） */
  private workspacePath: string;
  /** Bridge 远程权限代理（可选，Bridge 模式下注入；签名对齐 PermissionProxy.requestPermission） */
  private bridgePermissionDelegate:
    | ((req: {
        toolName: string;
        toolInput: unknown;
        description: string;
        dangerLevel: string;
      }) => Promise<boolean>)
    | null = null;

  /**
   * B25：SDK stream-json 双向流下，ask 可以交给宿主（`can_use_tool`）。
   * 置 true 后 isNonInteractive() 返回 false，ask 不再被就地判 deny，而是回 needsConfirmation
   * 交给 App.requestUserConfirmation → 宿主。宿主超时 / 断开时那一侧按 deny 闭合（仍 fail-closed）。
   * 只在 `--input-format stream-json` 下打开：没有 stdin 回路时问了也没人答。
   */
  private externalAskChannel = false;

  setExternalAskChannel(enabled: boolean): void {
    this.externalAskChannel = enabled;
  }

  /** 设置 Bridge 远程权限代理（null 清除，回退到本地确认） */
  setBridgePermissionDelegate(
    delegate:
      | ((req: {
          toolName: string;
          toolInput: unknown;
          description: string;
          dangerLevel: string;
        }) => Promise<boolean>)
      | null,
  ): void {
    this.bridgePermissionDelegate = delegate;
  }

  /**
   * 当前有没有 Bridge 远程确认代理。
   * App 用它决定走远端还是 TUI——不要读私有字段，也不要 `(checker as any)`。
   */
  hasBridgePermissionDelegate(): boolean {
    return this.bridgePermissionDelegate !== null;
  }

  /**
   * 把一次需要人确认的工具交给已注入的 Bridge 代理。
   * 没有代理时返回 null，调用方继续走 TUI / headless，不要在这里假装拒绝。
   * 远程不支持「始终允许」，remember 仍由调用方保持 false。
   */
  async requestBridgePermission(req: {
    toolName: string;
    toolInput: unknown;
    description: string;
    dangerLevel: string;
  }): Promise<boolean | null> {
    if (!this.bridgePermissionDelegate) return null;
    return this.bridgePermissionDelegate(req);
  }

  /** 设置 Plan Mode 管理器 */
  setPlanManager(manager: PlanModeManager): void {
    this.planManager = manager;
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
    return this.deriveWithConfig({ ...this.config, permissionMode: mode });
  }

  /** 派生共用实现：按给定 config 新建实例并搬运运行期协作者。 */
  private deriveWithConfig(derivedConfig: Config): PermissionChecker {
    const derived = new PermissionChecker(
      derivedConfig,
      this.rules ?? undefined,
      this.workspacePath,
    );
    // 搬运运行期注入的协作者（构造函数不覆盖这些，需显式复制）。
    if (this.planManager) derived.setPlanManager(this.planManager);
    if (this.sandboxManager) derived.setSandboxManager(this.sandboxManager);
    if (this.bashClassifier) derived.setBashClassifier(this.bashClassifier);
    if (this.toolClassifier) derived.setToolClassifier(this.toolClassifier);
    if (this.bridgePermissionDelegate)
      derived.setBridgePermissionDelegate(this.bridgePermissionDelegate);
    if (this.externalAskChannel) derived.setExternalAskChannel(true);
    // 运行时扩展的允许目录白名单也一并继承（用户 /add-dir 授权对子代理同样生效）。
    for (const dir of this.getAllowedDirectories()) derived.addAllowedDirectory(dir);
    return derived;
  }

  /**
   * W22：工作区目录变了（进入 / 退出 worktree）之后，按新目录重载 project / local 规则。
   * 只换规则来源，不动 workspacePath 与路径边界 —— 边界收窄由 W12 的越界检测负责。
   */
  async reloadWorkspaceRules(workspaceDir: string): Promise<void> {
    await this.ruleLoader.reloadWorkspaceSources(workspaceDir);
    this.rules = this.ruleLoader.toPermissionRule();
  }

  /**
   * D4：settings 文件被外部改动后重载文件来源的权限规则（运行期规则保留）。
   * 由 app 层订阅 settingsChanged 调用；调用方还要重新下发子代理 checker（它们是快照）。
   */
  async reloadSettingsRules(): Promise<void> {
    await this.ruleLoader.reloadFileSources();
    this.rules = this.ruleLoader.toPermissionRule();
  }

  /**
   * W22：为跑在某个 worktree 里的子代理派生一份 checker：规则全部继承自本实例，
   * 只有 project / local 两个来源换成那个 worktree 自己的 `.sid-code/`。
   * 不改本实例（主会话、其它子代理共享它）。
   */
  async deriveForWorkspace(workspaceDir: string): Promise<PermissionChecker> {
    // 共享 config 引用而不是展开快照：本实例若是子代理 checker，它的 config 是主会话的
    // 活视图（sub-agent-checker.ts createLiveSubAgentConfig）。展开会把派生时刻的
    // permissionMode/yesMode 冻住，worktree 子代理就跟不上主会话切档（PR #398 review 问题 1）。
    // 不换 permissionMode 时没有理由复制；checker 从不写 config，共享是安全的。
    const derived = this.deriveWithConfig(this.config);
    derived.ruleLoader.importFromRuleLoader(this.ruleLoader);
    await derived.reloadWorkspaceRules(workspaceDir);
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
    this.denialTracking = recordDenial(
      this.denialTracking,
      req.toolName,
      reason || "用户拒绝",
      resource,
    );
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
    // P1（防线可观测）：本函数是两条熔断路径（hard deny / ask 后处理）的**唯一汇聚点**，
    // 埋在这里就不会漏记也不会重复记。埋在 `shouldFuse()` 里则是错的——那是个
    // 每次拒绝都跑的纯谓词，绝大多数返回 false，记的会是"判定次数"而非"触发次数"。
    //
    // 只落 tool 名不落 resource：resource 是文件路径/命令行，基数无上界，
    // 做 metric 标签会把后端的时间序列打爆（tool 名是闭集，安全）。
    recordDefenseTrigger("denial_tracking", "tripped", {
      tool: req.toolName,
      count: consecutive,
      threshold: DENIAL_LIMITS.maxConsecutive,
    });
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

  /**
   * 硬拒绝路径的熔断：保持拒绝，只把「重试不会改变结果」说破（理由见 check() 硬拒绝分支注释）。
   * 防线触发照记（outcome=blocked：防线挡下了一次请求，而不是进入了可放行态）。
   */
  private hardDenyFuseNotice(req: PermissionRequest, resource: string, result: Decision): Decision {
    const consecutive =
      (this.denialTracking.bySignature[denialSignature(req.toolName, String(resource))]
        ?.consecutive ?? DENIAL_LIMITS.maxConsecutive) + 1;
    getLogger().warn(
      "PERMISSION",
      `同一操作（${req.toolName} ${String(resource).slice(0, 60)}）连续被硬拒绝，熔断→保持拒绝并提示停止重试`,
    );
    recordDefenseTrigger("denial_tracking", "blocked", {
      tool: req.toolName,
      count: consecutive,
      threshold: DENIAL_LIMITS.maxConsecutive,
    });
    return {
      ...result,
      reason: `${result.reason ?? "操作被拒绝"}（同一操作已被同一条约束连续拒绝，重试相同输入不会改变结果，请换一种做法或请用户调整配置）`,
      metadata: { ...result.metadata, denialTrackingTriggered: true },
      step: result.step,
    };
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

  /**
   * 权限配置形态（只有计数与开关，不含规则文本），供轨迹 SessionStart 记录影响面分母。
   * 口径见 decision-telemetry.ts PermissionConfigShape。
   */
  describeConfigShape(): import("./decision-telemetry.ts").PermissionConfigShape {
    const rules: Record<"allow" | "deny" | "ask", Record<string, number>> = {
      allow: {},
      deny: {},
      ask: {},
    };
    for (const r of this.ruleLoader.getAllRules()) {
      const bucket = rules[r.behavior];
      bucket[r.source] = (bucket[r.source] ?? 0) + 1;
    }
    return {
      mode: this.effectiveMode(),
      skip_permissions: this.config.skipPermissions === true,
      yes_mode: this.config.yesMode === true,
      rules,
      allowed_tools: this.config.allowedTools?.length ?? 0,
      disallowed_tools: this.config.disallowedTools?.length ?? 0,
      sandbox_auto_allow: this.sandboxManager?.shouldAutoAllowBash() === true,
    };
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

  /**
   * 获取工作区路径（已 realpath 归一化）。
   *
   * `/add-dir --list` 用它把「工作区（始终可访问）」列进可访问集合：白名单是追加语义，
   * 工作区不在 `allowedDirectories` 数组里，命令层没有别的入口能拿到它。
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * W12：当前异步链若绑定在某个隔离 worktree 上，而写目标落在它所属主仓的 worktree 之外，
   * 返回拒绝原因；否则返回 null。worktree 根取进入 withAgentCwd 时绑定的目录（不随 cd 变）。
   */
  private detectWorktreeEscape(filePath: string): string | null {
    const iso = getIsolatedWorktree();
    if (!iso) return null;
    const root = getAgentRoot()!;
    const mainRepo = iso.mainRepo;
    const real = (p: string) => normalizeCaseForComparison(this.pathValidator.resolveRealPath(p));
    const within = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
    const target = real(path.resolve(getAgentCwd() ?? root, filePath));
    const wt = real(iso.worktreeRoot);
    if (within(target, wt)) return null;
    if (!within(target, real(mainRepo))) return null;
    return (
      `隔离 worktree 越界写主仓: ${filePath} 不在当前 worktree（${root}）内。` +
      `请改用相对路径，或以 worktree 根为前缀的绝对路径`
    );
  }

  /** 获取配置（只读，供子代理 checker 工厂复制配置） */
  getConfig(): Readonly<Config> {
    return this.config;
  }

  /**
   * 构造路径规则解析上下文（P0-2）。
   * 文件类工具（read/write/edit/notebook_edit）的路径规则前缀（`//` `~/` `/` `./`）需据此归一化。
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
      // P1-3：rm/rmdir/mv 即使被加回白名单也不得自动放行（第二道闸）。
      if (ACCEPT_EDITS_DESTRUCTIVE_COMMANDS.has(baseCmd)) return false;
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
        // 必须走 resolveRealPath：macOS 上工作区 realpath 是 /private/var/...，
        // path.resolve 停在 /var/...，字面 startsWith 会把 cwd 内的 mkdir/touch 误判为区外。
        if (!this.pathValidator.isWithinWorkspace(this.pathValidator.resolveRealPath(resolved))) {
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
   * P1-1：路径是否命中敏感文件硬 deny（凭证类）。
   * 与 isPathHidden 并列：前者是用户 deny 规则，本方法是内置 SENSITIVE_FILES。
   * grep / read_many 列举过滤时两者都要藏，否则 `Read(.env)` 规则藏了、SENSITIVE_FILES 没藏。
   */
  isSensitivePath(absPath: string): boolean {
    return this.pathValidator.isSensitivePath(absPath);
  }

  /**
   * 异步初始化：从所有来源加载权限规则（P2-1：单一事实源 = RuleLoader）。
   *
   * 加载顺序与优先级：
   * - 构造器传入的 `rules`（来自 cli.ts loadPermissionRules，B 加载器）仅作**启动占位**，
   *   让 initRules 之前的权限检查有兜底；此处 loadAll 读到真实文件后，以 RuleLoader（A）为准。
   *   为避免 B 的占位 projectSettings 与 A 读到的 projectSettings 重复，先清占位再 loadAll。
   * - cliArg（--allow-tool/--deny-tool）与 flagSettings（--settings 的 permissions）从 config 接线。
   *   ⚠️ 这一行注释在 2026-09-22 之前是**假的**：只有 cliArg 真的接了，flagSettings 零调用方。
   *   改动这里时请连同下方两处 setXxxRules 一起看——注释与接线必须同时成立。
   */
  async initRules(): Promise<void> {
    // 清除构造器 B 占位的 projectSettings，避免与 loadAll 读到的真实文件重复计数
    this.ruleLoader.clearSource("projectSettings");

    // M3：远程策略 permissions 必须在 loadAll 之前注入。
    // loadPolicyFile 见 policyRulesFromRemote 就跳过本地 managed，兑现 first-source-wins。
    // 独立 state 文件，避免 checker 顶层 import policy.ts 成环。
    try {
      const { getRemotePolicyPermissions, isRemotePolicyApplied } =
        await import("../config/remote-policy-state.ts");
      if (isRemotePolicyApplied()) {
        this.ruleLoader.setPolicyRules(getRemotePolicyPermissions());
      }
    } catch (err: any) {
      getLogger().warn("PERMISSION", `远程策略权限规则接线失败: ${err?.message ?? err}`);
    }

    await this.ruleLoader.loadAll();

    // P2-1：接线 CLI 规则（cliArg 源）——此前 setCliArgRules 零调用者，--allow/deny-tool 从不生效
    const cliAllow = (this.config as { cliAllowRules?: string[] }).cliAllowRules;
    const cliDeny = (this.config as { cliDenyRules?: string[] }).cliDenyRules;
    if ((cliAllow && cliAllow.length) || (cliDeny && cliDeny.length)) {
      this.ruleLoader.setCliArgRules(cliAllow, cliDeny);
    }

    // P2-1（2026-09-22）：接线 flagSettings（`--settings` 的 permissions）。
    //
    // 修前的形态是「死接线」：上面那行注释早就写了「flagSettings 从 config 接线」，
    // `RULE_SOURCE_PRIORITY.flagSettings = 6`（比 userSettings/cliArg 都高）、
    // `setFlagRules` 的实现和单测都在，唯独**没有任何生产调用方**。于是
    // `sid-code --settings '{"permissions":{"deny":["Bash(*)"]}}'` 这类一次性收紧
    // checker 完全看不到——企业用 CLI 注入权限规则的通道是断的。
    //
    // 两条加载链此前不汇合：`--settings` 走 `setFlagSettings()` 进的是
    // config/settings 合并器的**内存源**（给 loadConfig 用：模型、开关等），
    // 而 RuleLoader 只读磁盘上的 user/project/local/policy 文件。这里把内存源那一侧的
    // `permissions` 取出来喂给 RuleLoader，两链合一。
    //
    // 用动态 import 而非顶层 import：settings.ts → permission/sensitive.ts 已有依赖，
    // checker.ts 顶层再 import settings.ts 会成环（loadPolicyFile 里 `await import("fs")`
    // 是同一处理法）。initRules 本就是 async，没有额外代价。
    //
    // flagSettings 是**可信源**（用户本次命令显式给的，与 policySettings 同列，
    // 见 settings.ts 的 TRUSTED_SETTING_SOURCES），故不走 projectSettings 那套
    // 危险 allow 剥离——这一点由 setFlagRules 内部的 parsePermissions 直通体现。
    try {
      const { getSettingsForSource } = await import("../config/settings/settings.ts");
      const flagPerms = getSettingsForSource("flagSettings").settings?.permissions;
      if (flagPerms) {
        this.ruleLoader.setFlagRules(flagPerms as Parameters<RuleLoader["setFlagRules"]>[0]);
      }
    } catch (err: any) {
      // 取不到 flagSettings 不应阻塞规则加载（磁盘来源已就绪），但必须留痕——
      // 静默 catch 会让这条接线退回成「看起来接上了、实际又空转」。
      getLogger().warn("PERMISSION", `flagSettings 权限规则接线失败: ${err?.message ?? err}`);
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

  /**
   * 设置命令作用域 allow 规则（斜杠命令 / skill 的 `allowed-tools`，对齐 CC
   * `alwaysAllowRules.command`）。写完立即 refresh：RuleLoader 与 `this.rules` 是两份状态，
   * 不 refresh 则本轮规则根本不进判定（sub-agent-checker.ts 记录过同型 bug）。
   *
   * @returns 因来源不可信被剥离的危险规则
   */
  setCommandScopedRules(allow: string[], trusted: boolean, origin?: string): string[] {
    const dropped = this.ruleLoader.setCommandScopedRules(allow, trusted, origin);
    this.refreshRulesFromLoader();
    return dropped;
  }

  /** 清空命令作用域规则（本轮结束 / 中断 / 异常时调用；无规则时是空操作） */
  clearCommandScopedRules(): void {
    this.ruleLoader.clearCommandScopedRules();
    this.refreshRulesFromLoader();
  }

  /**
   * 派生链的根 checker（主会话那一个）。子代理 checker 是派生时刻的**快照**，
   * fork 命令要按主会话**当前**的模式与规则重新派生，必须回到根上（见 agent/forked-command.ts）。
   */
  getRootChecker(): PermissionChecker {
    return this.parentChecker?.getRootChecker() ?? this;
  }

  /** 标记派生来源（仅 createSubAgentChecker 调用） */
  setParentChecker(parent: PermissionChecker): void {
    this.parentChecker = parent;
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

  /** 生成会话记忆 key。资源为空返回 null，调用方不得写入、也不得命中。 */
  private getMemoryKey(req: PermissionRequest): string | null {
    const resource = extractMemoryResource(req);
    if (!resource) return null;
    return `${req.toolName}:${resource}`;
  }

  /** 记住会话内权限决策。空资源（写工具 / 无 path 的 grep / 无 url 的 web_fetch）不写入。 */
  rememberDecision(req: PermissionRequest, allowed: boolean): void {
    const memKey = this.getMemoryKey(req);
    if (!memKey) return;
    // 限制记忆大小
    if (this.sessionMemory.size >= MAX_SESSION_MEMORY) {
      // 删除最早的条目
      const firstKey = this.sessionMemory.keys().next().value;
      if (firstKey) this.sessionMemory.delete(firstKey);
    }
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
  private async hasPermissionsInner(
    req: PermissionRequest,
    tool?: Tool,
    toolContext?: ToolUseContext,
  ): Promise<Decision> {
    // 每一步进入前把位置写进 st，命中即返回时由这里统一贴到 Decision.step（见 types.ts）。
    // 不在三十多个 return 处逐个填：新加一步只要照抄 `st.step = …`，漏了也只是归到上一步。
    const st = { step: "0" };
    const decision = await this.hasPermissionsInnerSteps(req, st, tool, toolContext);
    return decision.step ? decision : { ...decision, step: st.step };
  }

  private async hasPermissionsInnerSteps(
    req: PermissionRequest,
    st: { step: string },
    tool?: Tool,
    toolContext?: ToolUseContext,
  ): Promise<Decision> {
    const log = getLogger();
    const filePath = extractFilePath(req);
    const resource = filePath || (req.input as any)?.command || "";

    st.step = "1";
    // Step 1: deny 规则（工具级）
    //
    // bash 复合命令需逐子命令拆分匹配（对称于 Step 8 的 checkAllowRules）：
    // 用户配 `deny: ["Bash(curl *)"]` 时，`ls && curl evil.com` 的后段 curl 不应
    // 因 minimatch 前缀不跨 `&&` 而漏匹配。deny 语义与 allow 相反——任一子命令命中
    // deny 规则即整体拒绝（some(deny)，非 every）。
    if (this.rules) {
      const ruleDecision = this.checkDenyRules(req);
      if (ruleDecision && !ruleDecision.allowed) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(deny规则: ${ruleDecision.reason})`,
        );
        return {
          ...ruleDecision,
          decisionReason: { type: "rule", rule: ruleDecision.reason || "", behavior: "deny" },
        };
      }
    }

    st.step = "2";
    // Step 2: 危险命令拦截（硬编码 25 种模式 + 结构性注入防护 + 复合命令拆分 + 重定向检测 + LLM 风险分类）
    //   ⚠️ checkDangerousCommand 已为 async（内含 LLM 分类器调用），调用点必须 await——
    //   否则返回的 Promise 恒为 truthy，危险命令检测会被错误短路。
    if (req.toolName === "bash") {
      const dangerResult = await this.checkDangerousCommand(req);
      if (dangerResult) return dangerResult;
    }

    st.step = "3";
    // Step 3: 禁用工具检查
    // 名单项按工具名归一比较（`Bash` / `WebFetch` / `Bash(curl *)` 都认），见 isToolNameListed。
    // 精确 includes 曾让 CLAUDE.md 里 CC 风格的黑名单静默不生效。
    if (isToolNameListed(this.config.disallowedTools, req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(工具已禁用)`);
      return {
        allowed: false,
        reason: `工具 "${req.toolName}" 已被禁用`,
        decisionReason: { type: "other", reason: "工具已被禁用" },
      };
    }

    st.step = "3.5";
    // Step 3.5: 计划文件提前放行（W11.D4：解锁 plan capability eval）
    //
    // 背景：src/plan/prompt.ts 教 LLM 用 write 写计划文件到 ~/.sid-code/plans/plan-*.md，
    // 但默认计划文件在工作区外，Step 4 路径验证会先拒，Step 9 checkPlanMode 的 isPlanFile
    // 放行逻辑永远走不到。本步骤在 Step 4 之前判断：write/edit 计划文件 → 提前放行。
    //
    // P1-1：放行条件从「permissionMode === "plan"」扩到「plan 模式 **或** 执行阶段」。
    // 理由：approve() 之后 state 回 inactive、权限模式恢复成进入前的值，但批准消息
    // （plan/prompt.ts）仍明确要求「失败时必须先用 edit 更新计划文件再继续执行」。
    // 只认 permissionMode === "plan" 时，执行阶段的这一步在交互模式下每次弹窗、
    // 在无头模式（print / maxTurns>0）下被 isNonInteractive 直接转成拒绝——
    // 于是 recovery hint 指向一条走不通的路。isExecuting() 正是为「执行阶段」这个
    // 与三态正交的身份而存在的标志，这里与 Recovery Hook 认同一个标志。
    //
    // 安全：仍是精确匹配 planManager.getPlanFilePath()（不接受路径前缀匹配），
    // 不放宽到 plans/ 目录前缀，所以放行面只多了「同一份计划文件在执行阶段可写」。
    const pm = this.planManager;
    if (
      pm &&
      filePath &&
      (req.toolName === "write" || req.toolName === "edit") &&
      pm.isPlanFile(filePath) &&
      (this.config.permissionMode === "plan" || pm.isExecuting())
    ) {
      const phase = this.config.permissionMode === "plan" ? "plan模式" : "执行阶段";
      log.info(
        "PERMISSION",
        `${req.toolName}(${filePath.slice(0, 80)}) → 允许(${phase}+计划文件提前放行)`,
      );
      return { allowed: true, decisionReason: { type: "mode", mode: "plan+plan-file" } };
    }

    st.step = "3.8";
    // Step 3.8（W12）：隔离 worktree 里的子代理不许把写工具打回主仓。
    //
    // 工作区边界（workspacePath）在 checker 构造时冻结为主仓根，子代理派生 checker 时原样复制，
    // 而 withAgentCwd 只改 getCwd() —— 两份状态没有交汇点。于是跑在
    // `<主仓>/.sid-code/worktrees/agent-x/` 里的子代理 write 一个 `/<主仓>/src/a.ts`，
    // isWithinWorkspace 为真、直接放行，改动落进主仓且在 worktree 的 diff 里看不见。
    // 唯一拦它的曾经只是一句提示词（sub-agent.ts「不要引用主仓的绝对路径」）。
    //
    // 判据只看「写目标在不在自己的 worktree 之外、却在它所属的主仓之内」：
    // - worktree 之外的其它位置（/tmp、~/.sid-code/plans）不归这条管，交给下面的常规路径验证；
    // - 硬 deny、不给确认：确认框里用户看到的是一个「工作区内」的路径，点了允许就是隔离失效。
    // ⚠️ 只覆盖文件类写工具。bash 命令正文里的绝对路径不经过这层解析，仍靠 worktree 本身隔离。
    if (filePath && WRITE_TOOLS.has(req.toolName)) {
      const escape = this.detectWorktreeEscape(filePath);
      if (escape) {
        log.info("PERMISSION", `${req.toolName}(${filePath.slice(0, 80)}) → 拒绝(${escape})`);
        return {
          allowed: false,
          reason: escape,
          decisionReason: { type: "other", reason: "隔离 worktree 越界写主仓" },
        };
      }
    }

    st.step = "4";
    // Step 4: 统一路径验证（目录黑白名单 + symlink 解析 + 工作区边界 + 系统目录 + 敏感文件）
    // P1-1：grep / read_many 的 path 指向敏感文件或敏感目录时走硬 deny（与 read 同口径）。
    // 普通目录作搜索根不在这里拦——全树命中由工具层 isSensitivePath 过滤。
    const runPathValidation =
      !!filePath &&
      (FILE_TOOLS.has(req.toolName) ||
        (PATH_VALIDATED_READ_TOOLS.has(req.toolName) &&
          this.pathValidator.isSensitivePath(filePath)));
    if (runPathValidation) {
      const operation = WRITE_TOOLS.has(req.toolName) ? ("write" as const) : ("read" as const);
      const pathResult = this.pathValidator.validateAccess(filePath, operation);
      if (!pathResult.allowed) {
        // allow 规则逃生舱。两类拒绝可以走它，理由不同：
        //
        // 1. sensitiveFile（凭证类硬 deny，SEC-AUDIT-2026-07-19 P2）：用户在 settings.json
        //    里显式写了 `Read(.env)` / `Read(secrets/**)` 时放行——那是"用户明确知道自己
        //    要读哪个凭证文件"的正当场景（部署脚本、配置排查）。
        // 2. outsideWorkingDirs（工作目录边界，needsConfirmation）：路径落在工作区与
        //    `--add-dir` 追加目录之外。不开口子的话，用户在无头模式下对「读工作区外文件」
        //    没有任何配置途径（`Read(/data/**)` 写了也不生效），只能每次交互点允许。
        //
        // 为什么不给系统目录 / symlink 逃逸开：那两类要么是路径穿越攻击、要么是配置错误，
        // 没有"用户本意如此"的合理解释（symlink 逃逸更是只看链上某一环，允许它等于
        // 放弃整条检测）。
        //
        // 关键点：逃生舱是**配置文件里的决定**，不是对话中的一次点击。这正是收紧
        // needsConfirmation → deny 想要的效果（详见 path-validator.ts 第 5/6 步注释）。
        if ((pathResult.sensitiveFile || pathResult.outsideWorkingDirs) && this.rules) {
          const allowDecision = this.checkAllowRules(req);
          if (allowDecision?.allowed) {
            log.info(
              "PERMISSION",
              `${req.toolName}(${filePath.slice(0, 80)}) → 允许(${
                pathResult.sensitiveFile ? "敏感文件" : "工作目录边界"
              }，但命中用户显式 allow 规则)`,
            );
            this.auditLogger.log({
              timestamp: new Date().toISOString(),
              type: "tool_use",
              tool: req.toolName,
              resource,
              decision: "allow",
              reason: `${pathResult.sensitiveFile ? "敏感文件" : "工作目录边界"}经用户显式 allow 规则放行: ${pathResult.reason}`,
            });
            return {
              ...allowDecision,
              decisionReason: { type: "rule", rule: "allow", behavior: "allow" },
            };
          }
        }
        log.info(
          "PERMISSION",
          `${req.toolName}(${filePath.slice(0, 80)}) → ${pathResult.needsConfirmation ? "需确认" : "拒绝"}(路径验证: ${pathResult.reason})`,
        );
        return {
          allowed: false,
          reason: pathResult.reason,
          needsConfirmation: pathResult.needsConfirmation,
          decisionReason: { type: "pathValidation", reason: pathResult.reason || "" },
        };
      }
    }

    st.step = "5";
    // Step 5: ask 规则（工具级）
    //
    // bash 复合命令同样要逐子命令拆分（对称于 checkDenyRules / checkAllowRules）。
    // 整条匹配时 minimatch 不跨 &&/||/;/|/&/换行，`ask: ["Bash(curl *)"]` 对
    // `ls && curl evil` 匹配不到 → 在 always-allow / yesMode / auto 下这条「必须确认」
    // 被静默跳过。ask 语义与 deny 相同：任一子命令命中即整体要求确认（some(ask)）。
    if (this.rules) {
      const askDecision = this.checkAskRules(req);
      if (askDecision && !askDecision.allowed && askDecision.needsConfirmation) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 需确认(ask规则: ${askDecision.reason})`,
        );
        return {
          ...askDecision,
          decisionReason: { type: "rule", rule: askDecision.reason || "", behavior: "ask" },
        };
      }
    }

    st.step = "5.5";
    // Step 5.5: 工具级 checkPermissions（passthrough 语义）
    if (tool?.checkPermissions) {
      const toolPermResult = await tool.checkPermissions(req.input, toolContext!);
      if (toolPermResult.behavior === "deny") {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(工具级checkPermissions: ${toolPermResult.message})`,
        );
        return {
          allowed: false,
          reason: `工具拒绝: ${toolPermResult.message}`,
          decisionReason: {
            type: "other",
            reason: `工具级checkPermissions: ${toolPermResult.message}`,
          },
        };
      }
      if (toolPermResult.behavior === "ask") {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 需确认(工具级checkPermissions: ${toolPermResult.message})`,
        );
        return {
          allowed: false,
          needsConfirmation: true,
          reason: `工具要求确认: ${toolPermResult.message}`,
        };
      }
      if (toolPermResult.behavior === "allow") {
        // 工具说「我是只读」只能跳过默认 ask，不能跳过模式硬约束。
        // 否则 python3 / node / make 这类假只读会在 Step 5.5 直接 return，
        // plan / deny-write 永远走不到（P0-3）。
        if (this.config.permissionMode === "plan") {
          return this.checkPlanMode(req, filePath, resource);
        }
        if (this.config.permissionMode === "deny-write") {
          log.info(
            "PERMISSION",
            `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(deny-write模式，工具级allow不越过)`,
          );
          return {
            allowed: false,
            reason: "deny-write 模式下不允许写操作",
            decisionReason: { type: "mode", mode: "deny-write" },
          };
        }
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 允许(工具级checkPermissions)`,
        );
        return { allowed: true };
      }
      // passthrough: 工具没有意见，继续后续检查
    }

    st.step = "6";
    // Step 6: safetyCheck（bypass-immune，即使 always-allow 也不可绕过）
    //
    // 覆盖两类写入：文件工具的目标路径，以及 bash 命令的写入目标（cp/tee/sed -i/curl -o/
    // dd of=/重定向，含 sh -c 内层）。后者此前只有 Step 2 的「敏感重定向」一道，
    // `cp x .git/hooks/pre-commit` / `tee .git/hooks/pre-commit` 在 always-allow 下静默放行
    // （2026-10-24 实测）。bash 的相对路径按 bash 实际 cwd 解析（与 sed -i 校验同口径）。
    const safetyTargets: string[] =
      WRITE_TOOLS.has(req.toolName) && filePath
        ? [filePath]
        : req.toolName === "bash"
          ? await this.resolveBashWriteTargets(req)
          : [];
    // 多个写目标取**最严格**的命中，与 safetyCheck() 内部对解析链的取法同一理由：
    // 修前按顺序首中即返，`tee .git/config .git/hooks/pre-commit` 先命中宽泛的 `.git/`
    // （classifierApprovable: true），auto 分类器就有权放行一个 hook 写入；参数换个顺序
    // 结果就变成 false。format-patch -o .git/hooks 的目录目标同样会先命中 `.git/`。
    let worstTarget: {
      target: string;
      result: ReturnType<PermissionChecker["safetyCheck"]>;
    } | null = null;
    for (const target of safetyTargets) {
      const r = this.safetyCheck(target);
      if (r.safe) continue;
      if (!r.classifierApprovable) {
        worstTarget = { target, result: r };
        break;
      }
      worstTarget ??= { target, result: r };
    }
    if (worstTarget) {
      const { target, result: safetyResult } = worstTarget;
      log.info(
        "PERMISSION",
        `${req.toolName}(${target.slice(0, 80)}) → 需确认(safetyCheck: ${safetyResult.reason})`,
      );
      return {
        allowed: false,
        needsConfirmation: true,
        reason: `[安全检查] ${safetyResult.reason}`,
        decisionReason: {
          type: "safetyCheck",
          reason: safetyResult.reason!,
          classifierApprovable: safetyResult.classifierApprovable,
        },
        metadata: { classifierApprovable: safetyResult.classifierApprovable },
      };
    }

    st.step = "7";
    // Step 7: 沙箱自动放行（沙箱启用时 bash 命令可自动放行，减少弹窗）
    //
    // P2-3（2026-09-22）：这一步此前是「沙箱开了 = bash 跳过一切后续判定」。
    // 它的正当性依赖「Seatbelt 真的拦得住」，而 profile 里 `(allow file-write* (subpath cwd))`
    // 放开了整个工作区——写 `.git/hooks/` 在 OS 层是合法的。即
    // **保护依赖被保护对象存在，而那个对象不存在**。
    //
    // 修法分两层，两层都必要：
    //
    // ① 自动放行不得越过**模式硬约束**（本次新发现，文档只记了「跳过确认」）。
    //    实测 `plan` 模式 + `rm -rf src`：修前 `allowed=true dr=other 沙箱保护下自动放行`，
    //    无沙箱时是 `allowed=false dr=mode 计划模式下只允许只读操作`。
    //    也就是说沙箱把 plan / deny-write 这两个**代码级只读**模式也打穿了——
    //    这比「少弹一次窗」严重得多：用户切到 plan 是为了让 agent 不能改东西。
    //    处理方式与 Step 5.5 的工具级 allow 完全一致（P0-3 已确立该判据）：
    //    「谁说安全都不能越过模式硬约束」。
    //
    // ② `autoAllowBashIfSandboxed` 默认改 false（见 sandbox.ts defaultSandboxConfig）。
    //    危险命令（Step 2）与重定向（P1-4）已在此步之前拦住，所以剩下被自动放行的是
    //    「非危险但也没人看过」的任意 bash。让「少弹窗」变成显式 opt-in。
    if (req.toolName === "bash" && this.sandboxManager?.shouldAutoAllowBash()) {
      // ① 模式硬约束优先：plan / deny-write 是代码级只读，沙箱不构成放行理由
      if (this.config.permissionMode === "plan") {
        return this.checkPlanMode(req, filePath, resource);
      }
      if (this.config.permissionMode === "deny-write") {
        log.info(
          "PERMISSION",
          `bash(${resource.slice(0, 80)}) → 拒绝(deny-write模式，沙箱自动放行不越过)`,
        );
        return {
          allowed: false,
          reason: "deny-write 模式下不允许写操作",
          decisionReason: { type: "mode", mode: "deny-write" },
        };
      }
      log.info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → 允许(沙箱保护下自动放行)`,
      );
      return { allowed: true, decisionReason: { type: "other", reason: "沙箱保护下自动放行" } };
    }

    st.step = "8-mode";
    // Step 8: bypass/always-allow 模式（safetyCheck 之后才检查，确保关键路径不被绕过）
    if (this.config.permissionMode === "always-allow") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(always-allow模式)`);
      return { allowed: true, decisionReason: { type: "mode", mode: "always-allow" } };
    }

    st.step = "8-rule";
    // Step 8: allow 规则（工具级）
    if (this.rules) {
      const allowDecision = this.checkAllowRules(req);
      if (allowDecision && allowDecision.allowed) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(allow规则)`);
        return {
          ...allowDecision,
          decisionReason: { type: "rule", rule: "allow", behavior: "allow" },
        };
      }
    }

    st.step = "9";
    // Step 9: plan 模式（代码级强制只读，计划文件例外）
    if (this.config.permissionMode === "plan") {
      return this.checkPlanMode(req, filePath, resource);
    }

    st.step = "10";
    // Step 10: 读操作自动放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(只读工具)`);
      return { allowed: true };
    }

    st.step = "11";
    // Step 11: acceptEdits 模式（自动接受文件操作，其他仍需检查）
    if (this.config.permissionMode === "acceptEdits") {
      if (FILE_TOOLS.has(req.toolName)) {
        log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(acceptEdits模式)`);
        return { allowed: true, decisionReason: { type: "mode", mode: "acceptEdits" } };
      }
      // P1-3：cwd 内的文件系统 bash 命令（mkdir/touch/cp/sed）也自动放行。
      // rm/rmdir/mv 已从白名单拿掉——`rm -rf .` 的 `.` 在工作区内，修前会被放行。
      if (req.toolName === "bash") {
        const command = (req.input as { command?: string })?.command ?? "";
        if (command && this.canAutoAllowFsCommandInAcceptEdits(command)) {
          log.info(
            "PERMISSION",
            `bash(${command.slice(0, 80)}) → 允许(acceptEdits模式+cwd内fs命令)`,
          );
          return { allowed: true, decisionReason: { type: "mode", mode: "acceptEdits" } };
        }
      }
    }

    st.step = "12";
    // Step 12: 预授权工具放行（`--allowed-tools` / config.allowedTools / CLAUDE.md 工具白名单）
    //
    // P7：此前是 `preApproved.has(req.toolName)` 精确比较——`--allowed-tools Read` 对不上 `read`，
    // `--allowed-tools "Bash(git *)"` 永远不命中。CC 的 `--allowedTools` 是规则语法，这里改走
    // 规则引擎（认 CC 名 / 大小写 / `Bash(pattern)` / MCP 通配，bash 复合命令逐子命令校验）。
    // 位置保持在 Step 12（plan / 只读 / acceptEdits 之后），放行面只多了「名字写法」这一层。
    if (this.preApproved.size > 0 && this.matchesAllowList([...this.preApproved], req)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(预授权)`);
      return { allowed: true };
    }

    st.step = "13";
    // Step 13: deny-write 模式
    if (this.config.permissionMode === "deny-write") {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(deny-write模式)`);
      return {
        allowed: false,
        reason: "deny-write 模式下不允许写操作",
        decisionReason: { type: "mode", mode: "deny-write" },
      };
    }

    st.step = "13.5";
    // Step 13.5（D16）：工具自报破坏性（MCP destructiveHint: true）→ 安全类确认。
    // 与普通 ask 的区别只在下游：yesMode / auto 分类器 / PreToolUse hook allow 都不能放行它
    // （isSafetyConfirmation）。用户显式 allow 规则、always-allow、预授权在上面已经生效，不受影响——
    // 那是用户自己的明确决定；这里只吸收「Server 主动警告我会删东西」这条原先被丢弃的信息。
    // hint 是 Server 自声明，只用于收紧，绝不用于放行。
    if (tool?.isDestructive?.(req.input)) {
      const openWorld = (tool as { isOpenWorld?: () => boolean }).isOpenWorld?.() === true;
      log.info("PERMISSION", `${req.toolName} → 需确认(工具声明 destructive)`);
      return {
        allowed: false,
        needsConfirmation: true,
        reason: `工具 "${req.toolName}" 声明了破坏性操作，需要用户确认`,
        decisionReason: { type: "destructiveTool", tool: req.toolName, openWorld },
      };
    }

    st.step = "14";
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
  async check(
    req: PermissionRequest,
    tool?: Tool,
    toolContext?: ToolUseContext,
    options?: PermissionCheckOptions,
  ): Promise<Decision> {
    const decision = await this.checkUngated(req, tool, toolContext, options);
    const gated = decision.allowed ? this.enforceModeHardConstraint(req, decision) : null;
    const final = gated ?? decision;
    return { ...final, mode: final.mode ?? this.effectiveMode() };
  }

  /** 当前生效的权限模式（skipPermissions 是与 permissionMode 正交的布尔，单独标出） */
  private effectiveMode(): string {
    return this.config.skipPermissions
      ? "dangerously-skip-permissions"
      : String(this.config.permissionMode ?? "default");
  }

  /**
   * 模式硬约束总闸：plan / deny-write 是**代码级只读**，任何放行都必须过这一道。
   *
   * ## 为什么是总闸而不是在各 Step 里补判断
   *
   * 「谁说安全都不能越过模式硬约束」（P0-3）此前是在 Step 5.5（工具级 allow）与
   * Step 7（沙箱）里**逐处**补的，于是漏掉的放行口各自成了一条绕过路径——2026-10-24 实测：
   *
   * | 放行口 | 修前 |
   * | --- | --- |
   * | Step 8 allow 规则 `Bash(npm *)` / `Write(*)` | plan 下放行 npm install、写任意文件 |
   * | Step 4 敏感文件逃生舱 `Write(.env)` | plan 下写 .env |
   * | Step 12 预授权 `--allowed-tools write` | deny-write 下放行写入 |
   * | 会话记忆（切 plan 前点过「总是允许」） | plan 下放行 |
   * | yesMode 自动批准普通 ask | plan 下写工作区外文件 |
   * | PreToolUse hook allow | plan 下放行 ask 规则命中的写 |
   * | skipPermissions 早退 + enter_plan_mode | plan 下全放行 |
   *
   * 所有放行最终都从 check() 出去，所以把约束挂在出口：放行面再增加一条，也绕不过它。
   * 阶段一里的逐处判断保留（它们给出更具体的日志），总闸是兜底且是唯一事实源。
   *
   * 计划文件（Step 3.5，精确匹配 getPlanFilePath）是唯一豁免——那是 plan 模式本身要写的东西。
   * 返回 null = 不拦。
   */
  private enforceModeHardConstraint(req: PermissionRequest, decision: Decision): Decision | null {
    const mode = this.config.permissionMode;
    if (mode !== "plan" && mode !== "deny-write") return null;
    if (decision.step === "3.5") return null;
    const filePath = extractFilePath(req);
    const resource = filePath || (req.input as { command?: string })?.command || "";
    let blocked: Decision | null = null;
    if (mode === "plan") {
      const verdict = this.checkPlanMode(req, filePath, resource);
      if (!verdict.allowed) {
        blocked = {
          ...verdict,
          decisionReason: verdict.decisionReason ?? { type: "mode", mode: "plan" },
        };
      }
    } else if (!READ_ONLY_TOOLS.has(req.toolName)) {
      blocked = {
        allowed: false,
        reason: "deny-write 模式下不允许写操作",
        decisionReason: { type: "mode", mode: "deny-write" },
      };
    }
    if (!blocked) return null;
    getLogger().info(
      "PERMISSION",
      `${req.toolName}(${String(resource).slice(0, 80)}) → 拒绝(${mode}模式硬约束总闸，覆盖 step=${decision.step ?? "?"} 的放行)`,
    );
    this.denialTracking = recordDenial(
      this.denialTracking,
      req.toolName,
      blocked.reason || "",
      resource,
    );
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      type: "tool_use",
      tool: req.toolName,
      resource,
      decision: "deny",
      reason: `${blocked.reason}（覆盖 step=${decision.step ?? "?"} 的放行）`,
      decisionReason: blocked.decisionReason,
    });
    return { ...blocked, step: "mode-gate", metadata: { overriddenStep: decision.step } };
  }

  /** check() 的主体：阶段一 + 阶段二后处理。放行结果出去之前还要过 enforceModeHardConstraint。 */
  private async checkUngated(
    req: PermissionRequest,
    tool?: Tool,
    toolContext?: ToolUseContext,
    options?: PermissionCheckOptions,
  ): Promise<Decision> {
    const log = getLogger();
    const resource = extractFilePath(req) || (req.input as any)?.command || "";

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
        ...(options?.auditSource ? { source: options.auditSource } : {}),
      });
      return { allowed: true, step: "skip" };
    }

    // 会话记忆快速路径（空 key 不命中：写工具 / 无 path 的 grep / 无 url 的 web_fetch）
    const memKey = this.getMemoryKey(req);
    // H25：会话记忆的 allow 不能吃掉 hook 的 ask 升级。hook 的价值在于看得到规则看不到的东西
    // （文件内容、时间、外部状态），「同一资源第 2 次访问时 hook 改主意」是它的正常用法。
    // 只对 allow 记忆让路：deny 记忆照常早退（hook allow 不能越过用户明确拒绝）；skipPermissions 在上面已早退，不受影响。
    const memoryYieldsToHookAsk =
      options?.hookPermissionDecision === "ask" &&
      !!memKey &&
      this.sessionMemory.get(memKey) === true;
    if (memKey && this.sessionMemory.has(memKey) && !memoryYieldsToHookAsk) {
      const allowed = this.sessionMemory.get(memKey)!;
      log.info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → ${allowed ? "允许" : "拒绝"}(会话记忆)`,
      );
      // 记账（发现 1）：这条快速路径此前在任何计数之前就 return，导致
      //   - 记忆为 allow 时，该签名的连续拒绝计数不归零（墙已消失却仍算在撞墙）；
      //   - 记忆为 deny 时，反复撞同一面墙完全不被计数。
      // 两者都让熔断判据失真，故在此对称补记。
      this.denialTracking = allowed
        ? recordSuccess(this.denialTracking, req.toolName, resource)
        : recordDenial(this.denialTracking, req.toolName, "会话记忆拒绝", resource);
      return { allowed, decisionReason: { type: "sessionMemory" }, step: "memory" };
    }

    // 运行阶段 1 内部检查（硬拒绝熔断会就地改写 reason，见下方 hardDenyFuseNotice）
    let result = await this.hasPermissionsInner(req, tool, toolContext);

    // ── G2/G3：PreToolUse hook 权限决策注入 ──
    // 安全护栏（对齐 CC toolHooks.ts:386 + 我们既有 yesMode 语义）：
    //   - hook allow 只能把「普通 ask」转为放行；对硬拒绝（!allowed && !needsConfirmation）、
    //     危险命令确认（dangerousCommand）、safetyCheck 确认一律无效——deny/危险命令不被越过。
    //   - hook ask 把「本会放行」强制升级为用户确认（needsConfirmation）。
    if (options?.hookPermissionDecision === "allow") {
      const dr = result.decisionReason?.type;
      // 仅普通 ask（needsConfirmation 且非安全类确认）可被 hook allow 放行；硬 deny 不放行
      if (
        !result.allowed &&
        result.needsConfirmation &&
        !isSafetyConfirmation(result.decisionReason)
      ) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 允许(PreToolUse hook permissionDecision:allow)`,
        );
        this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource,
          decision: "allow",
          reason: "PreToolUse hook allow",
          user_confirmed: false,
          ...(options?.auditSource ? { source: options.auditSource } : {}),
        });
        return {
          allowed: true,
          decisionReason: { type: "other", reason: "PreToolUse hook allow" },
          step: "hook-allow",
        };
      }
      if (!result.allowed) {
        log.info(
          "PERMISSION",
          `${req.toolName} → PreToolUse hook allow 被安全护栏拦截(${dr})，不放行`,
        );
      }
    } else if (options?.hookPermissionDecision === "ask" && result.allowed) {
      // hook 要求升级确认：把本会自动放行的操作强制转为 needsConfirmation。
      // 非交互/dontAsk 无 UI 通道 → 降级为 deny（对齐既有 ask→deny 语义）。
      if (this.config.permissionMode === "dontAsk" || this.isNonInteractive()) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(PreToolUse hook ask，但无交互通道)`,
        );
        return {
          allowed: false,
          reason: "PreToolUse hook 要求确认，但当前为非交互模式，自动拒绝",
          decisionReason: { type: "other", reason: "PreToolUse hook ask (non-interactive)" },
          step: "hook-ask",
        };
      }
      log.info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → 升级确认(PreToolUse hook permissionDecision:ask)`,
      );
      return {
        allowed: false,
        needsConfirmation: true,
        reason: "PreToolUse hook 要求用户确认",
        decisionReason: { type: "other", reason: "PreToolUse hook ask" },
        step: "hook-ask",
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
        ...(options?.auditSource ? { source: options.auditSource } : {}),
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
      // ⚠️ 2026-10-24 改：硬拒绝**不再**熔断成确认，只升级成「停止重试」的明确信号。
      //
      // 硬拒绝来自 deny 规则、critical 危险命令、敏感凭证文件、plan / deny-write、
      // 禁用工具、worktree 越界——全部是「配置里的决定，对话中不给推翻机会」。
      // 熔断成确认等于给了推翻机会，而且推翻的条件是**模型重试三次**：
      // 修前实测第 4 次读 `.env` / 第 4 次 `rm -rf /` / 第 4 次撞 `Bash(curl *)` 都弹出确认，
      // speculative 分类器还会因为 decisionReason 变成 denialTracking 而不再被
      // dangerousCommand 护栏挡住。path-validator 把凭证文件收紧成硬 deny 的理由
      // （「弹窗是最容易被点穿的一环」）在这里被原样绕回去了。
      //
      // 熔断要解决的是「模型对同一面墙反复撞」——解法是把墙说清楚让它换路，不是开门。
      // 所以：保留原 decisionReason（成因口径不变），reason 加一句停止重试，记一次防线触发。
      if (shouldFuse(this.denialTracking, req.toolName, resource)) {
        result = this.hardDenyFuseNotice(req, resource, result);
      }
      this.denialTracking = recordDenial(
        this.denialTracking,
        req.toolName,
        result.reason || "",
        resource,
      );
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: result.reason,
        decisionReason: result.decisionReason,
        classifiedBy: result.metadata?.classifiedBy as "hardcoded" | "llm" | "both" | undefined,
        llmRisk: result.metadata?.llmRisk as string | undefined,
        ...(options?.auditSource ? { source: options.auditSource } : {}),
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
      if (!isSafetyConfirmation(result.decisionReason)) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 允许(yesMode 自动批准普通 ask)`,
        );
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
        return { allowed: true, decisionReason: { type: "mode", mode: "yesMode" }, step: "yes" };
      }
      // 危险来源的确认：yesMode 不放行，落到下方非交互/熔断/正常确认流程（高风险仍拦）
      log.info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → yesMode 不放行危险命令确认(${dr})`,
      );
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
          // P0-1：auto 与 yesMode 共用同一道危险确认护栏。
          // classifierApprovable:false 的 safetyCheck（hooks / commands / settings）
          // 以及 dangerousCommand，分类器结果直接丢弃——字段存在的理由就是这条路径。
          if (
            isSafetyConfirmation(result.decisionReason) &&
            !classifierMayApprove(result.decisionReason)
          ) {
            log.info(
              "PERMISSION",
              `${req.toolName}(${resource.slice(0, 80)}) → auto 不放行危险确认(${result.decisionReason?.type})`,
            );
          } else {
            const classifyResult = await toolClassifier.classify({
              toolName: req.toolName,
              input: (req.input || {}) as Record<string, unknown>,
              cwd: this.workspacePath,
              classifierInput,
            });
            if (!classifyResult.classifierUnavailable && classifyResult.safe) {
              log.info(
                "PERMISSION",
                `${req.toolName}(${resource.slice(0, 80)}) → 允许(auto 模式分类器批准: ${classifyResult.reason})`,
              );
              this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
              this.auditLogger.log({
                timestamp: new Date().toISOString(),
                type: "tool_use",
                tool: req.toolName,
                resource,
                decision: "allow",
                reason: `auto 模式分类器批准: ${classifyResult.reason}`,
              });
              return {
                allowed: true,
                decisionReason: { type: "mode", mode: "auto" },
                step: "auto",
              };
            }
            // 分类器判不安全或不可用：落到下方正常确认流程（needsConfirmation）
            log.info(
              "PERMISSION",
              `${req.toolName} → auto 模式分类器未放行(${classifyResult.reason})，回退人工确认`,
            );
          }
        } catch (err: any) {
          log.warn("PERMISSION", `auto 模式分类器异常(${err.message})，回退人工确认`);
        }
      }
      // 分类器不可用或未放行 → 返回 needsConfirmation，让上层三路竞争/用户弹窗处理
    }

    // dontAsk 模式：ask → deny（绝不弹窗，对齐 Claude Code 语义）
    if (this.config.permissionMode === "dontAsk") {
      log.info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(dontAsk模式下ask→deny)`,
      );
      this.denialTracking = recordDenial(
        this.denialTracking,
        req.toolName,
        result.reason || "",
        resource,
      );
      const dontAskDecision: Decision = {
        allowed: false,
        reason: `dontAsk 模式下自动拒绝: ${result.reason}`,
        decisionReason: { type: "mode", mode: "dontAsk" },
        step: "dontAsk",
      };
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: dontAskDecision.reason,
        decisionReason: dontAskDecision.decisionReason,
        ...(options?.auditSource ? { source: options.auditSource } : {}),
      });
      return dontAskDecision;
    }

    // 无头会话的本地记账工具：不放行就等于「批准了计划却不允许记进度」。
    // 位置刻意在 isNonInteractive 之前、dontAsk 之后：dontAsk 是用户显式选的
    // 「一切需确认的都拒」，本表只豁免「无人可问」这一种处境，不改 dontAsk 的语义。
    // 也不放在阶段一的 Step 10：那会同时放宽 plan 与 deny-write（见集合注释）。
    if (this.isNonInteractive() && HEADLESS_LOCAL_LEDGER_TOOLS.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(无头+本地记账)`);
      return { allowed: true, decisionReason: { type: "other", reason: "无头会话的本地记账工具" } };
    }

    // 非交互模式：ask → deny
    if (this.isNonInteractive()) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(非交互模式)`);
      this.denialTracking = recordDenial(
        this.denialTracking,
        req.toolName,
        result.reason || "",
        resource,
      );
      // ⚠️ **`decisionReason.reason` 必须带上真实成因，不能只写「非交互模式」。**
      //
      // 这里曾经写死 `reason: "非交互模式"`，而**模型看到的就是这一句**：
      // `tool-executor.ts` 走 `explainDecision(decision)`，它优先读
      // `decisionReason`（`decision.reason` 只在 decisionReason 缺失时才兜底），
      // 于是那条带着真实成因的长文本**只进审计日志，从不进对话**。
      // 形态：`权限拒绝: 拒绝 — 非交互模式`——一句**不含任何可行动信息**的话。
      //
      // ## 实测代价（Harbor A11，两题逐轨迹复算，2026-08-29）
      //
      // `polyglot-c-py` 18/33、`regex-log` 14/33 次工具调用被拒（合计 34/66 = 52%），
      // 而审计日志里成因是**三类语义完全不同**的东西：
      //   21× 白名单外需确认  |  8× injection 启发式命中  |  3× 写入路径在工作区外
      // 三类在对话里**长得一模一样**。于是模型无法判断「是我的命令形态有问题」
      // 还是「这类工具一律不给」，只能盲试：
      //   · 环境探测型动作占 30%（`polyglot`）/ 39%（`regex-log`）
      //     ——`pwd` / `which` / `echo test` / `touch` 反复确认「我到底能干什么」；
      //   · **同一条 heredoc 原样重发两次**（步 2/3、8/10）——它不知道触发物是引号；
      //   · 往 `/tmp` 写 9 次、9 次全拒——它始终没被告知 `/tmp` 在工作区外，
      //     而只要说一句，改写 `/app` 即可（该题 `write` 工具在工作区内是放行的）。
      // 结果：对照 mini-swe-agent **8 步提交**，我们 33 次调用撞满 `--max-turns` 未解出。
      //
      // **它不是「在原地打转」**（重复最多 2 次，循环检测拦不到），是**每一步都在做
      // 新动作、但都在试探一堵看不见的墙**——所以修法不是加循环检测，是把墙照亮。
      //
      // 与本仓「可见性」那批教训同型：**信息在系统里，只是没送到需要它的那一侧。**
      // 保留 `reason` 字段原文不动 —— 审计日志格式是既有数据源（上面那份复算就是
      // 从它取的），改它会让历史轨迹与新轨迹不同口径。
      const nonInteractiveDecision: Decision = {
        allowed: false,
        reason: `非交互模式下自动拒绝: ${result.reason}`,
        decisionReason: {
          type: "other",
          // 「重试相同输入不会改变结果」是刻意加的：上面那两处原样重发证明模型
          // 会把静默拒绝当成偶发失败。说破它，等于把一次白烧的轮次换成一次改道。
          reason: `非交互模式下自动拒绝（无人可确认，重试相同输入不会改变结果）：${result.reason}`,
        },
        // 成因步骤沿用阶段一（「为什么要问」），headless 只是把 ask 落成 deny
        step: `headless:${result.step ?? "?"}`,
      };
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: nonInteractiveDecision.reason,
        decisionReason: nonInteractiveDecision.decisionReason,
        ...(options?.auditSource ? { source: options.auditSource } : {}),
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
   * bash 命令的写入目标 → 绝对路径（供 Step 6 safetyCheck）。
   * 相对路径按 bash 实际 cwd 解析：input.cwd > 全局 getCwd()（追踪 cd）> 工作区根，
   * 与 checkDangerousCommand 里 sed -i 的目标校验同一口径。
   */
  private async resolveBashWriteTargets(req: PermissionRequest): Promise<string[]> {
    const cmd = (req.input as { command?: string })?.command;
    if (typeof cmd !== "string" || !cmd.trim()) return [];
    const targets = extractBashWriteTargets(cmd);
    if (targets.length === 0) return [];
    let baseCwd: string = this.workspacePath;
    const inputCwd = (req.input as { cwd?: unknown })?.cwd;
    if (typeof inputCwd === "string" && inputCwd) {
      baseCwd = inputCwd;
    } else {
      try {
        const { getCwd } = await import("../bootstrap/state.ts");
        baseCwd = getCwd();
      } catch {
        /* 无全局 cwd（测试 / 嵌入）：退回工作区根 */
      }
    }
    return targets.map((t) => {
      const expanded = t === "~" || t.startsWith("~/") ? path.join(os.homedir(), t.slice(1)) : t;
      return path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);
    });
  }

  /**
   * safetyCheck：bypass-immune 的关键路径保护
   * 即使在 always-allow 模式下也不可绕过
   */
  private safetyCheck(filePath: string): {
    safe: boolean;
    reason?: string;
    classifierApprovable: boolean;
  } {
    // 判定对象 = 字面路径 + symlink 解析链上的每一环 + 最终 realpath，任一命中即不安全。
    //
    // 只看字面路径时，`innocent -> .git/hooks` 之后写 `innocent/pre-commit` 在
    // always-allow / acceptEdits 下静默放行（2026-10-24 实测）：真正落盘的是 hook。
    // Step 4 的 symlink 检测拦不住它——那一步只管「逃出工作区」，`.git/hooks` 本就在工作区内。
    // 取整条解析链而非只取 realpath：中间一级指向受保护目录、最终又被链回别处的形态同样要拦，
    // 与 PathValidator 的 symlink 逃逸检测是同一个理由（getAllResolvedPaths 注释）。
    const candidates = new Set<string>([path.resolve(filePath)]);
    for (const p of this.pathValidator.getAllResolvedPaths(filePath)) candidates.add(p);
    // 取**最严格**的命中，而不是第一个：`innocent -> .git/hooks` 的解析链里，中间一环
    // `<ws>/.git/hooks`（目录本身）只命中宽泛的 `.git/`（classifierApprovable: true），
    // 最终 realpath `<ws>/.git/hooks/pre-commit` 才命中 `.git/hooks/`（false）。
    // 取第一个会让 auto 分类器有权放行一个 hook 写入。
    let worst: { safe: boolean; reason?: string; classifierApprovable: boolean } | null = null;
    for (const candidate of candidates) {
      const hit = this.safetyCheckResolved(candidate);
      if (hit.safe) continue;
      if (!hit.classifierApprovable) return hit;
      worst ??= hit;
    }
    return worst ?? { safe: true, classifierApprovable: true };
  }

  /** safetyCheck 对单个已解析绝对路径的判定（受保护路径表匹配） */
  private safetyCheckResolved(absolutePath: string): {
    safe: boolean;
    reason?: string;
    classifierApprovable: boolean;
  } {
    // W4：先剥掉 worktree 容器前缀，再判定。worktree 的物理路径本身就含
    // `.sid-code/worktrees/<slug>/`，不剥的话里面每一个普通源码文件都会被
    // 下面的 ".sid-code/" 一条命中（理由详见 stripWorktreeContainerPrefix）。
    const resolved = stripWorktreeContainerPrefix(absolutePath);
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
        if (
          relativePath.includes(`/${dirName}/`) ||
          relativePath.includes(`${sepLower}${dirName}${sepLower}`)
        ) {
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
    // cwd 与 bash 实际执行目录同口径（input.cwd > getCwd()）：危险路径判定里
    // `rm -rf *` / `rm -rf .` 这类相对路径要靠它 resolve 成绝对路径再判。
    const expansion = expandShellCommand(cmd);
    const hard = this.hardcodedDangerCheck(expansion, await resolveBashCwdForCheck(req));

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

    // ── 第 1.2 道：展开超限 → fail-closed 到危险类确认 ──
    // deny / ask 规则、危险检测、写目标提取都只看已展开的部分，展开没走完就是「看不全」。
    // 修前超出部分静默丢弃：200 段 `echo n &&` 之后接 `rm -rf /`、深于 MAX_DEPTH 的
    // `sh -c` 嵌套，在 always-allow / yesMode 下直接放行，deny `Bash(curl *)` 也失效。
    // 放在 critical 之后：已展开部分里真命中的 critical 照常硬拒，不降级成确认。
    // 不硬拒：上限误伤合法长命令时用户要有出口（本机 5626 条真实 bash 调用的形态数最大 46，
    // 上限 128）。类型记 dangerousCommand，isSafetyConfirmation 生效，yesMode / hook allow 越不过。
    if (expansion.truncated) {
      log.info("PERMISSION", `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(展开超限)`);
      return {
        allowed: false,
        reason: `[high] 命令过长或嵌套过深，权限检查无法看全，需要确认: ${cmd.slice(0, 80)}`,
        needsConfirmation: true,
        decisionReason: { type: "dangerousCommand", pattern: "展开超限", severity: "high" },
        metadata: { classifiedBy: "hardcoded" },
      };
    }

    // ── 第 1.5 道：结构性注入/混淆校验（纯逻辑、零成本，在 LLM 分类之前拦截 misparsing）──
    const injectionFinding = checkInjectionPatterns(cmd);
    if (injectionFinding) {
      log.info(
        "PERMISSION",
        `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(注入防护: ${injectionFinding.id})`,
      );
      return {
        allowed: false,
        reason: `[injection:${injectionFinding.id}] ${injectionFinding.message}: ${cmd.slice(0, 80)}`,
        needsConfirmation: true,
        decisionReason: {
          type: "dangerousCommand",
          pattern: `injection:${injectionFinding.id}`,
          severity: "high",
        },
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
        log.info(
          "PERMISSION",
          `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(危险sed: ${dangerousSed.reason})`,
        );
        return {
          allowed: false,
          reason: `[sed-danger] ${dangerousSed.reason}: ${cmd.slice(0, 80)}`,
          needsConfirmation: true,
          decisionReason: {
            type: "dangerousCommand",
            pattern: `sed:${dangerousSed.reason}`,
            severity: "high",
          },
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
        const baseCwd = await resolveBashCwdForCheck(req);
        const targetPath = isAbsolute(sedWrite.targetFile)
          ? sedWrite.targetFile
          : resolve(baseCwd, sedWrite.targetFile);
        const pathResult = this.pathValidator.validateAccess(targetPath, "write");
        if (!pathResult.allowed) {
          log.info(
            "PERMISSION",
            `${req.toolName}(sed -i → ${targetPath.slice(0, 80)}) → ${pathResult.needsConfirmation ? "需确认" : "拒绝"}(路径验证: ${pathResult.reason})`,
          );
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
    if (
      !speculativeMode &&
      this.config.permissionMode !== "plan" &&
      this.bashClassifier?.isAvailable()
    ) {
      const classifyResult = await this.bashClassifier.classify({
        command: cmd,
        // 与 bash 实际执行目录同口径（input.cwd > getCwd()，ALS 优先）：process.cwd() 在
        // 隔离子代理里是主仓根，分类器会按错的目录评估 `rm -rf ./x` 这类相对路径命令。
        cwd: await resolveBashCwdForCheck(req),
        description: req.description,
        signal: (req as any).signal,
      });

      // 分类器可用且给出明确判断
      if (!classifyResult.classifierUnavailable) {
        if (!classifyResult.safe) {
          const isHard = classifyResult.risk === "critical" || classifyResult.risk === "high";
          log.info(
            "PERMISSION",
            `${req.toolName}(${cmd.slice(0, 80)}) → ${isHard ? "拒绝" : "需确认"}(LLM风险分类: ${classifyResult.risk})`,
          );
          return {
            allowed: false,
            reason: `[LLM:${classifyResult.risk}] ${classifyResult.reason}`,
            needsConfirmation: !isHard, // critical/high → 直接拒绝；medium → 需确认
            decisionReason: {
              type: "dangerousCommand",
              pattern: `LLM:${classifyResult.risk}`,
              severity: classifyResult.risk,
            },
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
        log.info(
          "PERMISSION",
          `${req.toolName}(${cmd.slice(0, 80)}) → LLM判定安全(risk=${classifyResult.risk})，继续硬编码兜底`,
        );
      }
      // classifierUnavailable=true → 静默回退第三道硬编码兜底
    }

    // ── 第三道：硬编码兜底（LLM 未启用/不可用，或 LLM 判安全但硬编码命中 high/medium）──
    if (hard) {
      log.info(
        "PERMISSION",
        `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(危险命令: ${hard.name})`,
      );
      return {
        allowed: false,
        reason: `[${hard.severity}] 危险命令需要确认 (${hard.name}): ${cmd.slice(0, 80)}`,
        needsConfirmation: true,
        decisionReason: { type: "dangerousCommand", pattern: hard.name, severity: hard.severity },
        metadata: { classifiedBy: "hardcoded" },
      };
    }

    // 重定向检测（独立于上述模式）
    // P1-4：必须带 dangerousCommand，否则 yesMode/auto/hook allow 把「无 decisionReason
    // 的普通 ask」当可自动批准，`echo x > .git/hooks/pre-commit` 会从另一条路放行。
    const redirectCheck = hasSensitiveRedirection(cmd);
    if (redirectCheck.sensitive) {
      log.info(
        "PERMISSION",
        `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(敏感路径重定向: ${redirectCheck.targets.join(", ")})`,
      );
      return {
        allowed: false,
        reason: `重定向到敏感路径需要确认: ${redirectCheck.targets.join(", ")}`,
        needsConfirmation: true,
        decisionReason: {
          type: "dangerousCommand",
          pattern: "sensitiveRedirection",
          severity: "high",
        },
        metadata: { classifiedBy: "hardcoded" },
      };
    }

    return null; // 无危险
  }

  /**
   * ask 规则检查（复合命令感知）——与 checkDenyRules 同一形状，语义是「必须确认」。
   *
   * 整条匹配时 `ask: ["Bash(curl *)"]` 对 `ls && curl evil` / `ls & curl evil` /
   * `ls\ncurl evil` 全部匹配不到。ask 没中本身只是「不强制确认」，但后面的
   * always-allow（跳过确认兜底）、yesMode 与 auto 分类器放行会把这条漏匹配变成
   * 静默执行。所以 ask 与 deny 一样取 some：任一子命令命中即整体要求确认。
   */
  private checkAskRules(req: PermissionRequest): Decision | null {
    if (!this.rules) return null;
    const askRules = { deny: [], allow: [], ask: this.rules.ask };
    const pathCtx = this.buildPathRuleContext(req);

    if (req.toolName !== "bash") {
      return checkRules(askRules, req, pathCtx);
    }

    // 与 deny 同口径：逐「等价执行形态」匹配（见 checkDenyRules 注释与 shell-command-variants.ts）
    const command = (req.input as { command?: string })?.command ?? "";
    for (const variant of expandShellCommand(command).variants) {
      const subReq: PermissionRequest = {
        ...req,
        input: { ...(req.input as object), command: variant },
      };
      const subDecision = checkRules(askRules, subReq, pathCtx);
      if (subDecision && !subDecision.allowed && subDecision.needsConfirmation) {
        return subDecision;
      }
    }
    return null;
  }

  /**
   * deny 规则检查（复合命令感知）——对称于 checkAllowRules，语义相反。
   *
   * 对齐 claude-code bashPermissions：`Bash(curl *)` 这类前缀/glob deny 规则**不能**被
   * `safe && curl evil` 这样的复合命令前缀绕过。minimatch 不跨 `&&`/`||`/`;`/`|`/后台 `&`/换行，
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

    // 逐「等价执行形态」校验，任一形态命中 deny 即整体拒绝（some(deny)）。
    //
    // 形态 = 复合命令拆分出的每个子命令（已 trim）+ 命令头规范化形态（剥环境变量前缀 /
    // env·command·nohup·timeout·xargs 等包装命令、去转义去引号、绝对路径取 basename）
    // + sh -c / eval / 命令替换里的内层脚本（递归）。修前只做了第一项，
    // `  curl x` / `/usr/bin/curl x` / `env curl x` / `sh -c 'curl x'` 全部绕过 `Bash(curl *)`
    // （2026-10-24 实测 always-allow 下放行）。展开只用于「拦」，allow 不用（见模块头注释）。
    for (const variant of expandShellCommand(command).variants) {
      const subReq: PermissionRequest = {
        ...req,
        input: { ...(req.input as object), command: variant },
      };
      const subDecision = checkRules(denyRules, subReq, pathCtx);
      if (subDecision && !subDecision.allowed) {
        return subDecision;
      }
    }
    return null;
  }

  /**
   * allow 规则检查（复合命令感知）。
   *
   * 对齐 claude-code bashPermissions：`Bash(safe *)` 这类前缀/glob allow 规则**不能**放行
   * `safe && evil` 这样的复合命令。否则 `allow: ["Bash(ls *)"]` 会因 `ls *` 的 `*` 贪婪吞掉
   * `ls && ./untrusted.sh` 的后半段而整体放行，形成 allow 越权。
   *
   * 修复：bash 命令先拆成子命令，要求**至少一段命中 allow**，其余每段命中 allow 或是
   * 「管道下游纯过滤器 / 首段工作区内 cd &&」（见 checkAllowList 与 allow-composition.ts）；
   * 任一段都不满足 → 不放行（落到后续 ask）。`ls && ./x.sh` 照旧不放行。
   * 非 bash 工具（file_path/pattern 类）保持原逻辑，整条匹配。
   *
   * 说明：危险命令检测（Step 2）已在本步之前对复合命令拆分逐子命令查危险模式，
   * 故 `ls && curl|sh` 这类会被更早拦下；本修复补的是"逃过危险模式、又非受保护路径写入的
   * 第二条命令"（如 `ls && ./x.sh`、`ls && git push`）被 allow 前缀规则误放行的越权缺口。
   */
  private checkAllowRules(req: PermissionRequest): Decision | null {
    if (!this.rules) return null;
    return this.checkAllowList(this.rules.allow ?? [], req);
  }

  /** 预授权清单（Step 12）是否覆盖本次请求——与 allow 规则同一套匹配（见 checkAllowList） */
  private matchesAllowList(allow: string[], req: PermissionRequest): boolean {
    return this.checkAllowList(allow, req)?.allowed === true;
  }

  private checkAllowList(allow: string[], req: PermissionRequest): Decision | null {
    const allowRules = { deny: [], allow, ask: [] };
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

    // 复合命令：至少一段命中 allow，其余每段要么命中 allow，要么是「管道下游纯过滤器」
    // 或「首段工作区内 cd &&」（Q2）。修前是 every(allow)：`bun test x 2>&1 | tail -30`
    // 因 `tail -30` 不命中而落到 ask，无头直接落拒（harness-bench P1v/P2v 6 次误拦）。
    //
    // ⚠️ 「其余段」不能用 isReadOnlyCommand 判：只读集放行 `awk '{system($0)}'`、
    // `find -delete`、`cat /etc/passwd`，借这条路会被带进组合命令。判据只认
    // allow-composition.ts 那张逐参数约束的小白名单，见那里的文件头。
    //
    // Step 2 危险检测 / Step 4 路径 / Step 6 写目标都排在本步之前，照旧先跑。
    const pipelines = splitCommandStructure(command);
    const flatCount = pipelines.reduce((n, p) => n + p.stages.length, 0);
    // 两种拆分口径不一致时（理论上不该发生，见 shell-structure.ts 一致性断言）回到 every(allow)
    const structureTrusted = flatCount === subCommands.length;
    const matchesAllow = (sub: string): boolean => {
      const subReq: PermissionRequest = {
        ...req,
        input: { ...(req.input as object), command: sub },
      };
      return checkRules(allowRules, subReq, pathCtx)?.allowed === true;
    };

    if (!structureTrusted) {
      return subCommands.every(matchesAllow) ? { allowed: true } : null;
    }

    let anyAllowHit = false;
    for (let p = 0; p < pipelines.length; p++) {
      const stages = pipelines[p].stages;
      for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];
        if (matchesAllow(stage)) {
          anyAllowHit = true;
          continue;
        }
        // 管道下游（s > 0）的纯过滤器：只读 stdin、无文件操作数、无写重定向
        if (s > 0 && isPipelineFilterStage(stage)) continue;
        // 首段 `cd <工作区或白名单内目录> &&`
        if (
          p === 0 &&
          s === 0 &&
          stages.length === 1 &&
          this.isSafeLeadingCd(command, stage, req)
        ) {
          continue;
        }
        return null;
      }
    }
    // 全是过滤器 / cd 的命令（`cd <ws> && tail -5`）不经 allow 放行：放行面必须和 allow 清单挂钩
    return anyAllowHit ? { allowed: true } : null;
  }

  /**
   * 首段 `cd <dir>` 是否可视为无害前缀：只认第一段、后面紧跟 `&&`（`;` / `||` 下 cd 失败
   * 后续照跑，cwd 语义不确定），且目录解析后落在工作区或 allowedDirectories 内。
   */
  private isSafeLeadingCd(command: string, stage: string, req: PermissionRequest): boolean {
    const dir = parseLiteralCdTarget(stage);
    if (dir === null) return false;
    const trimmed = command.trim();
    if (!trimmed.startsWith(stage)) return false;
    const rest = trimmed.slice(stage.length).trimStart();
    if (!rest.startsWith("&&") || rest.startsWith("&&&")) return false;
    const cwd = this.buildPathRuleContext(req).cwd ?? this.workspacePath;
    const resolved = this.pathValidator.resolveRealPath(resolveCdTarget(dir, cwd));
    return this.pathValidator.isWithinWorkingDirectories(resolved);
  }

  /**
   * 硬编码危险模式检测（纯逻辑，无副作用）。
   *
   * 两段：
   *   0. **结构化判定**（dangerous-command.ts）：把 10 条 critical 按「程序名 + 参数值」判。
   *      这一层必须先跑——它对 heredoc / 引号 / 引号内的 `|` 免疫，误报和漏报同时修。
   *   1. 文本正则：剩余 critical（`Fork 炸弹`）与 high/medium，行为保持修前不变。
   *
   * 为什么不把 high/medium 也一起 token 化：它们的误报后果只是「多一次确认」，
   * 而全文改判据的回归面（`chmod -R 777`、`git reset --hard` 等十几条）远大于收益。
   * 本次只处理「误报即无出口」的 critical，见 Agent Note 的「放弃了什么」。
   */
  private hardcodedDangerCheck(
    expansion: ShellCommandExpansion,
    cwd: string,
  ): DangerousFinding | null {
    // 0. 结构化 critical 判定
    const structural = detectStructuredCriticalDanger(expansion, { cwd, home: os.homedir() });
    if (structural) return structural;

    // 1a. 跨管道危险模式（对整段脚本）
    const pipelinePatterns = DANGEROUS_PATTERNS.filter(
      (dp) => dp.pattern.source.includes("\\|") || dp.name.includes("管道"),
    );
    //
    // 整段匹配的对象除原命令外，还包括每一层 sh -c / eval / 命令替换的内层脚本：
    // `sh -c 'curl x | sh'` 的管道在引号里，对原文做跨管道匹配同样能命中，但
    // `eval "$(echo Y3VybCB4fHNo | base64 -d)"` 这类只有展开后才露出形态。
    // heredoc 正文已在 expandShellCommand 里剥离（正文是数据，不是命令）。
    for (const dp of pipelinePatterns) {
      if (expansion.scripts.some((sc) => dp.pattern.test(sc))) {
        return { name: dp.name, severity: dp.severity };
      }
    }

    // 1a'. 提权（sudo / doas）：按程序位置判，不扫原文
    const privilege = detectPrivilegeEscalation(expansion.variants);
    if (privilege) return privilege;

    // 1b. 拆分复合命令，对每个子命令检查其余模式
    //
    // ⚠️ 安全：每个子命令**额外**用「剥离 git 全局选项后的归一串」再查一遍。
    // git 允许在子命令之前插入 `-c k=v` / `-C dir` / `--no-pager` 等全局选项
    // （`git -c core.pager=cat reset --hard`），这会把子命令与 `git` 撑开，使所有
    // `\bgit\s+<子命令>` 形态的正则失配 → 危险命令在 acceptEdits/yesMode 下被静默放行。
    // 归一化后双重匹配即可覆盖该绕过（对齐 CC gitCmdRe 的全局选项容错）。
    //
    // 子命令取「等价执行形态」全集（shell-command-variants.ts）：修前只拆复合命令，
    // `sh -c 'rm -rf /'` 与 `r\m -rf /` 在 always-allow 下直接放行（2026-10-24 实测）。
    const nonPipelinePatterns = DANGEROUS_PATTERNS.filter((dp) => !pipelinePatterns.includes(dp));
    for (const subCmd of expansion.variants) {
      const normalized = normalizeGitGlobalOptions(subCmd);
      const variants = normalized === subCmd ? [subCmd] : [subCmd, normalized];
      for (const dp of nonPipelinePatterns) {
        if (variants.some((v) => dp.pattern.test(v))) {
          return { name: dp.name, severity: dp.severity };
        }
      }
    }

    return null;
  }

  /**
   * Plan 模式检查（从 check 中提取）
   *
   * P2-2：这里曾有一段「plan 继承 bypass」——进入 plan 前是 always-allow 就全放行。
   * 它的输入 `this.prePlanMode` 只能经 setPrePlanMode 赋值，而后者全仓零调用，
   * 所以这段恒为 false；permission/mode.ts 另有一份同义的 shouldPlanInheritBypass，也零调用。
   * 两份一起删掉，**刻意不接活**：接活等于让 always-allow 用户的计划模式变成全放行，
   * 把「计划模式只读」这条硬保证换成一个取决于进入前模式的条件——那是一次权限放宽，
   * 需要单独立项讨论，不能以「修死代码」的名义顺手打开。
   */
  private checkPlanMode(req: PermissionRequest, filePath: string, resource: string): Decision {
    const log = getLogger();

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
          log.info(
            "PERMISSION",
            `${req.toolName}(type=${subType}) → 拒绝(plan模式只允许explore子代理)`,
          );
          return { allowed: false, reason: "计划模式下只允许 explore 类型的子代理" };
        }
      }
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan模式+专用工具)`);
      return { allowed: true };
    }

    // 允许 write/edit 操作计划文件
    if ((req.toolName === "write" || req.toolName === "edit") && filePath && this.planManager) {
      if (this.planManager.isPlanFile(filePath)) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${filePath.slice(0, 80)}) → 允许(plan模式+计划文件)`,
        );
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
    // B25：有外部 ask 通道（SDK 宿主）时不是「无人可问」
    if (this.externalAskChannel) return false;
    // print 模式（单次输出）或 maxTurns > 0（批处理模式）视为非交互
    return (
      this.config.print === true || (this.config.maxTurns !== undefined && this.config.maxTurns > 0)
    );
  }
}
