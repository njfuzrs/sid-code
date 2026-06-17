/**
 * 规则阴影检测 + 按工具过滤 + 严重度分档单测
 *
 * 对标 claude-code Unreachable Rules：
 *  - deny 遮蔽 allow → severity "blocked"（完全拦截）
 *  - ask 遮蔽 allow → severity "shadowed"（仍弹窗）
 *  - getShadowedRulesForTool 只返回与目标工具相关的条目
 */

import { test, expect, describe } from "bun:test";
import {
  detectShadowedRules,
  getShadowedRulesForTool,
} from "../../src/permission/shadowed-rules.ts";
import type { SourcedPermissionRule } from "../../src/permission/types.ts";

describe("shadowed-rules 严重度分档", () => {
  test("低优先级 allow 被高优先级 deny 覆盖 → blocked", () => {
    const rules: SourcedPermissionRule[] = [
      { source: "userSettings", behavior: "allow", rawRule: "Bash(npm *)" },
      { source: "localSettings", behavior: "deny", rawRule: "Bash(npm *)" },
    ];
    const result = detectShadowedRules(rules);
    expect(result.length).toBe(1);
    expect(result[0].severity).toBe("blocked");
    expect(result[0].shadowed.rawRule).toBe("Bash(npm *)");
    expect(result[0].shadowedBy.behavior).toBe("deny");
  });

  test("低优先级 allow 被高优先级 ask 覆盖 → shadowed", () => {
    const rules: SourcedPermissionRule[] = [
      { source: "userSettings", behavior: "allow", rawRule: "Edit" },
      { source: "policySettings", behavior: "ask", rawRule: "Edit" },
    ];
    const result = detectShadowedRules(rules);
    expect(result.length).toBe(1);
    expect(result[0].severity).toBe("shadowed");
  });

  test("同优先级或同行为不算阴影", () => {
    const rules: SourcedPermissionRule[] = [
      { source: "userSettings", behavior: "allow", rawRule: "Bash(ls *)" },
      { source: "userSettings", behavior: "deny", rawRule: "Bash(ls *)" },
    ];
    // 同来源 → 优先级相等 → 不报阴影
    expect(detectShadowedRules(rules).length).toBe(0);
  });
});

describe("getShadowedRulesForTool 按工具过滤", () => {
  const rules: SourcedPermissionRule[] = [
    { source: "userSettings", behavior: "allow", rawRule: "Bash(ls:*)" },
    { source: "projectSettings", behavior: "deny", rawRule: "Bash(ls:*)" },
    { source: "userSettings", behavior: "allow", rawRule: "Edit" },
    { source: "localSettings", behavior: "ask", rawRule: "Edit" },
  ];

  test("只返回目标工具相关的阴影规则", () => {
    const bashShadows = getShadowedRulesForTool(rules, "Bash");
    expect(bashShadows.length).toBe(1);
    expect(bashShadows[0].shadowed.rawRule).toBe("Bash(ls:*)");
    expect(bashShadows[0].severity).toBe("blocked");

    const editShadows = getShadowedRulesForTool(rules, "Edit");
    expect(editShadows.length).toBe(1);
    expect(editShadows[0].severity).toBe("shadowed");
  });

  test("大小写不敏感匹配工具名", () => {
    expect(getShadowedRulesForTool(rules, "bash").length).toBe(1);
  });

  test("无匹配工具 / 空工具名 → 空数组", () => {
    expect(getShadowedRulesForTool(rules, "Read").length).toBe(0);
    expect(getShadowedRulesForTool(rules, "").length).toBe(0);
  });
});
