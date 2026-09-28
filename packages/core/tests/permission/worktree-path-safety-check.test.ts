/**
 * W4：写工具的 safetyCheck 不再把 worktree 里的普通源码文件当成「配置目录」。
 *
 * 本仓所有 worktree 的物理路径都是 `<repo>/.sid-code/worktrees/<slug>/…`
 * （manager.ts 的 worktreeDir），Claude Code 的默认位置是 `.claude/worktrees/<slug>/`。
 * safetyCheck 拿 path.resolve 后的绝对路径做子串匹配，于是 worktree 里**任何**文件
 * 都含 `/.sid-code/`，被 ".sid-code/"（配置目录）那条整体命中——`src/app.ts` 这种
 * 普通源码也判不安全。
 *
 * 后果不是「某个权限测试会红」（博客 §9.5 的定性太轻）：
 * - 交互模式下隔离子代理每写一个文件都要人点一次确认；
 * - 自动模式的分类器拿到一个错误前提（"这是配置目录"），既可能拒掉正常源码改动，
 *   也可能放行真正写进 worktree 内 .sid-code/settings.json 的动作——剥离前两者同形。
 * 且 Step 6 是 bypass-immune 且排在 allow 规则之后，copyLocalSettings 复制的
 * allow 规则救不了它。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger → mkdirSync(sidPaths.logs())，
 * 必须重定向 SID_CONFIG_DIR；恢复时存/恢复原值而非无条件 delete。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { hasSensitiveRedirection } from "@sid-code/core/permission/shell-parser.ts";
import { stripWorktreeContainerPrefix } from "@sid-code/core/permission/safety-protected-paths.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-w4-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-w4-ws-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function checker(over: Record<string, unknown> = {}) {
  return new PermissionChecker({ ...defaultConfig(), ...over }, undefined, workspace);
}

/** worktree 内的文件路径（本仓布局） */
function inSidWorktree(...seg: string[]): string {
  return join(workspace, ".sid-code", "worktrees", "agent-abcd1234", ...seg);
}
/** worktree 内的文件路径（Claude Code 布局） */
function inClaudeWorktree(...seg: string[]): string {
  return join(workspace, ".claude", "worktrees", "feat-x", ...seg);
}

describe("W4：worktree 内的普通源码文件不再被当成配置目录", () => {
  test("写 <wt>/src/app.ts 不需确认", async () => {
    const r = await checker().check({
      toolName: "write",
      input: { file_path: inSidWorktree("src", "app.ts") },
    });
    expect(r.decisionReason?.type).not.toBe("safetyCheck");
  });

  test("写 <wt>/packages/core/src/tool/bash.ts 不需确认（深层路径）", async () => {
    const r = await checker().check({
      toolName: "write",
      input: { file_path: inSidWorktree("packages", "core", "src", "tool", "bash.ts") },
    });
    expect(r.decisionReason?.type).not.toBe("safetyCheck");
  });

  test("edit / notebook_edit 同样不被误拦", async () => {
    const c = checker();
    const edit = await c.check({
      toolName: "edit",
      input: { file_path: inSidWorktree("src", "login.ts") },
    });
    expect(edit.decisionReason?.type).not.toBe("safetyCheck");

    const nb = await c.check({
      toolName: "notebook_edit",
      input: { notebook_path: inSidWorktree("analysis.ipynb") },
    });
    expect(nb.decisionReason?.type).not.toBe("safetyCheck");
  });

  test(".claude/worktrees 布局同样不被误拦（CC 的默认位置）", async () => {
    const r = await checker().check({
      toolName: "write",
      input: { file_path: inClaudeWorktree("src", "app.ts") },
    });
    expect(r.decisionReason?.type).not.toBe("safetyCheck");
  });

  test("yesMode 下也是同一结论（Step 6 本就 bypass-immune，剥离前它拦、剥离后它不拦）", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: inSidWorktree("src", "app.ts") },
    });
    expect(r.decisionReason?.type).not.toBe("safetyCheck");
  });
});

