/**
 * P0-1 / P0-2 / P0-3：权限管线三条绕过路径的回归。
 *
 * 来源：撰写 website/blog/sc-04-permission.md 时回源码核出。
 * 每条都曾用 `bun -e` 调 PermissionChecker.check 实证；本文件把那几行钉成单测。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，后者 mkdirSync(sidPaths.logs())，
 * 必须重定向 SID_CONFIG_DIR；恢复时存/恢复原值而非无条件 delete
 * （bun test 同批多文件同进程，直接删会抹掉 preload 兜底）。
 *
 * ⚠ 工作区用真实 tmpdir，不用仓库路径：worktree 路径含 `.claude/`，
 * safetyCheck 会在规则判定之前命中（见 CLAUDE.md worktree 假失败一节）。
 *
 * ⚠ 生产路径会把真实 tool 传入 check()（tool-executor.ts）。本文件凡测
 * bash 只读早退的用例都必须传带 checkPermissions 的 stub，不能只传 toolName。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";
import { matchRule } from "@sid-code/core/permission/rules.ts";
import type { Tool, PermissionResult, ToolUseContext } from "@sid-code/core/tool/types.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-p0-perm-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-p0-perm-ws-"));
  mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
  mkdirSync(join(workspace, ".sid-code", "commands"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** 永远判 safe 的分类器——模拟 auto 模式「分类器放行」那一侧。 */
function alwaysSafeClassifier() {
  return {
    isAvailable: () => true,
    classify: async () => ({ safe: true, risk: "none" as const, reason: "mock" }),
  };
}

/**
 * 复现 BashTool.checkPermissions 的只读早退，不构造真实 BashTool
 * （后者构造期会建 shell 快照，权限单测不该付这份成本）。
 */
function bashToolStub(): Tool {
  return {
    name: () => "bash",
    description: () => "stub",
    inputSchema: () => ({}),
    execute: async () => ({ output: "", isError: false }),
    async checkPermissions(input: unknown, _ctx: ToolUseContext): Promise<PermissionResult> {
      const command = (input as { command?: string })?.command;
      if (!command || typeof command !== "string") return { behavior: "passthrough" };
      if (isReadOnlyCommand(command)) return { behavior: "allow" };
      return { behavior: "passthrough" };
    },
  } as unknown as Tool;
}

function checker(over: Record<string, unknown> = {}) {
  return new PermissionChecker({ ...defaultConfig(), ...over }, undefined, workspace);
}

