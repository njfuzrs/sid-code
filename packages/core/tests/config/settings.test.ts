/**
 * Settings 子系统单元测试
 * 覆盖：合并语义（读拼接/写替换）、Zod 验证与错误格式化、
 *       安全字段过滤、内部写入抑制、环境变量两阶段白名单。
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { mergeSettingsRead, mergeSettingsWrite } from "@sid-code/core/config/settings/merge.ts";
import {
  filterInvalidPermissionRules,
  formatZodErrors,
} from "@sid-code/core/config/settings/validation.ts";
import { SettingsSchema } from "@sid-code/core/config/settings/types.ts";
import {
  filterProjectSettings,
  SECURITY_SENSITIVE_FIELDS,
} from "@sid-code/core/config/settings/security.ts";
import {
  markInternalWrite,
  consumeInternalWrite,
  resetInternalWrites,
} from "@sid-code/core/config/settings/internal-writes.ts";

describe("Settings 合并：读取语义（数组拼接去重）", () => {
  test("字符串数组拼接 + 去重", () => {
    const a = { permissions: { deny: ["Bash(rm -rf *)"] } };
    const b = { permissions: { deny: ["Bash(rm -rf *)", "Bash(DROP TABLE *)"] } };
    const merged = mergeSettingsRead(a, b);
    expect(merged.permissions.deny).toEqual(["Bash(rm -rf *)", "Bash(DROP TABLE *)"]);
  });

  test("多来源 deny 规则叠加而非替换", () => {
    const user: any = { permissions: { deny: ["A"] } };
    const project: any = { permissions: { deny: ["B"] } };
    const merged: any = mergeSettingsRead(mergeSettingsRead({} as any, user), project);
    expect(merged.permissions.deny.sort()).toEqual(["A", "B"]);
  });

  test("对象数组（budgetRules）直接拼接，不去重", () => {
    const a = { quota: { budgetRules: [{ id: "1" }] } };
    const b = { quota: { budgetRules: [{ id: "2" }] } };
    const merged = mergeSettingsRead(a, b);
    expect(merged.quota.budgetRules).toHaveLength(2);
  });

  test("标量后者覆盖前者", () => {
    const merged = mergeSettingsRead({ model: "a" }, { model: "b" });
    expect(merged.model).toBe("b");
  });

  test("嵌套对象深度合并", () => {
    const a: any = { search: { backend: "brave", braveApiKey: "k1" } };
    const b: any = { search: { searxngUrl: "http://x" } };
    const merged: any = mergeSettingsRead(a, b);
    expect(merged.search).toEqual({
      backend: "brave",
      braveApiKey: "k1",
      searxngUrl: "http://x",
    });
  });

  test("不修改入参", () => {
    const a = { list: ["x"] };
    const b = { list: ["y"] };
    mergeSettingsRead(a, b);
    expect(a.list).toEqual(["x"]);
    expect(b.list).toEqual(["y"]);
  });
});

describe("Settings 合并：写入语义（数组替换/undefined 删除）", () => {
  test("数组直接替换，不拼接", () => {
    const base = { permissions: { deny: ["A", "B"] } };
    const patch = { permissions: { deny: ["C"] } };
    const merged = mergeSettingsWrite(base, patch);
    expect(merged.permissions.deny).toEqual(["C"]);
  });

  test("undefined 表示删除字段", () => {
    const base = { model: "a", provider: "anthropic" };
    const merged = mergeSettingsWrite(base, { model: undefined });
    expect("model" in merged).toBe(false);
    expect(merged.provider).toBe("anthropic");
  });

  test("标量覆盖 + 对象深度合并", () => {
    const base = { search: { backend: "brave", braveApiKey: "k" } };
    const patch = { search: { backend: "tavily" } };
    const merged = mergeSettingsWrite(base, patch);
    expect(merged.search).toEqual({ backend: "tavily", braveApiKey: "k" });
  });
});

describe("Zod 验证与错误格式化", () => {
  test("合法 settings 通过验证", () => {
    const result = SettingsSchema().safeParse({
      provider: "anthropic",
      model: "claude-sonnet-4",
      maxTokens: 16384,
    });
    expect(result.success).toBe(true);
  });

  test("未知字段被保留（passthrough 向前兼容）", () => {
    const result = SettingsSchema().safeParse({
      model: "x",
      futureFeatureFlag: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).futureFeatureFlag).toBe(true);
    }
  });

  test("maxTokens 越界被拒绝", () => {
    const result = SettingsSchema().safeParse({ maxTokens: 500 });
    expect(result.success).toBe(false);
  });

  test("formatZodErrors 产出结构化错误 + 文件路径", () => {
    const result = SettingsSchema().safeParse({ maxTokens: 500 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatZodErrors(result.error, "/tmp/settings.json");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toBe("/tmp/settings.json");
      expect(errors[0].path).toBe("maxTokens");
      expect(typeof errors[0].message).toBe("string");
    }
  });

  test("非法 MCP transport 被拒绝", () => {
    const result = SettingsSchema().safeParse({
      mcpServers: { foo: { transport: "carrier-pigeon" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("权限规则预过滤", () => {
  test("剔除非字符串规则并产出警告", () => {
    const data = {
      permissions: { allow: ["Read", 123, "Write", null] },
    };
    const warnings = filterInvalidPermissionRules(data, "/tmp/s.json");
    expect(data.permissions.allow).toEqual(["Read", "Write"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].path).toBe("permissions.allow");
  });

  test("无 permissions 字段时安全返回空", () => {
    expect(filterInvalidPermissionRules({}, "/tmp/s.json")).toEqual([]);
    expect(filterInvalidPermissionRules({ model: "x" }, "/tmp/s.json")).toEqual([]);
  });

  test("一条坏规则不毒化整个文件（过滤后可通过 Zod）", () => {
    const data: any = { permissions: { deny: ["A", 999] } };
    filterInvalidPermissionRules(data, "/tmp/s.json");
    const result = SettingsSchema().safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe("安全边界：项目级配置字段过滤", () => {
  test("projectSettings 不能设置安全敏感字段", () => {
    const projectSettings: any = {
      model: "claude-x",
      permissionMode: "dangerously-skip-permissions",
      sanitizeEnv: false,
      allowedTools: ["Bash"],
      trustProjectExtensions: true,
      allowedDirectories: ["/"],
    };
    const filtered = filterProjectSettings(projectSettings);
    expect(filtered.model).toBe("claude-x"); // 非敏感字段保留
    for (const field of SECURITY_SENSITIVE_FIELDS) {
      expect(field in filtered).toBe(false);
    }
  });

  test("不修改入参", () => {
    const orig: any = { permissionMode: "plan" };
    filterProjectSettings(orig);
    expect(orig.permissionMode).toBe("plan");
  });
});

describe("内部写入抑制", () => {
  beforeEach(() => resetInternalWrites());

  test("窗口内标记被识别为内部写入（消费一次）", () => {
    markInternalWrite("/tmp/s.json");
    expect(consumeInternalWrite("/tmp/s.json", 5000)).toBe(true);
    // 消费后不再命中
    expect(consumeInternalWrite("/tmp/s.json", 5000)).toBe(false);
  });

  test("无标记时返回 false（外部变更）", () => {
    expect(consumeInternalWrite("/tmp/other.json", 5000)).toBe(false);
  });

  test("过期窗口不命中", () => {
    markInternalWrite("/tmp/s.json");
    expect(consumeInternalWrite("/tmp/s.json", 0)).toBe(false);
  });
});
