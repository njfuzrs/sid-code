/**
 * 权限系统增强功能测试
 * 测试新增的 6 种权限模式、规则配置、会话记忆、目录白名单/黑名单
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { defaultConfig } from "../../src/config/config.ts";
import type { PermissionRule } from "../../src/permission/types.ts";

describe("权限系统增强功能", () => {
  // === Task 1: 扩展权限模式（6 种） ===

  describe("acceptEdits 模式", () => {
    test("自动接受文件操作", async () => {
      const config = { ...defaultConfig(), permissionMode: "acceptEdits" };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const readResult = await checker.check({
        toolName: "read",
        input: { file_path: "/tmp/test.txt" },
      });
      expect(readResult.allowed).toBe(true);

      const writeResult = await checker.check({
        toolName: "write",
        input: { file_path: "/tmp/test.txt" },
      });
      expect(writeResult.allowed).toBe(true);

      const editResult = await checker.check({
        toolName: "edit",
        input: { file_path: "/tmp/test.txt" },
      });
      expect(editResult.allowed).toBe(true);
    });

    test("bash 仍需检查", async () => {
      const config = { ...defaultConfig(), permissionMode: "acceptEdits" };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const result = await checker.check({
        toolName: "bash",
        input: { command: "ls" },
      });
      expect(result.allowed).toBe(false);
      expect(result.needsConfirmation).toBe(true);
    });
  });

  describe("plan 模式", () => {
    test("只允许只读操作", async () => {
      const config = { ...defaultConfig(), permissionMode: "plan" };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const readResult = await checker.check({
        toolName: "read",
        input: { file_path: "/tmp/test.txt" },
      });
      expect(readResult.allowed).toBe(true);

      const grepResult = await checker.check({
        toolName: "grep",
        input: { pattern: "foo" },
      });
      expect(grepResult.allowed).toBe(true);

      const globResult = await checker.check({
        toolName: "glob",
        input: { pattern: "*.ts" },
      });
      expect(globResult.allowed).toBe(true);
    });

    test("拒绝写入和 bash", async () => {
      const config = { ...defaultConfig(), permissionMode: "plan" };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const writeResult = await checker.check({
        toolName: "write",
        input: { file_path: "/tmp/test.txt" },
      });
      expect(writeResult.allowed).toBe(false);
      expect(writeResult.reason).toContain("计划模式");

      const bashResult = await checker.check({
        toolName: "bash",
        input: { command: "ls" },
      });
      expect(bashResult.allowed).toBe(false);
      expect(bashResult.reason).toContain("计划模式");
    });
  });

  describe("dontAsk 模式", () => {
    test("dontAsk 模式下 ask 转为 deny（绝不弹窗）", async () => {
      const config = { ...defaultConfig(), permissionMode: "dontAsk" };
      // 使用 process.cwd() 作为工作区，确保测试文件在工作区内
      const checker = new PermissionChecker(config, undefined, process.cwd());

      const result = await checker.check({
        toolName: "write",
        input: { file_path: `${process.cwd()}/test.txt` },
      });
      // 新语义：dontAsk 模式下 ask→deny，不再自动允许
      expect(result.allowed).toBe(false);
      expect(result.needsConfirmation).toBeUndefined();
    });

    test("dontAsk 模式下 bash 命令也被拒绝（ask→deny）", async () => {
      const config = { ...defaultConfig(), permissionMode: "dontAsk" };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const result = await checker.check({
        toolName: "bash",
        input: { command: "ls -la" },
      });
      // 新语义：dontAsk 模式下 ask→deny
      expect(result.allowed).toBe(false);
    });

    test("危险命令仍被拦截", async () => {
      const config = { ...defaultConfig(), permissionMode: "dontAsk" };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const result = await checker.check({
        toolName: "bash",
        input: { command: "rm -rf /" },
      });
      expect(result.allowed).toBe(false);
    });
  });

  // === Task 2: 权限规则配置文件 ===

  describe("权限规则配置", () => {
    test("deny 规则拒绝操作", async () => {
      const config = defaultConfig();
      const rules: PermissionRule = {
        deny: ["Edit(config.local.*)"],
      };
      const checker = new PermissionChecker(config, rules);

      const result = await checker.check({
        toolName: "edit",
        input: { file_path: "config.local.yaml" },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("规则拒绝");
    });

    test("allow 规则放行操作", async () => {
      const config = defaultConfig();
      const rules: PermissionRule = {
        allow: ["Bash(npm *)"],
      };
      const checker = new PermissionChecker(config, rules);

      const result = await checker.check({
        toolName: "bash",
        input: { command: "npm test" },
      });
      expect(result.allowed).toBe(true);
    });

    test("ask 规则要求确认", async () => {
      const config = defaultConfig();
      const rules: PermissionRule = {
        ask: ["Write"],
      };
      const checker = new PermissionChecker(config, rules, "/tmp");

      const result = await checker.check({
        toolName: "write",
        input: { file_path: "/tmp/test.txt" },
      });
      expect(result.allowed).toBe(false);
      expect(result.needsConfirmation).toBe(true);
      expect(result.reason).toContain("规则要求确认");
    });

    test("deny 优先于 allow", async () => {
      const config = defaultConfig();
      const rules: PermissionRule = {
        allow: ["Bash(*)"],
        deny: ["Bash(rm *)"],
      };
      const checker = new PermissionChecker(config, rules);

      const allowResult = await checker.check({
        toolName: "bash",
        input: { command: "ls" },
      });
      expect(allowResult.allowed).toBe(true);

      const denyResult = await checker.check({
        toolName: "bash",
        input: { command: "rm test.txt" },
      });
      expect(denyResult.allowed).toBe(false);
    });
  });

  // === Task 4: 会话内权限记忆 ===

  describe("会话内权限记忆", () => {
    test("记住允许决策", async () => {
      const config = defaultConfig();
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const req = {
        toolName: "write",
        input: { file_path: "/tmp/test.txt" },
      };

      // 第一次检查：需要确认
      const firstResult = await checker.check(req);
      expect(firstResult.needsConfirmation).toBe(true);

      // 记住决策
      checker.rememberDecision(req, true);

      // 第二次检查：直接放行
      const secondResult = await checker.check(req);
      expect(secondResult.allowed).toBe(true);
    });

    test("记住拒绝决策", async () => {
      const config = defaultConfig();
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const req = {
        toolName: "write",
        input: { file_path: "/tmp/test.txt" },
      };

      // 记住拒绝决策
      checker.rememberDecision(req, false);

      // 检查：直接拒绝
      const result = await checker.check(req);
      expect(result.allowed).toBe(false);
    });

    test("清除会话记忆", async () => {
      const config = defaultConfig();
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const req = {
        toolName: "write",
        input: { file_path: "/tmp/test.txt" },
      };

      // 记住决策
      checker.rememberDecision(req, true);

      // 清除记忆
      checker.clearSessionMemory();

      // 检查：需要重新确认
      const result = await checker.check(req);
      expect(result.needsConfirmation).toBe(true);
    });
  });

  // === Task 6: 目录白名单/黑名单 ===

  describe("目录白名单/黑名单", () => {
    test("黑名单拒绝访问", async () => {
      const config = {
        ...defaultConfig(),
        blockedDirectories: ["/tmp/secrets"],
      };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const result = await checker.check({
        toolName: "read",
        input: { file_path: "/tmp/secrets/key.pem" },
      });
      expect(result.allowed).toBe(false);
      // PathValidator 可能先匹配敏感文件或黑名单，两者都是正确行为
      expect(result.reason).toBeDefined();
    });

    test("白名单外拒绝访问", async () => {
      // 使用实际存在的目录作为白名单
      const allowedDir = process.cwd();
      const config = {
        ...defaultConfig(),
        allowedDirectories: [allowedDir],
      };
      const checker = new PermissionChecker(config, undefined, allowedDir);

      const allowedResult = await checker.check({
        toolName: "read",
        input: { file_path: `${allowedDir}/test.txt` },
      });
      expect(allowedResult.allowed).toBe(true);

      const deniedResult = await checker.check({
        toolName: "read",
        input: { file_path: "/tmp/other/test.txt" },
      });
      expect(deniedResult.allowed).toBe(false);
      expect(deniedResult.reason).toContain("不在白名单中");
    });

    test("黑名单优先于白名单", async () => {
      const config = {
        ...defaultConfig(),
        allowedDirectories: ["/tmp"],
        blockedDirectories: ["/tmp/secrets"],
      };
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const result = await checker.check({
        toolName: "read",
        input: { file_path: "/tmp/secrets/key.pem" },
      });
      expect(result.allowed).toBe(false);
      // PathValidator 可能先匹配敏感文件或黑名单，两者都是正确行为
      expect(result.reason).toBeDefined();
    });
  });

  // === 综合测试：多层检查优先级 ===

  describe("多层检查优先级", () => {
    test("会话记忆 > 危险命令", async () => {
      const config = defaultConfig();
      const checker = new PermissionChecker(config, undefined, "/tmp");

      const req = {
        toolName: "bash",
        input: { command: "sudo rm -rf /" },
      };

      // 记住允许决策（虽然不推荐，但测试优先级）
      checker.rememberDecision(req, true);

      // 会话记忆优先级最高，直接放行
      const result = await checker.check(req);
      expect(result.allowed).toBe(true);
    });

    test("危险命令 > 权限规则", async () => {
      const config = defaultConfig();
      const rules: PermissionRule = {
        allow: ["Bash(*)"],
      };
      const checker = new PermissionChecker(config, rules);

      const result = await checker.check({
        toolName: "bash",
        input: { command: "rm -rf /" },
      });
      expect(result.allowed).toBe(false);
    });

    test("权限规则 > 权限模式", async () => {
      const config = { ...defaultConfig(), permissionMode: "acceptEdits" };
      const rules: PermissionRule = {
        deny: ["Write(.env*)"],
      };
      const checker = new PermissionChecker(config, rules);

      const result = await checker.check({
        toolName: "write",
        input: { file_path: ".env" },
      });
      expect(result.allowed).toBe(false);
    });
  });
});
