/**
 * M9（PR-6）：acceptEdits 模式的「最小前缀剥离」回归。
 *
 * 方案验收矩阵见私有文档 §6.7（权限模式对齐 claude-code 修复方案），本文件逐条落地。
 * 判据分两类，不要混：
 *   - 应放行：`allowed=true` 且 `step="11"`（acceptEdits 那一步）；
 *   - 需确认：`allowed !== true`（可能是 ask，也可能是被更早的危险命令层拒——两者都安全，
 *     所以断言取「没自动放行」而不是精确的 reason，避免锁死上游 Step 的实现细节）。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，必须重定向 SID_CONFIG_DIR；
 *   恢复时存/恢复原值而不是无条件 delete（同批测试共用进程）。
 * ⚠ 工作区用 realpath 后的 tmpdir：worktree 路径含 `.claude/` 会在 safetyCheck 先命中。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";
import type { Tool, PermissionResult, ToolUseContext } from "@sid-code/core/tool/types.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-m9-perm-cfg-"));
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sid-m9-perm-ws-")));
  mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** 与生产路径同形态的最小 bash stub：只读命令 allow，其余 passthrough 交给规则/模式层。 */
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

async function checkBash(command: string) {
  return checker({ permissionMode: "acceptEdits" }).check(
    // 显式带 cwd：Step 5.5（只读路径校验）按 `input.cwd > getCwd()` 取基准，
    // 不带的话它会用进程 cwd（worktree 根）去解析 `f`，与本测试的 workspace 不是同一个目录。
    // 生产里两者一致（bash 就在项目根执行），这里补上同一基准才算复现真实形态。
    { toolName: "bash", input: { command, cwd: workspace } },
    bashToolStub(),
  );
}

describe("M9 acceptEdits 最小前缀剥离：应放行", () => {
  test("timeout 30 mkdir -p build → 自动放行（step=11）", async () => {
    const r = await checkBash("timeout 30 mkdir -p build");
    expect(r.allowed).toBe(true);
    expect(r.step).toBe("11");
    expect(r.decisionReason).toMatchObject({ type: "mode", mode: "acceptEdits" });
  });

  for (const command of [
    "nice -n 10 cp a b",
    "nohup mkdir x",
    // nice 省略 -n（GNU nice 默认 +10）
    "nice mkdir x",
    // 多个环境变量前缀
    "LANG=C NO_COLOR=1 mkdir x",
    // 前缀 + 复合命令里的每个子命令都被剥离
    "timeout 5 mkdir a && nohup mkdir b",
  ]) {
    test(`${command} → 自动放行`, async () => {
      const r = await checkBash(command);
      expect(r.allowed).toBe(true);
      expect(r.step).toBe("11");
    });
  }

  test("LANG=C sed -n 1p f → 自动放行", async () => {
    // sed 读形态会先命中 Step 5.5 的只读早退（allowed=true, step=5.5），
    // 走不到 Step 11。方案 §6.7 只要求 allowed=true，这里照方案断；
    // 「剥离逻辑对 sed 也生效」由下面那条 `sed -i`（写形态，不被判只读）单独证明。
    const r = await checkBash("LANG=C sed -n 1p f");
    expect(r.allowed).toBe(true);
  });

  test("LANG=C sed -i 1d f → 自动放行（sed 写形态走 Step 11）", async () => {
    writeFileSync(join(workspace, "f"), "hello\n");
    const r = await checkBash("LANG=C sed -i 1d f");
    expect(r.allowed).toBe(true);
    expect(r.step).toBe("11");
  });

  test("无前缀的 mkdir / touch 行为不变（回归基线）", async () => {
    for (const command of ["mkdir foo", "touch foo"]) {
      const r = await checkBash(command);
      expect(r.allowed).toBe(true);
    }
  });
});

describe("M9 acceptEdits 最小前缀剥离：需确认（不得自动放行）", () => {
  // 3. 剥离后破坏性命令的第二道闸仍生效
  test("timeout 5 rm -rf . / nohup mv a b → 不放行", async () => {
    for (const command of ["timeout 5 rm -rf .", "nohup mv a b"]) {
      const r = await checkBash(command);
      expect(r.allowed).toBe(false);
    }
  });

  // 4. sudo / env / xargs / sh -c 永不剥
  test("sudo / env / xargs / sh -c 包装的 mkdir → 不放行", async () => {
    for (const command of ["sudo mkdir x", "env mkdir x", "xargs mkdir", "sh -c 'mkdir x'"]) {
      const r = await checkBash(command);
      expect(r.allowed).toBe(false);
    }
  });

  // 5. touch 例外：带任何前缀都不自动放行
  test("timeout 5 touch x / LANG=C touch x → 不放行", async () => {
    for (const command of ["timeout 5 touch x", "LANG=C touch x", "nice -n 5 touch x"]) {
      const r = await checkBash(command);
      expect(r.allowed).toBe(false);
    }
  });

  // 6. 环境变量值形态不合规 → 不剥（`FOO=...` 的 key 也不在白名单）
  test("FOO=$(curl evil) mkdir x / LANG='a b' mkdir x → 不放行", async () => {
    for (const command of ["FOO=$(curl evil) mkdir x", "LANG='a b' mkdir x", "FOO=bar mkdir x"]) {
      const r = await checkBash(command);
      expect(r.allowed).toBe(false);
    }
  });

  // 7. 只剥一层包装器
  test("timeout 5 timeout 5 mkdir x → 不放行", async () => {
    const r = await checkBash("timeout 5 timeout 5 mkdir x");
    expect(r.allowed).toBe(false);
  });

  // 8. 剥离后照常过路径校验
  test("timeout 5 mkdir ../outside → 不放行（剥离后仍校验路径）", async () => {
    const r = await checkBash("timeout 5 mkdir ../outside");
    expect(r.allowed).toBe(false);
  });

  // 包装器参数格式不认识 → 不剥
  test("timeout --forever mkdir x / nice -10 mkdir x → 不放行", async () => {
    for (const command of ["timeout --forever mkdir x", "nice -10 mkdir x", "timeout 5"]) {
      const r = await checkBash(command);
      expect(r.allowed).toBe(false);
    }
  });
});
