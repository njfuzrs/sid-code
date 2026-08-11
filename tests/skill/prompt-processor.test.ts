/**
 * Skill Prompt 处理管道测试（Task 3a / Task 8）
 */

import { describe, test, expect } from "bun:test";
import {
  processSkillPrompt,
  substituteArguments,
  executeShellCommandsInPrompt,
} from "@sid-code/core/skill/prompt-processor.ts";

const ctx = { cwd: process.cwd(), sessionId: "sess-123" };

describe("substituteArguments", () => {
  test("$ARGUMENTS / $@ / $* / {{args}} 替换完整参数", () => {
    expect(substituteArguments("do $ARGUMENTS", "a b")).toBe("do a b");
    expect(substituteArguments("do $@", "a b")).toBe("do a b");
    expect(substituteArguments("do $*", "a b")).toBe("do a b");
    expect(substituteArguments("do {{args}}", "a b")).toBe("do a b");
  });

  test("位置参数 $1 $2", () => {
    expect(substituteArguments("$1 then $2", "alpha beta")).toBe("alpha then beta");
  });

  test("缺失的位置参数替换为空", () => {
    expect(substituteArguments("$1-$2-$3", "only")).toBe("only--");
  });

  test("命名参数 $arg_name", () => {
    const out = substituteArguments("file=$file mode=$mode", "a.ts fix", ["file", "mode"]);
    expect(out).toBe("file=a.ts mode=fix");
  });

  test("命名参数单词边界：$file 不误伤 $filename", () => {
    const out = substituteArguments("$filename", "a.ts", ["file"]);
    // $file 应只匹配独立的 $file，不替换 $filename 的前缀
    expect(out).toBe("$filename");
  });
});

describe("processSkillPrompt", () => {
  test("注入 Base directory 头部（inline）", async () => {
    const out = await processSkillPrompt("正文", "", ctx, {
      skillRoot: "/tmp/my-skill",
      loadedFrom: "skills",
      injectBaseDir: true,
    });
    expect(out).toContain("Base directory for this skill: /tmp/my-skill");
    expect(out).toContain("正文");
  });

  test("${SKILL_DIR} 替换", async () => {
    const out = await processSkillPrompt("见 ${SKILL_DIR}/ref.md", "", ctx, {
      skillRoot: "/tmp/my-skill",
      loadedFrom: "skills",
      injectBaseDir: false,
    });
    expect(out).toBe("见 /tmp/my-skill/ref.md");
  });

  test("${SESSION_ID} 替换", async () => {
    const out = await processSkillPrompt("会话 ${SESSION_ID}", "", ctx, {
      loadedFrom: "skills",
    });
    expect(out).toBe("会话 sess-123");
  });

  test("MCP Skill 禁止内联 shell，替换为占位提示", async () => {
    const out = await processSkillPrompt("分支 !`git branch`", "", ctx, {
      loadedFrom: "mcp",
    });
    expect(out).toContain("[MCP Skill 不允许执行内联 shell 命令]");
    expect(out).not.toContain("git branch");
  });

  test("MCP Skill 的 ${SKILL_DIR} 替换为占位提示", async () => {
    const out = await processSkillPrompt("目录 ${SKILL_DIR}", "", ctx, {
      loadedFrom: "mcp",
      skillRoot: "/tmp/x",
    });
    expect(out).toContain("[MCP Skill 不支持 SKILL_DIR 变量]");
  });

  test("MCP Skill 不注入 Base directory 头部", async () => {
    const out = await processSkillPrompt("正文", "", ctx, {
      loadedFrom: "mcp",
      skillRoot: "/tmp/x",
      injectBaseDir: true,
    });
    expect(out).not.toContain("Base directory");
  });
});

describe("executeShellCommandsInPrompt", () => {
  test("执行 !`cmd` 并替换 stdout", async () => {
    const out = await executeShellCommandsInPrompt("结果: !`echo hello`", process.cwd());
    expect(out).toBe("结果: hello");
  });

  test("shell 命令失败时替换为错误占位", async () => {
    const out = await executeShellCommandsInPrompt(
      "x !`exit 1` y",
      process.cwd(),
    );
    expect(out).toContain("[shell error:");
  });

  test("无 !`cmd` 时原样返回", async () => {
    const out = await executeShellCommandsInPrompt("纯文本", process.cwd());
    expect(out).toBe("纯文本");
  });
});
