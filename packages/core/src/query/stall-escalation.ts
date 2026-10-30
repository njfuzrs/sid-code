/**
 * 停滞升级阶梯（评估会话 20261020-110542-ce7ea52e 发现 2a/2c/2d/2e，§5 决策 1）
 *
 * ## 缺口是什么
 *
 * 那个会话 9 小时、1343 次 API 原地打转，125 次 nag、11 次返工提醒全被无视。现有防线
 * **到顶只会沉默**：进展判据是 stock（`filesChanged` 只增不减，第一次 edit 之后「无进展」
 * 就再也到不了）；TodoRework / UnchangedObservationRun 只提醒不升级；唯一的硬刹车只认
 * git status 家族。交互模式下真正的兜底只剩用户按 ESC。
 *
 * ## 本模块做什么
 *
 * 1. **进展判据改 flow**（2a）：`ProgressLedger` 记「文件 → 内容 hash」，「真实进展」=
 *    出现一个**此前从未出现过**的工作区 hash 组合；改回历史状态记为回退，不算进展。
 * 2. **绿点账本**（2c）：只解析白名单测试命令的汇总行（目前只有 bun test 的 `N pass / M fail`），
 *    记下全绿时的工作区 hash；绿后变红计一次回归。**解析不了就不计**——宁可少判，不误判。
 * 3. **升级阶梯**（2d）：L1 = 一次性收敛提示（走尾部 reminder 通道，不动前缀）；
 *    L2 = 由 harness 结束本轮、走 P1-1 强制总结出口交还用户。
 *
 * ## 判据边界（缺一条就是误伤源）
 *
 * - **L2 只能从 L1 升上来**，且只认已确证的信号：2b 振荡计数、UnchangedObservationRun、
 *   K 轮内无新文件改动。hash 回退与绿点回归**只喂 L1**，没验证过之前不许触发强停。
 * - **回退单独不升级**：「试一个方案 → 撤销」是合法实验，只计入信号，不单独构成 L1 理由。
 * - **等后台任务的轮次不计入 L2**：有运行中的后台任务（`run_in_background` 的 bash / 子代理）时，
 *   「工作区没变」是在等合法结果，不是原地打转。影子样本 `20261026-105558-84f153dd` 的 L2 正是
 *   命中在 29 轮轮询全量 bun test 的那一段，测试跑完后任务正常交付——那次真停就是误伤。
 *   这类轮次照样推进 L1 与停滞窗口（L1 只是一句提示，误发代价低），只是不计入 L2 的「L1 后满 K 轮」，
 *   本身也不触发 L2。等待轮数随事件落 `bgWaitTurns`，影子数据能复算排除前后的差。
 * - **默认影子**：L2 只落 `StallEscalation{level:2, acted:false}`，不真停；`stallHardStop`
 *   打开才真停（D3 按影子期抽检结论再决定默认值）。
 * - **只开在交互主循环**：headless 默认整套不开（评测基线可比性依赖行为不变），子代理走
 *   agentic-loop 不经过这里。
 *
 * 纯函数 + 纯数据（hash 计算由调用方注入读文件函数），副作用（注入 / 埋点 / 收尾）留在 loop.ts。
 */

import { createHash } from "node:crypto";

// ─── 阈值（全仓只此一份） ───

/** 连续多少个工具轮没出现新工作区状态，才进入「停滞」候选。 */
export const STALL_WINDOW_TURNS = 15;
/** L1 需要的停滞信号总数（振荡 + 空转 + 绿点回归 + 回退）。 */
export const STALL_L1_SIGNAL_THRESHOLD = 3;
/** L1 发出后再过多少轮仍停滞才升 L2（同一条用户消息内每升一次 L2 翻倍）。 */
export const STALL_L2_AFTER_L1_TURNS = 10;
/** todo 闸门联动（2e）：本份清单内振荡达到此值，不再劝「继续」。 */
export const STALL_GATE_OSCILLATION_THRESHOLD = 3;

// ─── 开关 ───

export interface StallEscalationSwitches {
  /** 整套阶梯是否启用（L1 + 2e + L2 影子） */
  enabled: boolean;
  /** L2 是否真停（false = 影子，只落事件） */
  hardStop: boolean;
}

