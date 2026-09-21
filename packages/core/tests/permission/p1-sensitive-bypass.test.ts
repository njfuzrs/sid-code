/**
 * P1-1 / P1-2 / P1-3 / P1-4：权限管线四条平行路径的回归。
 *
 * 来源：撰写 website/blog/sc-04-permission.md 时回源码核出。
 * 每条都曾用 `bun -e` 调 PermissionChecker.check 实证；本文件把那几行钉成单测。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，后者 mkdirSync(sidPaths.logs())，
 * 必须重定向 SID_CONFIG_DIR；恢复时存/恢复原值而非无条件 delete。
 *
 * ⚠ 工作区用真实 tmpdir，不用仓库路径：worktree 路径含 `.claude/`，
 * safetyCheck 会在规则判定之前命中。
 *
 * ⚠ 生产路径会把真实 tool 传入 check()（tool-executor.ts）。本文件凡测
 * bash 只读早退的用例都必须传带 checkPermissions 的 stub。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";
import { matchRule } from "@sid-code/core/permission/rules.ts";
import { hasSensitiveRedirection } from "@sid-code/core/permission/shell-parser.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { ReadManyTool } from "@sid-code/core/tool/read-many.ts";
import type { Tool, PermissionResult, ToolUseContext } from "@sid-code/core/tool/types.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-p1-perm-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-p1-perm-ws-"));
  mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, ".env"), "SECRET=1");
  writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;");
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

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

function checker(
  over: Record<string, unknown> = {},
  rules?: { deny?: string[]; allow?: string[] },
) {
  return new PermissionChecker({ ...defaultConfig(), ...over }, rules, workspace);
}

describe("P1-1 敏感文件硬 deny 覆盖读旁路", () => {
  test("read .env 仍硬 deny（对照）", async () => {
    const r = await checker().check({
      toolName: "read",
      input: { file_path: join(workspace, ".env") },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("敏感文件");
  });

  test("grep path=.env 硬 deny，不能只读工具早退放行", async () => {
    const r = await checker().check({
      toolName: "grep",
      input: { pattern: ".*", path: join(workspace, ".env") },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("敏感文件");
  });

  test("read_many path=.env 硬 deny", async () => {
    const r = await checker().check({
      toolName: "read_many",
      input: { pattern: ["**/.env"], path: join(workspace, ".env") },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("敏感文件");
  });

  test("bash cat .env 需确认（读类命令 × 敏感路径）", async () => {
    const r = await checker().check(
      { toolName: "bash", input: { command: "cat .env" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("bash head ~/.ssh/id_rsa 需确认（不再只认 cat）", async () => {
    const r = await checker().check(
      { toolName: "bash", input: { command: "head ~/.ssh/id_rsa" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("bash tail ~/.ssh/id_ed25519 需确认", async () => {
    const r = await checker().check(
      { toolName: "bash", input: { command: "tail ~/.ssh/id_ed25519" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("bash rg -n . ~/.ssh/id_rsa 需确认", async () => {
    const r = await checker().check(
      { toolName: "bash", input: { command: "rg -n . ~/.ssh/id_rsa" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("bash cat ~/.aws/credentials 需确认", async () => {
    const r = await checker().check(
      { toolName: "bash", input: { command: `cat ${homedir()}/.aws/credentials` } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("Read(.env) 规则同时挡住 grep 对同一路径", () => {
    expect(
      matchRule(
        "Read(.env)",
        {
          toolName: "grep",
          input: { pattern: ".*", path: join(workspace, ".env") },
        },
        { workspaceRoot: workspace, cwd: workspace },
      ),
    ).toBe(true);
  });

  test("grep 普通目录搜索根不被敏感文件硬 deny 打穿", async () => {
    const r = await checker().check({
      toolName: "grep",
      input: { pattern: "foo", path: workspace },
    });
    expect(r.allowed).toBe(true);
  });

  test("isSensitivePath 认 .env 与 ~/.ssh 目录形态", () => {
    const c = checker();
    expect(c.isSensitivePath(join(workspace, ".env"))).toBe(true);
    expect(c.isSensitivePath(join(workspace, "src", "a.ts"))).toBe(false);
    expect(c.isSensitivePath(join(homedir(), ".ssh"))).toBe(true);
  });

  test("grep 工具层过滤敏感文件，不把 .env 内容吐给模型", async () => {
    const c = checker();
    const tool = new GrepTool((p) => c.isPathHidden(p) || c.isSensitivePath(p));
    const r = await tool.execute({ pattern: "SECRET", path: workspace, output_mode: "content" });
    expect(r.isError).toBeFalsy();
    expect(r.output).not.toContain("SECRET=1");
  });

  test("read_many 工具层过滤敏感文件", async () => {
    const c = checker();
    const tool = new ReadManyTool(undefined, (p) => c.isPathHidden(p) || c.isSensitivePath(p));
    const r = await tool.execute({ pattern: ["**/*"], path: workspace });
    expect(r.isError).toBeFalsy();
    expect(r.output).not.toContain("SECRET=1");
    expect(r.output).toContain("a.ts");
  });
});

describe("P1-2 会话记忆 key 不再串味", () => {
  test("write 不同内容不因同路径免确认", async () => {
    const c = checker();
    const first = {
      toolName: "write",
      input: { file_path: join(workspace, "src", "a.ts"), content: "// comment" },
    };
    c.rememberDecision(first, true);
    const second = await c.check({
      toolName: "write",
      input: { file_path: join(workspace, "src", "a.ts"), content: "evil hook" },
    });
    expect(second.decisionReason?.type).not.toBe("sessionMemory");
  });

  test("grep 无 path 批准后，换 path 不能命中空钥匙", async () => {
    const c = checker();
    c.rememberDecision({ toolName: "grep", input: { pattern: "password" } }, true);
    const r = await c.check({
      toolName: "grep",
      input: { pattern: "password", path: "/etc/passwd" },
    });
    expect(r.decisionReason?.type).not.toBe("sessionMemory");
  });

  test("notebook_edit 空钥匙不写入：批准 a.ipynb 不能放行 hooks", async () => {
    const c = checker();
    c.rememberDecision(
      { toolName: "notebook_edit", input: { notebook_path: join(workspace, "a.ipynb") } },
      true,
    );
    const r = await c.check({
      toolName: "notebook_edit",
      input: { notebook_path: join(workspace, ".git/hooks/x.ipynb") },
    });
    expect(r.decisionReason?.type).not.toBe("sessionMemory");
    expect(r.allowed).toBe(false);
  });

  test("web_fetch 不同 URL 不共用空钥匙", async () => {
    const c = checker();
    c.rememberDecision({ toolName: "web_fetch", input: { url: "https://example.com" } }, true);
    const r = await c.check({
      toolName: "web_fetch",
      input: { url: "https://evil.example/exfil" },
    });
    expect(r.decisionReason?.type).not.toBe("sessionMemory");
  });

  test("web_fetch 同一 URL 可以命中会话记忆", async () => {
    const c = checker();
    const req = { toolName: "web_fetch", input: { url: "https://example.com/docs" } };
    c.rememberDecision(req, true);
    const r = await c.check(req);
    expect(r.allowed).toBe(true);
    expect(r.decisionReason?.type).toBe("sessionMemory");
  });

  test("grep 同 path + 同 pattern 可以命中会话记忆", async () => {
    const c = checker();
    const req = {
      toolName: "grep",
      input: { pattern: "foo", path: join(workspace, "src") },
    };
    c.rememberDecision(req, true);
    const r = await c.check(req);
    expect(r.allowed).toBe(true);
    expect(r.decisionReason?.type).toBe("sessionMemory");
  });
});

describe("P1-3 acceptEdits 不自动放行 rm", () => {
  test("acceptEdits + rm -rf . 不得 allowed=true", async () => {
    const r = await checker({ permissionMode: "acceptEdits" }).check(
      { toolName: "bash", input: { command: "rm -rf ." } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).not.toBe("mode");
  });

  test("acceptEdits + rm -rf src 不得 allowed=true", async () => {
    const r = await checker({ permissionMode: "acceptEdits" }).check(
      { toolName: "bash", input: { command: "rm -rf src" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
  });

  test("acceptEdits + mkdir foo 仍自动放行", async () => {
    const r = await checker({ permissionMode: "acceptEdits" }).check(
      { toolName: "bash", input: { command: "mkdir foo" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(true);
    expect(r.decisionReason).toMatchObject({ type: "mode", mode: "acceptEdits" });
  });

  test("acceptEdits + rmdir / mv 不得自动放行", async () => {
    const c = checker({ permissionMode: "acceptEdits" });
    const rmdir = await c.check(
      { toolName: "bash", input: { command: "rmdir src" } },
      bashToolStub(),
    );
    const mv = await c.check(
      { toolName: "bash", input: { command: "mv src dest" } },
      bashToolStub(),
    );
    expect(rmdir.allowed).toBe(false);
    expect(mv.allowed).toBe(false);
  });

  test("default / acceptEdits 下 rm -rf / 仍是 critical 硬拒绝", async () => {
    const r = await checker({ permissionMode: "acceptEdits" }).check(
      { toolName: "bash", input: { command: "rm -rf /" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBeFalsy();
  });
});

describe("P1-4 bash 重定向写 hooks 走敏感路径确认", () => {
  test("always-allow write .git/hooks 仍 ask（对照，P0-2 未回归）", async () => {
    const r = await checker({ permissionMode: "always-allow" }).check({
      toolName: "write",
      input: { file_path: join(workspace, ".git/hooks/pre-commit") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("always-allow bash echo > .git/hooks/pre-commit 需确认，不能 always-allow 放行", async () => {
    const r = await checker({ permissionMode: "always-allow" }).check(
      { toolName: "bash", input: { command: "echo evil > .git/hooks/pre-commit" } },
      bashToolStub(),
    );
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.reason).toContain("敏感路径");
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("yesMode / auto 不把 hooks 重定向当普通 ask 放行", async () => {
    const cmd = {
      toolName: "bash" as const,
      input: { command: "echo evil > .git/hooks/pre-commit" },
    };
    const yes = await checker({ yesMode: true }).check(cmd, bashToolStub());
    expect(yes.allowed).toBe(false);
    expect(yes.decisionReason?.type).toBe("dangerousCommand");

    const auto = checker({ permissionMode: "auto" });
    auto.setToolClassifier({
      isAvailable: () => true,
      classify: async () => ({ safe: true, risk: "none" as const, reason: "mock" }),
    } as any);
    const autoR = await auto.check(cmd, bashToolStub());
    expect(autoR.allowed).toBe(false);
    expect(autoR.decisionReason?.type).toBe("dangerousCommand");
  });

  test("hasSensitiveRedirection 认 .git/hooks 与 .husky", () => {
    expect(hasSensitiveRedirection("echo x > .git/hooks/pre-commit").sensitive).toBe(true);
    expect(hasSensitiveRedirection("echo x > .husky/pre-commit").sensitive).toBe(true);
    expect(hasSensitiveRedirection("echo x > /tmp/ok.txt").sensitive).toBe(false);
  });

  test("hasSensitiveRedirection 认 classifierApprovable:false 的 settings", () => {
    expect(hasSensitiveRedirection("echo x > .sid-code/settings.json").sensitive).toBe(true);
    expect(hasSensitiveRedirection("echo x > .claude/settings.local.json").sensitive).toBe(true);
  });
});
