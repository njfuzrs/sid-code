/**
 * 低信息量空转检测（P1-4 item 3）：从"催"改为"给具体下一步"
 *
 * 背景（会话 20260810-214525-2df54593，13:55:30 – 14:04:14 窗口）：
 * 模型 8 分 44 秒、约 30 轮、edit 次数 = 0，唯一动作是反复跑同一条命令 33 次：
 *
 *   cd <repo> && bunx tsc --noEmit 2>&1 | grep -c "error TS"
 *
 * 返回值序列 `139 ×22 → 136 ×7 → 113 ×9`。**每轮花约 6 秒拿回一个数字**，得不到任何
 * 可执行信息，于是只能再想一遍策略——这是由"低信息量观测"驱动的稳定死循环。
 * 对照组 CC 跑同一任务时的形态是 `cmd > /tmp/e.txt 2>&1; wc -l /tmp/e.txt; grep <域> /tmp/e.txt`
 * ——每轮既拿到总数又拿到这一批要处理的具体错误行，错误数单调递减 267→60→…→21。
 * 同样是"重复跑 tsc"，一个每次都拿到下一步动作，一个每次只拿到一个数字。
 *
 * ─── 为什么必须新写一道检测，而不是调已有阀门的阈值 ───
 *
 * 修复方案 §4.4 item 3 把落点写在 `agent/loop-detection.ts`，但那里**默认全局关闭**
 * （记忆 loop-detection-default-off-empirical-basis：shape 误判率≈100%、exact 召回≈0），
 * 落在那里等于写死代码。而唯一默认开启的 `repeated-readonly-guard` 对本形态**完全失明**——
 * 实测 `isReadOnlyCommand("bunx tsc --noEmit 2>&1 | grep -c \"error TS\"")` = **false**
 * （含管道 + `bunx` 不在只读白名单），`isReadonlyProbeCommand` 随之为 false，
 * 这 33 次空转一次都进不了那道阀。所以缺的不是阈值，是这个形态的检测本身。
 *
 * ─── 判据（四条 AND，刻意极窄）───
 *
 * 1. 本轮**没有任何文件落盘**（edit/write/notebook_edit）——有落盘就是在干活，不是空转；
 * 2. 本轮**没有面向用户的文本产出**，只有 thinking + 工具调用——即"只思考不交付"；
 * 3. 本轮的命令签名与上一轮**逐字节相同**（同一条命令、同样的入参）；
 * 4. 该命令的输出是**单个标量**（`grep -c` / `wc -l` 只回一个数字）**且与上一轮相同**。
 *
 * 第 4 条是与 `repeated-readonly-guard` 的关键分工：那道阀盯"只读探查命令 + 输出不变"，
 * 本阀盯"**输出信息量本身就低**（单标量）+ 不变"。低信息量是本次死循环的成因——
 * 输出是完整错误列表时，反复跑虽然浪费但模型至少每轮都拿到可执行信息，不构成认知死锁。
 * 判据用"输出形态"而非命令名，故不硬编码 tsc（换 cargo check / pytest 同样命中）。
 *
 * 介入话术给**可执行指令**而非训话：这是本项的核心。事故里模型自己已经说了 8 次
 * "我需要停止反复思考，直接开始修复"——它不缺决心，缺的是"下一条命令该敲什么"。
 * 再催一遍"请推进"只会加重空转，故文案直接给出落盘 + 计数 + 切片的替代命令。
 *
 * 设计原则：纯函数 + 纯数据，副作用留在 loop.ts，便于单测。
 */

import { extractScalarMetric } from "./measured-progress.ts";

/**
 * 判定"低信息量空转"所需的连续轮数。取 5（方案 §4.4 建议值）：
 * 比 repeated-readonly-guard 的 3 更宽松，因为本阀不要求命令是只读白名单成员，
 * 覆盖面更广，宁可多给两轮自我纠正机会也不误伤"跑构建等结果"这类正当重复。
 */
export const LOW_YIELD_SPIN_THRESHOLD = 5;

/** 介入提醒的注入次数上限。达上限后沉默——本阀**绝不**强制收尾。 */
export const MAX_LOW_YIELD_INTERVENTIONS = 2;