/**
 * 解析开关。env 优先于 settings，判据刻意只认字面 "1"/"0"（与 SID_CODE_RESPONSES_REASONING_REPLAY 同口径）。
 *
 * @param isHeadless `config.print`。headless 默认不开：调用方本来就有 `--max-turns` 与预算，
 *   而 Harbor 评测的可比性依赖行为不变——默认开等于静默改了基线。
 */
export function resolveStallSwitches(
  isHeadless: boolean,
  settingsHardStop: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
): StallEscalationSwitches {
  const headlessOptIn = env.SID_CODE_STALL_ESCALATION_HEADLESS === "1";
  const enabled = env.SID_CODE_STALL_ESCALATION !== "0" && (!isHeadless || headlessOptIn);
  const envHardStop = env.SID_CODE_STALL_HARD_STOP;
  const hardStop =
    envHardStop === "1" ? true : envHardStop === "0" ? false : settingsHardStop === true;
  return { enabled, hardStop: enabled && hardStop };
}

// ─── 进展账本（2a） ───

/** 跨轮状态：挂 LoopState（每条用户消息重建 = 「用户回复后阶梯清零」）。 */
export interface StallState {
  /** 文件 → 最近一次内容 hash（null = 文件不存在/读不到） */
  fileHashes: Map<string, string | null>;
  /** 出现过的工作区 hash 组合 */
  seenStates: Set<string>;
  /** 本消息内工具轮计数 */
  toolTurns: number;
  /** 最近一次出现新工作区状态的工具轮 */
  lastNewStateTurn: number;
  /** 最近一次成功落盘（edit/write）的工具轮 */
  lastMutationTurn: number;
  /** 回退次数（改回历史状态） */
  rollbacks: number;
  /** 绿点回归次数（全绿后变红） */
  greenRegressions: number;
  /** 上一次测试结论：true=全绿，false=有失败，undefined=还没解析到 */
  lastTestGreen?: boolean;
  /** 最近一次全绿：工具轮 + 工作区 hash */
  lastGreen?: { turn: number; stateHash: string };
  /** 本消息内 UnchangedObservationRun 上报次数 */
  unchangedReports: number;
  /**
   * 上一次观测到的 2b 振荡计数（会话级 `TodoGateBudget.oscillations`）。只取它的**正增量**：
   * 换清单时那边会清零，直接相减会得负数，取 max 又会漏掉清零后重新累积的部分。
   */
  lastOscillationsObserved: number;
  /** 本消息内累计的振荡次数 */
  oscillationsInPrompt: number;
  /** L1 发出时的工具轮（undefined = 还没发过） */
  l1Turn?: number;
  /** 上一次 L2（含影子）或 L1 的基准：计入 L2 的工具轮（扣掉等后台轮）+ 当时的确证信号快照 */
  l2Base?: { turn: number; confirmed: number; mutationTurn: number };
  /** 本消息内升过几次 L2（含影子），用于阈值翻倍 */
  l2Count: number;
  /** 本消息内有运行中后台任务的工具轮数（不计入 L2 的轮数要求） */
  bgWaitTurns: number;
}

export function createStallState(currentOscillations: number): StallState {
  return {
    fileHashes: new Map(),
    seenStates: new Set(),
    toolTurns: 0,
    lastNewStateTurn: 0,
    lastMutationTurn: 0,
    rollbacks: 0,
    greenRegressions: 0,
    unchangedReports: 0,
    lastOscillationsObserved: currentOscillations,
    oscillationsInPrompt: 0,
    l2Count: 0,
    bgWaitTurns: 0,
  };
}

/** 内容 hash；读不到（删除 / 权限）记 null，删除本身也是一种工作区状态。 */
export function hashContent(content: string | null): string | null {
  if (content === null) return null;
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

/** 当前工作区组合的 hash（文件名排序后拼接，键序无关）。 */
export function workspaceStateHash(fileHashes: Map<string, string | null>): string {
  const parts = [...fileHashes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, h]) => `${p}\u0000${h ?? "-"}`);
  return createHash("sha1").update(parts.join("\u0001")).digest("hex").slice(0, 16);
}

// ─── 绿点账本（2c） ───

/**
 * 从 bash 输出里解析测试结论。只认 bun test 汇总行（`N pass` + `M fail` 各占一行），
 * affected-tests:run 底下也是 bun test，同一形态。
 *
 * 判据刻意窄：两行都得在、pass>0 才算有结论。格式一变就返回 undefined（不计绿点），
 * 而不是猜——静默误判比静默不判危险。
 */
