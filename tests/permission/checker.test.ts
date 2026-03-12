/**
 * 权限检查器测试
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { defaultConfig } from "../../src/config/config.ts";

describe("PermissionChecker", () => {
  test("危险命令被拦截", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const result = await checker.check({
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("危险命令");
  });

  test("禁用工具被拦截", async () => {
    const config = { ...defaultConfig(), disallowedTools: ["bash"] };
    const checker = new PermissionChecker(config);
    const result = await checker.check({
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("已被禁用");
  });

  test("敏感文件被拦截", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/home/user/.env" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("敏感文件");
  });

  test("读操作自动放行", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const result = await checker.check({
      toolName: "read",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(true);
  });

  test("grep 和 glob 自动放行", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const r1 = await checker.check({ toolName: "grep", input: { pattern: "foo" } });
    const r2 = await checker.check({ toolName: "glob", input: { pattern: "*.ts" } });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });

  test("预授权工具放行", async () => {
    const config = { ...defaultConfig(), allowedTools: ["bash"] };
    const checker = new PermissionChecker(config);
    const result = await checker.check({
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(result.allowed).toBe(true);
  });

  test("skipPermissions 跳过所有检查", async () => {
    const config = { ...defaultConfig(), skipPermissions: true };
    const checker = new PermissionChecker(config);
    const result = await checker.check({
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
    expect(result.allowed).toBe(true);
  });

  test("yesMode 自动批准", async () => {
    const config = { ...defaultConfig(), yesMode: true };
    const checker = new PermissionChecker(config);
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(true);
  });

  test("deny-write 模式拦截写操作", async () => {
    const config = { ...defaultConfig(), permissionMode: "deny-write" };
    const checker = new PermissionChecker(config);
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("deny-write");
  });

  test("always-allow 模式放行写操作", async () => {
    const config = { ...defaultConfig(), permissionMode: "always-allow" };
    const checker = new PermissionChecker(config);
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(true);
  });

  test("默认模式下写操作需要确认", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const result = await checker.check({
      toolName: "write",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
  });
});
