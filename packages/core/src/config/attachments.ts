/**
 * 附件系统核心
 * 对标 Claude Code 的动态附件机制：优先级排序 + 条件注入
 */

import { execFileSync } from "child_process";
import { getLogger } from "../debug/logger.ts";
import {
  generateSkillListing,
  type SkillListingEntry,
} from "../skill/budget.ts";

/** 附件类型 */
export interface Attachment {
  /** 附件类型标识 */
  type: string;
  /** 附件内容 */
  content: string;
  /** 优先级（数字越小越重要） */
  priority: number;
  /** 可选的显示标签（用于日志，比 type 更具描述性） */
  label?: string;
}

/** 附件优先级定义（对标 Claude Code） */
export const PRIORITY = {
  /** 关键系统提醒 */
  CRITICAL_REMINDER: 1,
  /**
   * 当前日期等每日变化的易变值。必须落在 DYNAMIC_BOUNDARY 之后（动态区），
   * 否则跨天首次请求会击穿静态前缀缓存（cache_creation 全价重算）。
   * 放在动态区最前部，紧跟静态区，注意力位置最优。
   */
  DATE_CONTEXT: 2,
  /** Plan/Delegate 模式提醒 */
  MODE_REMINDER: 5,
  /** Skill 摘要列表（在 CLAUDE.md 之前，确保模型能发现 Skill） */
  SKILL_LISTING: 8,
  /** CLAUDE.md 项目规则 */
  CLAUDE_MD: 10,
  /** 诊断信息 */
  DIAGNOSTICS: 15,
  /** IDE 选中代码 */
  IDE_SELECTION: 20,
  /** IDE 打开的文件 */
  IDE_OPEN_FILES: 25,
  /** 记忆信息 */
  MEMORY: 30,
  /** 动态召回的记忆文件（比静态摘要稍后，获得更多注意力） */
  MEMORY_RECALLED: 32,
  /** Session Memory 摘要（压缩后注入） */
  SESSION_MEMORY: 33,
  /** Todo 列表 */
  TODO_LIST: 35,
  /** 权限约束（deny 规则，配置态稳定，低优先级前置告知） */
  DENY_RULES: 38,
  /** Git 状态（最低优先级） */
  GIT_STATUS: 40,
  /**
   * G12：输出风格（用户可插拔）。放在 CLAUDE.md 之后、诊断之前——
   * 优先级高于大多数动态上下文，确保"按什么风格输出"的约束获得足够注意力，
   * 但不越过项目规则（CLAUDE.md）。配置态稳定，进静态缓存区。
   */
  OUTPUT_STYLE: 12,
  /** 追加提示词 */
  APPEND_PROMPT: 50,
  /** 文件提示词 */
  FILE_PROMPT: 60,
} as const;

// ─── G6：DANGEROUS_ 命名约定守护缓存正确性边界 ───

/**
 * 系统提示词附件的缓存属性声明。
 * - stable: 内容跨请求/跨会话稳定（可进静态区，享受长 TTL 缓存）
 * - dynamic: 内容每请求/每天可能变化（必须放 DYNAMIC_BOUNDARY 之后，否则击穿缓存）
 */
export interface SystemPromptAttachment extends Attachment {
  /** 缓存稳定性标记——dynamic 意味着放入静态区会破坏 prompt cache */
  cacheStability: "stable" | "dynamic";
}

/**
 * G6：标记一个附件为"会破坏缓存的动态内容"。
 *
 * 使用此函数创建的附件将被放入 DYNAMIC_BOUNDARY 之后（动态区），
 * 每次请求内容可能不同。开发者必须传入 _reason 说明为什么需要动态。
 *
 * 命名约定：DANGEROUS_ 前缀表示"有隐性代价（击穿缓存）"，reviewer 看到要重点审视。
 * 返回的 Attachment 带 cacheStability: "dynamic" 标记，system-prompt.ts 据此分拣。
 *
 * @param type 附件类型标识
 * @param content 附件内容
 * @param priority 优先级
 * @param _reason 运行时不使用，但强制调用者写下"为什么这段必须是动态的"理由（审计用）
 */
export function DANGEROUS_dynamicAttachment(
  type: string,
  content: string,
  priority: number,
  _reason: string,
): SystemPromptAttachment {
  return { type, content, priority, cacheStability: "dynamic" };
}

