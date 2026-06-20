/**
 * 退出二次确认 hook —— Ctrl+C / Ctrl+D 双击退出
 *
 * 背景:此前 setCtrlCPressedOnce/setCtrlDPressedOnce 导出但无人调用,ExitWarning
 * 「再按一次退出」是死代码;Ctrl+C 单击即退,误触就直接丢会话。本 hook 把"按一次→提示、
 * 窗口内再按一次→真退出、超时或继续输入→取消"这套逻辑收口为可复用单元。
 *
 * 设计:
 * - 第一次触发:置 pressedOnce=true(驱动 ExitWarning 显示),启动 timeout 计时器,window 内无
 *   第二次则自动归零(视为取消)。
 * - window 内第二次触发:执行 onConfirm(真正退出)。
 * - cancel():外部在"用户继续输入/提交"时调用,立即取消确认态(对标 cc:打字即取消退出意图)。
 *
 * 计时器在卸载/再次触发时清理,避免泄漏与陈旧回调。
 */

import { useCallback, useEffect, useRef } from "react";

/** 二次确认窗口(ms):两次按键间隔超过此值,第一次作废。对标 cc/gemini-cli 的 ~2s。 */
export const EXIT_CONFIRM_WINDOW_MS = 2000;

export interface UseExitConfirmProps {
  /** 当前是否已处于"按过一次"状态(来自 UIState,驱动 ExitWarning)。 */
  pressedOnce: boolean;
  /** 设置"按过一次"状态。 */
  setPressedOnce: (value: boolean) => void;
  /** 二次确认通过后执行(真正退出)。 */
  onConfirm: () => void;
  /** 确认窗口(ms),默认 EXIT_CONFIRM_WINDOW_MS。 */
  windowMs?: number;
}

export interface UseExitConfirmResult {
  /** 处理一次退出键按下:首次置位+计时,窗口内二次则确认退出。返回 true 表示已消费按键。 */
  press: () => void;
  /** 取消确认态(用户继续输入/提交时调用)。 */
  cancel: () => void;
}

export function useExitConfirm({
  pressedOnce,
  setPressedOnce,
  onConfirm,
  windowMs = EXIT_CONFIRM_WINDOW_MS,
}: UseExitConfirmProps): UseExitConfirmResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // pressedOnce 镜像到 ref,供 press() 闭包读最新值(避免 handler 闭包捕获陈旧 state)。
  const pressedOnceRef = useRef(pressedOnce);
  pressedOnceRef.current = pressedOnce;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    if (pressedOnceRef.current) {
      setPressedOnce(false);
    }
  }, [clearTimer, setPressedOnce]);

  const press = useCallback(() => {
    if (pressedOnceRef.current) {
      // 窗口内第二次:确认退出。
      clearTimer();
      setPressedOnce(false);
      onConfirm();
      return;
    }
    // 第一次:置位 + 启动归零计时器。
    setPressedOnce(true);
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPressedOnce(false);
    }, windowMs);
  }, [clearTimer, setPressedOnce, onConfirm, windowMs]);

  // 卸载时清理计时器,防止陈旧回调在组件销毁后触发 setState。
  useEffect(() => clearTimer, [clearTimer]);

  return { press, cancel };
}
