/**
 * 等待期前台状态查询的拦截（P1）：判据 + 回执 + 事件。
 *
 * 与 `background-poll-guard.ts`（Q1）是**同一类问题的两个入口**，但判据不同，所以分两个模块：
 * - Q1 判的是「后台任务还在跑，别去看它的输出文件」——依据是任务确实在运行；
 * - 本模块判的是「你在等的外部状态没变，别重复问」——依据是**模型自己声明了在等**
 *   （`hasPromisedWait()`），且这条命令的输出和上次一模一样。
 *
 * ## 为什么需要它（量级）
 *
 * 事故会话 20261108-112039-9e3a681d：20 分钟窗口内 97 次 `gh pr view`，只产出 23 种不同状态。
 * 20261108-112620-7dd98bf5：86 次 `gh pr checks`。每次查询都是一个完整请求，
 * 上下文到了这个阶段接近 20 万 token —— 这才是「等待」真正贵的地方。
 *
 * ## 三条判据同时成立才拦（§5.5.1）
 *
 * 1. **有等待源**：`hasPromisedWait()`。没有等待源时同一命令查 100 次也全放行，行为与改动前
 *    逐字节一致。这是本判据与 2026-07-14 那份否决（工具循环检测默认关闭）的根本区别：
 *    那份否决的场景是**没有任何依据判断模型在等**，这里模型自己挂了 monitor / 唤醒。
 * 2. **命令是外部状态查询且不含写操作**：见 `status-query-commands.ts` 的命令表。
 * 3. **结果与上次相同**：同一签名的归一化输出等于上次**实际执行**时的值。
 *
 * ## 拦截为什么要「第一次相同放行、第二次起才拦」
 *
 * 第一次相同（模型第二次看到同一结果）时，它还没有足够信息判断「这东西不会变」；
 * 直接拦会让它在第一次重复时就失去确认机会。所以第一次相同 = 放行 + 追加一行提示，
 * 第二次起才真的不执行。这与 §5.5.4 一致，也对应 `bg_task_list` 的现状（状态没变就拦，
 * 但那边没有「第一次相同放行」的台阶，因为后台任务的终态通知是确定会到的）。
 *
 * ## ⚠️ 探测间隔：本实现相对方案 §5.5 增加的一层安全阀（有实测依据，写进 Agent Note）
 *
 * 纯 memo 判据（「和上次一样就拦」）有一个致命后果：**一旦开始拦，就永远看不到状态变化**。
 * 用触发会话的真实数据回放：97 条查询、23 种状态，按「连续 2 次相同后拦截」会拦掉 84 条，
 * 而其中 84 条**如果执行了会看到不同的状态**——因为拦截期间外部世界一直在变。
 * 那会把「少查几次」变成「永远卡在旧状态」，比不拦更糟（等待结束模型也不知道 CI 绿了）。
 *
 * 所以加一条：**距上次实际执行超过 `STATUS_POLL_PROBE_INTERVAL_MS` 就放行一次探测**。
 * 它把「可能错过变化」从无界压缩到有界（最坏 2 分钟内一定会看到一次真实状态），
 * 代价是拦截率下降。回放实测见 Agent Note 第三段与 `status-poll-guard.test.ts` 的
 * 「真实轨迹回放」用例（数字写在那儿，不在这里复制，避免两处漂移）。
 */

import {
  describeWaitSource,
  findWaitBySubject,
  hasPromisedWait as defaultHasPromisedWait,
  listWaits as defaultListWaits,
  type WaitSource,
} from "./wait-registry.ts";
import {
  matchStatusQuery,
  normalizeStatusOutput,
  summarizeStatusOutput,
  type StatusQueryKind,
} from "./status-query-commands.ts";

/**
 * 探测间隔：距上次**实际执行**超过这么久，即使结果预计不变也放行一次。
 *
 * 取值依据：触发会话里两次查询的中位间隔约 12s，CI 一个分片的状态迁移在分钟级。
 * 120s 让「最坏错过窗口」不超过一个大致的 CI 阶段，同时仍能拦掉 90% 以上的重复查询
 * （回放实测见测试里的真实轨迹用例）。
 */
export const STATUS_POLL_PROBE_INTERVAL_MS = 120_000;

/**
 * 连续多少次「观察到与上次相同」之后开始拦。
 *
 * 2 = 第 2 次相同（即第 3 次查询）起拦截：第 1 次相同放行 + 提示。见模块头注释。
 */
export const STATUS_POLL_BLOCK_AFTER_SAME = 2;

/** 单签名的记忆。进程级：主循环只有一条，与 `defaultTaskListMemo` 同口径。 */
interface PollMemoEntry {
  /** 上次**实际执行**时的归一化输出 */
  last: string;
  /** 连续「与上次相同」的观察次数（首次执行为 1） */
  sameRun: number;
  /** 上次**实际执行**的时间（毫秒）；探测间隔按它算 */
  lastExecutedAt: number;
  /** 上次执行时的时间戳文案（回执里「上次查询于 HH:MM:SS」用） */
  lastExecutedLabel: string;
}

