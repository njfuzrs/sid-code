/**
 * 无进展只读命令重复检测 + git-status 刷新止损阀
 *
 * 背景（根因分析-commit任务git状态快照冻结死循环.md，会话 20260710-164407）：
 * git-status 快照在会话初始化时冻结进 system prompt，整会话不刷新。当模型连续 3 次
 * /commit 把脏工作区提交干净后，冻结快照仍显示"10 个文件待处理"，与 bash 实时
 * `git status --short` 返回的"(空)"长期矛盾。弱模型（deepseek-v4-pro）无法仲裁这对
 * 方向相反的事实源，在一个已经干净的工作区上反复空跑 `git status --short` 11 轮直到
 * 用户 ESC——任务其实早已 100% 完成。
 *
 * 本模块是"方向 2/3/4/6"的统一落地（合并同源缺口，避免四套割裂机制）：
 *   - 方向 2（git-status 每轮刷新）：检测到卡在只读 git 命令上时，把**实时**的 git 状态
 *     经 reminderParts 注入 user 消息（cache-safe，不碰 system prompt 静态前缀，不打断
 *     prompt cache 前缀——对标 deepseek-cache-prefix-split 记忆的约束）。
 *   - 方向 6（无进展硬熔断止损阀）：识别"连续 N 轮相同只读命令 + 输出稳定不变"，注入
 *     收敛提示；达上限后强制收尾（yield done），而非无限空转到用户 ESC。
 *   - 方向 4（幂等收尾任务终止锚点）：当卡住的命令是 git status 且实时工作区干净时，
 *     提醒里明确"实时 git status 已干净 = 任务已完成，请直接 end_turn，勿再确认"。
 *
 * 设计纪律（对齐 reminder-throttle.ts + 项目记忆 reminder-nag-replay-hallucination）：
 *   - 去重 + 封顶：提醒最多注入 MAX_STUCK_REMINDERS 次，之后强制收尾，不刷"幻影用户消息"。
 *   - 纯检测逻辑做成纯函数，便于单测；副作用（注入/收尾）留在 loop.ts。
 *   - 默认全局启用：与 loop-detection（默认关，靠 shape 易误判）不同，本阀只盯"完全相同
 *     命令 + 完全相同输出"这一极窄且高确定性的模式，误伤面极小，故默认开。
 */

import { isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";

/** 判定"卡住"所需的连续相同 (命令,输出) 次数。取 3：给模型两次自我纠正机会后才介入。 */
export const STUCK_REPEAT_THRESHOLD = 3;

/**
 * 只读探查类工具名单（非 bash 的纯只读检查工具）。
 *
 * ★根治「git 快照冻结死循环」缺口 B(§4.2/§3b)：历史死循环里模型是
 *   `git status`(bash) → `read×3` → `git status` 交替空转,而旧逻辑把"本轮出现任何
 *   非 bash-probe 工具(含 read)"一律当"有进展"清零,连续计数永远到不了阈值。
 * 修复思路:把这些**纯只读检查工具**也折叠进 probe 签名(工具名+入参 → 输出),
 *   而非当成进展信号。这样"反复 read 同一区域且返回相同内容"会与 git status 一起
 *   构成稳定的复合签名,只有**写操作**或**输出不同的新探查**才算真进展、才清零。
 * 名单刻意收窄到无副作用的检查工具;write/edit/notebook_edit/todo_write/task_* 等
 *   有产出的工具不在内,它们出现即视为有进展。
 */
export const READ_FAMILY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "read_many",
  "ls",
  "glob",
  "grep",
  "lsp",
]);

/** 判断一个工具名是否属于"纯只读检查工具"(见 READ_FAMILY_TOOLS 注释)。 */
export function isReadFamilyTool(name: string): boolean {
  return READ_FAMILY_TOOLS.has(name);
}

/**
 * 把一次只读检查工具调用归一化成可比签名的"命令"文本(工具名 + 稳定序列化的入参)。
 *
 * 例:read {file_path:/a, offset:585} → `read {"file_path":"/a","offset":585}`。
 * 入参不同(如 offset 变了)→ 命令文本不同 → 签名不同 → 视为"新探查"而清零;
 * 完全相同的入参反复调用 → 命令文本相同 → 与输出一起构成稳定签名 → 计入空转。
 *
 * 入参键排序后序列化,避免键序抖动造成的伪差异;序列化失败兜底为工具名。
 */
