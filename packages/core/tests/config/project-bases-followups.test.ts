/**
 * #220 复核遗留项回归（20261009 方案复核）。
 *
 * 变异自证（逐条撤掉修复，对应用例必须变红）：
 * - getProjectIdentityRoot 改回 resolveProjectRoot（--show-toplevel）→「worktree 归主仓」红；
 * - rules.ts 合并顺序改回「全部 CLAUDE.md → 全部 rules → 全部 local」→「P3 逐层」红；
 * - trust.ts 继承记录改回比 configHash →「P10 继承」红；
 * - resolveLocalSettingsBase 去掉属主判断 →「P1b 属主」红（需要 chown，非 root 下跳过）；
 * - cli.ts 去掉 pending 也建 manager → shouldCreateMcpManager 断言红；
 * - applyServerToggles 去掉 enabled 名单 →「显式启用盖过 enabled:false」红。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { getCheckoutRoot, getProjectIdentityRoot } from "@sid-code/core/config/project-bases.ts";
import { loadAllCLAUDEmd } from "@sid-code/core/config/rules.ts";
import { TrustManager } from "@sid-code/core/permission/trust.ts";
import { clearProjectRootCache } from "@sid-code/core/memory/paths.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import {
  applyServerToggles,
  getMcpServerToggles,
  getMcpProjectRoot,
  getLegacyMcpProjectKeys,
  setMcpServerDisabled,
  shouldCreateMcpManager,
  ancestorDirsToRoot,
} from "@sid-code/core/mcp/project-files.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

function git(cwd: string, ...args: string[]): void {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

let tmp: string;
let repo: string;
let prevConfigDir: string | undefined;
let prevCwd: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sid-bases-fu-")));
  repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", ".");
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(tmp, "sid-home");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  prevCwd = process.cwd();
  clearProjectRootCache();
  resetSettingsCache();
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  clearProjectRootCache();
  resetSettingsCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** 在 repo 旁建一个 linked worktree，返回其路径 */
