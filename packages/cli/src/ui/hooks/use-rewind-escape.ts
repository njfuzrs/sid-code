/**
 * Esc 双击打开会话回退面板（A1）。
 *
 * ## 背景
 * 帮助里写的「Esc Esc 空闲时打开会话回退」在正常速度下**用不了**：
 *   - 面板只认 `key.name === "escape-escape"`；
 *   - 那个事件只在解析器**同一轮 data** 里收到 `\x1b\x1b` 时才合成；
 *   - 而 `ESC_TIMEOUT = 50ms` 一到就把单个 `\x1b` 作为 `escape` 冲刷出去，
 *     人手双击间隔 150–300ms，于是永远是两个独立 `escape`。
 *
 * 修法是在这一层按**时间窗口**判定双击（`hooks/double-press.ts`），`escape-escape`
 * 保留为快路径。为什么不能改解析层、也不能调大 `ESC_TIMEOUT`，见 double-press.ts 头注释。
 *
 * ## 三条派发路径（优先级从高到低）
 * 1. **High**：`escape-escape` 快路径；
 * 2. **Critical**：只观察、不消费的复位器——任何非 Esc 按键清掉计时，防止
 *    「Esc · 打字 · Esc」被判成双击。必须是 Critical 才看得到被 High/Normal 消费掉的按键；
 * 3. **Low**：人手双击的慢路径。让到 Low 的理由是单个 Esc 在这些场景已有语义，
 *    必须让它们先消费，且**被消费掉的那次 Esc 不计入双击**：
 *      - App 中断 handler（High）：忙时中断，否则「中断 + 再按一次」会立刻弹面板；
 *      - 各 Dialog（Critical）：关面板；
 *      - InputArea（Normal）：撤回失败输入 / 关闭反向搜索 / 关闭补全；
 *      - vim（Normal，经 InputArea）：insert→normal、退出 visual。
 *
 * ## 为什么抽成 hook
 * 门控与三条路径的接线是这次修复的核心，必须有测试能**真实驱动**（真实 KeypressProvider
 * + 真实优先级派发）。留在 App.tsx 里就只能靠源码文本断言去锁，测不到「谁先消费」。
 */

import { useCallback, useMemo } from "react";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { createDoublePressDetector, DOUBLE_ESC_WINDOW_MS } from "./double-press.ts";

/** 打开回退面板的前置条件（由 App 从当前 UI 状态投影）。 */
export interface RewindEscapeGate {
  /** 忙：加载 / 流式输出 / 工具执行中。忙时单个 Esc 是「中断」，不能凑成双击。 */
  busy: boolean;
  /** 有任何面板或待确认请求在前台（activeDialog / commandPanel / 各种 request）。 */
  panelOpen: boolean;
  /** 回退能力是否已接线。headless / bridge 无回调时不响应，避免开一个空面板。 */
  wired: boolean;
}

export interface UseRewindEscapeOptions {
  gate: RewindEscapeGate;
  /**
   * 读「输入框当前是否为空」。
   *
   * 必须是函数而不是布尔值：keypress handler 的闭包会拿到**上一帧**的 state，
   * 所以生产侧传的是 `() => inputEmptyRef.current`（UIState 里的可变引用）。
   * 输入框非空时不打开——用户正在编辑，不能被一个面板打断。
   */
  isInputEmpty: () => boolean;
  /** 打开回退面板。 */
  onOpen: () => void;
  /**
   * 第一次 Esc（判定为「双击的第一击」）时的引导提示。
   * 渐进衰减由调用方用 shouldShowHint / markHintShown 实现。
   */
  onFirstPress?: () => void;
}

export function useRewindEscape({
  gate,
  isInputEmpty,
  onOpen,
  onFirstPress,
}: UseRewindEscapeOptions): void {
  const { busy, panelOpen, wired } = gate;

  const canOpen = useCallback((): boolean => {
    if (busy || panelOpen || !wired) return false;
    return isInputEmpty();
  }, [busy, panelOpen, wired, isInputEmpty]);

  // 一个实例管整条生命周期，计时状态跨渲染保留。
  const detector = useMemo(() => createDoublePressDetector(DOUBLE_ESC_WINDOW_MS, Date.now), []);

  // ① 快路径：同一轮 data 里的 `\x1b\x1b`。
  useKeypress(KeypressPriority.High, (key: Key) => {
    if (key.name !== "escape-escape") return false;
    // 无论门控是否通过都复位：这一击已被快路径认领，不该再和下一次凑成双击。
    detector.reset();
    if (!canOpen()) return false;
    onOpen();
    return true;
  });

  // ② 只观察、不消费：任何非 Esc 按键清掉双击计时。
  // 恒返回 false，所以不改变任何既有语义（只是让 Critical 层多看一眼）。
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name !== "escape" && key.name !== "escape-escape") detector.reset();
    return false;
  });

  // ③ 慢路径：人手双击。
  useKeypress(KeypressPriority.Low, (key: Key) => {
    if (key.name !== "escape") return false;
    if (!canOpen()) {
      // 门控不通过时也复位：这次 Esc 没被当成「第一击」，不该让下一次 Esc 凑成双击。
      detector.reset();
      return false;
    }
    if (!detector.press()) {
      // 第一击：不吞键（Low 已是最低层，返回 false 等价于「不消费」），顺手给一次引导。
      onFirstPress?.();
      return false;
    }
    onOpen();
    return true;
  });
}