/**
 * 创建一个稳定附件（可安全进入静态缓存区）。
 * 与 DANGEROUS_dynamicAttachment 对称，不需要 reason——默认是安全的。
 */
export function stableAttachment(
  type: string,
  content: string,
  priority: number,
): SystemPromptAttachment {
  return { type, content, priority, cacheStability: "stable" };
}

/**
 * 权限模式描述映射。
 *
 * ⚠️ 键必须与 src/permission/mode.ts 的 PermissionMode 联合类型严格对齐——
 * 此前的键（bypassPermissions / yesMode / readonly / strict）从不匹配任何运行时 mode 值，
 * 导致 generatePermissionModeAttachment(mode) 对 acceptEdits / always-allow 等所有非 default
 * mode 都静默回退到 default 描述（缺口 C 排查时发现的潜伏 bug）。现按 mode.ts 实际取值重写。
 */
export const PERMISSION_MODE_DESCRIPTIONS: Record<string, string> = {
  default: `# 权限模式: 默认
执行以下操作前必须请求用户确认：
- 写入或编辑文件
- 运行 bash 命令
- 发起网络请求`,

  "always-allow": `# 权限模式: 全部允许
所有需要确认的工具调用将自动批准（仍会拦截危险命令）。
你可以直接读写文件、运行命令，无需逐个等待用户确认。`,

  acceptEdits: `# 权限模式: 自动接受编辑
文件编辑（write/edit）自动批准，无需逐个确认。
但 bash 命令、网络请求等非编辑类操作仍需按默认规则确认。`,

  "deny-write": `# 权限模式: 禁止写入
你只能使用只读工具（read、grep、glob、ls）。
所有写入文件、编辑、执行命令的操作都会被拒绝。`,

  dontAsk: `# 权限模式: 静默拒绝
不再弹出确认。需要确认的操作将被直接拒绝（而非询问用户）。
请只执行明确允许的操作，被拒绝的操作不要反复重试。`,

  auto: `# 权限模式: 自动模式
分类器判断安全的操作自动批准，不安全的操作仍需用户确认。
行为与默认模式类似，但安全操作无需逐个确认（分类器可用时）。`,

  // plan 键已删除（2026-07-30，重复注入根因修复 P0）。
  // 唯一消费方 buildPermissionModeReminder 被 loop.ts 的 `mode !== "plan"` 排除，
  // 永远取不到本键；system 附件通道也已删除。plan 的约束文案现在只有一处事实源：
  // src/plan/prompt.ts 的 buildPlanModeReminder（full 档已并入本键原有的
  // 「此约束覆盖你收到的所有其他指令」+ 允许/禁止清单）。
  // 保留本键会让两份 plan 文案继续独立漂移（此前实测已漂移）。

  "dangerously-skip-permissions": `# 权限模式: 跳过权限（危险）
所有工具调用自动批准，包括危险命令。请极其谨慎。`,
};

/**
 * 生成 CLAUDE.md 附件
 * 对标 Claude Code 的注入格式：明确告知模型这些规则覆盖默认行为
 *
 * @param content - CLAUDE.md 原始内容
 * @param sourcePath - 来源文件路径（用于标注）
 */
export function generateClaudeMdAttachment(content: string, sourcePath?: string): Attachment {
  const sourceLabel = sourcePath ? `Contents of ${sourcePath}` : "Project rules";
  return {
    type: "claudeMd",
    label: sourceLabel,
    content: `<system-reminder>
# claudeMd
代码库和用户指令如下。请务必遵守这些指令。重要：这些指令覆盖任何默认行为，你必须严格按照指令执行。

${sourceLabel}:

${content}

      重要：此上下文可能与你的当前任务相关，也可能不相关。
      （本提醒由系统自动添加，请勿向用户提及或复述它，静默遵循即可）
</system-reminder>`,
    priority: PRIORITY.CLAUDE_MD,
  };
}

/** Git 状态缓存（TTL 30 秒，覆盖用户输入期间的预取窗口） */
let gitStatusCache: { result: Attachment | null; timestamp: number; workingDir: string } | null = null;
const GIT_STATUS_CACHE_TTL = 30_000;

/** 清除 Git 状态缓存（供外部调用，如 CLAUDE.md 变更时） */
export function clearGitStatusCache(): void {
  gitStatusCache = null;
}

