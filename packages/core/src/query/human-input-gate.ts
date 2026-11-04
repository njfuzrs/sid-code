/**
 * 人机输入闸门（human-input gate）
 *
 * 解决"流式处理进行中途弹出阻塞式对话框等用户作答，被无进展看门狗误杀"的问题。
 *
 * 背景（事故复盘 session 20260721-142757）：主模型失败触发 fallback 询问弹窗时，
 * 弹窗是**阻塞等用户作答**的，且发生在 stream generator 内部（tryFallback →
 * onFallbackDecision）。此时没有任何 SSE 事件流动，于是：
 *   - stream-processor 的 60s 心跳看门狗 → abort("stream-heartbeat-timeout")
 *   - loop.ts 的 300s 无进展看门狗 → abort("watchdog-timeout")
 * 弹窗被 abort 掐断 → askUserQuestion 返回 cancelled → 被误判成"用户取消/超时"，
 * 触发 timeout-retry，与弹窗形成双状态机打架、无限重试。
 *
 * 本闸门是一个模块级引用计数器：真正阻塞等用户输入的代码段用 begin/end 包裹（务必
 * try/finally 配对，否则闸门永不关闭会架空看门狗）。两个看门狗在判定"无进展该中断"前
 * 先查 isAwaitingHumanInput()——为 true 则跳过本次检查（等人不是 hang，不该计时）。
 *
 * 设计要点：
 * - 引用计数而非布尔：允许嵌套/并发的多个等待段（虽罕见），最后一个 end 才真正关闭。
 * - 不持有任何 timer/promise：纯状态查询，看门狗只读。看门狗自身的周期 tick 不受影响，
 *   只是"命中无进展"时被本闸门短路，等用户答完 end 后自然恢复计时。
 *
 * ## 作用域（scope）：把「谁的等待」与「进程等了多久」分开
 *
 * 同一进程里可能同时有多个 agent（主循环 + 后台子代理 / forked agent）。只用一个进程级
 * 累计值时，消费侧（`AfterModel.api_duration_ms` 的扣减、`TurnComplete.hitl_wait_ms`）
 * 拿它做**本轮**差值，会把别的 agent 等人的时间扣进本轮的模型耗时 —— 极端情况扣成 0，
 * 凭空造出「模型耗时 0ms」的假样本，方向与北极星「更快」口径相反（越并发越好看）。
 *
 * 归属规则（**宁可漏计，不可多计**）：
 * 1. `beginHumanInputWait(scopeId)` 的 scopeId 优先；未传则 `resolveHitlScope()` 推断；
 * 2. 推断只在「进程内恰好只有一个活跃 scope」时成立（`openHitlScope()` / `closeHitlScope()`
 *    由每个 loop 的生命周期在入口/`finally` 包住）。0 个或多个活跃 scope 一律推断失败；
 * 3. 一段等待（全局 0→1 到 1→0）只归属一个 scope。中途有「不同 scope / 无法归属」的
 *    等待加入时，**把已过去的这段结算给原归属，之后的部分不再归属任何 scope**；
 * 4. 无法归属的等待仍计入进程级累计值（`isAwaitingHumanInput()` 与既有消费者语义不变），
 *    只是不出现在任何 scope 的计数/时长里。
 *
 * 为什么不用 AsyncLocalStorage：实测 async generator 里 `enterWith` 的 store 会泄漏给
 * 消费方与主流程（`for await` 循环体和调用者都能读到），而 `run()` 无法跨 yield 生效。
 */

let awaitingCount = 0;
// 累计等待时长：配对看门狗（trace/pairing-deadline.ts）要从「请求挂了多久」里扣掉这段。
// 只在计数 0→1 / 1→0 的边沿记时，嵌套段不重复计入。
let waitStartedAt: number | null = null;
let waitTotalMs = 0;
// 「HITL 区段数」：引用计数 0→1 的边沿 +1，即「真正开始阻塞等人」的次数（只增不减）。
//
// 存在的理由是**口径单一**：此前「本轮有没有 HITL」由 `tool-executor` 在弹窗前手写
// `recordHitlPrompt()` 二次登记（挂 SessionState）。那条路只覆盖权限弹窗，fallback 询问
//（app.ts）与 MCP elicitation 都会阻塞等人却不计数 —— 消费侧想按 `had_hitl` 剔除样本，
// 恰好剔不掉那条 2.85h 的 fallback 等待。现在改为所有等待都必须经过本闸门，
// 计数与耗时都从这一个登记点派生，不再存在第二份口径。
let hitlSegmentCount = 0;

/**
 * 当前这段等待的归属 scope（`undefined` = 不归属任何 scope）。
 *
 * 只在一段等待的「全局 0→1」处确定；段内出现归属冲突时置空（见文件头归属规则 3）。
 */
let segmentScopeId: string | undefined;