export function makeToolProbeCommand(name: string, input: unknown): string {
  let inputStr = "";
  try {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const obj = input as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const ordered: Record<string, unknown> = {};
      for (const k of sortedKeys) ordered[k] = obj[k];
      inputStr = JSON.stringify(ordered);
    } else {
      inputStr = JSON.stringify(input ?? null);
    }
  } catch {
    inputStr = "";
  }
  return inputStr ? `${name} ${inputStr}` : name;
}

/**
 * 剥离命令前导的 `cd <路径> &&|;` 与 `VAR=值 ` 前缀,取真正执行的命令主体。
 *
 * ★根治「git 快照冻结死循环」缺口 A(§4.1/§3a)：本次真实死锁的命令**全是带 `cd` 前缀
 *   的复合命令**(如 `cd /a/b && git status --short`),而含 `&&` 的复合命令会被
 *   isReadOnlyCommand 判为非只读(cd 不在只读白名单),整条链被排除,止损阀零触发。
 * 修复:先把 `cd .../VAR=val` 前缀剥掉再判定主体。**关键**:剥离后仍对主体跑
 *   isReadOnlyCommand,故 `cd x && rm y` 的主体 `rm y` 仍被判非只读而排除——只放行
 *   "cd 到某目录后执行纯只读探查"这一种,不会误纳带副作用的复合命令。
 *
 * 反复剥离以处理 `cd a && cd b && git status`、`FOO=1 cd x && git status` 等多重前缀。
 */
export function stripLeadingCdAndEnv(command: string): string {
  let s = command.trim();
  let prev: string;
  do {
    prev = s;
    // 环境变量赋值前缀:VAR=value （值可带引号）
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/, "").trim();
    // cd <arg> 后跟 && 或 ;（arg 可带引号）
    s = s.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/, "").trim();
  } while (s !== prev);
  return s;
}

/** 注入收敛提醒的次数上限。达上限后强制收尾，不再刷提醒。 */
export const MAX_STUCK_REMINDERS = 2;

/** 只读命令重复检测的运行时状态（挂在 loop state 上，跨轮累积）。 */
export interface RepeatedReadonlyState {
  /** 上一轮命中的只读命令签名（命令文本 ⊕ 输出文本的归一化拼接）。 */
  lastSignature?: string;
  /** 当前签名连续重复的次数。 */
  repeatCount: number;
  /** 已注入收敛提醒的次数（封顶用）。 */
  reminderCount: number;
}

/** 创建初始状态。 */
export function createRepeatedReadonlyState(): RepeatedReadonlyState {
  return { repeatCount: 0, reminderCount: 0 };
}

/**
 * 判断一条命令是否是"只读、无副作用、反复跑不改变世界"的探查类命令。
 *
 * 只有这类命令反复跑才构成"空转"——写操作（git commit / add）反复跑是另一回事，
 * 不在本阀管辖内（那是真的在改状态）。命中范围刻意收窄到高频探查命令，宁可漏报不误报。
 *
 * 两道关卡（AND，缺一不可）：
 *   1. 复用 bash 工具的 AST 级 isReadOnlyCommand——它能正确识别写入重定向（`git log > f`）、
 *      管道、`&&` 链里的写操作、`sed -i` 等**带副作用**的形式，把它们判为非只读。
 *      仅靠正则会把 `git log > file.txt`、`ls && rm x` 误判为只读，这道关卡堵死该类误伤。
 *   2. 命令主体匹配窄化的探查白名单——只盯 git status/diff/log 这类"死锁高发、天天被空跑"
 *      的命令，避免把所有只读命令（含一次性的 grep/find 大范围检索）都纳入止损，缩小误伤面。
 */
export function isReadonlyProbeCommand(command: string): boolean {
  // ★缺口 A 修复(§4.1/§3a)：先剥离 `cd .../VAR=val` 前缀,取真正执行的命令主体,
  // 让"cd 到某目录后跑纯只读探查"这种**本次真实死锁的形态**也能进检测。
  const body = stripLeadingCdAndEnv(command);

  // 关卡 1：对**剥离前缀后的主体**跑 AST 级只读校验（含重定向/管道/剩余 && 链/sed -i
  // 等副作用识别）。这是安全阀:`cd x && rm y` 剥出主体 `rm y` 在此被判非只读而排除,
  // `cd x && git status && rm y` 剥出 `git status && rm y` 同样被排除——只有主体是
  // 纯只读命令时才可能通过,不会误纳任何带副作用的复合命令。
  if (!isReadOnlyCommand(body)) return false;

  // 关卡 2：窄化探查白名单。再去掉主体自身可能残留的环境变量赋值前缀,只看命令主体。
  const normalized = body
    .toLowerCase()
    .replace(/^[a-z_][a-z0-9_]*=[^\s]+\s+/, "")
    .trim();
  return (
    /^git\s+status\b/.test(normalized) ||
    /^git\s+diff\b/.test(normalized) ||
    /^git\s+log\b/.test(normalized) ||
    /^git\s+branch\b/.test(normalized) ||
    /^git\s+show\b/.test(normalized) ||
    /^(ls|pwd|cat|head|tail|stat)\b/.test(normalized)
  );
}

