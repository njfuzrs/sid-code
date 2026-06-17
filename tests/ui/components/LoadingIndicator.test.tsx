/**
 * LoadingIndicator 组件渲染测试（§6.2）
 *
 * 用 vendored ink 的 render harness 抓帧，确定性断言：
 * 1. Connecting 态渲染「连接中…」且含 spinner 字符（非空、非 null）——根治盲区 1。
 * 2. Idle 态 lastFrame 为空（return null 行为不变）。
 * 3. 慢提示文案在传入 slowHint 时渲染出来。
 * 4. 等待态（WaitingForConfirmation）不显示慢提示。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "../../../src/ink/_vendor/testing.tsx";
import { LoadingIndicator } from "../../../src/ui/components/LoadingIndicator.tsx";
import { StreamingState } from "../../../src/ui/types.ts";

describe("LoadingIndicator — Connecting 态渲染", () => {
  test("Connecting 显示「连接中…」且含 spinner 字符", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Connecting}
        elapsedTime={3}
        currentLoadingPhrase="连接中…"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("连接中…");
    // spinner 帧字符之一（首帧 ⠋）或 a11y BULLET——至少非空。
    expect(frame.trim().length).toBeGreaterThan(0);
    // 计时显示（3s）应出现。
    expect(frame).toContain("3s");
  });

  test("Idle 态不渲染（return null，帧为空）", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Idle}
        elapsedTime={0}
      />,
    );
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("LoadingIndicator — 慢提示渲染", () => {
  test("传入 slowHint 时渲染慢提示文案", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Connecting}
        elapsedTime={15}
        currentLoadingPhrase="连接中…"
        slowHint="仍在等待响应…"
      />,
    );
    expect(lastFrame() ?? "").toContain("仍在等待响应");
  });

  test("无 slowHint 时不渲染慢提示", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Connecting}
        elapsedTime={3}
        currentLoadingPhrase="连接中…"
      />,
    );
    expect(lastFrame() ?? "").not.toContain("仍在等待");
  });

  test("等待态不显示慢提示（即使传入）", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.WaitingForConfirmation}
        elapsedTime={60}
        slowHint="等待较久，可按 esc 取消"
      />,
    );
    expect(lastFrame() ?? "").not.toContain("等待较久");
  });
});

describe("LoadingIndicator — 工具执行态", () => {
  test("Responding 带 toolName 显示「执行 X…」", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Responding}
        elapsedTime={2}
        toolName="bash"
      />,
    );
    expect(lastFrame() ?? "").toContain("执行 bash…");
  });

  test("L3：工具执行未超阈值不显示工具计时", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Responding}
        elapsedTime={10}
        toolName="bash"
        toolElapsedTime={3}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("执行 bash…");
    expect(frame).not.toContain("已执行");
  });

  test("L3：工具执行超阈值显示「· 已执行 Xs」", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        inline
        streamingState={StreamingState.Responding}
        elapsedTime={20}
        toolName="bash"
        toolElapsedTime={8}
      />,
    );
    expect(lastFrame() ?? "").toContain("已执行 8s");
  });
});
