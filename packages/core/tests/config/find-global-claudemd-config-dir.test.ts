/**
 * 用户级 CLAUDE.md 的查找必须尊重 `CLAUDE_CONFIG_DIR`（2026-11-10）。
 *
 * 修前 `findGlobalCLAUDEmd()` 第一候选硬用 `join(homedir(), ".claude", "CLAUDE.md")`：
 * 配置目录被重定向（`CLAUDE_CONFIG_DIR` / `SID_CONFIG_DIR` 做隔离、CI、多账号）后，
 * 仍然去读**真实 HOME** 的那份。而这一层是 `user`（可信层）——能设
 * `## Permission Mode` 与 `## Allowed Tools`，等于隔离意图被一份"本该读不到的文件"抬了权限档。
 * 同层的 `userRulesDirs()` 早就是 `getClaudeHome()` 口径，两条用户级读取路径不允许再分叉。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGlobalCLAUDEmd } from "@sid-code/core/config/rules.ts";

let dir: string;
let prevClaudeDir: string | undefined;
let prevSidDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-global-claudemd-"));
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  prevSidDir = process.env.SID_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  // 必须存/恢复原值：同批多文件跑在同一进程里，无条件 delete 会抹掉 preload 的兜底
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  if (prevSidDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("findGlobalCLAUDEmd 尊重 CLAUDE_CONFIG_DIR", () => {
  test("重定向后返回重定向目录里的 CLAUDE.md，而不是真实 HOME 的那份", () => {
    const target = join(dir, "CLAUDE.md");
    writeFileSync(target, "# 用户级\n\n## Allowed Tools\n- Bash(ls *)\n");
    expect(findGlobalCLAUDEmd()).toBe(target);
  });

  test("重定向目录里没有时返回 null（不去回退真实 HOME）", () => {
    // 真实 HOME 是否存在 ~/.claude/CLAUDE.md 与本断言无关：重定向后它就不该被读
    expect(findGlobalCLAUDEmd()).toBeNull();
  });

  test('源码不再硬编码 join(homedir(), ".claude", "CLAUDE.md")', () => {
    const src = readFileSync(join(import.meta.dir, "../../src/config/rules.ts"), "utf8");
    expect(src).toContain('join(getClaudeHome(), "CLAUDE.md")');
    expect(src).not.toContain('join(homedir(), ".claude", "CLAUDE.md")');
  });
});
