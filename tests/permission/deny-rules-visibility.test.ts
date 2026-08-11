/**
 * deny 规则前置告知单测（缺口 D）
 *
 * 覆盖：
 * - PermissionChecker.describeDenyRules：列出禁用工具 + deny 规则；无约束返回空串
 * - generateDenyRulesAttachment：有摘要生成附件、空摘要返回 null
 * - buildSystemPrompt：传入 denyRulesSummary 时注入约束块、空时不注入
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { generateDenyRulesAttachment } from "@sid-code/core/config/attachments.ts";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...defaultConfig(), ...overrides } as Config;
}

describe("PermissionChecker.describeDenyRules（缺口 D）", () => {
  test("列出禁用工具", () => {
    const checker = new PermissionChecker(makeConfig({ disallowedTools: ["bash", "write"] }));
    const desc = checker.describeDenyRules();
    expect(desc).toContain("禁用工具");
    expect(desc).toContain("bash");
    expect(desc).toContain("write");
  });

  test("列出 deny 规则模式", () => {
    const checker = new PermissionChecker(
      makeConfig({ disallowedTools: [] }),
      { deny: ["Edit(.env*)", "Bash(rm *)"] },
    );
    const desc = checker.describeDenyRules();
    expect(desc).toContain("Edit(.env*)");
    expect(desc).toContain("Bash(rm *)");
  });

  test("同时含禁用工具 + deny 规则", () => {
    const checker = new PermissionChecker(
      makeConfig({ disallowedTools: ["web_fetch"] }),
      { deny: ["Bash(curl *)"] },
    );
    const desc = checker.describeDenyRules();
    expect(desc).toContain("web_fetch");
    expect(desc).toContain("Bash(curl *)");
  });

  test("无任何约束时返回空字符串（调用方据此不注入空块）", () => {
    const checker = new PermissionChecker(makeConfig({ disallowedTools: [] }));
    expect(checker.describeDenyRules()).toBe("");
  });
});

describe("generateDenyRulesAttachment（缺口 D）", () => {
  test("有摘要时生成 permission-constraints 附件", () => {
    const att = generateDenyRulesAttachment("- 禁用工具：bash");
    expect(att).not.toBeNull();
    expect(att!.content).toContain("<permission-constraints>");
    expect(att!.content).toContain("禁用工具：bash");
  });

  test("空摘要返回 null", () => {
    expect(generateDenyRulesAttachment("")).toBeNull();
    expect(generateDenyRulesAttachment("   ")).toBeNull();
  });
});

describe("buildSystemPrompt — deny 规则注入（缺口 D）", () => {
  test("传入 denyRulesSummary 时注入约束块", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      denyRulesSummary: "- 禁用工具：bash、write",
      model: "claude-sonnet-4-6",
    });
    expect(prompt).toContain("permission-constraints");
    expect(prompt).toContain("禁用工具：bash、write");
  });

  test("未传 denyRulesSummary 时不注入约束块", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      model: "claude-sonnet-4-6",
    });
    expect(prompt).not.toContain("permission-constraints");
  });

  test("空 denyRulesSummary 不注入", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      denyRulesSummary: "",
      model: "claude-sonnet-4-6",
    });
    expect(prompt).not.toContain("permission-constraints");
  });
});