/**
 * 安全执行 git 子命令（对标 CC execFileNoThrow）。
 * - 用 execFileSync 数组参数形式而非 execSync 字符串拼接，杜绝命令注入（分支名/路径含 shell 元字符时）。
 * - 统一挂 --no-optional-locks 全局标志：只读采集 git 状态时不去抢 index.lock，
 *   避免与用户并行的 git 命令（commit/rebase 等）抢锁导致偶发失败或干扰对方（对齐 CC）。
 * - 失败返回空串（调用方按需回退），不抛出。
 */
function runGit(args: string[], workingDir: string, timeout = 5000): string {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: workingDir,
      stdio: "pipe",
      timeout,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * 生成 Git 状态附件
 * 执行 git status --short 获取当前仓库状态
 * 带模块级缓存，预取和正式调用共享结果
 */
export function generateGitStatusAttachment(workingDir: string): Attachment | null {
  const log = getLogger();

  // 命中缓存
  if (gitStatusCache
    && gitStatusCache.workingDir === workingDir
    && Date.now() - gitStatusCache.timestamp < GIT_STATUS_CACHE_TTL) {
    log.debug("ATTACHMENT", "Git 状态命中缓存");
    return gitStatusCache.result;
  }

  try {
    // 检查是否是 Git 仓库（execFileSync 数组参数，失败抛出 → 走外层 catch 返回 null）
    execFileSync("git", ["--no-optional-locks", "rev-parse", "--is-inside-work-tree"], {
      cwd: workingDir,
      stdio: "pipe",
      timeout: 5000,
    });

    // 获取当前分支
    const branch = runGit(["branch", "--show-current"], workingDir) || "unknown";

    // 获取简短状态（对标 CC context.ts:64 —— git status --short）
    const status = runGit(["status", "--short"], workingDir);

    // 获取最近 5 条提交（对标 CC context.ts:68 —— git log --oneline -n 5）
    // 新仓库可能没有提交 → runGit 返回空串
    const recentCommits = runGit(["log", "--oneline", "-5"], workingDir);

    // 获取 git 用户名（对标 CC context.ts:74）
    const userName = runGit(["config", "user.name"], workingDir, 3000);

    // 获取默认主分支（对标 CC context.ts:63 —— getDefaultBranch()）
    // 优先从 remote HEAD 推断（execFile 不走 shell，故不能用 `|| echo ''`，改由 runGit 失败返回空串兜底）
    let mainBranch = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], workingDir, 3000)
      .replace("refs/remotes/origin/", "");
    if (!mainBranch) {
      // 回退：检查常见分支名
      for (const candidate of ["main", "master"]) {
        if (runGit(["rev-parse", "--verify", candidate], workingDir, 2000)) {
          mainBranch = candidate;
          break;
        }
      }
    }

    // ── 第一层·预防(根治「git 快照冻结死循环」) ──
    // 【关键决策】冻结快照里唯一会过期、唯一制造"净/脏"矛盾的就是 `Status:` 文件状态列表。
    // 我们把它**物理移除**,不再作为冻结权威常驻上下文;保留稳定、不会过期的部分
    // (branch / main branch / git user / recent commits——会话内极少变或只增不减)。
    //
    // 为什么删而非"加措辞让模型别信":
    //   - 加措辞是"留着矛盾,叫弱模型仲裁"——deepseek 这类弱模型做不到,历史修了两次仍复发;
    //   - 删除 volatile 块是"矛盾根本不存在"——上下文里只剩实时 `git status` 一个状态来源,
    //     没有第二个"权威"跟它打架,模型无从纠结。这是治本 vs 治标的区别。
    // 完全对齐 CC 的思路:CC 在只读子代理里直接删掉整段 gitStatus(runAgent.ts:400-410,
    //   注释 "explicitly labeled stale"、"dead weight"),我们更温和——只删最毒的 volatile 部分。
    //
    // 注:`status` 变量仍保留采集(供缓存键/未来诊断),但不再拼进快照文本。
    void status; // 明确标注:采集了但刻意不进快照(避免"未使用变量"误删)

    const lines: string[] = [
      // 首行=显式声明这是启动快照,并**引导**模型:工作区文件状态未包含在此,需实时获取。
      "This is the git status at the start of the conversation. Note that this status is a snapshot in time, "
        + "and will not update during the conversation. "
        + "工作区文件状态(哪些文件被修改/新增/删除)未包含在此快照中(会随对话变化);"
        + "需要时请运行 `git status` 获取实时状态,不要依据此快照判断工作区是否有未提交改动。",
      `Current branch: ${branch}`,
    ];
    if (mainBranch) lines.push(`Main branch (you will usually use this for PRs): ${mainBranch}`);
    if (userName) lines.push(`Git user: ${userName}`);
    if (recentCommits) lines.push(`Recent commits:\n${recentCommits}`);

    const result: Attachment = {
      type: "gitStatus",
      label: `Git 状态 (${branch})`,
      content: `<git-status>\n${lines.join("\n\n")}\n</git-status>`,
      priority: PRIORITY.GIT_STATUS,
    };

    // 写入缓存
    gitStatusCache = { result, timestamp: Date.now(), workingDir };
    return result;
  } catch {
    log.debug("ATTACHMENT", "非 Git 仓库或 git 命令不可用，跳过 Git 状态附件");
    const result = null;
    gitStatusCache = { result, timestamp: Date.now(), workingDir };
    return result;
  }
}