/** 按 scope 的累计值。键只由 `openHitlScope()` 产出，`closeHitlScope()` 负责删除。 */
interface HitlScopeGate {
  /** 已完成（或已结算）的、归属本 scope 的等待段数。 */
  segmentCount: number;
  /** 已完成（或已结算）的、归属本 scope 的等待毫秒数。 */
  waitTotalMs: number;
}

const scopeGates = new Map<string, HitlScopeGate>();
/** 进程内活跃的 loop scope（由 loop 生命周期 open/close）。 */
const activeScopes = new Set<string>();
let scopeSeq = 0;

/** 等待区段结束的订阅者（引用计数归零时触发一次）。 */
const waitEndListeners = new Set<() => void>();

/**
 * 订阅「等待用户输入结束」（引用计数 1→0 的边沿）。
 *
 * 为什么需要这个订阅：任务安全阀（`task/registry.ts` 的 `UNDELIVERED_SAFETY_VALVE_MS`）
 * 要把人工等待从时钟里扣掉（等人不是「主循环不转了」），而等待期间它**不能**排定时器
 * ——截止时刻会随等待同步后移，排了就是每次 tick 都发现「还没到」。所以等待结束这一刻
 * 必须有人重新唤醒它。与 `task/lifecycle.ts` 的 `onMainTurnCompleted` 同款：
 * 纯回调注册，本模块不持有任何 timer、不知道调用方是谁。
 */
export function onHumanInputWaitEnd(cb: () => void): void {
  waitEndListeners.add(cb);
}

/** 取（必要时新建）某个 scope 的累计容器。 */
function gateOf(scopeId: string): HitlScopeGate {
  let gate = scopeGates.get(scopeId);
  if (!gate) {
    gate = { segmentCount: 0, waitTotalMs: 0 };
    scopeGates.set(scopeId, gate);
  }
  return gate;
}

/**
 * 开启一个「判定归属用」的 scope，返回其 id。由每个 loop 的生命周期在入口调用一次，
 * 并在 `finally` 里用同一个 id 调 `closeHitlScope()`（忘关会让推断永久失效，务必配对）。
 *
 * 为什么由 loop 登记而不是由闸门自己推断「当前是哪个 loop」：闸门是纯状态模块，看不到
 * 调用栈；loop 的入口/`finally` 是唯一能保证「进入与退出严格配对」的位置。
 */
export function openHitlScope(): string {
  const id = `hitl-scope-${++scopeSeq}`;
  activeScopes.add(id);
  gateOf(id);
  return id;
}

/** 关闭 scope 并丢弃其累计容器。传入未开启过的 id 是安全的空操作。 */
export function closeHitlScope(scopeId: string | undefined): void {
  if (!scopeId) return;
  activeScopes.delete(scopeId);
  scopeGates.delete(scopeId);
}

/** 当前活跃 scope 数。0 或 >1 时 `resolveHitlScope()` 会推断失败（宁可漏计）。 */
export function activeHitlScopeCount(): number {
  return activeScopes.size;
}

/**
 * 推断「此刻唯一可能在等的 scope」。**只在恰好一个活跃 scope 时成立**。
 *
 * 多 agent 并发时返回 undefined 是刻意的：猜错的代价是「把别人的等待扣进我的模型耗时」，
 * 那会伪造出更快的数字；漏计的代价只是某些轮次的 `had_hitl` 判不出来。
 */
export function resolveHitlScope(): string | undefined {
  if (activeScopes.size !== 1) return undefined;
  return activeScopes.values().next().value;
}

/**
 * 把「从 waitStartedAt 到现在」这段时间结算给当前归属，并把起点推进到 now。
 *
 * 两处调用：段结束时（随后清零）、以及段内出现归属冲突时（随后降级为不归属）。
 * 段数只在结算这一刻 +1 —— 未完成的段不计数，保证「段数 × 段时长」不会出现半段。
 */
function settleSegment(now: number): void {
  if (waitStartedAt === null) return;
  const delta = Math.max(0, now - waitStartedAt);
  waitTotalMs += delta;
  if (segmentScopeId !== undefined) {
    const gate = gateOf(segmentScopeId);
    gate.waitTotalMs += delta;
    gate.segmentCount++;
  }
  waitStartedAt = now;
}

/**
 * 进入"等待用户输入"区段（引用计数 +1）。
 *
 * @param scopeId 归属的 loop scope。能确定时务必显式传（权限弹窗 / fallback 询问
 *   通过 `readHitlScopeFromSession()` 从会话状态里取）；拿不到时省略，闸门会尝试推断。
 */
export function beginHumanInputWait(scopeId?: string): void {
  const scope = scopeId ?? resolveHitlScope();
  if (awaitingCount === 0) {
    waitStartedAt = Date.now();
    // 只在 0→1 边沿计一次「区段」：嵌套 / 并发等待属于同一段，不重复计数。
    hitlSegmentCount++;
    segmentScopeId = scope;
  } else if (scope !== segmentScopeId) {
    // 归属冲突：本段已被别的（或无法归属的）等待占了。先把已过去的部分结算给原归属，
    // 之后的部分不再归属任何 scope。方向是「漏计」而不是「多计」—— 见文件头规则 3。
    settleSegment(Date.now());
    segmentScopeId = undefined;
  }
  awaitingCount++;
}

