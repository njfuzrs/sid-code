/**
 * PR2（B1 / B2）分类器请求结构与工具通道测试
 *
 * 三组断言各守一条方案约定：
 * 1. §4.3.3 请求结构：`<user_intent>` 是**稳定前缀**（同轮共享 prefix cache），
 *    `<action>` 在后且带实际 cwd / workspace / path_verdict；
 * 2. §4.3.2 账本缺失时的退化：不带 `<user_intent>` 内容也不崩（老调用方兼容）；
 * 3. §4.3.5 B2：`enter_worktree` 自报「与安全无关」走 Level 0，`exit_worktree` 不走——
 *    后者 remove 会丢未提交改动，必须留给人看。
 */

import { describe, test, expect } from "bun:test";
import {
  ToolClassifier,
  composeClassifierUserMessage,
  type ToolClassifyRequest,
} from "@sid-code/core/permission/tool-classifier.ts";
import { UserIntentLedger } from "@sid-code/core/permission/user-intent.ts";
import { EnterWorktreeTool } from "@sid-code/core/tool/enter-worktree.ts";
import { ExitWorktreeTool } from "@sid-code/core/tool/exit-worktree.ts";

/** 造一个带账本的请求 */
function reqWithIntent(texts: string[], overrides: Partial<ToolClassifyRequest> = {}) {
  const ledger = new UserIntentLedger();
  for (const t of texts) ledger.record(t);
  return {
    toolName: "bash",
    input: { command: "cd ws && git push -u origin feat/x" },
    cwd: "/ws",
    workspace: "/ws",
    pathVerdict: "inside" as const,
    userIntent: ledger.snapshot(),
    ...overrides,
  } satisfies ToolClassifyRequest;
}

describe("composeClassifierUserMessage：稳定前缀 + 动作在后", () => {
  test("user_intent 在前，action 在后，条目按 seq 列出", () => {
    const msg = composeClassifierUserMessage(reqWithIntent(["修登录 bug", "创建 PR 并自动合并"]));

    const intentIdx = msg.indexOf("<user_intent");
    const closeIdx = msg.indexOf("</user_intent>");
    const actionIdx = msg.indexOf("<action>");
    expect(intentIdx).toBe(0); // 前缀从第一行开始
    expect(closeIdx).toBeGreaterThan(intentIdx);
    expect(actionIdx).toBeGreaterThan(closeIdx);

    expect(msg).toContain("[1] 修登录 bug");
    expect(msg).toContain("[2] 创建 PR 并自动合并");
    expect(msg).toContain('omitted="0"');
  });

  test("前缀稳定性：同一账本 + 不同 action → user_intent 段逐字节相同（prefix cache 的前提）", () => {
    const a = composeClassifierUserMessage(
      reqWithIntent(["同一句话"], { input: { command: "ls" } }),
    );
    const b = composeClassifierUserMessage(
      reqWithIntent(["同一句话"], { input: { command: "git push" }, cwd: "/ws/sub" }),
    );
    const prefix = (s: string) => s.slice(0, s.indexOf("<action>"));
    expect(prefix(a)).toBe(prefix(b));
  });

  test("action 带 tool / input / cwd / workspace / path_verdict", () => {
    const msg = composeClassifierUserMessage(
      reqWithIntent(["创建 PR"], { cwd: "/ws/feature", pathVerdict: "outside" }),
    );
    const actionJson = JSON.parse(msg.slice(msg.indexOf("<action>") + 8, msg.indexOf("</action>")));
    expect(actionJson.tool).toBe("bash");
    expect(actionJson.cwd).toBe("/ws/feature");
    expect(actionJson.workspace).toBe("/ws");
    expect(actionJson.path_verdict).toBe("outside");
  });

  test("classifierInput 非空时替代原始 input（G7 精简视图优先）", () => {
    const msg = composeClassifierUserMessage(
      reqWithIntent(["x"], { classifierInput: "git push 功能分支", input: { command: "很长" } }),
    );
    const actionJson = JSON.parse(msg.slice(msg.indexOf("<action>") + 8, msg.indexOf("</action>")));
    expect(actionJson.input).toBe("git push 功能分支");
  });

  test("未接线的老调用方：无 userIntent 时仍可用，omitted=0 且说明「用户还没发过消息」", () => {
    const msg = composeClassifierUserMessage({
      toolName: "bash",
      input: { command: "ls" },
      cwd: "/ws",
    });
    expect(msg).toContain('omitted="0"');
    expect(msg).toContain("用户还没有发过消息");
    // workspace / path_verdict 未传时不写出，避免模型把「没传」读成「明确判定为未知」
    expect(msg).not.toContain('"workspace"');
    expect(msg).not.toContain('"path_verdict"');
  });

  test("omitted 透传账本挤出条数", () => {
    const msg = composeClassifierUserMessage(
      reqWithIntent(["1", "2", "3", "4", "5", "6", "7", "8"]),
    );
    expect(msg).toContain('omitted="3"');
  });
});

describe("B2：enter_worktree 自报与安全无关、exit_worktree 不报", () => {
  const clf = new ToolClassifier({ enabled: true });

  test("enter_worktree.toAutoClassifierInput() 返回空串（走 Level 0）", () => {
    expect(new EnterWorktreeTool().toAutoClassifierInput()).toBe("");
  });

  test("exit_worktree 不实现零成本通道（remove 会丢弃未提交改动）", () => {
    // 用结构化类型断言而不是直接点属性：`ExitWorktreeTool` 上根本没有这个方法，
    // 直接写 `tool.toAutoClassifierInput` 会 TS2339。这里要断言的正是「它不存在」。
    const tool = new ExitWorktreeTool() as unknown as {
      toAutoClassifierInput?: () => string;
    };
    // 未实现 → checker 侧取到 undefined → 回退原始 input 交给分类器判断
    expect(tool.toAutoClassifierInput).toBeUndefined();
  });

  test("Level 0 命中：classifierInput 为空串直接 safe，且不发请求（via=fast-path）", () => {
    const r = clf.fastPath({
      toolName: "enter_worktree",
      input: { name: "fix/x" },
      classifierInput: "",
      cwd: "/ws",
      pathVerdict: "inside",
    });
    expect(r).not.toBeNull();
    expect(r?.safe).toBe(true);
    expect(r?.via).toBe("fast-path");
  });

  test("enter_worktree 若非空视图仍走 LLM（证明零成本来自空串声明，不是工具名白名单）", () => {
    const r = clf.fastPath({
      toolName: "enter_worktree",
      input: { name: "fix/x" },
      classifierInput: "enter_worktree { name: 'fix/x' }",
      cwd: "/ws",
      pathVerdict: "inside",
    });
    expect(r).toBeNull();
  });
});