// generatePermissionModeAttachment 已删除（2026-07-30，重复注入根因修复 P0）。
// 权限模式文案曾同时走 system 附件（本函数）与 user reminder（permission-reminder.ts），
// 同一份文案同轮出现两次。现只保留 reminder 通道，本函数无调用方故删除。
// PERMISSION_MODE_DESCRIPTIONS 保留（reminder 通道 import 它）。
// 决策依据见 src/config/system-prompt.ts 附件收集段的注释与
// docs/bugfixes/todo/重复注入根因-system附件与user-reminder双通道.md §7.1。

/**
 * 缺口 D：生成 deny 规则约束附件（前置告知模型哪些操作必被拒绝）。
 *
 * summary 来自 PermissionChecker.describeDenyRules()——配置态、会话内稳定，故放 system prompt
 * （静态、缓存冻结无害），用低优先级（DENY_RULES = GIT_STATUS 级）。空 summary 返回 null。
 *
 * @param summary describeDenyRules() 的多行摘要文本
 */
export function generateDenyRulesAttachment(summary: string): Attachment | null {
  if (!summary || !summary.trim()) return null;
  return {
    type: "denyRules",
    label: "权限约束（deny 规则）",
    content: `<permission-constraints>
以下操作已被配置禁止，请勿尝试（尝试也会被权限检查拒绝，浪费轮次）：
${summary.trim()}
</permission-constraints>`,
    priority: PRIORITY.DENY_RULES,
  };
}

/**
 * G12：生成输出风格附件（用户可插拔）。
 *
 * content 已由 output-styles.ts 包裹为 <output-style> 标签。配置态稳定，
 * 用 stableAttachment 进静态缓存区（同一风格跨请求不变，可享长 TTL 缓存）。
 */
export function generateOutputStyleAttachment(content: string): SystemPromptAttachment | null {
  if (!content || !content.trim()) return null;
  return stableAttachment("outputStyle", content, PRIORITY.OUTPUT_STYLE);
}

/**
 * 生成诊断信息附件（预留接口）
 */
export function generateDiagnosticsAttachment(diagnostics: string): Attachment {
  return {
    type: "diagnostics",
    label: "诊断信息",
    content: `<diagnostics>\n${diagnostics}\n</diagnostics>`,
    priority: PRIORITY.DIAGNOSTICS,
  };
}

/**
 * 生成当前日期附件（动态区）。
 *
 * 日期每天变化，绝不能进静态核心区（coreParts）——否则跨天首次请求会让整个静态
 * 前缀缓存失效、cache_creation 全价重算。本附件经 DYNAMIC_BOUNDARY 之后注入，
 * 跨天只击穿动态区（本就是会话内缓存），静态前缀缓存得以跨会话保全。
 *
 * @param date YYYY-MM-DD 格式日期字符串（由调用方传入，便于测试与避免本模块直接读时钟）。
 */