/** 离开"等待用户输入"区段（引用计数 -1，下限 0）。 */
export function endHumanInputWait(): void {
  if (awaitingCount === 0) return;
  awaitingCount--;
  if (awaitingCount === 0 && waitStartedAt !== null) {
    settleSegment(Date.now());
    waitStartedAt = null;
    segmentScopeId = undefined;
    // 回调异常不能影响调用方（取消/结束等待的路径往往是 finally）。
    for (const cb of waitEndListeners) {
      try {
        cb();
      } catch {
        /* 监听器异常不影响闸门 */
      }
    }
  }
}

/**
 * 进程内 / 某个 scope 内累计「等用户输入」的毫秒数，进行中的那段按已过去部分计入。
 * 只增不减：调用方在计时开始时取一次快照，之后相减得到本窗口内的等待时长。
 *
 * @param scopeId 省略 = 进程级累计（既有语义，`task/registry.ts` 与
 *   `pairing-deadline.ts` 依赖它）；传入 loop scope id = 只算归属该 loop 的等待，
 *   供「本轮模型耗时扣减」这类**窗口口径**使用。
 */
export function humanInputWaitElapsedMs(scopeId?: string): number {
  const now = Date.now();
  if (scopeId === undefined) {
    return waitTotalMs + (waitStartedAt !== null ? Math.max(0, now - waitStartedAt) : 0);
  }
  const gate = scopeGates.get(scopeId);
  if (!gate) return 0;
  const inProgress =
    segmentScopeId === scopeId && waitStartedAt !== null ? Math.max(0, now - waitStartedAt) : 0;
  return gate.waitTotalMs + inProgress;
}

/** 当前是否正在阻塞等待用户输入（任一区段未闭合即为 true）。进程级语义，与 scope 无关。 */
export function isAwaitingHumanInput(): boolean {
  return awaitingCount > 0;
}

/**
 * 累计发生过的「HITL 区段」数（只增不减）。
 *
 * 口径是「阻塞等人的**次数**」，不是「弹窗次数」：任何走 `beginHumanInputWait()` 的
 * 阻塞段都算（权限确认 / fallback 询问 / MCP elicitation / ask_user_question / plan 审批）。
 * 消费方（`TurnComplete.had_hitl`）用轮首快照与轮末值的**差**回答「本轮有没有」——
 * 不能用布尔标志：一旦置真，后续每轮都会被误标。
 *
 * @param scopeId 省略 = 进程级累计；传入 = 只数归属该 loop 的段（含正在进行的这一段）。
 */
export function readHitlSegmentCount(scopeId?: string): number {
  if (scopeId === undefined) return hitlSegmentCount;
  const gate = scopeGates.get(scopeId);
  const inProgress = segmentScopeId === scopeId && waitStartedAt !== null ? 1 : 0;
  return (gate?.segmentCount ?? 0) + inProgress;
}

/**
 * 便捷包裹：在等待区段内执行异步操作，自动 begin/end（含异常安全的 finally）。
 * 用于把阻塞式对话框调用一行包起来，避免手写 try/finally 漏配对。
 */
export async function withHumanInputWait<T>(fn: () => Promise<T>, scopeId?: string): Promise<T> {
  beginHumanInputWait(scopeId);
  try {
    return await fn();
  } finally {
    endHumanInputWait();
  }
}

/**
 * 当前轮次的 HITL scope id 在 `SessionState` 上的键。
 *
 * 为什么要绕一次会话状态：`withHumanInputWait` 的调用点分属两层——`tool-executor` 与
 * `app.ts` 各有一套 deps，而 loop 内部创建的 `LoopState` 传不到它们手上。会话状态是
 * 两层都能拿到的同一份对象，且主循环每条用户消息只会有一个 scope（`queryLoop` 的
 * `finally` 负责清除），不会出现「读到上一轮残留」。
 */
export const HITL_SCOPE_SESSION_KEY = "hitlScopeId";

/**
 * 从会话状态读当前轮次的 HITL scope。读不到（子代理 / 无会话 / 上一轮已清理）返回
 * `undefined` —— 此时闸门退回「唯一活跃 scope」推断，多 agent 场景下会漏计而非多计。
 */
export function readHitlScopeFromSession(
  sessionState: { get(key: string): unknown } | undefined,
): string | undefined {
  if (!sessionState) return undefined;
  try {
    const v = sessionState.get(HITL_SCOPE_SESSION_KEY);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 测试用：强制清零全部状态（避免用例间状态泄漏）。 */
export function __resetHumanInputGate(): void {
  awaitingCount = 0;
  waitStartedAt = null;
  waitTotalMs = 0;
  hitlSegmentCount = 0;
  segmentScopeId = undefined;
  scopeGates.clear();
  activeScopes.clear();
}
