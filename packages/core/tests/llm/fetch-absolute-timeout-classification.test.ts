/**
 * PR7 回归：runtime 级 `TimeoutError` 的分类与"不崩进程"
 *
 * 缺陷形态（改造前）：`AbortSignal.timeout` 到点时 runtime 抛
 * `DOMException("...", "TimeoutError")`，它**既不是** RetryableError **也不是**
 * TerminalError → 命中 `fallback.ts` 的 fail-fast 零重试分支。一条被绝对硬顶
 * 掐断的流因此一次重试都没有。
 *
 * 本文件钉三件事：
 *   ① 分类 = RetryableError("timeout")；
 *   ② 判据是**结构性** `err.name`，不是消息文本（改文案不改结论）；
 *   ③ 它与 `isAbortError` 刻意互斥（不是"用户取消"，不该被静默吞掉）。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  classifyError,
  isAbortError,
  isRuntimeTimeoutError,
  RetryableError,
} from "@sid-code/core/llm/errors.ts";

/** 造一个与 runtime 同形的 TimeoutError（`AbortSignal.timeout` 抛的就是这个） */
function makeTimeoutError(message = "The operation timed out."): DOMException {
  return new DOMException(message, "TimeoutError");
}

describe("PR7 — TimeoutError 纳入可重试", () => {
  test("classifyError 归成 RetryableError，reason=timeout", () => {
    const classified = classifyError(makeTimeoutError());
    expect(classified).toBeInstanceOf(RetryableError);
    expect((classified as RetryableError).reason).toBe("timeout");
  });

  test("判据是 err.name，不是消息文本：换任意文案结论不变", () => {
    // 三种文案：英文原文 / 中文 / 完全不含 "timeout" 字样。
    // 若实现退回文本匹配，第三条必然失败——那正是本用例要拦的回归
    // （memory: stream-timeout-misclassified-as-cancel-rootcause）。
    for (const msg of ["The operation timed out.", "操作超时", "zzz"]) {
      const classified = classifyError(makeTimeoutError(msg));
      expect(classified).toBeInstanceOf(RetryableError);
      expect((classified as RetryableError).reason).toBe("timeout");
    }
  });

  test("负向对照：name 不是 TimeoutError 的错误不被本条分支拦走", () => {
    // 一个消息里带 "timed out" 但 name 是 AbortError 的错误 → 属于 abort 语义，
    // 不该被 isRuntimeTimeoutError 命中（否则用户 ESC 会被当成可重试超时重发一次）。
    const abortish = new DOMException("The operation timed out.", "AbortError");
    expect(isRuntimeTimeoutError(abortish)).toBe(false);
    expect(isAbortError(abortish)).toBe(true);
  });

  test("与 isAbortError 互斥：TimeoutError 不是 abort", () => {
    const err = makeTimeoutError();
    expect(isRuntimeTimeoutError(err)).toBe(true);
    // 关键的互斥关系：认成 abort 就会被上层当"用户主动取消"静默吞掉，
    // 表现为"任务停了但没有任何报错"——比崩溃更难查。
    expect(isAbortError(err)).toBe(false);
  });

  test("非对象 / 无 name 的输入不误判", () => {
    expect(isRuntimeTimeoutError(undefined)).toBe(false);
    expect(isRuntimeTimeoutError(null)).toBe(false);
    expect(isRuntimeTimeoutError("TimeoutError")).toBe(false); // 裸字符串不算
    expect(isRuntimeTimeoutError({})).toBe(false);
  });
});