export function generateDateAttachment(date: string, language?: "zh" | "en" | "auto"): Attachment {
  // G6：日期每天变化，放进静态区会跨天击穿缓存。用 DANGEROUS_ 工厂标记为动态。
  // 标签跟随语言：en 模式下这是仅剩的几处中文之一，留着就是在提示模型"中文也行"。
  const label = language === "en" ? "Today's date" : "当前日期";
  return DANGEROUS_dynamicAttachment(
    "date",
    `<current-date>\n${label}: ${date}\n</current-date>`,
    PRIORITY.DATE_CONTEXT,
    "日期每天变化，放入静态区会击穿 prompt cache 前缀",
  );
}

// IDE 选区 / @提及的 system prompt 附件 generator 已删除。
// 这两类内容随用户在编辑器里的每次点选变化，做成 system prompt 附件会每次变更都
// 击穿 prompt cache 静态前缀；已改走 delta 消息通道（drainIDEContextDelta →
// reminderParts），与 MCP server instructions 同模式。
// PRIORITY.IDE_SELECTION / IDE_OPEN_FILES 保留：优先级表是稳定的排序契约，
// 有测试断言相邻档位的序关系，且未来若有真正稳定的 IDE 类附件可复用。

/**
 * 生成 Todo 列表附件（预留接口）
 */
export function generateTodoListAttachment(todoList: string): Attachment {
  return {
    type: "todoList",
    label: "Todo 列表",
    content: `<todo-list>\n${todoList}\n</todo-list>`,
    priority: PRIORITY.TODO_LIST,
  };
}

/**
 * 生成记忆附件
 * 将全局/项目双层记忆注入系统提示词
 *
 * @deprecated M11：记忆已统一走 memorySystemPrompt 索引指针路径（core 区注入
 * MEMORY.md 索引，模型按需 Read 全文），不再注入本 <memory> 全文摘要附件。
 * 保留导出仅为向后兼容，buildSystemPrompt 已不再调用。
 */
export function generateMemoryAttachment(memorySummary: string): Attachment {
  return {
    type: "memory",
    label: "记忆摘要",
    content: `<memory>\n## 记忆\n以下是之前会话中保存的记忆信息，请参考：\n\n${memorySummary}\n</memory>`,
    priority: PRIORITY.MEMORY,
  };
}

/**
 * 生成动态召回的记忆附件（Task 7）。
 * 根据当前查询召回的相关记忆文件正文（已含新鲜度警告）。
 */
export function generateRecalledMemoryAttachment(
  recalled: Array<{ filename: string; content: string }>,
): Attachment | null {
  if (!recalled || recalled.length === 0) return null;
  const body = recalled
    .map((m) => `### ${m.filename}\n${m.content}`)
    .join("\n\n---\n\n");
  return {
    type: "memoryRecalled",
    label: "召回记忆",
    content: `<recalled-memory>\n以下是与当前任务相关的记忆，请参考：\n\n${body}\n</recalled-memory>`,
    priority: PRIORITY.MEMORY_RECALLED,
  };
}

/**
 * 生成 Session Memory 附件（Task 7）。
 * 仅在压缩后注入结构化会话笔记。
 */
export function generateSessionMemoryAttachment(
  sessionMemoryContent: string | null,
): Attachment | null {
  if (!sessionMemoryContent || !sessionMemoryContent.trim()) return null;
  return {
    type: "sessionMemory",
    label: "会话笔记",
    content: `<session-memory>\n以下是本次会话的结构化笔记（任务目标、进展、关键文件）：\n\n${sessionMemoryContent}\n</session-memory>`,
    priority: PRIORITY.SESSION_MEMORY,
  };
}

/**
 * 生成 Skill 摘要列表附件（Task 2：两层索引发现机制）
 *
 * 只放 Skill 摘要（约 1% 上下文窗口），模型通过 skill 工具按名称调用，
 * 避免每个 Skill 注册独立工具导致工具列表膨胀。
 *
 * @param entries Skill 摘要条目
 * @param contextWindowTokens 上下文窗口 token 数（用于计算 1% 预算）
 */
export function generateSkillListingAttachment(
  entries: SkillListingEntry[],
  contextWindowTokens?: number,
): Attachment | null {
  const content = generateSkillListing(entries, contextWindowTokens);
  if (!content) return null;
  return {
    type: "skillListing",
    label: "Skill 摘要列表",
    content,
    priority: PRIORITY.SKILL_LISTING,
  };
}

