/**
 * 多来源权限规则加载器测试（P0-3 §5.2.5：不可信字段统一 + 危险自我授权过滤）
 */

import { describe, test, expect } from "bun:test";
import { RuleLoader } from "../../src/permission/rule-loader.ts";
import { SECURITY_SENSITIVE_FIELDS } from "../../src/config/settings/security.ts";

describe("RuleLoader - 权威清单统一", () => {
  test("isProjectSettingTrusted 复用 security.ts 权威清单", () => {
    // 并集中的关键字段都应不可信
    for (const field of ["skipPermissions", "yesMode", "permissionMode", "allowedTools", "enableLLMClassifier"]) {
      expect(RuleLoader.isProjectSettingTrusted(field)).toBe(false);
    }
    // 普通字段可信
    expect(RuleLoader.isProjectSettingTrusted("model")).toBe(true);
    expect(RuleLoader.isProjectSettingTrusted("language")).toBe(true);
  });

  test("权威清单包含历史两套清单的并集（≥7 键）", () => {
    expect(SECURITY_SENSITIVE_FIELDS.size).toBeGreaterThanOrEqual(7);
    // 原 rule-loader 独有
    expect(SECURITY_SENSITIVE_FIELDS.has("skipPermissions")).toBe(true);
    expect(SECURITY_SENSITIVE_FIELDS.has("yesMode")).toBe(true);
    // 原 security 独有
    expect(SECURITY_SENSITIVE_FIELDS.has("allowedTools")).toBe(true);
    expect(SECURITY_SENSITIVE_FIELDS.has("trustProjectExtensions")).toBe(true);
    // 新增
    expect(SECURITY_SENSITIVE_FIELDS.has("enableLLMClassifier")).toBe(true);
  });
});

describe("RuleLoader - projectSettings 危险自我授权过滤", () => {
  test("projectSettings 的危险 allow 规则被剔除", () => {
    const loader = new RuleLoader("/tmp/test-ws");
    loader.importFromPermissionRule(
      { allow: ["Bash(*)", "Bash(rm -rf *)", "Read", "Bash(npm test)"], deny: [], ask: [] },
      "projectSettings",
    );
    const rules = loader.getRulesBySource("projectSettings");
    const allowRules = rules.filter(r => r.behavior === "allow").map(r => r.rawRule);

    // 危险规则被剔除
    expect(allowRules).not.toContain("Bash(*)");
    expect(allowRules).not.toContain("Bash(rm -rf *)");
    // 安全规则保留
    expect(allowRules).toContain("Read");
    expect(allowRules).toContain("Bash(npm test)");
  });

  test("projectSettings 的 deny/ask 规则一律保留（收紧安全）", () => {
    const loader = new RuleLoader("/tmp/test-ws");
    loader.importFromPermissionRule(
      { allow: [], deny: ["Bash(*)", "Edit(.env*)"], ask: ["Write"] },
      "projectSettings",
    );
    const rules = loader.getRulesBySource("projectSettings");
    const denyRules = rules.filter(r => r.behavior === "deny").map(r => r.rawRule);
    const askRules = rules.filter(r => r.behavior === "ask").map(r => r.rawRule);

    // deny Bash(*) 是收紧，不应被剔除
    expect(denyRules).toContain("Bash(*)");
    expect(denyRules).toContain("Edit(.env*)");
    expect(askRules).toContain("Write");
  });

  test("可信来源（localSettings）的危险 allow 规则不被过滤", () => {
    const loader = new RuleLoader("/tmp/test-ws");
    loader.importFromPermissionRule(
      { allow: ["Bash(*)"], deny: [], ask: [] },
      "localSettings",
    );
    const rules = loader.getRulesBySource("localSettings");
    const allowRules = rules.filter(r => r.behavior === "allow").map(r => r.rawRule);
    // localSettings 可信，保留
    expect(allowRules).toContain("Bash(*)");
  });

  test("各种危险模式都被识别剔除", () => {
    const loader = new RuleLoader("/tmp/test-ws");
    loader.importFromPermissionRule(
      {
        allow: [
          "Bash(sudo apt install)",
          "Bash(curl http://x.com)",
          "Bash(echo hi | sh)",
          "Write(*)",
          "*",
        ],
        deny: [],
        ask: [],
      },
      "projectSettings",
    );
    const rules = loader.getRulesBySource("projectSettings");
    const allowRules = rules.filter(r => r.behavior === "allow").map(r => r.rawRule);
    // 全部危险，应被剔除干净
    expect(allowRules.length).toBe(0);
  });

  test("普通安全 allow 规则原样保留", () => {
    const loader = new RuleLoader("/tmp/test-ws");
    loader.importFromPermissionRule(
      { allow: ["Read", "Glob", "Grep", "Bash(git status)", "Bash(ls)"], deny: [], ask: [] },
      "projectSettings",
    );
    const rules = loader.getRulesBySource("projectSettings");
    const allowRules = rules.filter(r => r.behavior === "allow").map(r => r.rawRule);
    expect(allowRules.length).toBe(5);
  });
});