export function parseTestVerdict(output: string): boolean | undefined {
  const pass = /^\s*(\d+) pass\s*$/m.exec(output);
  const fail = /^\s*(\d+) fail\s*$/m.exec(output);
  if (!pass || !fail) return undefined;
  const p = Number(pass[1]);
  const f = Number(fail[1]);
  if (f > 0) return false;
  return p > 0 ? true : undefined;
}

// ─── 每个工具轮的观测 ───

export interface StallTurnObservation {
  /** 本轮成功落盘的文件（绝对路径）→ 落盘后内容（读不到为 null） */
  mutatedFiles: Array<{ path: string; content: string | null }>;
  /**
   * 本轮执行过非只读 bash 时，账本里已登记文件的最新内容（sed / git checkout 改的文件
   * edit 账本看不见，只能对已登记文件补算——未登记的新文件仍然是盲区，见 Note）。
   */
  rehashedFiles: Array<{ path: string; content: string | null }>;
  /** 本轮 bash 输出（解析测试结论用） */
  bashOutputs: string[];
  /** 本轮 UnchangedObservationRun 上报次数 */
  unchangedReports: number;
  /** 当前 2b 振荡计数（会话级，来自 TodoGateBudget.oscillations） */
  oscillations: number;
  /** 本轮结束时是否有运行中的后台任务（缺省视为没有） */
  backgroundRunning?: boolean;
}

export type StallDecision =
  | { level: 0 }
  | { level: 1; signals: StallSignals; message: string }
  | { level: 2; signals: StallSignals; acted: boolean };

export interface StallSignals {
  turnsSinceNewState: number;
  oscillations: number;
  unchangedReports: number;
  rollbacks: number;
  greenRegressions: number;
  lastGreenTurn?: number;
  toolTurns: number;
  l2Count: number;
  bgWaitTurns: number;
}

function signalsOf(s: StallState): StallSignals {
  return {
    turnsSinceNewState: s.toolTurns - s.lastNewStateTurn,
    oscillations: s.oscillationsInPrompt,
    unchangedReports: s.unchangedReports,
    rollbacks: s.rollbacks,
    greenRegressions: s.greenRegressions,
    lastGreenTurn: s.lastGreen?.turn,
    toolTurns: s.toolTurns,
    l2Count: s.l2Count,
    bgWaitTurns: s.bgWaitTurns,
  };
}

/** 计入 L2 轮数要求的工具轮（扣掉等后台任务的轮次）。 */
function l2Turns(s: StallState): number {
  return s.toolTurns - s.bgWaitTurns;
}

/** L2 只认的确证信号总量（2b 振荡 + 空转）。hash 回退 / 绿点回归不在其中。 */
function confirmedSignals(s: StallState): number {
  return s.oscillationsInPrompt + s.unchangedReports;
}

/**
 * 推进一个工具轮并给出升级决策。
 *
 * @param hardStop L2 是否真停；false 时返回 `acted:false`（影子），调用方只落事件。
 */
