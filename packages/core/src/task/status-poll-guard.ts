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
 * 1. **模型显式声明了在等外部状态**：`hasDeclaredExternalWait()`（D12）。没有它时同一命令查
 *    100 次也全放行，行为与改动前逐字节一致。这是本判据与 2026-07-14 那份否决
 *    （工具循环检测默认关闭）的根本区别：那份否决的场景是**没有任何依据判断模型在等**，
 *    这里模型自己挂了 monitor / 唤醒 / `wait_until`。
 *
 *    ⚠️ 刻意**不是** `hasPromisedWait()`：后者还包含派生的子代理 / workflow / 普通后台 shell，
 *    它们承诺的是「**自己**结束时会回报」，不是「查询的那个**外部对象**变化时会回报」。
 *    拿它当前提，模型起一个无关的 `bun test` 之后就再也查不到 PR 状态（D12 / R10）。
 *    T2 闸门问「有没有东西在等」（要宽），P1 问「模型是否声明了在等外部状态」（要窄），
 *    两个问题不该共用一个函数。
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
  hasDeclaredExternalWait as defaultHasDeclaredExternalWait,
  isDeclaredExternalWait,
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
  /**
   * 判据 1：**模型是否显式声明了在等外部状态**（D12）。
   *
   * 刻意不是 `hasPromisedWait`：后者含派生的子代理 / workflow / 普通后台 shell，
   * 它们承诺的是「自己结束时会回报」，不是「查询的那个外部对象变化时会回报」。
   * 两个问题不该共用一个函数（T2 闸门要宽，P1 要窄）。
   */
  hasDeclaredExternalWait: () => boolean;
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
    hasDeclaredExternalWait: () => defaultHasDeclaredExternalWait(),
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
 * 回执与首次提示共用的「谁在等、等着的是什么」说明（D12 第 2/3 条）。
 *
 * 两处过去各写一份，且都在找不到盯本对象的等待源时 `?? waits[0]` 退回第一个，
 * 于是拿一个**无关的**后台 shell 说「状态变化会以通知送达」——模型信了，不再查，
 * 而没有任何东西在盯它问的那个对象（D12 的事故 R10）。这个函数只认
 * **模型自己声明**的等待源（monitor / 唤醒 / wait_until），永不引用子代理或普通 shell。
 *
 * 措辞必须区分 monitor 与定时器（D12 第 2 条）：只有 monitor 会「在状态变化时通知」，
 * 唤醒与 wait_until 只是定时器，期间状态可能变化。
 */
export function describeWaitRelation(subject: string, waits: WaitSource[]): string {
  const declared = waits.filter(isDeclaredExternalWait);
  const deadlineText = (w: WaitSource): string =>
    w.promise.kind === "deadline"
      ? `，最晚 ${formatClock(w.promise.deadlineAt)} 前会回报`
      : "，结束时会回报";

  // 只有 monitor 才「盯对象」。唤醒 / wait_until 的 subjects 只是顺手从 prompt 里抽到的
  // 实体，它们本身不观察任何东西——拿 subjects 命中就说「盯了这个对象」正是 D12 的同款错误。
  const coveringMonitor = declared.find(
    (w) => w.kind === "monitor" && w.subjects?.includes(subject),
  );
  if (coveringMonitor) {
    return `${describeWaitSource(coveringMonitor)}${deadlineText(coveringMonitor)}；状态变化会以通知送达，不需要再查。`;
  }

  // 有定时器类等待（唤醒 / wait_until）：到点才会再看，期间状态可能变化
  const timer = declared.find((w) => w.kind !== "monitor");
  if (timer) {
    return `${describeWaitSource(timer)}${deadlineText(timer)}；它只是一个定时器，到点才会再看，期间状态可能变化，不要反复查询。`;
  }

  // 只剩「盯别的对象的 monitor」：如实说它不盯这个对象，绝不 fallback 成「状态变化会通知」
  const otherMonitor = declared.find((w) => w.kind === "monitor");
  if (otherMonitor) {
    return `${describeWaitSource(otherMonitor)}${deadlineText(otherMonitor)}；它不盯这个对象，状态变化不会自动送达，不要反复查询。`;
  }
  return "当前没有盯这个对象的等待源，状态变化不会自动送达；不要反复查询。";
}

/**
 * 拦截后的回执正文。
 *
 * 三个要素缺一不可（§5.5.4）：
 * 1. **上次的状态摘要** —— 模型不因被拦而丢信息，压缩后再问也拿得到答案；
 * 2. **谁在等、最晚什么时候** —— 见 `describeWaitRelation`（不引用无关等待源）；
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

  return [
    `本次未执行：结果与上次查询相同（${subject}：${summary || "无输出"}）。`,
    describeWaitRelation(subject, waits),
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

  // 判据 1：没有**模型显式声明**的等待 → 与改动前完全一致。
  //
  // D12：这里刻意不是 `hasPromisedWait()`。后者含派生的子代理 / workflow / 普通后台 shell，
  // 它们承诺的是「自己结束时会回报」，不是「你查的那个外部对象变化时会回报」。
  // 拿它当前提的后果（实测 R10）：模型起了一个无关的 `bun test`，之后连查 `gh pr view`
  // 被拦，回执还说「状态变化会以通知送达」—— 没有任何东西在盯 PR。
  // 无等待源时同命令同结果 100 次仍全部放行（T-P1-4）。
  if (!ctx.hasDeclaredExternalWait()) return { intercept: false };

  const entry = ctx.memo.entries.get(matched.signature);
  if (!entry) return { intercept: false };

  // 探测间隔：距上次实际执行超过阈值就放行一次，避免「拦住就永远看不到变化」。
  //
  // 只有 **monitor 且命令族命中** 才算「被覆盖」（D13）：monitor 会在它报告的那类字段
  // 变化时主动通知，此时拦到底是安全的；而它不报告的字段（如 monitor 只跑
  // `gh pr checks`，模型在查 `gh pr view --json reviewDecision`）没有通知通道，
  // 必须留探测窗口，否则 review 通过、冲突出现模型都看不到。
  //
  // 旧实现只看 `subjects`（对象粒度）：覆盖了对象 ≠ 覆盖了字段（D13）。
  // 扫不出命令族（自定义脚本）→ `commandFamilies` 为空 → 视为不覆盖（保守方向）。
  const covered = ctx
    .listWaits()
    .some(
      (w) =>
        w.kind === "monitor" &&
        w.subjects?.includes(matched.subject) === true &&
        w.commandFamilies?.includes(matched.family) === true,
    );
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
    // 文案与回执共用 `describeWaitRelation`（D12 第 3 条）：两处过去各写一份，
    // 且都 fallback 到第一个等待源，会拿无关的普通后台 shell 说「正在盯着」（R10 的同款错误）。
    if (sameRun === 2) {
      return `[等待中] 结果与上次相同。${describeWaitRelation(matched.subject, ctx.listWaits())}`;
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