/**
 * 归一化一条 (命令, 输出) 为签名，用于判断"完全相同的探查又跑了一遍"。
 * 命令与输出都 trim + 折叠空白，避免尾随换行/空格造成的伪差异。
 */
export function makeSignature(command: string, output: string): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  // 分隔符用**转义写法** `\x1f`（US，单元分隔符）而非裸控制字节：语义比 NUL 更贴切
  // （它就是为"分隔字段"设计的），且 `\s` 不匹配它，norm 折叠空白时不会被吃掉。
  // ★为什么必须是转义写法：源码里出现**裸 NUL 字节**会让 `grep` 把整个文件判为二进制而
  // 静默跳过（exit=1 与"真的没匹配"不可区分），全文件所有符号都搜不到——2026-07-30 审计
  // 实测本文件正因此对 grep 完全失明，而它是唯一默认开启且能强制收尾的止损阀，最不该被
  // 搜索工具漏掉。改为转义后运行时行为等价，源码字节不含控制字符。
  return `${norm(command)}\x1f${norm(output)}`;
}

/** processObservation 的决策结果。 */
export interface StuckDecision {
  /** 是否已达到"卡住"阈值（连续相同 ≥ STUCK_REPEAT_THRESHOLD）。 */
  stuck: boolean;
  /** 卡住时，本次应当"注入提醒"还是"强制收尾"（已注满上限）。 */
  action: "none" | "remind" | "terminate";
  /** 命中卡住的命令原文（用于日志/提醒文案）。 */
  command?: string;
  /** 命中卡住的命令实时输出（用于提醒文案；空串表示无输出）。 */
  output?: string;
}

/**
 * 观测本轮执行的只读探查动作，更新卡住计数并给出决策。
 *
 * ★缺口 B 修复(§4.2/§3b)：probes 不再只含 bash 只读命令,还包含**纯只读检查工具**
 *   (read/ls/glob/grep/lsp,经 makeToolProbeCommand 归一化为 `工具名 入参` 文本)。
 *   这样"git status → read 同一区域 → git status"交替空转会构成稳定的复合签名而被计入,
 *   不再被交替的 read 清零。只有**真进展**才清零——判据收紧为:出现写操作/有产出工具
 *   (hadOtherActivity=true),或本轮探查签名与上一轮**不同**(输出变了/读了新区域)。
 *
 * @param state 跨轮状态（会被就地更新）
 * @param probes 本轮执行的只读探查动作列表：{ command, output } 数组
 *               （command 对 bash 是命令原文,对 read 家族工具是 makeToolProbeCommand 的归一化文本）
 * @param hadOtherActivity 本轮是否还有真进展信号（写操作/有产出工具/文本产出等）
 */
export function processObservation(
  state: RepeatedReadonlyState,
  probes: Array<{ command: string; output: string }>,
  hadOtherActivity: boolean,
): StuckDecision {
  // 有其它活动 = 有进展，重置。
  if (hadOtherActivity || probes.length === 0) {
    state.lastSignature = undefined;
    state.repeatCount = 0;
    // 注意：reminderCount 不清零——它是"本条用户消息内"的封顶预算，
    // 由 loop 在新一条用户消息（新 state）时重建，避免长任务里反复刷提醒。
    return { stuck: false, action: "none" };
  }

  // 本轮的复合签名：所有探查命令的签名按顺序拼接（多条命令也要完全一致才算"重复"）。
  const signature = probes.map((p) => makeSignature(p.command, p.output)).join("\n");

  if (signature === state.lastSignature) {
    state.repeatCount++;
  } else {
    state.lastSignature = signature;
    state.repeatCount = 1;
    return { stuck: false, action: "none" };
  }

  if (state.repeatCount < STUCK_REPEAT_THRESHOLD) {
    return { stuck: false, action: "none" };
  }

  // 已卡住。决定注入提醒还是强制收尾。
  // ★缺口 B 联动:折叠 read 家族后,一轮可能是复合探查 [git status, read...]。选一个
  //   "代表命令"用于提醒/收尾文案与 git 判定——优先挑批次里的 git status 探查(死锁主体),
  //   没有才退回最后一条。避免"last 恰好是 read 探查 → 永不 terminate"的漏判。
  const gitProbe = probes.find((p) => /git\s+status/.test(p.command.toLowerCase()));
  const representative = gitProbe ?? probes[probes.length - 1];
  if (state.reminderCount < MAX_STUCK_REMINDERS) {
    state.reminderCount++;
    return { stuck: true, action: "remind", command: representative.command, output: representative.output };
  }
  // 提醒已注满。是否升级到"强制收尾"要看命令类型：
  //   - git status 家族：正是文档记录的死锁模式（快照冻结 vs 实时矛盾），强制收尾是治本，放行。
  //   - 其它探查命令（ls/cat/pwd/read 等）：可能是合法的"轮询等待"（等构建产物、等异步任务），
  //     强制掐断风险更高。保守起见**只反复提醒、绝不强制收尾**，把决定权留给模型/用户。
  // 这样把"强制收尾"这个最激进的动作,收窄到唯一被实证证明会死锁的命令族。
  if (gitProbe) {
    return { stuck: true, action: "terminate", command: gitProbe.command, output: gitProbe.output };
  }
  // 非 git 探查：已注满提醒，之后保持沉默（不再刷提醒，也不强制收尾），避免刷屏。
  return { stuck: true, action: "none", command: representative.command, output: representative.output };
}