export function observeStallTurn(
  s: StallState,
  obs: StallTurnObservation,
  hardStop: boolean,
): StallDecision {
  s.toolTurns++;
  if (obs.backgroundRunning) s.bgWaitTurns++;
  s.unchangedReports += obs.unchangedReports;
  s.oscillationsInPrompt += Math.max(0, obs.oscillations - s.lastOscillationsObserved);
  s.lastOscillationsObserved = obs.oscillations;

  // ── 2a：工作区状态 ──
  const before = workspaceStateHash(s.fileHashes);
  if (s.seenStates.size === 0) s.seenStates.add(before);
  for (const f of obs.rehashedFiles) {
    if (s.fileHashes.has(f.path)) s.fileHashes.set(f.path, hashContent(f.content));
  }
  for (const f of obs.mutatedFiles) s.fileHashes.set(f.path, hashContent(f.content));
  if (obs.mutatedFiles.length > 0) s.lastMutationTurn = s.toolTurns;
  const after = workspaceStateHash(s.fileHashes);
  if (after !== before) {
    if (s.seenStates.has(after)) {
      s.rollbacks++;
    } else {
      s.seenStates.add(after);
      s.lastNewStateTurn = s.toolTurns;
    }
  }

  // ── 2c：绿点 ──
  for (const out of obs.bashOutputs) {
    const verdict = parseTestVerdict(out);
    if (verdict === undefined) continue;
    if (verdict) {
      s.lastGreen = { turn: s.toolTurns, stateHash: after };
    } else if (s.lastTestGreen === true) {
      s.greenRegressions++;
    }
    s.lastTestGreen = verdict;
  }

  const sig = signalsOf(s);
  const stalled = sig.turnsSinceNewState >= STALL_WINDOW_TURNS;
  if (!stalled) return { level: 0 };

  // ── L1：一次性 ──
  if (s.l1Turn === undefined) {
    const total = sig.oscillations + sig.unchangedReports + sig.greenRegressions + sig.rollbacks;
    // 回退单独不构成理由：至少要有一个非回退信号
    const nonRollback = sig.oscillations + sig.unchangedReports + sig.greenRegressions;
    if (total >= STALL_L1_SIGNAL_THRESHOLD && nonRollback >= 1) {
      s.l1Turn = s.toolTurns;
      s.l2Base = {
        turn: l2Turns(s),
        confirmed: confirmedSignals(s),
        mutationTurn: s.lastMutationTurn,
      };
      return { level: 1, signals: sig, message: buildStallL1Message(s, sig) };
    }
    return { level: 0 };
  }

  // ── L2：只能从 L1 升上来，只认确证信号；等后台任务的轮次既不计数也不触发 ──
  if (obs.backgroundRunning) return { level: 0 };
  const base = s.l2Base!;
  const need = STALL_L2_AFTER_L1_TURNS * 2 ** s.l2Count;
  if (l2Turns(s) - base.turn < need) return { level: 0 };
  const newConfirmed = confirmedSignals(s) - base.confirmed;
  const noMutationSinceBase = s.lastMutationTurn === base.mutationTurn;
  if (newConfirmed < 1 && !noMutationSinceBase) return { level: 0 };

  s.l2Count++;
  s.l2Base = {
    turn: l2Turns(s),
    confirmed: confirmedSignals(s),
    mutationTurn: s.lastMutationTurn,
  };
  return { level: 2, signals: { ...sig, l2Count: s.l2Count }, acted: hardStop };
}

// ─── 文案 ───

export function buildStallL1Message(s: StallState, sig: StallSignals): string {
  const green = s.lastGreen
    ? `上一次测试全绿在本条消息第 ${s.lastGreen.turn} 个工具轮（工作区 ${s.lastGreen.stateHash.slice(0, 8)}）；`
    : "本条消息内还没有观察到一次全绿的测试结果；";
  return (
    `<system-reminder>\n` +
    `收敛提示（harness 观测，非用户输入）：已连续 ${sig.turnsSinceNewState} 个工具轮没有产生新的工作区状态。` +
    `${green}此后清单振荡 ${sig.oscillations} 次、同参同返回值空转 ${sig.unchangedReports} 次、` +
    `改回历史状态 ${sig.rollbacks} 次、测试由绿变红 ${sig.greenRegressions} 次。\n` +
    `如果绿点已经满足用户要求，请停止改动，提交收尾；如果卡在某个设计选择上来回切换，` +
    `请向用户说明现状、卡点和可选方案，由用户决定，而不是继续尝试。\n` +
    `</system-reminder>`
  );
}

/** L2 强制总结轮的提示文本（与 maxTurns 版区分触发原因）。 */
export function buildStallSummaryPrompt(goalLine?: string): string {
  return (
    "harness 检测到本条任务已停滞（反复修改又改回、或重复执行同样的操作而没有新进展），" +
    "本轮由系统暂停，交还给用户决定。请不要再调用任何工具，直接用结构化格式（列表/表格）输出：\n" +
    "1. 现状：已完成并验证过的部分，最后一次测试全绿时的状态；\n" +
    "2. 卡点：在哪个问题或设计选择上反复；\n" +
    "3. 可选方案：每个方案的代价，供用户选择。" +
    (goalLine ? `\n当前目标（/goal）：${goalLine}` : "")
  );
}

/** 2e：todo 闸门在振荡超阈值时，不劝「继续」，改为交还用户。 */
export function buildStallGateHandoffMessage(unfinished: number, oscillations: number): string {
  return (
    `清单还有 ${unfinished} 项未完成，但本份清单已经来回改动 ${oscillations} 次，` +
    `不再自动续跑。请查看现状后决定下一步。`
  );
}
