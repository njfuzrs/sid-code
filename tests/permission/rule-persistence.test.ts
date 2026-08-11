/**
 * 规则持久化测试（P2-3：Bash「始终允许」持久档落盘 + 归一规则可命中原命令）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { persistRule, removePersistedRule } from "@sid-code/core/permission/rule-persistence.ts";
import { matchRule } from "@sid-code/core/permission/rules.ts";

const dirs: string[] = [];
function tmpWs(): string {
  const d = mkdtempSync(join(tmpdir(), "sid-persist-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("persistRule - project settings 落盘", () => {
  test("写入 project settings.json 且结构正确", async () => {
    const ws = tmpWs();
    await persistRule("project", "allow", "Bash(git status)", ws);
    const file = join(ws, ".sid-code", "settings.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.permissions.allow).toContain("Bash(git status)");
  });

  test("重复写入不产生重复项", async () => {
    const ws = tmpWs();
    await persistRule("project", "allow", "Bash(ls)", ws);
    await persistRule("project", "allow", "Bash(ls)", ws);
    const parsed = JSON.parse(readFileSync(join(ws, ".sid-code", "settings.json"), "utf-8"));
    expect(parsed.permissions.allow.filter((r: string) => r === "Bash(ls)").length).toBe(1);
  });

  test("removePersistedRule 移除已写入规则", async () => {
    const ws = tmpWs();
    await persistRule("project", "allow", "Bash(pwd)", ws);
    const removed = await removePersistedRule("project", "allow", "Bash(pwd)", ws);
    expect(removed).toBe(true);
    const parsed = JSON.parse(readFileSync(join(ws, ".sid-code", "settings.json"), "utf-8"));
    expect(parsed.permissions.allow).not.toContain("Bash(pwd)");
  });
});

describe("P2-3 归一规则可命中原命令（对齐 P0-1 新 matcher）", () => {
  test("Bash(<command>) 精确命中原命令", () => {
    // app.persistBashAllowRule 用精确整条命令生成规则
    expect(matchRule("Bash(git status)", { toolName: "bash", input: { command: "git status" } })).toBe(true);
  });

  test("精确规则不误放行其它命令（保守归一，不自动加 *）", () => {
    expect(matchRule("Bash(git status)", { toolName: "bash", input: { command: "git status --short" } })).toBe(false);
    expect(matchRule("Bash(git status)", { toolName: "bash", input: { command: "git push" } })).toBe(false);
  });

  test("含路径的命令也能精确命中（P0-1 修复后 minimatch 失配问题不复现）", () => {
    expect(
      matchRule("Bash(cat src/config/app.ts)", { toolName: "bash", input: { command: "cat src/config/app.ts" } }),
    ).toBe(true);
  });
});
