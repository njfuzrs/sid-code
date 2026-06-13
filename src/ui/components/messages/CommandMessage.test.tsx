/**
 * CommandMessage 渲染测试 — CM2（bash 输入/输出区分）
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "../../../ink/_vendor/testing.js";
import {
  CommandMessage,
  isBashCommand,
  extractBashCommand,
} from "./CommandMessage.tsx";

describe("CM2 — isBashCommand / extractBashCommand", () => {
  test("识别 /bash 前缀命令", () => {
    expect(isBashCommand("/bash ls -la")).toBe(true);
    expect(isBashCommand("/help")).toBe(false);
    expect(isBashCommand("/model gpt")).toBe(false);
  });

  test("还原原始 shell 命令", () => {
    expect(extractBashCommand("/bash ls -la")).toBe("ls -la");
    expect(extractBashCommand("/bash echo hi")).toBe("echo hi");
  });
});

describe("CM2 — CommandMessage 渲染", () => {
  test("bash 命令用 ! 前缀渲染输入与还原后的命令", () => {
    const { lastFrame } = render(
      <CommandMessage input="/bash ls -la" output="file1\nfile2" width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("!");
    expect(frame).toContain("ls -la");
    expect(frame).toContain("file1");
    // 不应出现内部前缀
    expect(frame).not.toContain("/bash");
  });

  test("普通斜杠命令用 > 前缀（UserMessage）", () => {
    const { lastFrame } = render(
      <CommandMessage input="/help" output="帮助内容" width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
    expect(frame).toContain("/help");
    expect(frame).toContain("帮助内容");
  });

  test("无输出时不渲染输出区", () => {
    const { lastFrame } = render(
      <CommandMessage input="/bash pwd" output={null} width={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("pwd");
  });

  test("错误输出可渲染（isError）", () => {
    const { lastFrame } = render(
      <CommandMessage
        input="/bash badcmd"
        output="command not found"
        width={80}
        isError={true}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("command not found");
  });
});