describe("P0-1 auto 不放行 safetyCheck / dangerousCommand", () => {
  test("yesMode 写 .git/hooks 仍需确认（护栏有效，对照）", async () => {
    const c = checker({ yesMode: true });
    const r = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, ".git/hooks/pre-commit") },
    });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("auto + 分类器永远 safe，写 .git/hooks 仍需确认", async () => {
    const c = checker({ permissionMode: "auto" });
    c.setToolClassifier(alwaysSafeClassifier() as any);
    const r = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, ".git/hooks/pre-commit") },
    });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("safetyCheck");
    expect((r.decisionReason as { classifierApprovable?: boolean }).classifierApprovable).toBe(
      false,
    );
  });

  test("auto + 分类器永远 safe，写 .sid-code/commands 仍需确认", async () => {
    const c = checker({ permissionMode: "auto" });
    c.setToolClassifier(alwaysSafeClassifier() as any);
    const r = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, ".sid-code/commands/pwn.md") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("auto + 分类器永远 safe，cat SSH 密钥仍需确认（dangerousCommand）", async () => {
    const c = checker({ permissionMode: "auto" });
    c.setToolClassifier(alwaysSafeClassifier() as any);
    const r = await c.check(
      { toolName: "bash", input: { command: "cat ~/.ssh/id_rsa" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("auto + 分类器永远 safe，sudo 仍需确认", async () => {
    const c = checker({ permissionMode: "auto" });
    c.setToolClassifier(alwaysSafeClassifier() as any);
    const r = await c.check({ toolName: "bash", input: { command: "sudo ls" } }, bashToolStub());
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("auto 写 .git/config（classifierApprovable:true）分类器可以放行", async () => {
    const c = checker({ permissionMode: "auto" });
    c.setToolClassifier(alwaysSafeClassifier() as any);
    const r = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, ".git/config") },
    });
    expect(r.allowed).toBe(true);
    expect(r.decisionReason).toMatchObject({ type: "mode", mode: "auto" });
  });

  test("rm -rf / 在 auto 下仍是 critical 硬拒绝", async () => {
    const c = checker({ permissionMode: "auto" });
    c.setToolClassifier(alwaysSafeClassifier() as any);
    const r = await c.check({ toolName: "bash", input: { command: "rm -rf /" } }, bashToolStub());
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBeFalsy();
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });
});

describe("P0-2 notebook_edit 走同一套路径守卫", () => {
  test("always-allow write .git/hooks 仍需确认（对照，别修回归）", async () => {
    const c = checker({ permissionMode: "always-allow" });
    const r = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, ".git/hooks/pre-commit") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("always-allow notebook_edit .git/hooks/*.ipynb 必须 ask，不能 always-allow 放行", async () => {
    const c = checker({ permissionMode: "always-allow" });
    const r = await c.check({
      toolName: "notebook_edit",
      input: { notebook_path: join(workspace, ".git/hooks/evil.ipynb") },
    });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("always-allow notebook_edit .sid-code/commands 必须 ask", async () => {
    const c = checker({ permissionMode: "always-allow" });
    const r = await c.check({
      toolName: "notebook_edit",
      input: { notebook_path: join(workspace, ".sid-code/commands/x.ipynb") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("always-allow edit .git/hooks 仍需确认（edit 本来就在集合里）", async () => {
    const c = checker({ permissionMode: "always-allow" });
    const r = await c.check({
      toolName: "edit",
      input: { file_path: join(workspace, ".git/hooks/pre-commit") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("路径规则 Edit(.git/hooks/*) 能匹配 notebook_path", () => {
    expect(
      matchRule(
        "Edit(.git/hooks/*)",
        {
          toolName: "notebook_edit",
          input: { notebook_path: join(workspace, ".git/hooks/x.ipynb") },
        },
        { workspaceRoot: workspace, cwd: workspace },
      ),
    ).toBe(true);
  });
});

describe("P0-3 bash 只读早退不得打穿 plan / deny-write", () => {
  test("isReadOnlyCommand：解释器与构建器不再是只读", () => {
    expect(isReadOnlyCommand("python3 foo.py")).toBe(false);
    expect(isReadOnlyCommand('python3 -c "print(1)"')).toBe(false);
    expect(isReadOnlyCommand("node -e \"require('fs').writeFileSync('/tmp/x',1)\"")).toBe(false);
    expect(isReadOnlyCommand("make")).toBe(false);
    expect(isReadOnlyCommand("gcc -o a a.c")).toBe(false);
    expect(isReadOnlyCommand("ruby script.rb")).toBe(false);
    expect(isReadOnlyCommand("java Main")).toBe(false);
    expect(isReadOnlyCommand("go run main.go")).toBe(false);
  });

  test("isReadOnlyCommand：版本查询仍是只读（别误伤）", () => {
    expect(isReadOnlyCommand("python3 --version")).toBe(true);
    expect(isReadOnlyCommand("node --version")).toBe(true);
    expect(isReadOnlyCommand("python3 -V")).toBe(true);
    expect(isReadOnlyCommand("make --version")).toBe(true);
  });

  test("isReadOnlyCommand：真只读命令仍是只读", () => {
    expect(isReadOnlyCommand("ls")).toBe(true);
    expect(isReadOnlyCommand("cat f")).toBe(true);
    expect(isReadOnlyCommand("git status")).toBe(true);
    expect(isReadOnlyCommand("curl https://example.com")).toBe(true);
  });

  test("plan + python3 foo.py 传了 bash 工具 → deny（生产路径）", async () => {
    const c = checker({ permissionMode: "plan" });
    const r = await c.check(
      { toolName: "bash", input: { command: "python3 foo.py" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("计划模式");
  });

  test("plan + ls 传了 bash 工具仍 deny（ls 是真只读，但 plan 对 bash 一律拦）", async () => {
    const c = checker({ permissionMode: "plan" });
    const r = await c.check({ toolName: "bash", input: { command: "ls" } }, bashToolStub());
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("计划模式");
  });

  test("plan + python3 foo.py 不传工具 → deny（旧测试路径不能绿得虚假）", async () => {
    const c = checker({ permissionMode: "plan" });
    const r = await c.check({ toolName: "bash", input: { command: "python3 foo.py" } });
    expect(r.allowed).toBe(false);
  });

  test("deny-write + python3 foo.py 传了工具 → deny", async () => {
    const c = checker({ permissionMode: "deny-write" });
    const r = await c.check(
      { toolName: "bash", input: { command: "python3 foo.py" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("deny-write");
  });

  test("deny-write + write 工具仍拒（对照）", async () => {
    const c = checker({ permissionMode: "deny-write" });
    const r = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, "a.ts") },
    });
    expect(r.allowed).toBe(false);
  });

  test("default 模式 python3 foo.py 不再因假只读免确认", async () => {
    const c = checker();
    const r = await c.check(
      { toolName: "bash", input: { command: "python3 foo.py" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("default 模式 python3 --version 仍免确认", async () => {
    const c = checker();
    const r = await c.check(
      { toolName: "bash", input: { command: "python3 --version" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(true);
  });
});
