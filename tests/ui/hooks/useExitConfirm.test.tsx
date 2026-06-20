/**
 * useExitConfirm Hook 测试
 *
 * 验证 Ctrl+C / Ctrl+D 双击退出确认逻辑:
 * 1. 首次 press → pressedOnce=true、不触发 onConfirm。
 * 2. 窗口内二次 press → 触发 onConfirm、归零。
 * 3. 超时未二次 → 自动归零、不触发 onConfirm。
 * 4. cancel() → 归零、不触发 onConfirm。
 * 5. 超时后再 press → 视为新的第一次(不直接确认)。
 */

import { test, expect, describe, afterEach, jest } from "bun:test";
import React, { useState } from "react";
import { render } from "../../../src/ink/_vendor/testing.tsx";
import Text from "../../../src/ink/components/Text.js";
import { useExitConfirm, EXIT_CONFIRM_WINDOW_MS } from "../../../src/ui/hooks/useExitConfirm.ts";

/**
 * 宿主:自管 pressedOnce 状态(模拟 UIState),把 press/cancel 暴露到 ref 上供测试调用,
 * 渲染 `P<0|1>|C<confirmCount>` 便于字节断言。
 */
function Harness({
  apiRef,
  onConfirmSpy,
}: {
  apiRef: { current: { press: () => void; cancel: () => void } | null };
  onConfirmSpy: () => void;
}): React.ReactElement {
  const [pressedOnce, setPressedOnce] = useState(false);
  const { press, cancel } = useExitConfirm({
    pressedOnce,
    setPressedOnce,
    onConfirm: onConfirmSpy,
  });
  apiRef.current = { press, cancel };
  return React.createElement(Text, null, `P${pressedOnce ? 1 : 0}`);
}

function parsePressed(frame: string | undefined): number {
  const m = (frame ?? "").match(/P(\d)/);
  return m ? Number(m[1]) : NaN;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("useExitConfirm", () => {
  test("首次 press 置位、不确认退出", () => {
    jest.useFakeTimers();
    const apiRef: { current: { press: () => void; cancel: () => void } | null } = { current: null };
    let confirmCount = 0;
    const { lastFrame, rerender } = render(<Harness apiRef={apiRef} onConfirmSpy={() => { confirmCount++; }} />);
    expect(parsePressed(lastFrame())).toBe(0);

    apiRef.current!.press();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={() => { confirmCount++; }} />);
    expect(parsePressed(lastFrame())).toBe(1);
    expect(confirmCount).toBe(0);
  });

  test("窗口内二次 press 触发退出并归零", () => {
    jest.useFakeTimers();
    const apiRef: { current: { press: () => void; cancel: () => void } | null } = { current: null };
    let confirmCount = 0;
    const spy = () => { confirmCount++; };
    const { lastFrame, rerender } = render(<Harness apiRef={apiRef} onConfirmSpy={spy} />);

    apiRef.current!.press();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(1);

    // 窗口内（<2s）再按一次
    jest.advanceTimersByTime(500);
    apiRef.current!.press();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(confirmCount).toBe(1);
    expect(parsePressed(lastFrame())).toBe(0);
  });

  test("超时未二次按则自动归零、不退出", () => {
    jest.useFakeTimers();
    const apiRef: { current: { press: () => void; cancel: () => void } | null } = { current: null };
    let confirmCount = 0;
    const spy = () => { confirmCount++; };
    const { lastFrame, rerender } = render(<Harness apiRef={apiRef} onConfirmSpy={spy} />);

    apiRef.current!.press();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(1);

    jest.advanceTimersByTime(EXIT_CONFIRM_WINDOW_MS + 100);
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(0);
    expect(confirmCount).toBe(0);
  });

  test("cancel 归零、不退出", () => {
    jest.useFakeTimers();
    const apiRef: { current: { press: () => void; cancel: () => void } | null } = { current: null };
    let confirmCount = 0;
    const spy = () => { confirmCount++; };
    const { lastFrame, rerender } = render(<Harness apiRef={apiRef} onConfirmSpy={spy} />);

    apiRef.current!.press();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(1);

    apiRef.current!.cancel();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(0);
    expect(confirmCount).toBe(0);
  });

  test("超时归零后再 press 视为新的第一次（不直接确认）", () => {
    jest.useFakeTimers();
    const apiRef: { current: { press: () => void; cancel: () => void } | null } = { current: null };
    let confirmCount = 0;
    const spy = () => { confirmCount++; };
    const { lastFrame, rerender } = render(<Harness apiRef={apiRef} onConfirmSpy={spy} />);

    apiRef.current!.press();
    jest.advanceTimersByTime(EXIT_CONFIRM_WINDOW_MS + 100);
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(0);

    // 再按一次：应只是重新置位，不应直接确认退出
    apiRef.current!.press();
    rerender(<Harness apiRef={apiRef} onConfirmSpy={spy} />);
    expect(parsePressed(lastFrame())).toBe(1);
    expect(confirmCount).toBe(0);
  });
});
