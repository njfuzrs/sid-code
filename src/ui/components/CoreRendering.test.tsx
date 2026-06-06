/**
 * 核心组件渲染快照测试 — D4-2
 *
 * 系统级查漏补缺方案 §防线4 D4-2：对核心消息/状态组件加 golden snapshot，防渲染回归。
 * 此前 src/ui 仅 2 个测试（K1 新加），渲染层几乎裸奔。本文件覆盖几个**纯展示、低依赖**
 * 的核心组件（diff 渲染 / 加载指示 / Copy Mode 警告），用 ink-testing-library 抓
 * lastFrame 做内容断言（非逐字符 golden，避免 spinner/颜色码带来的脆弱性）。
 *
 * ink-testing-library 4.0.0 已验证可用于 @jrichman/ink@6.4.11 fork（2026-06-04 实测）。
 * fix_type: entry_code（L2）
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { DiffRenderer } from "./DiffRenderer.tsx";
import { LoadingIndicator } from "./LoadingIndicator.tsx";
import { CopyModeWarning } from "./CopyModeWarning.tsx";
import { StreamingState } from "../types.ts";

/**
 * 去除 ANSI 转义序列（含起始 ESC 字符 \x1b）。
 * DiffRenderer 会对代码做语法高亮（lowlight），当全局 theme 状态被其他测试激活后，
 * 输出帧里会注入 ANSI 颜色码，把 "const b = 3;" 拆成带色 token（如
 * "\x1b[38;2;255;255;255mconst \x1b[38;2;175;215;215mb..."），导致 toContain 与运行
 * 顺序耦合。snapshot 断言关注"内容是否渲染"，故先 strip ANSI 再断言——这正是 golden
 * snapshot 该有的鲁棒性（不依赖颜色 / 不依赖测试运行顺序）。
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("D4-2 — DiffRenderer 渲染快照", () => {
  const sampleDiff = [
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
  ].join("\n");

  test("渲染 unified diff：含增删行内容", () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent={sampleDiff} terminalWidth={80} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // 增删行的代码内容应出现
    expect(frame).toContain("const b = 3;");
    expect(frame).toContain("const c = 4;");
    expect(frame).toContain("const b = 2;");
  });

  test("空 diff：不崩溃，渲染为空或占位", () => {
    const { lastFrame } = render(<DiffRenderer diffContent="" terminalWidth={80} />);
    // 只要不抛错即可（lastFrame 可能为空字符串）
    expect(typeof lastFrame()).toBe("string");
  });

  test("新文件 diff（全 + 行）：渲染新增内容", () => {
    const newFileDiff = ["@@ -0,0 +1,2 @@", "+line one", "+line two"].join("\n");
    const { lastFrame } = render(
      <DiffRenderer diffContent={newFileDiff} terminalWidth={80} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
  });
});

describe("D4-2 — LoadingIndicator 渲染快照", () => {
  test("Idle 状态：渲染为空（null）", () => {
    const { lastFrame } = render(
      <LoadingIndicator streamingState={StreamingState.Idle} elapsedTime={0} />,
    );
    expect(lastFrame() ?? "").toBe("");
  });

  test("Responding 状态：显示加载短语 + 计时", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        streamingState={StreamingState.Responding}
        elapsedTime={5}
        currentLoadingPhrase="思考中..."
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("思考中...");
    expect(frame).toContain("5s");
  });

  test("执行工具时:显示工具名", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        streamingState={StreamingState.Responding}
        elapsedTime={2}
        toolName="read"
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("read");
  });

  test("时间格式化:≥60s 显示分钟", () => {
    const { lastFrame } = render(
      <LoadingIndicator
        streamingState={StreamingState.Responding}
        elapsedTime={75}
        currentLoadingPhrase="处理中"
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("1m15s");
  });
});

describe("D4-2 — CopyModeWarning 渲染快照", () => {
  test("enabled=true:显示 Copy Mode 提示", () => {
    const { lastFrame } = render(<CopyModeWarning enabled={true} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Copy Mode");
    expect(frame).toContain("PageUp/PageDown");
  });

  test("enabled=false:渲染为空（null）", () => {
    const { lastFrame } = render(<CopyModeWarning enabled={false} />);
    expect(lastFrame() ?? "").toBe("");
  });
});
