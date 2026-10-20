/**
 * getWorktreeConfig 对 symlinkDirectories 空数组的语义。
 *
 * 旧实现用 length > 0 把显式 [] 和未设置混为一谈，都回退默认 ["node_modules"]。
 * 用户写 [] 是想关掉 symlink；回退后创建期零告警，比没有这个配置项更危险。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, lstatSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { getWorktreeConfig, DEFAULT_WORKTREE_CONFIG } from "@sid-code/core/worktree/config.ts";
import { WorktreeManager } from "@sid-code/core/worktree/manager.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const prevConfigDir = process.env.SID_CONFIG_DIR;
let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sid-wt-cfg-")));
  process.env.SID_CONFIG_DIR = join(root, "home");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  resetSettingsCache();
});

afterEach(() => {
  resetSettingsCache();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function writeProjectSettings(obj: unknown): void {
  mkdirSync(join(repo, ".sid-code"), { recursive: true });
  writeFileSync(join(repo, ".sid-code", "settings.json"), JSON.stringify(obj));
  resetSettingsCache();
}

describe("getWorktreeConfig symlinkDirectories 空数组", () => {
  it('未设置 → 默认 ["node_modules"]', () => {
    expect(getWorktreeConfig(repo).symlinkDirectories).toEqual(
      DEFAULT_WORKTREE_CONFIG.symlinkDirectories,
    );
  });

  it("显式 [] → 尊重为空（不再回退默认）", () => {
    writeProjectSettings({ worktree: { symlinkDirectories: [] } });
    expect(getWorktreeConfig(repo).symlinkDirectories).toEqual([]);
  });

  it("显式名单 → 原样保留", () => {
    writeProjectSettings({ worktree: { symlinkDirectories: ["vendor"] } });
    expect(getWorktreeConfig(repo).symlinkDirectories).toEqual(["vendor"]);
  });

  it("显式 [] 创建 worktree 时不 symlink node_modules", async () => {
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", ".keep"), "");
    writeProjectSettings({ worktree: { symlinkDirectories: [] } });

    const session = await new WorktreeManager(repo).create("no-symlink");
    expect(lstatSync(join(session.worktreePath, "a.txt")).isFile()).toBe(true);
    expect(() => lstatSync(join(session.worktreePath, "node_modules"))).toThrow();
  });
});