export interface StatusPollMemo {
  entries: Map<string, PollMemoEntry>;
}

export interface StatusPollContext {
  /** 当前是否有带承诺的等待源（判据 1） */
  hasPromisedWait: () => boolean;
  /** 当前等待源清单（回执里引用 monitor / 期限） */
  listWaits: () => WaitSource[];
  memo: StatusPollMemo;
  now: () => number;
}

/** 进程级默认 memo。测试用 `__resetStatusPollGuardForTest` 复位。 */
const defaultMemo: StatusPollMemo = { entries: new Map() };

/**
 * 被 P1 拦下的 tool_use_id。
 *
 * 用途只有一个：`loop.ts` 算 `UnchangedObservationRun` 时把 `intervened` 记成 true
 * （§5.5.4「终于有了真干预的数据」）。用 tool_use_id 而不是指纹，是因为同一个指纹
 * 可能一次被拦、一次被放行，只有 id 能精确对上「这一次」。
 *
 * 有上限：消费方（loop.ts）正常情况下每条都会取走，但子代理路径不经过那里，
 * 所以设个上界防泄漏——这条通道只用于埋点，丢了不影响任何行为。
 */
const intervenedIds = new Set<string>();
const INTERVENED_ID_CAP = 256;

export function defaultStatusPollContext(): StatusPollContext {
  return {
    hasPromisedWait: () => defaultHasPromisedWait(),
    listWaits: () => defaultListWaits(),
    memo: defaultMemo,
    now: () => Date.now(),
  };
}

/** 测试复位。 */
export function __resetStatusPollGuardForTest(): void {
  defaultMemo.entries.clear();
  intervenedIds.clear();
}

/** 标记这次调用被 P1 拦下（供 loop 的 intervened 埋点消费）。 */
export function markStatusPollIntervened(toolUseId: string): void {
  if (intervenedIds.size >= INTERVENED_ID_CAP) {
    // 超上限时丢最早的（Set 保持插入序），不抛错：埋点不能影响主流程
    const first = intervenedIds.values().next().value;
    if (first !== undefined) intervenedIds.delete(first);
  }
  intervenedIds.add(toolUseId);
}

/** 取走并清除某个 tool_use_id 的拦截标记。 */
export function consumeStatusPollIntervened(toolUseId: string): boolean {
  return intervenedIds.delete(toolUseId);
}

/** 本地时钟 HH:MM:SS（回执里给模型一个「这个结论有多旧」的锚点） */
function formatClock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export type StatusPollCheck =
  | { intercept: false }
  | {
      intercept: true;
      subject: string;
      kind: StatusQueryKind;
      /** 回执正文（模型看到的东西，`is_error=false`） */
      output: string;
    };

/**
 * 拦截后的回执正文。
 *
 * 三个要素缺一不可（§5.5.4）：
 * 1. **上次的状态摘要** —— 模型不因被拦而丢信息，压缩后再问也拿得到答案；
 * 2. **谁在等、最晚什么时候** —— 引用具体的 monitor / 唤醒，不是泛泛的「稍等」；
 * 3. **上次查询时间** —— 让模型自己判断这个结论有多旧（§6.5 第 10 条）。
 */
function buildReceipt(opts: {
  kind: StatusQueryKind;
  subject: string;
  entry: PollMemoEntry;
  waits: WaitSource[];
}): string {
  const { kind, subject, entry, waits } = opts;
  const summary = summarizeStatusOutput(kind, entry.last);
  const waiter = waits.find((w) => w.subjects?.includes(subject)) ?? waits[0];
  const who = waiter
    ? `${describeWaitSource(waiter)}${
        waiter.promise.kind === "deadline"
          ? `，最晚 ${formatClock(waiter.promise.deadlineAt)} 前会回报`
          : "，结束时会回报"
      }；状态变化会以通知送达。`
    : "有等待源会在状态变化时通知。";

  return [
    `本次未执行：结果与上次查询相同（${subject}：${summary || "无输出"}）。`,
    who,
    `上次查询于 ${entry.lastExecutedLabel}。`,
    "没有别的事就告诉用户在等什么，然后结束本轮；不要反复查询。",
  ].join("\n");
}

/**
 * 执行前判定：这条调用要不要拦。
 *
 * 纯函数式判定 + 一处**放行时**的写 memo（与 `checkBackgroundPoll` 的 `taskListMemo` 同一模式：
 * 判据要看「模型上次看到的东西」，所以必须在这里记下来）。
 */
