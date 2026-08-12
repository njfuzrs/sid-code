/**
 * 团队记忆路径解析测试（E.11）
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import {
  isTeamMemPath,
  resolveSharedTeamDir,
  isTeamMemorySyncAvailable,
  isTeamMemoryEnabled,
  getTeamMemPath,
  TEAM_MEMORY_DIRNAME,
} from "@sid-code/core/memory/team/paths.ts";

describe("team paths — 目录解析", () => {
  test("getTeamMemPath 落在 projects/<key>/team-memory", () => {
    const p = getTeamMemPath(process.cwd());
    expect(p).toContain("projects");
    expect(p.endsWith(TEAM_MEMORY_DIRNAME)).toBe(true);
  });

  test("isTeamMemPath 命中团队目录内文件", () => {
    const dir = getTeamMemPath(process.cwd());
    expect(isTeamMemPath(join(dir, "patterns.md"))).toBe(true);
    expect(isTeamMemPath(join(dir, "sub", "a.md"))).toBe(true);
  });

  test("isTeamMemPath 拒绝目录外文件 + ../ 逃逸", () => {
    const dir = getTeamMemPath(process.cwd());
    expect(isTeamMemPath(join(dir, "..", "other.md"))).toBe(false);
    expect(isTeamMemPath("/etc/passwd")).toBe(false);
  });
});

describe("team paths — 共享目录与开关", () => {
  test("resolveSharedTeamDir 合法绝对路径返回规范化路径", () => {
    expect(resolveSharedTeamDir({ enabled: true, dir: "/tmp/shared-team" })).toBe(
      "/tmp/shared-team",
    );
  });

  test("resolveSharedTeamDir 相对路径/空返回 undefined", () => {
    expect(resolveSharedTeamDir({ enabled: true, dir: "relative/path" })).toBeUndefined();
    expect(resolveSharedTeamDir({ enabled: true })).toBeUndefined();
    expect(resolveSharedTeamDir(undefined)).toBeUndefined();
  });

  test("isTeamMemoryEnabled 只看 enabled", () => {
    expect(isTeamMemoryEnabled({ enabled: true })).toBe(true);
    expect(isTeamMemoryEnabled({ enabled: false })).toBe(false);
    expect(isTeamMemoryEnabled(undefined)).toBe(false);
  });

  test("isTeamMemorySyncAvailable 需要 enabled + 合法共享目录", () => {
    expect(isTeamMemorySyncAvailable({ enabled: true, dir: "/tmp/x" })).toBe(true);
    expect(isTeamMemorySyncAvailable({ enabled: true })).toBe(false); // 无共享目录
    expect(isTeamMemorySyncAvailable({ enabled: false, dir: "/tmp/x" })).toBe(false);
  });
});
