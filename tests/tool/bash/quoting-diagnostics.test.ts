/**
 * Shell 命令引号畸形诊断测试
 *
 * 覆盖真实事故场景：中文 commit message 内层引号未转义导致命令被 shell 拆断。
 * 根因见 quoting-diagnostics.ts 头注（实测坐实：非 eval、非全角标点，而是内层引号闭合外层）。
 */

import { describe, test, expect } from "bun:test";
import {
  looksLikeQuotingBreakage,
  quotingBreakageHint,
} from "../../../src/tool/bash/quoting-diagnostics.ts";

describe("looksLikeQuotingBreakage", () => {
  test("命中：真实事故命令（多行 + 内层双引号 + 退出码 127）", () => {
    // 复刻轨迹 20260714-135438 的失败命令
    const command = `git commit -m "feat: git-status 快照冻结死循环多方向修复

补充：loop-detection 默认关闭的决策依据从"对齐 CC"升级为"实测
证据驱动"（8 条探针 + 42 会话回放，shape 误判率≈100%）。"`;
    const output =
      "错误：路径规格 'CC升级为实测' 未匹配任何 Git 已知文件\n(eval):14: command not found: 证据驱动";
    expect(looksLikeQuotingBreakage(command, 127, output)).toBe(true);
  });

  test("命中：单行但内层引号嵌套 + command not found", () => {
    const command = `git commit -m "修复"对齐"问题"`;
    const output = "command not found: 问题";
    expect(looksLikeQuotingBreakage(command, 127, output)).toBe(true);
  });

  test("不命中：正常成功的简单命令（退出码 0）", () => {
    expect(looksLikeQuotingBreakage("git status", 0, "位于分支 master")).toBe(
      false,
    );
  });

  test("不命中：退出码非 0 但不是 shell 拆词错误（如编译失败）", () => {
    const command = `git commit -m "正常单行提交"`;
    const output = "error: pathspec did not... (实际编译错误)";
    // 退出码 1 且无 command not found / 未匹配特征 → 不误报
    expect(looksLikeQuotingBreakage(command, 1, output)).toBe(false);
  });

  test("不命中：命令不含任何引号（不可能是引号畸形）", () => {
    expect(
      looksLikeQuotingBreakage("git push origin master", 127, "command not found"),
    ).toBe(false);
  });

  test("不命中：含引号但引号平衡、单行、无嵌套（退出码 127 来自别的原因）", () => {
    // 引号成对平衡、单行、无 -m 内嵌套 → 不判为引号畸形
    const command = `foobar "arg"`;
    const output = "command not found: foobar";
    expect(looksLikeQuotingBreakage(command, 127, output)).toBe(false);
  });

  test("命中：单引号未闭合（奇数个单引号）+ 拆词报错", () => {
    const command = `git commit -m 'message with ' unescaped quote'`;
    const output = "unexpected EOF while looking for matching quote";
    expect(looksLikeQuotingBreakage(command, 2, output)).toBe(true);
  });

  test("不命中：合法多行命令 + 引号平衡 + 子命令找不到（多行本身不是判据）", () => {
    // 回归保护：收紧判据后，仅"多行"不足以命中——合法多行脚本引号平衡，
    // 即便某子命令恰好 127 找不到，也不该误判为引号畸形附加误导性引导。
    const command = `echo "开始"\nmycli run\necho "结束"`;
    const output = "command not found: mycli";
    expect(looksLikeQuotingBreakage(command, 127, output)).toBe(false);
  });

  test("不命中：全角标点但引号平衡、无拆词报错（全角对 shell 无害）", () => {
    // 全角括号（）「」不会导致 shell 出错，只要引号本身平衡就正常
    const command = `git commit -m "方向（一）：全角括号测试「引用」（8条）"`;
    expect(looksLikeQuotingBreakage(command, 0, "")).toBe(false);
  });
});

describe("quotingBreakageHint", () => {
  test("git commit 给出 git commit -F - heredoc 模板", () => {
    const hint = quotingBreakageHint(`git commit -m "..."`);
    expect(hint).toContain("git commit -F -");
    expect(hint).toContain("<< 'SIDEOF'");
    expect(hint).toContain("SIDEOF");
  });

  test("非 git commit 给出通用 heredoc + 临时文件方案", () => {
    const hint = quotingBreakageHint(`echo "..." | some-cmd`);
    expect(hint).toContain("<< 'SIDEOF'");
    expect(hint).toContain("write");
  });

  test("引导文案不含误导性 eval/全角归因（防止旧错误结论回潮）", () => {
    const hint = quotingBreakageHint(`git commit -m "x"`);
    // 根因是内层引号，不是 eval 也不是全角标点，文案不应甩锅给它们
    expect(hint).not.toContain("eval");
    expect(hint).not.toContain("全角");
  });
});