export function checkStatusQueryPoll(
  toolName: string,
  input: unknown,
  ctx: StatusPollContext = defaultStatusPollContext(),
): StatusPollCheck {
  if (toolName !== "bash") return { intercept: false };
  const params = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // 自己转后台的命令不是「等外部状态」
  if (params.run_in_background === true) return { intercept: false };
  const command = typeof params.command === "string" ? params.command : "";
  if (!command) return { intercept: false };

  const matched = matchStatusQuery(command);
  if (!matched) return { intercept: false };

  // 判据 1：没有等待源 → 与改动前完全一致（T-P1-4：同命令同结果 100 次全部放行）
  if (!ctx.hasPromisedWait()) return { intercept: false };

  const entry = ctx.memo.entries.get(matched.signature);
  if (!entry) return { intercept: false };

  // 探测间隔：距上次实际执行超过阈值就放行一次，避免「拦住就永远看不到变化」。
  //
  // ⚠️ 这条**只对「没有 monitor 盯着同一对象」的等待源**生效。理由见下面 `covered` 的注释：
  // monitor 会在状态变化时主动通知，所以它盯着的时候拦到底是对的（方案 §6.5 第 10 条
  // 「不可能长期发生」正是以 monitor 在场为前提）；而没有 monitor 时，「拦住就永远看不到变化」
  // 是真实缺口，必须留一个探测窗口把它变成有界。
  const covered = ctx.listWaits().some((w) => w.subjects?.includes(matched.subject));
  if (!covered && ctx.now() - entry.lastExecutedAt >= STATUS_POLL_PROBE_INTERVAL_MS) {
    return { intercept: false };
  }

  // `sameRun` 是「连续观察到与上次相同的次数」，首次执行为 1。所以：
  //   sameRun=1 → 还没见过重复，放行；
  //   sameRun=2 → 第 1 次相同，放行（那一次已在 recordStatusQueryResult 里追加过提示）；
  //   sameRun≥2 → 第 2 次起相同，拦。
  // 判据写成 `<` 而不是 `<=`：`<=` 会让拦截晚一轮，与 T-P1-3 的「第 3 次查询不执行」差一位。
  if (entry.sameRun < STATUS_POLL_BLOCK_AFTER_SAME) return { intercept: false };

  return {
    intercept: true,
    subject: matched.subject,
    kind: matched.kind,
    output: buildReceipt({
      kind: matched.kind,
      subject: matched.subject,
      entry,
      waits: ctx.listWaits(),
    }),
  };
}

/**
 * 执行后记录：只有**真的执行了**才调用（被拦的那次不更新 memo）。
 *
 * @returns 需要追加到工具结果末尾的提示（第一次观察到相同时给，其余为空）
 */
export function recordStatusQueryResult(
  command: string,
  output: string,
  ctx: StatusPollContext = defaultStatusPollContext(),
): string | undefined {
  const matched = matchStatusQuery(command);
  if (!matched) return undefined;

  const normalized = normalizeStatusOutput(matched.kind, output);
  const now = ctx.now();
  const entry = ctx.memo.entries.get(matched.signature);

  if (entry && entry.last === normalized) {
    const sameRun = entry.sameRun + 1;
    ctx.memo.entries.set(matched.signature, {
      last: normalized,
      sameRun,
      lastExecutedAt: now,
      lastExecutedLabel: formatClock(now),
    });
    // 第一次相同：放行，但明确告诉模型「这结果没变，别再问了」。
    // 只提示一次（sameRun === 2 这一次），之后就走拦截，不必每轮都念一遍。
    if (sameRun === 2) {
      const waits = ctx.listWaits();
      const waiter = waits.find((w) => w.subjects?.includes(matched.subject)) ?? waits[0];
      const who = waiter ? describeWaitSource(waiter) : "等待源";
      return `[等待中] 结果与上次相同。${who}正在盯着，状态变化时会通知你，不需要再查。`;
    }
    return undefined;
  }

  ctx.memo.entries.set(matched.signature, {
    last: normalized,
    sameRun: 1,
    lastExecutedAt: now,
    lastExecutedLabel: formatClock(now),
  });
  return undefined;
}

// ─────────────────────────── BackgroundPollIntercepted 事件（复用 Q1 的通道） ───────────────────────────

/**
 * P1 命中的 kind 标记。
 *
 * 复用 `BackgroundPollIntercepted` 事件而不是新开一个事件名：F2 的取数源是「§1.1 计数减去
 * 本事件命中的 tool_use_id」，两类拦截都要从同一个分母里扣，分成两个事件反而要在两处扣。
 * `kind` 已能区分（`external_status_poll`），归因不受影响。
 */
export const STATUS_POLL_INTERCEPT_KIND = "external_status_poll" as const;

/** 供 `findWaitBySubject` 之外的调用方使用（测试里断言回执引用了正确的等待源） */
export { findWaitBySubject };
