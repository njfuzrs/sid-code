/**
 * `/memory` 面板的 CLAUDE.md 发现必须与 `config/rules.ts` 同源（2026-11-10）。
 *
 * 修前这里硬用 `join(homedir(), ".claude", "CLAUDE.md")`：配置目录被重定向
 * （`CLAUDE_CONFIG_DIR` / `SID_CONFIG_DIR`）后，面板展示的是一个并未被加载的文件，
 * 而 `findGlobalCLAUDEmd()` 读的是重定向目录那份。两处路径分叉 = 面板撒谎。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMemoryFiles } from "@sid-code/cli/ui/utils/memory-files.ts";

let home: string;
let work: string;
let prevClaudeDir: string | undefined;
let prevSidDir: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sid-memfiles-home-"));
  work = mkdtempSync(join(tmpdir(), "sid-memfiles-work-"));
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  prevSidDir = process.env.SID_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.SID_CONFIG_DIR = home;
});

afterEach(() => {
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  if (prevSidDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidDir;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("discoverMemoryFiles 尊重 CLAUDE_CONFIG_DIR", () => {
  test("用户级条目只来自重定向目录，displayPath 用真实路径而不是写死的 ~/.claude", () => {
    const target = join(home, "CLAUDE.md");
    writeFileSync(target, "# 用户级\n\n## Allowed Tools\n- Bash(ls *)\n");

    const userFiles = discoverMemoryFiles(work).filter((f) => f.scope === "user");
    expect(userFiles).toHaveLength(1);
    expect(userFiles[0]!.path).toBe(target);
    // 重定向后不在家目录下，展示路径必须诚实（写死 "~/.claude/CLAUDE.md" 会指向未被读取的文件）
    expect(userFiles[0]!.displayPath).toBe(target);
  });

  test("项目级条目不受配置目录重定向影响", () => {
    writeFileSync(join(work, "CLAUDE.md"), "# 项目\n");
    writeFileSync(join(home, "CLAUDE.md"), "# 用户\n");

    const files = discoverMemoryFiles(work);
    expect(files.some((f) => f.scope === "project" && f.path === join(work, "CLAUDE.md"))).toBe(
      true,
    );
    expect(files.some((f) => f.scope === "user" && f.path === join(home, "CLAUDE.md"))).toBe(true);
  });
});
