/**
 * 团队记忆 secret 守卫测试（E.11）
 *
 * 验证 checkTeamMemSecrets 仅在「启用 + 命中团队记忆路径 + 含 secret」时拦截。
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { checkTeamMemSecrets } from "@sid-code/core/memory/team/secret-guard.ts";
import { getTeamMemPath } from "@sid-code/core/memory/team/paths.ts";

const cwd = process.cwd();
const teamFile = join(getTeamMemPath(cwd), "patterns.md");
const nonTeamFile = "/tmp/some-other-file.md";
const SECRET = "ghp_" + "a".repeat(36);

describe("checkTeamMemSecrets", () => {
  test("未启用团队记忆 → 不拦截（返回 null）", () => {
    expect(checkTeamMemSecrets(teamFile, `token ${SECRET}`, { enabled: false }, cwd)).toBeNull();
    expect(checkTeamMemSecrets(teamFile, `token ${SECRET}`, undefined, cwd)).toBeNull();
  });

  test("非团队记忆路径 → 不拦截", () => {
    expect(checkTeamMemSecrets(nonTeamFile, `token ${SECRET}`, { enabled: true }, cwd)).toBeNull();
  });

  test("团队记忆路径 + 含 secret → 拦截并返回错误信息", () => {
    const err = checkTeamMemSecrets(teamFile, `token ${SECRET}`, { enabled: true }, cwd);
    expect(err).not.toBeNull();
    expect(err).toContain("secret");
    expect(err).toContain("GitHub PAT");
    // 错误信息不含明文 secret
    expect(err).not.toContain("a".repeat(36));
  });

  test("团队记忆路径 + 干净内容 → 放行", () => {
    const err = checkTeamMemSecrets(teamFile, "统一用 4 空格缩进", { enabled: true }, cwd);
    expect(err).toBeNull();
  });
});
