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

import { resolveSubAgentTypeParam } from "../agent/sub-agent-input.ts";
import type {
  AuditEntry,
  Checker,
  ConfirmationOutcome,
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
import { getToolRegistrationSource } from "../tool/registry.ts";
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
  detectCommandSubstitutionDanger,
  expandShellCommand,
  extractBashWriteTargets,
  listInvokedPrograms,
  type ShellCommandExpansion,
} from "./shell-command-variants.ts";
import { collectReadOnlyReadPaths, createSidSelfReadPathFilter } from "./readonly-read-paths.ts";
import { detectStructuredCriticalDanger, type DangerousFinding } from "./dangerous-command.ts";
import { isToolNameListed } from "../tool/tool-name-aliases.ts";
import { checkInjectionPatterns } from "./bash-security.ts";
import { guardOf } from "./decision-telemetry.ts";
import { isSafetyConfirmation } from "./safety-confirmation.ts";
// 只取类型：`import type` 编译期擦除，不会把 ToolClassifier 的运行时代码拉进权限判定模块
// （classifier 实例仍然只通过 setToolClassifier 注入，见下方字段声明）。
import type { PathVerdict, ToolClassifyResult } from "./tool-classifier.ts";
import { classifyBashShape, collectEnvPrefixVars, resolveCdTargetGitTrust } from "./bash-shape.ts";
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
import {
  judgeReadOnlyGitInOwnRepo,
  type ReadOnlyGitBoundaryResult,
} from "./readonly-git-boundary.ts";
import { judgeReadOnlyCompoundBash, type ReadOnlyCompoundResult } from "./readonly-compound.ts";
import type { ReadOnlyCompoundStage } from "./readonly-compound.ts";
import { matchPathRule } from "./path-rule-matching.ts";
import { isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";
import { resolveOwnCommonDir } from "./git-repo-trust.ts";
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
  // 「命令替换注入」也不在正则表里：按**替换出现的位置**判
  // （shell-command-variants.ts 的 detectCommandSubstitutionDanger）。
  // 正则 `/`…`|\$\([^)]*\)/` 把 `echo $(git rev-parse HEAD)` 和 `$(curl x)` 同等对待，
  // 前者在参数位、内层命令已单独判过，用户每次都得在「危险命令」红框里点确认。
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
 * M1：auto 分类器 fastPath 用的「目标路径」抽取。
 *
 * 与 `extractFilePath` 的差别：多认 `dir_path`（ls）。`ls` 是 Level 1 快路径会放行的
 * 只读工具，漏了 `dir_path` 就只能判 unknown、每次列目录都白花一次分类器调用。
 * 顺序与 `extractFilePath` 保持一致（file_path → notebook_path → path），
 * 只是多一个兜底字段，避免两处口径分叉。
 */
function extractAutoClassifyPath(req: PermissionRequest): string {
  const input = (req.input ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path", "dir_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

/**
 * B20：把阶段一危险确认的闸门标签（`guardOf`：A2 注入校验器 / A6 展开超限）搬进 metadata。
 * headless / dontAsk 会用新的 decisionReason 覆盖阶段一成因，不搬就在轨迹上丢掉了。
 * 只进 metadata，不影响任何判定。
 */
function guardMetadata(phaseOne: Decision): { metadata?: Record<string, unknown> } {
  const guard = guardOf(phaseOne);
  return guard ? { metadata: { guard } } : {};
}

/**
 * 阶段一给出的确认是否属于「危险来源」：dangerousCommand / safetyCheck。
 * yesMode、auto、hook allow 三处必须共用——复制粘贴会漏抄（P0-1 就是 auto 漏了这道）。
 *
 * 唯一实现在 `safety-confirmation.ts`：query 层（tool-executor）也要用它，
 * 从 checker.ts 导出会让 query 静态拉进整个权限判定模块。
 */

/**
 * M8：阶段一的确认原因是「用户自己写下的 ask 规则」。
 *
 * ask 规则是用户明确表达的「这件事必须问我一眼」，与安全分类器（系统判断危险）不同：
 * 任何自动批准通道都不该吞掉它。auto 分类器（M1b）、`-y`（M8）、skip 档（M8）三处
 * 共用这一条判据——复制粘贴会漏抄，而漏抄的形态是「配置了 ask 却静默执行」，
 * 三处各自单点测试还都是绿的。
 *
 * 与 `isSafetyConfirmation` 的分工：那个答「这是不是系统认定的危险」，
 * 这个答「这是不是用户点名要问的」，两者互不包含（ask 规则可以指向完全无害的命令）。
 */
function isUserAskRule(reason: PermissionDecisionReason | undefined): boolean {
  return reason?.type === "rule" && reason.behavior === "ask";
}

/**
 * auto 分类器是否允许发言。safetyCheck 命中且 classifierApprovable === false
 * （hooks / commands / settings）时分类器结果直接丢弃——这是字段存在的唯一理由。
 * classifierApprovable: true 的项（.git/、.bashrc）才允许分类器放行。
 *
 * M1b：用户**显式写的 ask 规则**同样不许分类器发言。写了 ask 就是要求人看一眼，
 * 分类器同意等于把用户规则静默降级成 allow——规则匹配赢不了「模型判断」就不再是规则。
 * 这是分类器「能不能发言」的唯一判定点，auto 分支不要另加 if。
 */
function classifierMayApprove(reason: PermissionDecisionReason | undefined): boolean {
  if (!reason) return true;
  if (reason.type === "dangerousCommand" || reason.type === "destructiveTool") return false;
  if (reason.type === "safetyCheck") return reason.classifierApprovable === true;
  if (isUserAskRule(reason)) return false;
  return true;
}

/**
 * M1b：阶段一的终局原因属于「请分类器看上下文」时，auto 的零成本快速路径必须退场。
 *
 * - `pathValidation`：工作区外读写。界外不等于危险（`/tmp` 下跑测试很常见），
 *   所以仍交给分类器判上下文，但不能让 fastPath 凭工具名直接放行。
 * - `safetyCheck` 且 `classifierApprovable: true`：`.git/hooks`、shell rc 这类
 *   「可执行代码路径」。字段名的意思就是「分类器看一眼」，同理。
 *
 * 与 `classifierMayApprove` 的分工：那个管「分类器能不能说话」，这个管
 * 「说了之后能不能走零成本通道」。两条都成立才需要 LLM。
 */
function shouldSkipFastPath(reason: PermissionDecisionReason | undefined): boolean {
  if (!reason) return false;
  if (reason.type === "pathValidation") return true;
  if (reason.type === "safetyCheck") return reason.classifierApprovable === true;
  return false;
}

/** `classifierReason` 的落盘上限：模型输出长度无上界，一条跑偏的理由不该撑大整条轨迹行 */
const CLASSIFIER_REASON_MAX_CHARS = 200;

function truncateClassifierReason(reason: string): string {
  return reason.length > CLASSIFIER_REASON_MAX_CHARS
    ? `${reason.slice(0, CLASSIFIER_REASON_MAX_CHARS)}…`
    : reason;
}

/**
 * PR0（C1）：auto 档「分类器说话」那一次要留下的结构化事实（耗时 / 风险 / 理由）。
 *
 * 此前只有**回退**分支带一个 `autoClassifier` 枚举，于是 auto 档最想回答的三个问题
 * 全是空白：分类器放行了多少次、放行里有多少是零成本的快速路径、每次判定花了多少毫秒。
 *
 * 返回的字段**不含 `autoClassifier` 本身**：放行时它是 `fast-path` / `llm-safe`，
 * 回退时是 `unsafe` / `unavailable` / `error`，两侧口径不同，由调用点各自决定。
 *
 * 两处刻意不落：
 * - `via=fast-path`：没发请求也就没有 `latencyMs`；落 `classifier_ms: 0` 会把「零成本」
 *   记成「一次耗时 0ms 的调用」，与真的 0ms 返回混在一起。
 * - `classifierUnavailable=true`：此时 `risk` 恒为占位值 `medium`，不是模型判的，
 *   落盘会变成「分类器说风险中等」这种没发生过的事实。
 */
function autoClassifyFactsOf(result: ToolClassifyResult): {
  classifierMs?: number;
  classifierRisk?: string;
  classifierReason?: string;
} {
  if (result.via === "fast-path") return {};
  const facts: { classifierMs?: number; classifierRisk?: string; classifierReason?: string } = {};
  if (result.latencyMs !== undefined) facts.classifierMs = result.latencyMs;
  if (result.via === "llm" && !result.classifierUnavailable) facts.classifierRisk = result.risk;
  facts.classifierReason = truncateClassifierReason(result.reason);
  return facts;
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
 * B14（方案 20261114）：读工具的 `requiresPermission()` 声明，判断能否整条权限链放行。
 *
 * ## 为什么从「名单」改成「工具自报」
 *
 * 此前这里是一张 `HEADLESS_LOCAL_LEDGER_TOOLS = ["todo_write", "task_create", "task_update"]`
 * 名单，它只在**无头模式**这一条路径上生效（位置在 `isNonInteractive()` 之前），
 * 于是同一批工具在交互模式下依然要用户为「记一条 todo」点确认。名单还必然漂移：
 * 新增一个纯记账工具的人不会知道有这张表，`task_get` / `task_list` / `think` 就一直落在
 * Step 14 默认 ask 上（实测：计划批准后第一步 `todo_write` 在无头实跑里被拒，整段执行报废）。
 * 现在改由工具在自身定义处声明，名单消失。
 *
 * ## 三重 fail-closed
 *
 * 1. **来源必须是内置**：MCP / 插件 / 自定义代理工具即便实现了 `requiresPermission`
 *    也一律忽略——那是外部代码，不享受「我写的我担保」这一层（判据见
 *    `TOOL_REGISTRATION_SOURCE` 的注释）。
 * 2. **只认显式的 `false`**：返回 `true`、返回 `undefined`、声明抛错都按「需要权限」处理。
 * 3. **工具对象缺失**：调用方拿不到工具实例时同样返回 false。
 */
function declaredNoPermission(tool: Tool | undefined, input: unknown): boolean {
  if (!tool) return false;
  if (getToolRegistrationSource(tool) !== "builtin") return false;
  const declared = (tool as { requiresPermission?: (input?: unknown) => boolean })
    .requiresPermission;
  if (typeof declared !== "function") return false;
  try {
    return declared.call(tool, input) === false;
  } catch {
    return false;
  }
}

/**
 * 工具是否自报「只读」——两种接口形态都认。
 *
 * 迁移期 checker 可能拿到 `LegacyTool`（`readOnly()` 无参，registry 内部存储的形态）
 * 或新版 `Tool`（`isReadOnly(input)` 有参，测试与直接构造的调用方）。`tool/registry.ts`
 * 内部存的是 LegacyTool，但 bridge 归一后 `readOnly()` 已经调用了原 `isReadOnly`，
 * 所以两条分支不会同时命中同一份语义两次。
 */
function toolReportsReadOnly(tool: Tool | undefined, input: unknown): boolean {
  if (!tool) return false;
  const legacy = (tool as { readOnly?: () => boolean }).readOnly;
  if (typeof legacy === "function") {
    try {
      return legacy.call(tool) === true;
    } catch {
      return false;
    }
  }
  const modern = (tool as { isReadOnly?: (input?: unknown) => boolean }).isReadOnly;
  if (typeof modern === "function") {
    try {
      return modern.call(tool, input) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * acceptEdits 模式下自动放行的文件系统命令（对齐 CC modeValidation.ts ACCEPT_EDITS_ALLOWED_COMMANDS）。
 * 仅当命令的路径参数都在 cwd 内才自动放行。
 * P1-3：`rm`/`rmdir`/`mv` 不在白名单——`rm -rf .` 的 `.` resolve 后就是 cwd，
 * isWithinWorkspace 为 true，会把工作区（cwd 恰好是家目录时更糟）直接删掉。
 */
const ACCEPT_EDITS_FS_COMMANDS = new Set(["mkdir", "touch", "cp", "sed"]);
/** 即使被加回白名单也不得自动放行（第二道闸，防名单回潮）。 */
const ACCEPT_EDITS_DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "mv"]);

/**
 * acceptEdits 放行侧允许剥离的环境变量名前缀（M9）。
 * 只放纯展示性变量：它们不改变命令要做什么，剥掉只是让「顺手写了 LANG=C」不再多弹一次确认。
 * 值另需匹配 ACCEPT_EDITS_ENV_VALUE_RE —— `LANG='a b'`、`FOO=$(curl evil)` 这类
 * 需要 shell 解释的形态一律不剥。
 */
const ACCEPT_EDITS_ENV_PREFIX_KEYS = new Set(["LANG", "LC_ALL", "NO_COLOR", "TERM"]);
/** 环境变量值只认「不需要 shell 解释」的字符集；带引号/空格/展开的一律不剥。 */
const ACCEPT_EDITS_ENV_VALUE_RE = /^[A-Za-z0-9_.-]+$/;
/** `timeout` 的时长参数（GNU coreutils NUMBER[SUFFIX] 的子集）：`30` / `5s` / `1.5m`。 */
const ACCEPT_EDITS_TIMEOUT_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * M9：剥掉 acceptEdits 放行侧的**最小**前缀（进程包装器 + 纯展示性环境变量）。
 *
 * 为什么不复用 `expandShellCommand`：那份实现是为「拦」设计的——递归展开 `sh -c`/`eval`/
 * 命令替换，剥 `sudo`/`xargs`。放行侧沿用它等于把「拦」的宽口径借给「放」，
 * `env mkdir x`、`xargs mkdir` 会被直接放行（10-24 Note 的否决论证）。
 * 这里只认三种不改变被调命令语义的包装器和四个展示性变量，且**至多剥一层包装器**。
 *
 * 「只剥一层」是刻意的：`timeout 5 timeout 5 mkdir x` 剥完 baseCmd 仍是 `timeout`，
 * 不在 fs 白名单里，落回 ask。递归剥离会让放行面随嵌套深度线性扩大，收益接近零。
 * 剥离顺序也固定为「先环境变量（可多个）→ 再一个包装器」：反过来剥
 * （`timeout 5 LANG=C mkdir x`）在 shell 里本来就是错的——`timeout` 会把 `LANG=C`
 * 当成要执行的命令名。
 *
 * `stripped` 单独返回，是因为 `touch` 有例外：CC 的 acceptEdits 只信任裸 `touch`，
 * 带任何前缀都不自动接受（方案 §4.7 约束 2）。
 */
function stripAcceptEditsSafePrefixes(tokens: string[]): { tokens: string[]; stripped: boolean } {
  let i = 0;
  // 1. 环境变量前缀：允许连续多个（`LANG=C LC_ALL=C mkdir x`），每个都必须在白名单且值形态合规。
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const eq = tok.indexOf("=");
    if (eq <= 0) break;
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    if (!ACCEPT_EDITS_ENV_PREFIX_KEYS.has(key) || !ACCEPT_EDITS_ENV_VALUE_RE.test(value)) break;
    i++;
  }
  const envStripped = i > 0;

  // 2. 进程包装器：至多剥一个，参数格式不认识就不剥（落回 ask 是安全方向）。
  let wrapperStripped = false;
  const head = tokens[i];
  if (head === "timeout") {
    const duration = tokens[i + 1];
    if (duration && ACCEPT_EDITS_TIMEOUT_DURATION_RE.test(duration) && i + 2 < tokens.length) {
      i += 2;
      wrapperStripped = true;
    }
  } else if (head === "nohup") {
    if (i + 1 < tokens.length) {
      i += 1;
      wrapperStripped = true;
    }
  } else if (head === "nice") {
    // `nice [-n N] cmd`；`nice -10 cmd` 这类老式调整量不认。
    const next = tokens[i + 1];
    if (next === "-n" && tokens[i + 2] && /^-?\d+$/.test(tokens[i + 2]!) && i + 3 < tokens.length) {
      i += 3;
      wrapperStripped = true;
    } else if (next && !next.startsWith("-")) {
      i += 1;
      wrapperStripped = true;
    }
  }

  return { tokens: tokens.slice(i), stripped: envStripped || wrapperStripped };
}

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
  /**
   * 本仓的公共 git 目录（B4）：只读 git「执行边界」判定的基准。
   * 会话内只算一次——工作区的仓库归属不会在会话中途变，判定本身只做 stat 与读一个小文件。
   */
  private ownCommonGitDir: string | null;
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
   * 权限审计的唯一写入口。B19：给每行盖上 `tool_use_id`（取自 `req.toolUseId`）；
   * 会话键由 `AuditLogger` 统一盖。所有审计行都必须经过这里——直接调
   * `this.auditLogger.log` 会漏键（`audit-trace-keys.test.ts` 有静态哨兵拦）。
   */
  private audit(req: PermissionRequest, entry: AuditEntry): void {
    this.auditLogger.log(
      req.toolUseId && !entry.tool_use_id ? { ...entry, tool_use_id: req.toolUseId } : entry,
    );
  }

  /**
   * B20：确认弹窗终局落审计。`check()` 判 needsConfirmation 时自己不写审计（结论还没出），
   * 于是人工批准 / 拒绝、hook 裁决、超时拒绝此前一条都不落盘，`user_confirmed` 全量恒 false。
   * 只写审计，不动 denial tracking / 会话记忆——那两件事调用方另有入口（recordUserDenial /
   * rememberDecision），这里再记一次会让计数翻倍。
   */
  auditConfirmationOutcome(req: PermissionRequest, outcome: ConfirmationOutcome): void {
    const resource = extractFilePath(req) || (req.input as any)?.command || "";
    // PR0（C2）：把「为什么要问」里的分类器结论带进审计。此前这一行只有
    // `"reason":"用户批准"`，于是触发会话里「分类器为什么判 unsafe」在审计侧
    // 完全查不到（轨迹里也只有枚举，理由没落）。
    // 只取固定枚举与被截断的一句话理由，不落整个 metadata —— 里面可能有其它字段
    // （如 `denialTrackingTriggered` 布尔位），审计的字段集应当是可枚举的。
    const autoClassifier = outcome.metadata?.autoClassifier;
    const classifierReason = outcome.metadata?.classifierReason;
    this.audit(req, {
      timestamp: new Date().toISOString(),
      type: "tool_use",
      tool: req.toolName,
      resource,
      decision: outcome.allowed ? "allow" : "deny",
      reason: outcome.reason,
      decisionReason: outcome.decisionReason,
      user_confirmed: outcome.source === "user",
      confirm_source: outcome.source,
      ...(typeof autoClassifier === "string"
        ? { auto_classifier: truncateClassifierReason(autoClassifier) }
        : {}),
      ...(typeof classifierReason === "string"
        ? { classifier_reason: truncateClassifierReason(classifierReason) }
        : {}),
    });
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
    this.audit(req, {
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
    // B4：本仓的公共 git 目录只算一次。工作区不是仓库时是 null，此时所有只读 git
    // 都会落到确认（安全方向上的退化，不会误放行）。
    this.ownCommonGitDir = resolveOwnCommonDir(this.workspacePath);
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

  /**
   * 运行期补入预授权规则（Step 12 放行）。
   *
   * 为什么需要显式同步：`preApproved` 在构造函数里从 `config.allowedTools` 快照一次，
   * 之后对 config 的写入它一概看不见。而 CLAUDE.md 的 `## Allowed Tools` 由 app 层
   * 在 checker 构造**之后**才追加进 config（`app.ts` `applyProjectRules`，
   * 时序：`cli.ts` 构造 checker → `app.init()` → `doInit` 加载 CLAUDE.md），
   * 于是用户级 CLAUDE.md 写的白名单一条都不生效（B32，2026-11-10 实测
   * `preApproved=[]`、`allowed=false step=14`）。
   *
   * 用 Set 承接：热重载 / 切 worktree 会带着同一份名单反复走到这里，天然幂等。
   */
  addPreApprovedRules(rules: readonly string[]): void {
    for (const raw of rules) {
      const rule = raw.trim();
      if (rule) this.preApproved.add(rule);
    }
  }

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
   * M1：给 auto 分类器的 fastPath 算「目标路径是否在工作目录集合内」。
   *
   * 判定只用 `PathValidator`（`resolveRealPath` 解 symlink + `..`，
   * `isWithinWorkingDirectories` 含 `--add-dir` / `allowedDirectories` 白名单），
   * 不再让分类器自己写一套——并行的第二套路径判断正是 M1 的根源。
   *
   * 用 `isWithinWorkingDirectories` 而不是 `isWithinWorkspace`：用户显式授权的目录
   * 在 default 档读写都不问，auto 不该比 default 更严。
   *
   * 取不到路径 → `"unknown"`（不放行，落到 LLM）。不猜「大概在工作区内」。
   */
  private classifyPathVerdict(req: PermissionRequest): PathVerdict {
    const rawPath = extractAutoClassifyPath(req);
    if (!rawPath) return "unknown";
    const realPath = this.pathValidator.resolveRealPath(rawPath);
    return this.pathValidator.isWithinWorkingDirectories(realPath) ? "inside" : "outside";
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
      // M9：先剥掉「安全前缀」，再用剥完的 tokens 走原有三道校验。
      // 剥的顺序是刻意的——下面的破坏性第二道闸**必须**在剥离之后判，
      // 否则 `timeout 5 rm -rf .` 的 baseCmd 是 `timeout`，第二道闸形同不存在。
      const stripped = stripAcceptEditsSafePrefixes(trimmed.split(/\s+/));
      const tokens = stripped.tokens;
      const baseCmd = tokens[0];
      if (!baseCmd) return false;
      // P1-3：rm/rmdir/mv 即使被加回白名单也不得自动放行（第二道闸）。
      if (ACCEPT_EDITS_DESTRUCTIVE_COMMANDS.has(baseCmd)) return false;
      // baseCmd 必须是白名单 fs 命令
      if (!ACCEPT_EDITS_FS_COMMANDS.has(baseCmd)) return false;
      // M9：`touch` 例外——带任何前缀都不自动放行（对齐 CC permission-modes.md:281）。
      // `touch` 是白名单里唯一会**创建**文件的命令，前缀让「他到底要 touch 什么」
      // 从命令名字面上看不全，CC 的取舍是宁可多问一次。
      if (stripped.stripped && baseCmd === "touch") return false;

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
    // config/settings 合并器的**内存源**（给 `getSettings()` / `getSettingsForSource()` 用），
    // 而 RuleLoader 只读磁盘上的 user/project/local/policy 文件。这里把内存源那一侧的
    // `permissions` 取出来喂给 RuleLoader，两链合一。
    //
    // 2026-11-17 更新：Config 侧与 hooks 侧也已接入同一个源（见 config.ts 的
    // loadConfigFile 与 hook-layers.ts 的 flag 层），`--settings` 现在是统一视野；
    // 本段注释里「Config 不读这个源」的旧说法已随那次改动删除。
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
    /**
     * A1：Step 4 因为「工作区外的非敏感路径」放过了子代理，但放行本身还没发生——
     * 真正的放行点在 Step 8（always-allow）。这个标记只用于那一步的 decisionReason 埋点，
     * 让这类放行在轨迹里可以和普通 always-allow 分开统计（见 PermissionDecisionReason.via）。
     */
    let skipInheritedOutsideWorkdir = false;

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
    if (isCommandSemanticsRequest(req)) {
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
            this.audit(req, {
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
        // A1（2026-11-03 会话 3b4f9ca7 复盘）：skip 档主会话派生的子代理，
        // 「工作区外 + 非敏感」这一类不在 Step 4 拦。
        //
        // 为什么必须在这一步放（而不是等 Step 8 的 always-allow）：Step 4 排在 Step 8 之前，
        // 主会话 skip 档零校验的同一位置，子代理会先在这里被拒——轨迹里 10 次
        // `读取路径在工作区外` + 1 次 `/tmp` 写入全来自这里，而主会话全程 0 次拒绝。
        //
        // 为什么只放这一类：敏感文件在 path-validator 第 5 步就硬 deny 了（排在边界检查之前，
        // 返回对象不带 outsideWorkingDirs），系统目录 / symlink 逃逸同理不带该标记。
        // 放行后仍要过 Step 5 ask 规则、Step 6 safetyCheck（`.git/hooks`、shell rc 照拦）
        // 与 Step 8 模式判定——这里只回答「路径边界这一票不 veto」。
        //
        // 为什么规则逃生舱排在这之前：用户写的 allow 规则比模式继承更具体，命中它应当
        // 记成 rule 而非 mode（否则轨迹里分不清「用户配了」还是「模式带的」）。
        if (
          pathResult.outsideWorkingDirs === true &&
          pathResult.sensitiveFile !== true &&
          this.config.inheritedFromSkip === true
        ) {
          skipInheritedOutsideWorkdir = true;
          log.info(
            "PERMISSION",
            `${req.toolName}(${filePath.slice(0, 80)}) → 路径边界放行(继承 skip 档，工作区外非敏感路径，后续 safetyCheck 照常)`,
          );
        } else {
          return {
            allowed: false,
            reason: pathResult.reason,
            needsConfirmation: pathResult.needsConfirmation,
            decisionReason: { type: "pathValidation", reason: pathResult.reason || "" },
          };
        }
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
      // B1/B2/B4：只读 git 的「执行边界」判定。两条路径共用同一次计算：
      // ① 工具说 allow → 命令含 git 段时还要判「这个只读 git 作用在谁的仓库上」；
      // ② 工具没意见（passthrough）→ 补回被 `-C` 严格口径挡掉的「本仓内只读 git」。
      const gitBoundary = await this.evaluateReadOnlyGitBoundary(req);
      if (toolPermResult.behavior === "allow") {
        // 工具说「我是只读」只能跳过默认 ask，不能跳过模式硬约束。
        // 否则 python3 / node / make 这类假只读会在 Step 5.5 直接 return，
        // plan / deny-write 永远走不到（P0-3）。
        if (!gitBoundary.applicable || gitBoundary.allowed) {
          // B5：只读放行前先看它的**读路径**在不在工作区内。
          // `cat /etc/hosts` 此前在这里直接放行（工作区外读取静默通过），
          // `cat ../README.md`（工作区内）反倒被 Step 2 的文本正则拦下。
          const readPath = await this.evaluateReadOnlyReadPaths(req);
          if (readPath) return readPath;
          return this.allowAtToolLevel(req, filePath, resource, "工具级checkPermissions", tool);
        }
        // 越界（异仓 / 裸仓库形态 / 工作区外）不在这里放行，落到后续步骤 → 普通确认。
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 落确认(只读 git 执行边界: ${gitBoundary.reason ?? "未知"})`,
        );
      } else if (gitBoundary.applicable && gitBoundary.allowed) {
        // B2 补回：`git -C <本仓内目录> <只读子命令>` 在 isReadOnlyCommand 里因为不剥 `-C`
        // 判非只读，但它等价于「只对这一条 git 命令生效的 cd <dir>」，目标字面量、
        // 在工作区内、属本仓，按只读放行。模式硬约束与工具级 allow 完全相同。
        return this.allowAtToolLevel(req, filePath, resource, "只读 git 本仓边界", tool);
      } else {
        // Step 5.6: 工作区内 `cd` + 只读主体（B3）。
        //
        // `BashTool.checkPermissions` 用的是不带上下文的 `isReadOnlyCommand`，它把 `cd`
        // 一律判非只读——这是对的（纯函数不知道会话 cwd），但代价是
        // `cd <会话 cwd> && git log` 这类命令每次都弹确认（本会话 22 条 / 327.8s）。
        // 这里补回带 cwd 上下文的那一半：cd 目标必须在工作区内，主体仍逐段只读，
        // 含 git 段时仓库归属照 PR-1 的口径判。判不准一律返回 false → 落到后续确认。
        st.step = "5.6";
        const compound = await this.evaluateReadOnlyCompoundBash(req);
        if (compound.applicable && compound.readOnly) {
          // B5：同样的读路径校验，只是这次按**每段的有效 cwd** 解析
          // （`cd <ws>/packages && cat ../README.md` 的 `../` 基准是 packages）。
          const readPath = await this.evaluateReadOnlyReadPaths(req, compound.stages);
          if (readPath) return readPath;
          return this.allowAtToolLevel(req, filePath, resource, "工作区内 cd 复合只读", tool);
        }
        if (compound.applicable) {
          // 适用但判不准：留一条可归因的日志，最终落普通确认
          log.info(
            "PERMISSION",
            `${req.toolName}(${resource.slice(0, 80)}) → 落确认(cd 复合只读: ${compound.reason ?? "未知"})`,
          );
        }
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
        : isCommandSemanticsRequest(req)
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
    //
    // ③ 只放行 bash（D5）：这一步的正当性还依赖「命令**真的会在沙箱里跑**」——
    //    bash.ts 的两处执行都用 sandboxManager.wrapCommand 包裹。monitor 的子进程是
    //    裸 spawn（monitor-task.ts），没有任何沙箱约束；此前条件写的是
    //    isCommandSemanticsRequest(req)，把带 command 的 monitor 也算进来，等于对一个
    //    不在沙箱里的进程宣称「沙箱保护下自动放行」——决策日志声称了一个不存在的保护。
    //    monitor 仍走后面的规则匹配（commandRuleRequest 把规则名归一成 bash），
    //    只是不再享受这一步；行为等价于「沙箱关闭」时的 monitor。
    if (req.toolName === "bash" && this.sandboxManager?.shouldAutoAllowBash()) {
      // ① 模式硬约束优先：plan / deny-write 是代码级只读，沙箱不构成放行理由
      if (this.config.permissionMode === "plan") {
        return this.checkPlanMode(req, filePath, resource, tool);
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
      return {
        allowed: true,
        // A1：Step 4 因「继承 skip 档 + 工作区外非敏感路径」让路时单独埋点。
        // 这条口子放宽了「更安全」，混进普通 always-allow 就再也统计不到它被用了多少次。
        decisionReason: skipInheritedOutsideWorkdir
          ? { type: "mode", mode: "always-allow", via: "skip-inherit-outside-workdir" }
          : { type: "mode", mode: "always-allow" },
      };
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
      return this.checkPlanMode(req, filePath, resource, tool);
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
      if (isCommandSemanticsRequest(req)) {
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
    //
    // B14：自报「不需要权限」**且真的只读**的工具在这里放行。deny-write 的语义是
    // 「不许改文件」，不是「连记账都不许」——旧实现无条件 deny，于是 plan 模式落到
    // deny-write 时 `todo_write` 连一行进度都记不了。
    // 两个条件必须同时成立：只看声明会把 `todo_write` 放进来（它会写 progress 文件，
    // `readOnly()` 为 false）；只看 readOnly 又会把「只读但会起子进程」的工具放进来。
    if (this.config.permissionMode === "deny-write") {
      if (declaredNoPermission(tool, req.input) && toolReportsReadOnly(tool, req.input)) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 允许(deny-write+免权限只读工具)`,
        );
        return { allowed: true, decisionReason: { type: "mode", mode: "deny-write" } };
      }
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

    st.step = "13.6";
    // Step 13.6（B14）：工具自报「我不需要权限」→ 放行。
    //
    // 位置刻意在 Step 13.5（破坏性确认）**之后**：`requiresPermission` 只是「我不写不跑」
    // 的自述，不该盖过 MCP server 自己声明的 destructiveHint——那条更严格的信息优先。
    // 也不放在 Step 10（`READ_ONLY_TOOLS`）：那张表被 plan / deny-write 共用，
    // 而本声明与「只读」不是同一个概念（`todo_write` 会写 progress 文件）。
    //
    // 无头模式因此自动被覆盖：`isNonInteractive()` 的 deny 在阶段二（本函数返回 ask 之后），
    // 这里先一步放行，不需要再单独维护一张「无头白名单」。
    if (declaredNoPermission(tool, req.input)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(工具声明免权限)`);
      return { allowed: true, decisionReason: { type: "other", reason: "工具声明不需要权限" } };
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
    const gated = decision.allowed ? this.enforceModeHardConstraint(req, decision, tool) : null;
    const final = gated ?? decision;
    return {
      ...final,
      mode: final.mode ?? this.effectiveMode(),
      ...this.bashTelemetryMetadata(req, final),
    };
  }

  /**
   * B12：给 bash 决策附上命令形状与危险成因相关的观测字段
   * （`Decision.metadata.bashShape` / `envPrefixVars` / `gitTrust`）。
   *
   * 为什么在 `check()` 出口而不是各 Step 里各塞一次：判定面有十几条 return，逐处补
   * 就是下一个新分支只记得其中几处；出口是唯一经过全部决策的地方。
   *
   * 为什么算在这里而不是 digest 里：`events.jsonl` 里的命令文本是截断的
   * （本会话 51 条普通确认里 25 条超过 200 字符），从截断文本重跑分类会把长命令
   * 整段误判成「非只读其他」——那个读数看起来像数据，其实是错的。
   *
   * 只对 bash 生效；非 bash 工具（read / write 的路径确认）不落这些字段。
   * 缺失 = 不适用（不是 0）：无 `cd` 前缀就没有 `gitTrust`，前缀里全是白名单变量
   * 就没有 `envPrefixVars`。
   */
  private bashTelemetryMetadata(
    req: PermissionRequest,
    final: Decision,
  ): { metadata?: Record<string, unknown> } {
    // monitor 的 `command` 走 bash 同一条权限管线（§5.4.6）：规则名按 `bash` 匹配，
    // 审计要能区分「这条决策是 monitor 继承 bash 规则来的」与「bash 自己的」。
    // 只标这一个字段，**不继承** bashShape / envPrefixVars——那是 bash 工具自己的
    // 统计口径（命令形状桶专门用于分析 bash 的确认分布），把 monitor 混进去会污染分母。
    if (req.toolName === "monitor") {
      return { metadata: { ...final.metadata, effectiveTool: "bash" } };
    }
    if (req.toolName !== "bash") return {};
    const command = (req.input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") return {};
    const workspacePath = this.pathValidator.getWorkspacePath();
    const extra: Record<string, unknown> = {};

    const bashShape = classifyBashShape({
      command,
      workspacePath,
      dangerous: final.decisionReason?.type === "dangerousCommand",
    });
    if (bashShape) extra.bashShape = bashShape;

    // B1 的变量白名单收窄后，「还有多少确认是被 env 前缀拖进来的」直接数这个
    const envPrefixVars = collectEnvPrefixVars(command);
    if (envPrefixVars.length > 0) extra.envPrefixVars = envPrefixVars;

    // B4 的仓库归属：拆「工作区内 cd + 只读」里还有多少是换仓（foreign）导致的真确认。
    // ownCommonGitDir 在构造时算好（见 resolveOwnCommonDir 调用点），不重复 stat。
    const gitTrust = resolveCdTargetGitTrust({
      command,
      workspacePath,
      ownCommonDir: this.ownCommonGitDir,
    });
    if (gitTrust) extra.gitTrust = gitTrust;

    if (Object.keys(extra).length === 0) return {};
    return { metadata: { ...final.metadata, ...extra } };
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
  private enforceModeHardConstraint(
    req: PermissionRequest,
    decision: Decision,
    tool?: Tool,
  ): Decision | null {
    const mode = this.config.permissionMode;
    // M7：dontAsk 的承诺是「绝不弹窗」，而声明了 `requiresUserInteraction` 的工具
    // 一执行就要阻塞等人回答。这道拦截必须在出口：allow 规则（Step 8）、会话记忆、
    // 预授权、hook allow 全都排在阶段二的 dontAsk 之前，任何一条命中都会把问卷弹出来——
    // 用户级 settings 里从 Claude Code 迁过来的 `AskUserQuestion` allow 就是最常见的那条。
    // 与 plan / deny-write 共用一个出口，理由同上：放行面再增加一条也绕不过它。
    if (mode !== "plan" && mode !== "deny-write" && mode !== "dontAsk") return null;
    if (mode === "dontAsk" && tool?.requiresUserInteraction?.() !== true) return null;
    if (decision.step === "3.5") return null;
    const filePath = extractFilePath(req);
    const resource = filePath || (req.input as { command?: string })?.command || "";
    let blocked: Decision | null = null;
    if (mode === "dontAsk") {
      blocked = {
        allowed: false,
        reason: "dontAsk 模式下不允许需要用户交互的工具",
        decisionReason: { type: "mode", mode: "dontAsk" },
      };
    } else if (mode === "plan") {
      const verdict = this.checkPlanMode(req, filePath, resource, tool);
      if (!verdict.allowed) {
        blocked = {
          ...verdict,
          decisionReason: verdict.decisionReason ?? { type: "mode", mode: "plan" },
        };
      }
    } else if (!READ_ONLY_TOOLS.has(req.toolName)) {
      // B14：与阶段一 Step 13 同一条判据——「声明免权限 **且** 真的只读」才放过。
      // 这道总闸的名字就写着「覆盖 step 的放行」，所以两处必须同步改：只改 Step 13
      // 会让阶段一的 ALLOW 在这里被静默改回 DENY（`step: "mode-gate"`），
      // 表现是测试全绿而线上照旧弹确认——本 PR 实现时实测踩到过一次。
      const exemptInDenyWrite =
        declaredNoPermission(tool, req.input) && toolReportsReadOnly(tool, req.input);
      if (!exemptInDenyWrite) {
        blocked = {
          allowed: false,
          reason: "deny-write 模式下不允许写操作",
          decisionReason: { type: "mode", mode: "deny-write" },
        };
      }
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
    this.audit(req, {
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
      // skip 档只跳过「系统认定的危险」，不跳过「用户写下的拒绝」（04 剖析 5.7 第 2 条，用户拍板选项 B）。
      // 修前这里排在 Step 1 deny 规则之前，于是 `--dangerously-skip-permissions` 让用户 / 项目 / 企业
      // 配的 deny、`disallowedTools`、弹窗里点过的「拒绝并记住」全部失效；而子代理上 skip 归一成
      // always-allow、排在 Step 1–6 之后——主会话的保护反而比它派出去的子代理少。
      // 危险命令、敏感路径、safetyCheck 仍跳过：那是 skip 档本来的语义（无人值守、用户自负）。
      const userDeny = this.checkUserDenyUnderSkip(req, resource, options);
      if (userDeny) return userDeny;
      // M8：用户写下的 ask 规则同样不被跳过——它与 deny 是一对，都是「人明确表达的意图」。
      // 修前这里只挡 deny，于是 `ask: ["Bash(git push*)"]` 在 skip 下静默执行，
      // 而 default 档同一份规则会弹确认：同一条配置在不同模式下的含义被悄悄改写了。
      // 命中后返回 needsConfirmation 而不是在这里自己决定「无头怎么办」——交互弹窗 /
      // 无头 deny 由下游一处统一处理，权限层不复制那条口径。
      const userAsk = this.checkUserAskUnderSkip(req);
      if (userAsk) return userAsk;
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(skipPermissions)`);
      this.audit(req, {
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
        this.audit(req, {
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
        const hookAskDenied: Decision = {
          allowed: false,
          reason: "PreToolUse hook 要求确认，但当前为非交互模式，自动拒绝",
          decisionReason: { type: "other", reason: "PreToolUse hook ask (non-interactive)" },
          step: "hook-ask",
        };
        // B20 / A5：此前直接 return，审计里没有这一行（trace 有 step=hook-ask）
        this.audit(req, {
          timestamp: new Date().toISOString(),
          type: "tool_use",
          tool: req.toolName,
          resource,
          decision: "deny",
          reason: hookAskDenied.reason,
          decisionReason: hookAskDenied.decisionReason,
          ...(options?.auditSource ? { source: options.auditSource } : {}),
        });
        return hookAskDenied;
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
      this.audit(req, {
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
      this.audit(req, {
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
      // M8：用户显式写的 ask 规则同样不放行。`-y` 的语义是「自动批准需确认操作」，
      // 而 ask 规则是用户点名要求「无论什么模式都问我一眼」的那一类——把自动批准
      // 盖在它上面，等于让 -y 静默改写用户自己的配置（配置了 ask 却直接执行）。
      // 与 M1b（auto 分类器不得放行 ask 规则）共用同一个判据 `isUserAskRule`。
      if (!isSafetyConfirmation(result.decisionReason) && !isUserAskRule(result.decisionReason)) {
        log.info(
          "PERMISSION",
          `${req.toolName}(${resource.slice(0, 80)}) → 允许(yesMode 自动批准普通 ask)`,
        );
        this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
        this.audit(req, {
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
      // A9 标记：auto 档没有放行、回退人工确认时，记下回退成因（固定枚举）。
      // 此前「分类器判不安全」「分类器挂了」「护栏禁止分类器」三种回退在审计与轨迹里长得一样，
      // 分类器质量问题与配置问题无从区分。只进 metadata，不改决策。
      // M1b：新增 "ask-rule"——「用户写了 ask 规则、分类器根本没说话」必须与
      // 「分类器判不安全」分开，否则调分类器 prompt 时会把用户规则的效果算成模型误判。
      let autoFallback:
        | "absent"
        | "safety-guard"
        | "ask-rule"
        | "unsafe"
        | "unavailable"
        | "error" = "absent";
      // PR0（C1）：分类器**说过话**的那一次要留下的耗时 / 风险 / 理由，放行与回退共用一份。
      // 此前只有回退分支带 `autoClassifier`，放行分支直接 return 且不带 metadata —— 于是
      // auto 档最想回答的两个问题全是空白：分类器放行了多少次、其中多少是零成本的快速路径。
      let autoClassifyFacts: ReturnType<typeof autoClassifyFactsOf> = {};
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
          // P0-1 + M1b：auto 与 yesMode 共用同一道护栏，判据统一收在 classifierMayApprove。
          // 它返回 false 的三类确认都不交给分类器：
          //   - dangerousCommand / destructiveTool（硬编码危险命令 / MCP 自报破坏性）
          //   - classifierApprovable:false 的 safetyCheck（hooks / commands / settings）
          //   - **用户显式写的 ask 规则**（M1b）：写了 ask 就是要人看，
          //     分类器同意等于把用户规则静默降级成 allow
          if (!classifierMayApprove(result.decisionReason)) {
            const reasonTag =
              result.decisionReason?.type === "rule"
                ? `rule:${result.decisionReason.behavior}`
                : String(result.decisionReason?.type);
            autoFallback = result.decisionReason?.type === "rule" ? "ask-rule" : "safety-guard";
            log.info(
              "PERMISSION",
              `${req.toolName}(${resource.slice(0, 80)}) → auto 不放行该确认(${reasonTag})`,
            );
          } else {
            const classifyResult = await toolClassifier.classify({
              toolName: req.toolName,
              input: (req.input || {}) as Record<string, unknown>,
              cwd: this.workspacePath,
              classifierInput,
              // M1：路径归属由 PathValidator 算好传下去，fastPath 只认结论（不自己判断）
              pathVerdict: this.classifyPathVerdict(req),
              // M1b：工作区外读写 / 可执行代码路径必须由分类器看上下文，零成本快路径退场
              skipFastPath: shouldSkipFastPath(result.decisionReason),
            });
            // PR0：先取「分类器说了什么」的事实，放行与回退共用同一份——分两处手写会让
            // 「fast-path 多带了 classifier_ms / llm-safe 忘了带 risk」这种漂移没有门禁能发现。
            autoClassifyFacts = autoClassifyFactsOf(classifyResult);
            if (!classifyResult.classifierUnavailable && classifyResult.safe) {
              log.info(
                "PERMISSION",
                `${req.toolName}(${resource.slice(0, 80)}) → 允许(auto 模式分类器批准: ${classifyResult.reason})`,
              );
              this.denialTracking = recordSuccess(this.denialTracking, req.toolName, resource);
              this.audit(req, {
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
                // PR0（C1）：**放行也要留痕**。此前这条路径直接 return、不带 metadata，
                // 于是「auto 档到底自动放行了多少次」在轨迹与审计里都是空白 —— 只能靠
                // 反推（没弹窗的调用），而反推分不出「分类器批的」与「规则直放的」。
                // `via` 决定枚举值：`fast-path` = 一分钱没花，`llm-safe` = 花了一次请求买来的结论。
                metadata: {
                  autoClassifier: classifyResult.via === "fast-path" ? "fast-path" : "llm-safe",
                  ...autoClassifyFacts,
                },
              };
            }
            // 分类器判不安全或不可用：落到下方正常确认流程（needsConfirmation）
            autoFallback = classifyResult.classifierUnavailable ? "unavailable" : "unsafe";
            log.info(
              "PERMISSION",
              `${req.toolName} → auto 模式分类器未放行(${classifyResult.reason})，回退人工确认`,
            );
          }
        } catch (err: any) {
          log.warn("PERMISSION", `auto 模式分类器异常(${err.message})，回退人工确认`);
          autoFallback = "error";
          // PR0：理由用异常消息本身，而不是「分类器异常」这个常量 —— 超时 / 401 /
          // 模型返回结构变更三种情况的处置完全不同，常量会让它们在盘上长得一样。
          // 只进本地轨迹（collector 落 classifier_reason，上传前由 LOCAL_ONLY 剥掉）。
          autoClassifyFacts = {
            classifierReason: truncateClassifierReason(String(err?.message ?? "分类器异常")),
          };
        }
      }
      // 分类器不可用或未放行 → 返回 needsConfirmation，让上层三路竞争/用户弹窗处理
      result = {
        ...result,
        metadata: { ...result.metadata, autoClassifier: autoFallback, ...autoClassifyFacts },
      };
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
        // 同 headless：decisionReason 被换成 mode，闸门标签另行保留（子代理多走这一支）
        ...guardMetadata(result),
      };
      this.audit(req, {
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

    // 无头会话的本地记账工具不在这里特殊处理：B14 之后由工具的
    // `requiresPermission()` 声明在**阶段一**的 Step 13.6 就放行了（早于本函数），
    // 那张 `HEADLESS_LOCAL_LEDGER_TOOLS` 名单随之删除——名单必然漂移，
    // `task_get` / `task_list` / `think` 从来没被列进去过。

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
        // B20：decisionReason 被换成 type=other，阶段一的危险确认成因（A2 注入校验器 /
        // A6 展开超限）随之丢失。把闭集标签带到 metadata，轨迹 guard 字段才取得到。
        ...guardMetadata(result),
      };
      this.audit(req, {
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
  /**
   * 只读 git 的「执行边界」判定（B1/B2/B4）。
   *
   * `BashTool.checkPermissions` 只回答「这条命令是不是只读」，不回答「这个只读 git 作用在
   * 谁的仓库上」。而裸仓库形态目录里的 `git status` 会执行目录 `config` 指定的
   * `core.fsmonitor`，所以只读放行之前还要过这一道：
   * - 命令起始目录在工作区内；
   * - 每个 git 段的实际目录（含 `-C` 目标、段内字面量 `cd` 链）属于本仓（linked worktree 算本仓）；
   * - 剥掉本仓 `-C` 之后整条命令仍逐段只读，前导变量赋值照 B1 白名单复核。
   *
   * 命令里没有 git 段时返回 `applicable: false`，调用方沿用工具自身的判定。
   */
  private async evaluateReadOnlyGitBoundary(
    req: PermissionRequest,
  ): Promise<ReadOnlyGitBoundaryResult> {
    if (!isCommandSemanticsRequest(req)) return { applicable: false, allowed: false };
    const cmd = (req.input as { command?: unknown })?.command;
    if (typeof cmd !== "string" || !cmd.trim()) return { applicable: false, allowed: false };

    // 起始 cwd 与 resolveBashWriteTargets 同一口径：input.cwd → 全局 cwd（cd 会被回写）→ 工作区根
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

    return judgeReadOnlyGitInOwnRepo({
      command: cmd,
      startCwd: baseCwd,
      ownCommonDir: this.ownCommonGitDir,
    });
  }

  /**
   * 工作区内 `cd` + 只读主体的复合命令判定（B3）。
   *
   * 与 `evaluateReadOnlyGitBoundary` 的分工：那个管「只读 git 作用在谁的仓库上」，
   * 本方法管「`cd` 之后主体还是不是只读」。两者都只在**工具自己判非只读**时才被问到
   * （否则前者由 Step 5.5 的 allow 路径、后者根本不需要介入）。
   *
   * 判不准一律 `readOnly: false` —— 方向是多问一次，不是多放一条。
   */
  private async evaluateReadOnlyCompoundBash(
    req: PermissionRequest,
  ): Promise<ReadOnlyCompoundResult> {
    if (!isCommandSemanticsRequest(req)) return { applicable: false, readOnly: false };
    const cmd = (req.input as { command?: unknown })?.command;
    if (typeof cmd !== "string" || !cmd.trim()) return { applicable: false, readOnly: false };

    // 起始 cwd 与 resolveBashWriteTargets / evaluateReadOnlyGitBoundary 同一口径：
    // input.cwd → 全局 cwd（cd 会被回写）→ 工作区根
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

    return judgeReadOnlyCompoundBash({
      command: cmd,
      startCwd: baseCwd,
      ownCommonDir: this.ownCommonGitDir,
      isWithinWorkingDirectories: (p) => this.pathValidator.isWithinWorkingDirectories(p),
      resolveRealPath: (p) => this.pathValidator.resolveRealPath(p),
    });
  }

  /**
   * 工具级「只读放行」的统一出口：plan / deny-write 硬约束 + 日志 + allow。
   *
   * Step 5.5 的工具级 allow 与 B2 的只读 git 补回**都走这里**。两处各写一遍模式判据迟早
   * 会漂移，而漂移的后果是 plan / deny-write 被打穿（P0-3 那条教训：工具说「我是只读」
   * 只能跳过默认 ask，不能跳过模式硬约束）。
   */
  private allowAtToolLevel(
    req: PermissionRequest,
    filePath: string,
    resource: string,
    source: string,
    tool?: Tool,
  ): Decision {
    const log = getLogger();
    if (this.config.permissionMode === "plan") {
      return this.checkPlanMode(req, filePath, resource, tool);
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
    log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(${source})`);
    return { allowed: true };
  }

  /**
   * Step 5.5b / 5.6b：只读命令的读路径工作区校验（B5）
   *
   * ## 为什么需要这一步
   *
   * 只读命令在 Step 5.5 / 5.6 被自动放行，此前它们的**路径参数**没人看：
   * - `cat /etc/hosts`（工作区外）静默放行——「读通常安全」这个假设并不成立；
   * - `cat ../README.md`（工作区内，cwd=<ws>/packages）反倒被 Step 2 的「路径遍历」
   *   文本正则拦成危险确认。
   *
   * 两个方向都和 CC 不一致。CC 的做法是解析路径参数、按工作目录判定，没有文本层面的 `../`
   * 规则（`filesystem.ts` 的 pathValidation）。
   *
   * ## 判据
   *
   * 按**该段有效 cwd** 解析（cd 复合命令用 `readonly-compound` 给出的 `stages`），
   * 然后走 `pathValidator.validateAccess(path, "read")`：
   * - 在工作区内 → 放行；
   * - 工作区外 → 普通确认（`pathValidation`，不是危险样式），确认框可给
   *   「本会话允许读取 <目录>」把 `Read(<目录>/**)` 写进会话规则，同目录下次不再问；
   * - 敏感文件 / 系统目录 / symlink 逃逸 → **不在这里处理**，交回现有规则。这一层只补
   *   「工作区外」这一类，同一路径两套结论最难归因。
   *
   * 返回 null = 通过（无读路径 / 全在工作区内 / 命中 J4 豁免 / 命中 Read 规则）。
   */
  private async evaluateReadOnlyReadPaths(
    req: PermissionRequest,
    stages?: ReadOnlyCompoundStage[],
  ): Promise<Decision | null> {
    const cmd = (req.input as { command?: string })?.command;
    if (typeof cmd !== "string" || !cmd.trim()) return null;

    const targets = collectReadOnlyReadPaths({
      command: cmd,
      startCwd: await resolveBashCwdForCheck(req),
      stages,
      resolveRealPath: (p) => this.pathValidator.resolveRealPath(p),
    });
    if (targets.length === 0) return null;

    const isSidSelfRead = createSidSelfReadPathFilter();
    const outside: string[] = [];
    for (const target of targets) {
      // J4：sid 自己让模型去读的文件（任务输出 / 计划 / 会话工具输出）不打扰用户。
      // 用绝对路径判，`cat ~/.sid-code/tasks/x.output` 与展开后的写法一视同仁。
      if (isSidSelfRead(target.abs)) continue;
      // 传绝对路径：validateAccess 内部按 process.cwd() 解析相对路径，而这里的相对路径
      // 已经按 bash 的实际 cwd（可能被 cd 改过）解析过了，再让它 resolve 一次会跑偏。
      const verdict = this.pathValidator.validateAccess(target.abs, "read");
      if (verdict.allowed) continue;
      // 只处理「不在工作目录集合内」这一类。敏感文件 / 系统目录 / Unicode 混淆 / symlink
      // 逃逸这些已经是 Step 2 危险命令层与裸路径校验的职责（`cat ~/.ssh/id_rsa` 在
      // Step 2 就被拦成危险确认），同一路径两套结论最难归因，这里不重复下结论。
      //
      // ⚠️ 不能用 `verdict.outsideWorkingDirs` 当判据：白名单非空时 `validateAccess`
      // 在「目录不在白名单中」那一步就返回了，那个字段只在**白名单为空**时才被置位
      // （实测：`allowedDirectories: [ws]` 下工作区外路径全部漏判成放行）。
      if (this.pathValidator.isWithinWorkingDirectories(verdict.resolvedPath)) continue;
      // 会话/持久 Read 规则（`Read(<目录>/**)`）命中 → 放行。这是「本会话允许读取 <目录>」
      // 的落地形态：同一个目录只问一次。
      if (this.isReadPathCoveredByReadRule(verdict.resolvedPath, req)) continue;
      outside.push(verdict.resolvedPath);
    }
    if (outside.length === 0) return null;

    const unique = [...new Set(outside)];
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `只读命令读取工作区外文件: ${unique.join(", ")}`,
      decisionReason: {
        type: "pathValidation",
        reason: `读取路径在工作区外: ${unique.join(", ")}`,
      },
      // suggestedReadDir 给确认框的「本会话允许读取 <目录>」用：取第一个越界路径的父目录，
      // 用户点它就把该目录写进会话级 `Read(<目录>/**)` 规则。
      metadata: { outsideReadPaths: unique, suggestedReadDir: path.dirname(unique[0]!) },
    };
  }

  /**
   * 会话/持久 allow 规则里的 `Read(...)` 是否覆盖该路径。
   *
   * bash 读路径不会被 `checkAllowRules` 命中：那条链路按 `req.toolName`（bash）匹配，
   * `Read(...)` 规则的工具名对不上。所以这里单独取一遍 allow 里的读类规则，
   * 用与文件工具相同的 `matchPathRule` 口径比对——这样「本会话允许读取 <目录>」
   * 与用户在 settings 里手写 `Read(//data/**)` 走的是同一套解析。
   */
  private isReadPathCoveredByReadRule(absPath: string, req: PermissionRequest): boolean {
    const allow = this.rules?.allow ?? [];
    if (allow.length === 0) return false;
    const ctx = this.buildPathRuleContext(req);
    for (const raw of allow) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*(?:\((.*)\))?\s*$/.exec(raw);
      if (!m) continue;
      if ((m[1] ?? "").toLowerCase() !== "read") continue;
      const pattern = (m[2] ?? "").trim();
      if (!pattern) return true; // 裸 `Read` = 所有读取放行
      if (matchPathRule(pattern, absPath, ctx)) return true;
    }
    return false;
  }

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
    // B5：「路径遍历」文本正则只对**非只读**命令保留（J3）。
    // 只读命令的路径参数由 Step 5.5b/5.6b 按 cwd 解析后判，见 `evaluateReadOnlyReadPaths`。
    // 只在命令真的含 `../` 时才去算「是不是只读」——否则每条 bash 都多跑一次复合判定。
    const skipPathTraversal =
      /\.\.[/\\]/.test(cmd) &&
      (isReadOnlyCommand(cmd) || (await this.evaluateReadOnlyCompoundBash(req)).readOnly);
    const hard = this.hardcodedDangerCheck(expansion, await resolveBashCwdForCheck(req), cmd, {
      skipPathTraversal,
    });

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
        `${req.toolName}(${cmd.slice(0, 80)}) → 需确认(注入防护: ${injectionFinding.id}${
          injectionFinding.scope ? `/${injectionFinding.scope}` : ""
        })`,
      );
      return {
        allowed: false,
        reason: `[injection:${injectionFinding.id}] ${injectionFinding.message}: ${cmd.slice(0, 80)}`,
        needsConfirmation: true,
        decisionReason: {
          type: "dangerousCommand",
          pattern: `injection:${injectionFinding.id}`,
          // A4：severity 从 finding 透传，不再硬编码 "high"。
          // 注入校验的语义是「值得看一眼」（ask），与 rm -rf / 那种「确定危险」
          // 不是一级；硬编码 high 会让遥测分不开两类，也把升级路径堵死。
          severity: injectionFinding.severity,
        },
        metadata: {
          classifiedBy: "injection-validator",
          injectionId: injectionFinding.id,
          // 命中位于 heredoc 脚本正文（`bash <<EOF` 的正文）时标出来，
          // 否则轨迹里只看得到 `bash <<EOF` 这一行，不知道可疑的是正文哪段。
          ...(injectionFinding.scope ? { injectionScope: injectionFinding.scope } : {}),
        },
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

    if (!isCommandSemanticsRequest(req)) {
      return checkRules(askRules, req, pathCtx);
    }

    // monitor 的 command 按 bash 规则名匹配（§5.4.6：`Bash(gh pr checks:*)` 同样生效）
    const ruleReq = commandRuleRequest(req);
    // 与 deny 同口径：逐「等价执行形态」匹配（见 checkDenyRules 注释与 shell-command-variants.ts）
    const command = (req.input as { command?: string })?.command ?? "";
    for (const variant of expandShellCommand(command).variants) {
      const subReq: PermissionRequest = {
        ...ruleReq,
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
  /**
   * skip 档下仍然生效的「用户写下的拒绝」：deny 规则 → `disallowedTools` → 会话记忆里的 deny。
   * 三者都是人明确表达过的意图；命中返回 deny（`mode` 由 check() 出口统一补成 skip），否则 null。
   * 刻意**不**含 Step 2 危险命令 / Step 4 敏感路径 / Step 6 safetyCheck——见调用处注释。
   */
  private checkUserDenyUnderSkip(
    req: PermissionRequest,
    resource: string,
    options?: PermissionCheckOptions,
  ): Decision | null {
    let denied: Decision | null = null;
    const ruleDecision = this.checkDenyRules(req);
    if (ruleDecision && !ruleDecision.allowed) {
      denied = {
        ...ruleDecision,
        decisionReason: { type: "rule", rule: ruleDecision.reason || "", behavior: "deny" },
        step: "skip-deny-rule",
      };
    } else if (isToolNameListed(this.config.disallowedTools, req.toolName)) {
      denied = {
        allowed: false,
        reason: `工具 "${req.toolName}" 已被禁用`,
        decisionReason: { type: "other", reason: "工具已被禁用" },
        step: "skip-disallowed",
      };
    } else {
      const memKey = this.getMemoryKey(req);
      if (memKey && this.sessionMemory.get(memKey) === false) {
        denied = {
          allowed: false,
          reason: "会话内已拒绝过同一操作",
          decisionReason: { type: "sessionMemory" },
          step: "skip-memory-deny",
        };
      }
    }
    if (!denied) return null;
    getLogger().info(
      "PERMISSION",
      `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(skipPermissions 下仍尊重用户拒绝: ${denied.step})`,
    );
    this.denialTracking = recordDenial(
      this.denialTracking,
      req.toolName,
      denied.reason || "",
      resource,
    );
    this.audit(req, {
      timestamp: new Date().toISOString(),
      type: "tool_use",
      tool: req.toolName,
      resource,
      decision: "deny",
      reason: denied.reason,
      decisionReason: denied.decisionReason,
      ...(options?.auditSource ? { source: options.auditSource } : {}),
    });
    return denied;
  }

  /**
   * M8：skip 档下仍然生效的「用户写下的询问」。
   *
   * skip 只跳过「系统认定的危险」（Step 2 危险命令 / Step 4 敏感路径 / Step 6 safetyCheck），
   * 不跳过「用户要求我确认一下」——ask 规则与 deny 规则是一对，都是人明确表达过的意图
   * （04 剖析 5.7 用户拍板的选项 B 写着「不跳过用户写下的拒绝」，ask 是它的姊妹）。
   *
   * 修前这里只查 deny：`ask: ["Bash(git push*)"]` 在 skip 下静默执行，而 default 档
   * 同一份规则会弹确认——同一条配置在不同模式下的含义被悄悄改写了。
   *
   * 命中后交互模式返回 `needsConfirmation`（由 tool-executor 弹窗）；无头模式返回 deny。
   * 为什么无头要在这里落一次：skip 早退排在阶段二的 headless 分支**之前**，走不到那个
   * 统一落点。文案与它保持同一形状（含「重试相同输入不会改变结果」，否则模型会原样重发），
   * 并带上规则原文——模型要知道是哪条配置拦的，才改得动命令。
   */
  private checkUserAskUnderSkip(req: PermissionRequest): Decision | null {
    const ruleDecision = this.checkAskRules(req);
    if (!ruleDecision || ruleDecision.allowed || !ruleDecision.needsConfirmation) return null;
    const resource = String(extractFilePath(req) || (req.input as any)?.command || "");
    const ruleText = ruleDecision.reason || "";
    if (this.isNonInteractive()) {
      const nonInteractive: Decision = {
        allowed: false,
        reason: `非交互模式下自动拒绝（skip 模式命中用户 ask 规则，无人可确认）：${ruleText}`,
        decisionReason: {
          type: "other",
          reason: `非交互模式下自动拒绝（无人可确认，重试相同输入不会改变结果）：skip 模式命中用户 ask 规则 ${ruleText}`,
        },
        step: "skip-ask-rule",
      };
      getLogger().info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → 拒绝(skip 模式命中 ask 规则，无头无法确认)`,
      );
      this.denialTracking = recordDenial(
        this.denialTracking,
        req.toolName,
        nonInteractive.reason || "",
        resource,
      );
      this.audit(req, {
        timestamp: new Date().toISOString(),
        type: "tool_use",
        tool: req.toolName,
        resource,
        decision: "deny",
        reason: nonInteractive.reason,
        decisionReason: nonInteractive.decisionReason,
      });
      return nonInteractive;
    }
    getLogger().info(
      "PERMISSION",
      `${req.toolName}(${resource.slice(0, 80)}) → 需确认(skipPermissions 下仍尊重用户 ask 规则)`,
    );
    return {
      ...ruleDecision,
      decisionReason: { type: "rule", rule: ruleDecision.reason || "", behavior: "ask" },
      step: "skip-ask-rule",
    };
  }

  private checkDenyRules(req: PermissionRequest): Decision | null {
    if (!this.rules) return null;
    const denyRules = { deny: this.rules.deny, allow: [], ask: [] };
    const pathCtx = this.buildPathRuleContext(req);

    // 非命令语义工具：保持原整条匹配语义（文件类工具走路径前缀解析）
    if (!isCommandSemanticsRequest(req)) {
      return checkRules(denyRules, req, pathCtx);
    }
    // monitor 的 command 按 bash 规则名匹配：deny 规则 `Bash(curl *)` 对它同样拦
    const ruleReq = commandRuleRequest(req);

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
        ...ruleReq,
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

    // 非命令语义工具：保持原整条匹配语义（文件类工具走路径前缀解析）
    if (!isCommandSemanticsRequest(req)) {
      return checkRules(allowRules, req, pathCtx);
    }
    // monitor 的 command 按 bash 规则名匹配：allow 规则 `Bash(gh pr checks:*)` 同样放行
    const ruleReq = commandRuleRequest(req);

    const command = (req.input as { command?: string })?.command ?? "";
    const subCommands = splitCompoundCommand(command);

    // 单命令（无 &&/||/;/| 复合）：等价于原逻辑，直接整条匹配
    if (subCommands.length <= 1) {
      return checkRules(allowRules, ruleReq, pathCtx);
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
        ...ruleReq,
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
    originalCommand: string,
    opts?: { skipPathTraversal?: boolean },
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

    // 1a''. 命令替换：按**位置**判，不按「有没有」判。
    //   命令位 / 参数即代码 → high；参数位 → 不报，内层命令已作为独立 variant
    //   过完整套判定（下面第 1b 步）。放在 structural 与 privilege 之后：
    //   `echo $(rm -rf /)` 仍按内层 critical 硬拒，`sudo $(cat cmd)` 仍报「sudo 命令」。
    const substitution = detectCommandSubstitutionDanger(expansion, originalCommand);
    if (substitution) return substitution;

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
        // B5：只读命令不再跑「路径遍历」文本正则。
        //
        // 这条正则是文本层面的 `../` 计数，判不出「相对路径解析后落在哪」：
        // cwd=<ws>/packages 时 `cat ../README.md` 的目标是 `<ws>/README.md`（工作区内，
        // CC 不问），它却判成危险确认；反过来工作区外的绝对路径（`cat /etc/hosts`）
        // 它一条都不命中。修法是把判定换成 Step 5.5b/5.6b 的读路径校验——
        // 按该段有效 cwd 解析后判是否在工作区内。
        //
        // 只对**判为只读**的命令跳过（J3）：非只读命令（`python3 ../x.py`）上的
        // `../` 仍按原样报危险确认，那一半本轮不动。
        if (opts?.skipPathTraversal && dp.name === "路径遍历") continue;
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
  private checkPlanMode(
    req: PermissionRequest,
    filePath: string,
    resource: string,
    tool?: Tool,
  ): Decision {
    const log = getLogger();

    // 只读工具直接放行
    if (READ_ONLY_TOOLS.has(req.toolName)) {
      log.info("PERMISSION", `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan模式+只读工具)`);
      return { allowed: true };
    }

    // M4：bash 的**只读命令**放行。
    //
    // plan 的承诺是「不改任何东西」，而 `git log` / `git diff` / `git status` /
    // `ls -la` / `rg foo` 不写任何东西。此前这里只认 READ_ONLY_TOOLS 名单，bash 不在
    // 名单里，于是规划阶段最常用的几条命令全被拒，模型只能改用 read/grep/glob 绕路，
    // 或者干脆少看——这与 plan「先摸清楚再动手」的目的相反。
    //
    // 四条约束（改动时不要破）：
    // 1. **只放 bash，不放 monitor**：monitor 的子进程是裸 spawn，不经沙箱
    //    （与上面沙箱自动放行那段同一个理由，见 `shouldAutoAllowBash` 的注释）。
    // 2. **只认 `isReadOnlyCommand`**：不用 `isReadOnlyIgnoringCd`（它的注释明确写着
    //    「不许拿去做权限放行」），也不用 allow-composition 的组合规则（那是给 allow
    //    规则匹配复合命令用的，口径不同）。
    // 3. **不挪位置**：这里是 Step 5.5（工具级 allow）与 Step 9（出口总闸
    //    `enforceModeHardConstraint`）共同的落点，两者都排在 Step 1（deny 规则）/
    //    Step 2（危险命令）/ Step 4（路径）/ Step 5（ask 规则）之后。所以
    //    `cat ~/.ssh/id_rsa`、`env`、`cat ../x` 仍在 Step 2 被拦，放行面不比 default 宽。
    // 4. **不在 `enforceModeHardConstraint` 里另写一份判断**：那里调的就是本函数，
    //    改一处两处生效；写两份必然漂移。
    if (req.toolName === "bash" && tool) {
      const command = (req.input as { command?: unknown } | undefined)?.command;
      if (typeof command === "string" && isReadOnlyCommand(command)) {
        // 这一支**只在 Step 5.5 的路径上才安全**，判据就是 `tool` 参数在不在：
        //
        // - Step 5.5（工具级 allow）→ 本函数由 `allowAtToolLevel` 调，前面刚跑过
        //   `evaluateReadOnlyReadPaths`，`cat /etc/passwd` 那类「读工作区外文件」已被拦成确认。
        // - Step 9（出口总闸）→ 本函数由 `enforceModeHardConstraint` 调，**前面没有那道检查**。
        //   2026-11-15 实测：不加这个 `&& tool`，`plan + cat /etc/passwd` 会在这里被放行，
        //   而 `default` 下它需要确认——那就比 default 宽了，违反 M4 的硬约束。
        //
        // 所以「只读命令放行」的资格来自**工具自己确认过**（Step 5.5 已判只读并校验过读路径），
        // 权限层不替它猜。不传 tool 的调用（测试 / 嵌入 / SDK）退回原拒绝，方向是多拒一条，
        // 不是多放一条。
        log.info("PERMISSION", `bash(${resource.slice(0, 80)}) → 允许(plan模式+只读bash命令)`);
        return { allowed: true };
      }
    }

    // Plan Mode 专用工具放行
    if (PLAN_MODE_EXTRA_TOOLS.has(req.toolName)) {
      if (req.toolName === "sub_agent") {
        // 与执行层同一个取值入口（sub-agent-input.ts）：plan 模式拦的必须是实际会跑的类型，
        // 否则 subagent_type=explore + type=general-purpose 能让写类子代理混过 plan 模式。
        const subType = resolveSubAgentTypeParam(req.input);
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

    // B14：工具自报「我不需要权限」→ plan 模式同样放行。
    //
    // plan 是「代码级强制只读」，本来就不该拦记账类工具（`todo_write` / `task_*` /
    // `think`）——它们不改工作区。此前靠 `PLAN_MODE_EXTRA_TOOLS` 逐个点名，名单外的
    // 工具一律拒，于是 plan 会话里连「记一条 todo」都做不了。
    //
    // **必须放在 `PLAN_MODE_EXTRA_TOOLS` 之后**：`sub_agent` 也在那张表里，而它有一道
    // 「plan 下只许 explore」的硬约束。放前面会让 `sub_agent(type: "general-purpose")`
    // 用免权限声明直接跳过那次检查——一个工具同时属于两套判据时，严的那套必须先生效。
    if (declaredNoPermission(tool, req.input)) {
      log.info(
        "PERMISSION",
        `${req.toolName}(${resource.slice(0, 80)}) → 允许(plan模式+免权限工具)`,
      );
      return { allowed: true, decisionReason: { type: "other", reason: "工具声明不需要权限" } };
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
      // 文案要点出「墙在哪里」：只写「只允许只读操作」时模型会反复试 bash（2026-08-29
      // headless Note 的教训：拒绝不解释边界，模型只会盲试）。括号里给出合法样例，
      // 且样例必须是 `isReadOnlyCommand` 真会放行的那几条，写错等于重新制造盲试。
      reason: "计划模式下只允许只读操作（bash 只允许只读命令，如 git log / ls / rg）",
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

/**
 * 「命令语义」工具判定：bash 本身 + monitor 的 command（M1，§5.4.6）。
 *
 * monitor 的 `command` 是 shell 脚本，必须走 **bash 同一条权限管线**：命令规则
 * `Bash(gh pr checks:*)` 对它同样生效、deny 规则同样拦、危险命令 / safetyCheck /
 * 沙箱策略全部复用。不另开口子，也不在工具侧复制一套规则匹配——复制必然漂移，
 * 本仓「两套尺子」的教训已多次（`isAwaitedBackgroundTask` 与 wait-registry 那次）。
 *
 * 判据要求 input 上确有非空 `command`：monitor 的 schema 校验失败时 checker 仍可能
 * 被调用，此时按「非命令工具」处理，落到后续步骤给出正常的参数错误。
 */
function isCommandSemanticsRequest(req: PermissionRequest): boolean {
  if (req.toolName === "bash") return true;
  if (req.toolName !== "monitor") return false;
  const command = (req.input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && command.length > 0;
}

/**
 * 规则匹配视角的请求：monitor 的 command 必须按 **bash** 的规则名匹配。
 *
 * `checkRules` 用 `req.toolName` 与规则名（归一到内部名）比较，而 monitor 的 toolName
 * 是 `monitor` —— 规则 `Bash(gh pr checks:*)` 就永远命中不了。这里只**为匹配**把名字换成
 * `bash`：执行视图、审计视图（`PermissionDecision.tool_name`）仍是原始的 `monitor`，
 * 两者不混淆（§5.4.6 要求审计能区分来源）。
 */
function commandRuleRequest(req: PermissionRequest): PermissionRequest {
  return req.toolName === "monitor" ? { ...req, toolName: "bash" } : req;
}