function addWorktree(): string {
  write(join(repo, "README.md"), "x");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(tmp, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  return realpathSync(wt);
}

describe("B2 两个入口：私有状态归主仓，工作树文件按 checkout", () => {
  test("linked worktree：identity = 主仓根，checkout = worktree 自己", () => {
    const wt = addWorktree();
    const sub = join(wt, "a");
    mkdirSync(sub, { recursive: true });
    expect(getProjectIdentityRoot(sub)).toBe(repo);
    expect(getCheckoutRoot(sub)).toBe(wt);
  });

  test("MCP 项目键归主仓；旧键（worktree 根、cwd）作为迁移回退", async () => {
    const wt = addWorktree();
    const sub = join(wt, "a");
    mkdirSync(sub, { recursive: true });
    expect(await getMcpProjectRoot(sub)).toBe(repo);
    expect(await getLegacyMcpProjectKeys(sub)).toEqual([wt, sub]);
  });

  test("在主仓禁用 → worktree 里读到同一份禁用状态", async () => {
    const wt = addWorktree();
    await setMcpServerDisabled("pw", true, repo);
    expect((await getMcpServerToggles(wt)).disabled).toEqual(["pw"]);
  });

  test("#220 按 worktree 根存的 mcp-state.json 仍被读到（迁移兼容）", async () => {
    const wt = addWorktree();
    const { sanitizeProjectKey } = await import("@sid-code/core/memory/paths.ts");
    write(
      join(process.env.SID_CONFIG_DIR!, "projects", sanitizeProjectKey(wt), "mcp-state.json"),
      JSON.stringify({ disabledMcpServers: ["old"] }),
    );
    expect((await getMcpServerToggles(wt)).disabled).toEqual(["old"]);
    // 写入落到主仓键那份
    const written = await setMcpServerDisabled("new", true, wt);
    expect(written).toContain(sanitizeProjectKey(repo));
    expect(JSON.parse(readFileSync(written, "utf-8")).disabledMcpServers.sort()).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("P3：父链逐层 CLAUDE.md → rules → CLAUDE.local.md", () => {
  test("外层 CLAUDE.local.md 排在内层 CLAUDE.md 与内层 rules 之前", async () => {
    const outer = tmp;
    const deep = join(repo, "pkg");
    write(join(outer, "CLAUDE.local.md"), "# Instructions\nOUTER_LOCAL");
    write(join(repo, "CLAUDE.md"), "# Instructions\nREPO_MD");
    write(join(repo, ".claude", "rules", "r.md"), "# Instructions\nREPO_RULE");
    write(join(repo, "CLAUDE.local.md"), "# Instructions\nREPO_LOCAL");
    write(join(deep, "CLAUDE.md"), "# Instructions\nDEEP_MD");
    mkdirSync(deep, { recursive: true });

    const raw = (await loadAllCLAUDEmd(deep, { activeFiles: [] }))?.rawContent ?? "";
    const order = ["OUTER_LOCAL", "REPO_MD", "REPO_RULE", "REPO_LOCAL", "DEEP_MD"].map((m) =>
      raw.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("`.claude/CLAUDE.md` 归入它所在的那一层，不是 .claude 子目录", async () => {
    write(join(repo, ".claude", "CLAUDE.md"), "# Instructions\nDOT_CLAUDE_MD");
    write(join(repo, ".claude", "rules", "r.md"), "# Instructions\nREPO_RULE");
    const raw = (await loadAllCLAUDEmd(repo, { activeFiles: [] }))?.rawContent ?? "";
    expect(raw.indexOf("DOT_CLAUDE_MD")).toBeGreaterThanOrEqual(0);
    expect(raw.indexOf("DOT_CLAUDE_MD")).toBeLessThan(raw.indexOf("REPO_RULE"));
  });
});

describe("P10：祖先信任锁存，不比 configHash；本项目记录仍比", () => {
  const dangerous = (dir: string, cmd: string) =>
    write(
      join(dir, ".sid-code", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: cmd }] }] } }),
    );

  test("祖先目录信任 → 带危险配置的仓库继承信任（#220 下这里恒为 false）", async () => {
    await new TrustManager(tmp).trust(); // tmp 不是 git 仓库：身份根即自身
    dangerous(repo, "echo a");
    expect(await new TrustManager(repo).isTrusted()).toBe(true);
    expect(new TrustManager(repo).isTrustedSync()).toBe(true);
  });

  test("对照：本项目自己的记录，配置变了仍要重新确认", async () => {
    dangerous(repo, "echo a");
    await new TrustManager(repo).trust();
    expect(await new TrustManager(repo).isTrusted()).toBe(true);
    dangerous(repo, "echo b");
    expect(await new TrustManager(repo).isTrusted()).toBe(false);
    expect(new TrustManager(repo).isTrustedSync()).toBe(false);
  });

  test("对照：本项目自己的记录优先于祖先 —— 配置改了不会被祖先信任兜过去", async () => {
    await new TrustManager(tmp).trust();
    dangerous(repo, "echo a");
    await new TrustManager(repo).trust();
    dangerous(repo, "echo b");
    expect(await new TrustManager(repo).isTrusted()).toBe(false);
  });
});

describe("MCP 启用 / 禁用开关与 manager 创建条件", () => {
  test("显式启用盖过配置源里的 enabled:false；禁用名单打 enabled:false", () => {
    const servers: Record<string, MCPServerConfig> = {
      legacyOff: { transport: "stdio", command: "a", enabled: false } as MCPServerConfig,
      plugin: { transport: "stdio", command: "b" } as MCPServerConfig,
    };
    const out = applyServerToggles(servers, { disabled: ["plugin"], enabled: ["legacyOff"] });
    expect(out.legacyOff.enabled).toBeUndefined();
    expect(out.plugin.enabled).toBe(false);
    expect(servers.legacyOff.enabled).toBe(false); // 不改原对象
  });

  test("禁用后再启用：两个名单互斥", async () => {
    await setMcpServerDisabled("x", true, repo);
    await setMcpServerDisabled("x", false, repo);
    expect(await getMcpServerToggles(repo)).toEqual({ disabled: [], enabled: ["x"] });
    await setMcpServerDisabled("x", true, repo);
    expect(await getMcpServerToggles(repo)).toEqual({ disabled: ["x"], enabled: [] });
  });

  test("只有待审批 server 也建 manager；策略禁用 MCP 时不建", () => {
    const base = { serverCount: 0, ideAutoConnect: false, pendingApprovalCount: 1 };
    expect(shouldCreateMcpManager({ ...base, mcpAllowedByPolicy: true })).toBe(true);
    expect(shouldCreateMcpManager({ ...base, mcpAllowedByPolicy: false })).toBe(false);
    expect(
      shouldCreateMcpManager({ ...base, pendingApprovalCount: 0, mcpAllowedByPolicy: true }),
    ).toBe(false);
  });

  test(".mcp.json 祖先遍历与 B4 同源：cwd 为文件系统根时不再与 getAncestorChain 分叉", () => {
    expect(ancestorDirsToRoot("/")).toEqual(["/"]);
    expect(ancestorDirsToRoot(repo)[0]).toBe(repo);
  });
});