describe("W4：worktree **内部**的敏感路径照旧拦住（不是放宽守卫）", () => {
  test("<wt>/.git/hooks/pre-commit 仍需确认且不可自动审批", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: inSidWorktree(".git", "hooks", "pre-commit") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
    expect((r.decisionReason as { classifierApprovable?: boolean }).classifierApprovable).toBe(
      false,
    );
  });

  test("<wt>/.sid-code/settings.json 仍需确认且不可自动审批", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: inSidWorktree(".sid-code", "settings.json") },
    });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("safetyCheck");
    expect((r.decisionReason as { classifierApprovable?: boolean }).classifierApprovable).toBe(
      false,
    );
  });

  test("<wt>/.sid-code/commands/pwn.md 仍需确认", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: inSidWorktree(".sid-code", "commands", "pwn.md") },
    });
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("<wt>/.claude/skills/x.md 仍需确认", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: inSidWorktree(".claude", "skills", "x.md") },
    });
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("主仓（非 worktree）的 .sid-code/settings.json 照旧拦住", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: join(workspace, ".sid-code", "settings.json") },
    });
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });

  test("worktrees 目录本身（还没进到某个 slug 里）仍算配置目录", async () => {
    const r = await checker({ yesMode: true }).check({
      toolName: "write",
      input: { file_path: join(workspace, ".sid-code", "worktrees", "note.txt") },
    });
    expect(r.decisionReason?.type).toBe("safetyCheck");
  });
});

describe("W4：bash 重定向与写工具同口径", () => {
  test("重定向到 worktree 内普通文件不算敏感", () => {
    const target = inSidWorktree("src", "out.txt");
    expect(hasSensitiveRedirection(`echo hi > ${target}`).sensitive).toBe(false);
  });

  test("重定向到 worktree 内 .git/hooks 仍算敏感", () => {
    const target = inSidWorktree(".git", "hooks", "pre-push");
    const r = hasSensitiveRedirection(`echo x > ${target}`);
    expect(r.sensitive).toBe(true);
    // 报给用户的 target 是原始字符串，不拿剥过的路径糊弄人
    expect(r.targets[0]).toBe(target);
  });

  test("重定向到 worktree 内 .sid-code/settings.json 仍算敏感", () => {
    const target = inClaudeWorktree(".sid-code", "settings.json");
    expect(hasSensitiveRedirection(`echo {} > ${target}`).sensitive).toBe(true);
  });
});

describe("stripWorktreeContainerPrefix 的边界", () => {
  test("剥掉容器前缀，保留 worktree 内的相对结构", () => {
    expect(stripWorktreeContainerPrefix("/repo/.sid-code/worktrees/agent-1/src/a.ts")).toBe(
      "/repo/src/a.ts",
    );
    expect(stripWorktreeContainerPrefix("/repo/.claude/worktrees/feat/src/a.ts")).toBe(
      "/repo/src/a.ts",
    );
  });

  test("worktree 内的敏感路径剥离后依然可被匹配", () => {
    expect(
      stripWorktreeContainerPrefix("/repo/.sid-code/worktrees/agent-1/.sid-code/settings.json"),
    ).toBe("/repo/.sid-code/settings.json");
    expect(
      stripWorktreeContainerPrefix("/repo/.sid-code/worktrees/agent-1/.git/hooks/pre-commit"),
    ).toBe("/repo/.git/hooks/pre-commit");
  });

  test("嵌套 worktree 全部剥净（只剥一层会让外层前缀仍命中）", () => {
    expect(
      stripWorktreeContainerPrefix(
        "/repo/.sid-code/worktrees/agent-1/.sid-code/worktrees/agent-2/src/a.ts",
      ),
    ).toBe("/repo/src/a.ts");
  });

  test("相对路径也能剥（bash 重定向目标未必是绝对路径）", () => {
    expect(stripWorktreeContainerPrefix(".sid-code/worktrees/agent-1/src/a.ts")).toBe("src/a.ts");
  });

  test("非 worktree 路径原样返回", () => {
    expect(stripWorktreeContainerPrefix("/repo/src/a.ts")).toBe("/repo/src/a.ts");
    expect(stripWorktreeContainerPrefix("/repo/.sid-code/settings.json")).toBe(
      "/repo/.sid-code/settings.json",
    );
    // worktrees 目录本身（后面没有 slug/文件两段）不剥
    expect(stripWorktreeContainerPrefix("/repo/.sid-code/worktrees/agent-1")).toBe(
      "/repo/.sid-code/worktrees/agent-1",
    );
  });

  test("不误伤名字里带 worktrees 的普通目录", () => {
    expect(stripWorktreeContainerPrefix("/repo/my-worktrees/agent-1/src/a.ts")).toBe(
      "/repo/my-worktrees/agent-1/src/a.ts",
    );
    expect(stripWorktreeContainerPrefix("/repo/.sid-code-old/worktrees/a/src/a.ts")).toBe(
      "/repo/.sid-code-old/worktrees/a/src/a.ts",
    );
  });
});