/** 本轮观测（由 loop.ts 从工具批次归纳后传入）。 */
export interface TurnObservation {
  /** 本轮执行的命令签名列表（命令原文，按调用顺序）。 */
  commands: string[];
  /** 与 commands 一一对应的输出。 */
  outputs: string[];
  /** 本轮是否有文件落盘（edit/write/notebook_edit）。 */
  hadFileMutation: boolean;
  /** 本轮是否有面向用户的文本产出（assistant text，非 thinking）。 */
  hadTextOutput: boolean;
}

/** 跨轮累积状态（挂 LoopState）。 */
export interface LowYieldSpinState {
  /** 上一轮的"命令⊕输出"签名。 */
  lastSignature?: string;
  /** 该签名连续重复的轮数。 */
  repeatTurns: number;
  /** 已注入介入提醒的次数（封顶用）。 */
  interventionCount: number;
}

export function createLowYieldSpinState(): LowYieldSpinState {
  return { repeatTurns: 0, interventionCount: 0 };
}

/** 决策结果。 */
export interface LowYieldDecision {
  /** 是否判定为低信息量空转。 */
  spinning: boolean;
  /** 是否应当本轮注入介入提醒（已达封顶时为 false）。 */
  intervene: boolean;
  /** 命中的命令（用于文案）。 */
  command?: string;
  /** 该命令的（单标量）输出（用于文案）。 */
  output?: string;
  /** 连续重复轮数（用于日志/埋点核对阈值）。 */
  repeatTurns: number;
}

/**
 * 归一化"命令⊕输出"签名。空白折叠，避免尾随换行造成伪差异。
 * 分隔符用转义写法 `\x1f`（US），理由同 repeated-readonly-guard.makeSignature：
 * 源码里出现裸控制字节会让 grep 把整个文件判为二进制而静默跳过。
 */
function signatureOf(obs: TurnObservation): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return obs.commands.map((c, i) => `${norm(c)}\x1f${norm(obs.outputs[i] ?? "")}`).join("\n");
}

/**
 * 本轮是否具备"低信息量"形态：至少有一条命令，且**每一条**的输出都是单标量。
 *
 * 要求"每一条"而非"任一条"是刻意的：一轮里既跑了 `grep -c` 又跑了完整错误列表时，
 * 模型已经拿到了可执行信息，不是认知死锁，不该介入。
 */
function isLowInformationTurn(obs: TurnObservation): boolean {
  if (obs.commands.length === 0) return false;
  return obs.commands.every((_, i) => extractScalarMetric(obs.outputs[i] ?? "") !== null);
}

/**
 * 观测本轮，更新计数并给出决策。
 *
 * 清零条件（任一成立即"有进展/有交付"，不算空转）：
 *   - 有文件落盘；
 *   - 有面向用户的文本产出；
 *   - 本轮不具备低信息量形态；
 *   - 签名与上一轮不同（跑了新命令 / 输出变了 —— 后者正是"世界在变"的证据）。
 *
 * `interventionCount` **不**随清零重置：它是本条用户消息内的封顶预算，
 * 由 loop 在新一条用户消息（新 LoopState）时重建。与 repeated-readonly-guard 同纪律。
 */
export function observeLowYieldTurn(
  state: LowYieldSpinState,
  obs: TurnObservation,
): LowYieldDecision {
  if (obs.hadFileMutation || obs.hadTextOutput || !isLowInformationTurn(obs)) {
    state.lastSignature = undefined;
    state.repeatTurns = 0;
    return { spinning: false, intervene: false, repeatTurns: 0 };
  }

  const sig = signatureOf(obs);
  if (sig === state.lastSignature) {
    state.repeatTurns++;
  } else {
    state.lastSignature = sig;
    state.repeatTurns = 1;
    return { spinning: false, intervene: false, repeatTurns: 1 };
  }

  if (state.repeatTurns < LOW_YIELD_SPIN_THRESHOLD) {
    return { spinning: false, intervene: false, repeatTurns: state.repeatTurns };
  }

  const command = obs.commands[obs.commands.length - 1];
  const output = obs.outputs[obs.outputs.length - 1] ?? "";
  if (state.interventionCount >= MAX_LOW_YIELD_INTERVENTIONS) {
    // 已注满：保持沉默。**刻意不强制收尾**——本阀的判据比 repeated-readonly-guard 宽
    // （不限于只读白名单命令），误伤代价可能是掐断一个正当的"轮询等构建"长任务。
    // 强制收尾这个最激进的动作只留给那道被实证证明会死锁的 git-status 阀。
    return { spinning: true, intervene: false, command, output, repeatTurns: state.repeatTurns };
  }
  state.interventionCount++;
  return { spinning: true, intervene: true, command, output, repeatTurns: state.repeatTurns };
}