/**
 * 构建"卡在只读命令上"的收敛提醒文案（经 reminderParts 注入 user 消息）。
 *
 * 核心作用是给模型一个**实时、权威**的事实源，压制被冻结 system prompt 快照带偏的认知：
 *   - 明示"你在反复跑同一条命令、结果没变"；
 *   - 附上该命令的**实时输出**作为当前真相（覆盖 system prompt 里的启动快照）；
 *   - 若是 git status 且实时干净 → 给出"任务已完成，请直接 end_turn"的终止锚点（方向 4）。
 *
 * @param command 卡住的命令
 * @param output  该命令的实时输出（空串=无输出）
 * @param freshGitStatus 实时 git 状态块（可选，来自 generateGitStatusAttachment 重新抓取）
 */
export function buildStuckReminder(
  command: string,
  output: string,
  freshGitStatus?: string | null,
): string {
  const trimmedOutput = output.trim();
  // bash 工具会把空输出转成字面量 "(命令无输出)"（bash.ts），故干净工作区的
  // `git status --short` 实际返回的是这个哨兵而非空串——两者都要判为"无变更"。
  const isEmptyOutput = trimmedOutput === "" || trimmedOutput === "(命令无输出)";
  const isGitStatus = /git\s+status/.test(command.toLowerCase());
  const cleanWorkingTree = isGitStatus && isEmptyOutput;

  const lines: string[] = [
    "<system-reminder>",
    `你已连续多轮执行相同的只读命令且结果没有变化：\`${command.trim()}\`。`,
    `该命令的**实时输出**如下（这是当前的权威事实，优先于 system prompt 里会话启动时抓取的旧快照）：`,
    "```",
    trimmedOutput || "(命令无输出)",
    "```",
  ];

  if (cleanWorkingTree) {
    lines.push(
      "实时 `git status` 显示工作区已干净——没有待提交/待处理的变更。" +
        "system prompt 顶部的 `<git-status>` 块是**会话启动时的快照**，可能显示旧的待处理文件，" +
        "请**以上面的实时输出为准**。",
      "如果你的任务是提交/整理变更且工作区现已干净，说明任务**已经完成**，" +
        "请直接总结并结束（end_turn），**不要再反复确认或寻找不存在的活干**。",
    );
  } else {
    lines.push(
      "重复跑同一条命令不会带来新信息。请基于上面的实时输出直接下结论并推进，" +
        "或结束当前任务；不要再重复执行它。",
    );
  }

  if (freshGitStatus && freshGitStatus.trim()) {
    lines.push("", "供参考，实时 git 状态：", freshGitStatus.trim());
  }

  lines.push("</system-reminder>");
  return lines.join("\n");
}

/**
 * 构建"强制收尾"提示（已注满提醒上限仍在空转时，loop 强制 yield done 前的最后一条消息）。
 */
export function buildTerminateNotice(command: string): string {
  return (
    "<system-reminder>\n" +
    `已连续多轮空转于只读命令 \`${command.trim()}\` 且给出收敛提醒后仍无进展，` +
    "为避免无限循环，本轮强制结束。若确有后续工作，请在新的回复中明确下一步具体动作。\n" +
    "</system-reminder>"
  );
}
