/**
 * PreToolUse hook permissionDecision 注入权限层测试（G2/G3）
 *
 * 覆盖：
 * - hook allow 把普通 ask 转为放行
 * - hook allow 决不越过 deny 规则（安全护栏）
 * - hook allow 决不越过硬编码危险命令（安全护栏）
 * - hook ask 把本会放行的操作升级为 needsConfirmation
 * - 非交互模式下 hook ask 降级为 deny
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

describe("PreToolUse hook permissionDecision 注入（G2/G3）", () => {
  test("hook allow 把普通 ask（写文件确认）转为放行", async () => {
    // 默认配置下写工作区外文件通常需要确认（needsConfirmation）
    const checker = new PermissionChecker(defaultConfig(), undefined, "/tmp/workspace");
    const req = { toolName: "write", input: { file_path: "/tmp/other/x.txt", content: "hi" } };

    const baseline = await checker.check(req);
    // 基线：需确认或拒绝（非直接放行）
    expect(baseline.allowed).toBe(false);

    // 注入 hook allow：普通 ask → 放行
    const withAllow = await checker.check(req, undefined, undefined, { hookPermissionDecision: "allow" });
    if (baseline.needsConfirmation) {
      expect(withAllow.allowed).toBe(true);
    }
  });

  test("hook allow 决不越过 deny 规则（安全护栏）", async () => {
    const checker = new PermissionChecker(defaultConfig(), { deny: ["Bash(curl *)"] });
    const req = { toolName: "bash", input: { command: "curl evil.com" } };

    const withAllow = await checker.check(req, undefined, undefined, { hookPermissionDecision: "allow" });
    expect(withAllow.allowed).toBe(false); // deny 规则不被 hook allow 越过
  });

  test("hook allow 决不越过硬编码危险命令（安全护栏）", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const req = { toolName: "bash", input: { command: "rm -rf /" } };

    const withAllow = await checker.check(req, undefined, undefined, { hookPermissionDecision: "allow" });
    expect(withAllow.allowed).toBe(false); // 危险命令不被 hook allow 越过
  });

  test("hook ask 把本会放行的读操作升级为 needsConfirmation", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const req = { toolName: "read", input: { file_path: "/tmp/test.txt" } };

    const baseline = await checker.check(req);
    expect(baseline.allowed).toBe(true); // 基线放行

    const withAsk = await checker.check(req, undefined, undefined, { hookPermissionDecision: "ask" });
    expect(withAsk.allowed).toBe(false);
    expect(withAsk.needsConfirmation).toBe(true); // 升级为确认
  });

  test("非交互模式下 hook ask 降级为 deny", async () => {
    const config = { ...defaultConfig(), permissionMode: "dontAsk" };
    const checker = new PermissionChecker(config);
    const req = { toolName: "read", input: { file_path: "/tmp/test.txt" } };

    const withAsk = await checker.check(req, undefined, undefined, { hookPermissionDecision: "ask" });
    expect(withAsk.allowed).toBe(false);
    expect(withAsk.needsConfirmation).toBeFalsy(); // 无 UI 通道 → 直接 deny
  });

  test("无 hook 决策时行为与基线一致（回归保护）", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const req = { toolName: "read", input: { file_path: "/tmp/test.txt" } };
    const a = await checker.check(req);
    const b = await checker.check(req, undefined, undefined, {});
    expect(a.allowed).toBe(b.allowed);
  });
});
