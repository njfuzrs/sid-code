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
// 恰好剔不掉本会话那条 2.85h 的 fallback 等待。现在改为所有等待都必须经过本闸门，
// 计数与耗时都从这一个登记点派生，不再存在第二份口径。
let hitlSegmentCount = 0;

/** 进入"等待用户输入"区段（引用计数 +1）。 */
export function beginHumanInputWait(): void {
  if (awaitingCount === 0) {
    waitStartedAt = Date.now();
    // 只在 0→1 边沿计一次「区段」：嵌套 / 并发等待属于同一段，不重复计数。
    hitlSegmentCount++;
  }
  awaitingCount++;
}

/** 离开"等待用户输入"区段（引用计数 -1，下限 0）。 */
export function endHumanInputWait(): void {
  if (awaitingCount === 0) return;
  awaitingCount--;
  if (awaitingCount === 0 && waitStartedAt !== null) {
    waitTotalMs += Math.max(0, Date.now() - waitStartedAt);
    waitStartedAt = null;
  }
}

/**
 * 进程内累计「等用户输入」的毫秒数，进行中的那段按已过去部分计入。
 * 只增不减：调用方在计时开始时取一次快照，之后相减得到本窗口内的等待时长。
 */
export function humanInputWaitElapsedMs(): number {
  return waitTotalMs + (waitStartedAt !== null ? Math.max(0, Date.now() - waitStartedAt) : 0);
}

/** 当前是否正在阻塞等待用户输入（任一区段未闭合即为 true）。 */
export function isAwaitingHumanInput(): boolean {
  return awaitingCount > 0;
}

/**
 * 进程内累计发生过的「HITL 区段」数（只增不减）。
 *
 * 口径是「阻塞等人的**次数**」，不是「弹窗次数」：任何走 `beginHumanInputWait()` 的
 * 阻塞段都算（权限确认 / fallback 询问 / MCP elicitation / 抢跑权限门）。
 * 消费方（`TurnComplete.had_hitl`）用轮首快照与轮末值的**差**回答「本轮有没有」——
 * 不能用布尔标志：一旦置真，后续每轮都会被误标。
 */
export function readHitlSegmentCount(): number {
  return hitlSegmentCount;
}

/**
 * 便捷包裹：在等待区段内执行异步操作，自动 begin/end（含异常安全的 finally）。
 * 用于把阻塞式对话框调用一行包起来，避免手写 try/finally 漏配对。
 */
export async function withHumanInputWait<T>(fn: () => Promise<T>): Promise<T> {
  beginHumanInputWait();
  try {
    return await fn();
  } finally {
    endHumanInputWait();
  }
}

/** 测试用：强制清零计数（避免用例间状态泄漏）。 */
export function __resetHumanInputGate(): void {
  awaitingCount = 0;
  waitStartedAt = null;
  waitTotalMs = 0;
}