/**
 * 构建介入提醒（经 reminderParts 注入 user 消息，仅本轮、不落历史、缓存友好）。
 *
 * 文案纪律：**给可执行指令，不训话**。事故里模型自己已连说 8 次"我要停止反复思考、
 * 直接动手"，可见它不缺决心而缺"下一条命令敲什么"。所以这里给出的是完整可粘贴的
 * 替代命令（落盘 → 计数 → 按域切片），并明确点出"该命令只回一个数字，无法指导下一步"
 * 这个根因——让模型理解为什么要换，而不是被要求"别再跑了"。
 *
 * @param command     反复执行的命令原文
 * @param output      它的（单标量）输出
 * @param repeatTurns 已连续重复轮数
 */
export function buildLowYieldSpinReminder(
  command: string,
  output: string,
  repeatTurns: number,
): string {
  const cmd = command.trim();
  const value = output.trim() || "(无输出)";
  // 从原命令里剥出"计数管道"之前的主体，拼一条落盘版建议。
  // 取不到就退回占位符 `<你的检查命令>`——宁可给个明确要替换的占位，
  // 也不要猜错命令误导模型（猜错的具体命令比占位符更危险）。
  const body = extractCommandBody(cmd);
  const base = body || "<你的检查命令>";

  return [
    "<system-reminder>",
    `你已连续 ${repeatTurns} 轮执行同一条命令且返回值未变（当前仍是 ${value}）：\`${cmd}\``,
    "**这条命令只返回一个计数，拿不到任何可执行信息**——它无法告诉你该改哪个文件的哪一行，" +
      "所以反复跑它不会让你更接近完成，只会让你重新想一遍策略。这正是你现在在做的事。",
    "",
    "请改用「落盘 + 计数 + 切片」三步，一次拿到总数**和**这一批要处理的具体条目：",
    "```bash",
    `${base} > /tmp/check.txt 2>&1`,
    "wc -l /tmp/check.txt          # 总数（等价于你原来那个计数）",
    "head -50 /tmp/check.txt       # 看清具体条目，据此决定先改哪个文件",
    "```",
    "拿到具体条目后**按文件分批直接改**（edit/write），改完再跑一次上面的命令对比总数。",
    "同形的批量改写可以写一个脚本一次到位，并让脚本报告哪条没匹配上，避免静默漏改。",
    "不要再重复执行原命令，也不要再重新规划——现在就读 /tmp/check.txt 并开始编辑。",
    "</system-reminder>",
  ].join("\n");
}

/**
 * 从"检查命令 | 计数命令"里剥出检查主体（管道左侧第一段）。
 *
 * 只做最保守的一件事：按 `|` 切，取第一段，并去掉 `cd x &&` 前缀之外原样保留
 * （含 `2>&1` 这类重定向——保留它才能让落盘版同时捕获 stderr，而类型检查器的错误
 * 通常正走 stderr，丢了它落盘文件会是空的）。取不到有效主体返回空串。
 */
export function extractCommandBody(command: string): string {
  const firstSegment = command.split("|")[0]?.trim() ?? "";
  if (!firstSegment) return "";
  // 去掉 `cd <path> &&` / `VAR=v ` 前缀，保留真正执行的检查命令。
  let s = firstSegment;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/, "").trim();
    s = s.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/, "").trim();
  } while (s !== prev);
  return s;
}
