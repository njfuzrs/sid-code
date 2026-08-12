import { describe, expect, test } from "bun:test";
import { buildInteractiveBashToolUse, parseShellInput } from "@sid-code/cli/ui/shell-input.ts";

describe("parseShellInput", () => {
  test("解析行首感叹号后的 shell 命令", () => {
    expect(parseShellInput("!git log")).toBe("git log");
  });

  test("允许行首空白并保留命令内部空格", () => {
    expect(parseShellInput("  !  git   log --oneline")).toBe("git   log --oneline");
  });

  test("普通文本和斜杠命令不进入 Shell 路由", () => {
    expect(parseShellInput("git log")).toBeNull();
    expect(parseShellInput("/help")).toBeNull();
  });

  test("只有感叹号或空白命令时返回 null", () => {
    expect(parseShellInput("!")).toBeNull();
    expect(parseShellInput("!   ")).toBeNull();
  });

  test("解析结果是原始 Bash 命令，不生成 /bash 斜杠命令", () => {
    const command = parseShellInput("!git log");
    expect(command).toBe("git log");
    expect(command).not.toBe("/bash git log");
  });

  test("构造 bash tool_use 请求而不是 slash command", () => {
    expect(buildInteractiveBashToolUse(" git log ")).toEqual({
      type: "tool_use",
      id: "interactive-bash-test",
      name: "bash",
      input: {
        command: "git log",
        description: "用户通过 ! 前缀执行：git log",
      },
    });
    expect(buildInteractiveBashToolUse("   ")).toBeNull();
  });
});
