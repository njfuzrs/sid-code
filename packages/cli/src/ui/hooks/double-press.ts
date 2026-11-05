/**
 * 双击（同一按键在时间窗口内按两次）判定器。
 *
 * 为什么需要它：键盘解析层只在**同一轮 data** 里连续收到 `\x1b\x1b` 时才合成
 * `escape-escape`（KeypressContext 的解析器），而 `ESC_TIMEOUT = 50ms` 一到就把单个 `\x1b`
 * 作为 `escape` 冲刷出去。人手双击的间隔是 150–300ms，所以正常速度下永远收不到
 * `escape-escape`——帮助文案里的「Esc Esc 空闲时打开会话回退」在真实使用中等于不存在。
 *
 * 为什么不在解析层合成：解析层不知道第一个 Esc 有没有被「中断 / 关面板 / 关补全」消费掉，
 * 会把「中断 + 再按一次」误判成双击；而且它必须先发出第一个 `escape` 才能等第二个，
 * 发出去的那个已经收不回来了。双击语义依赖 App 状态，只能放在上层。
 * 也不能靠调大 `ESC_TIMEOUT` 修：那个值同时决定单按 Esc（中断 / 关补全 / 关面板）的生效延迟，
 * 以及 Alt 组合键（`ESC x`）的识别窗口，调到 500ms 等于让所有单按 Esc 都慢半秒。
 *
 * 做成纯函数 + 注入时钟，是为了能精确断言「799ms 算、801ms 不算」而不依赖真实计时。
 */

/**
 * 双击判定窗口（ms）。
 *
 * 取 800 与 claude-code 的 `DOUBLE_PRESS_TIMEOUT_MS` 一致
 * （`claude-code/src/hooks/useDoublePress.ts:6`），保持两套 TUI 的手感相同。
 */
export const DOUBLE_ESC_WINDOW_MS = 800;

export interface DoublePressDetector {
  /** 记一次按键；窗口内的第二次返回 true，并自动复位。 */
  press: () => boolean;
  /** 复位。有任何其它按键 / 状态变化时调用，防止「Esc · 打字 · Esc」被判成双击。 */
  reset: () => void;
}

/**
 * 创建判定器。
 *
 * 语义：
 * - 第一次 press 记录时刻并返回 false；
 * - 距上次 press 不超过 `windowMs` 的第二次 press 返回 true，并**清掉记录**——
 *   连按三次只触发一次（第三次若想触发，得再按两次）。
 */
export function createDoublePressDetector(
  windowMs: number,
  now: () => number,
): DoublePressDetector {
  let lastAt: number | null = null;
  return {
    press(): boolean {
      const at = now();
      const hit = lastAt !== null && at - lastAt <= windowMs;
      // 命中后复位：避免「连按三次」被算成两次双击，也让下一次计时从零开始。
      lastAt = hit ? null : at;
      return hit;
    },
    reset(): void {
      lastAt = null;
    },
  };
}
