/**
 * extractWorktreeArg 三态解析测试
 *
 * 背景：`--worktree[=<name>]` 对齐 GNU 可选值语义——parseArgs 的 type:"string"
 * 强制带值（`sid-code --worktree` 单独出现会报 argument missing），故手动预扫描
 * argv 抽取 worktree。与 extractResumeArg 不同：只认等号形式，不吃下一个 token，
 * 避免 `sid-code --worktree 帮我修登录页` 把提示词当 worktree 名。
 *
 * 三态：
 *   - 未出现              → { present:false }
 *   - 裸 --worktree       → { present:true, value:"" }     自动命名
 *   - --worktree= / =name → { present:true, value:"..." }
 * 并把相关 token 从 argv 剔除（rest），交给 parseArgs 处理其余选项。
 */

import { describe, test, expect } from "bun:test";
import { extractWorktreeArg } from "@sid-code/cli/cli.ts";

describe("extractWorktreeArg", () => {
  test("未出现 worktree → present=false，rest 原样保留", () => {
    const r = extractWorktreeArg(["--model", "opus", "hello"]);
    expect(r.present).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.rest).toEqual(["--model", "opus", "hello"]);
  });

  test("裸 --worktree → present=true，值为空串（自动命名）", () => {
    const r = extractWorktreeArg(["--worktree"]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("");
    expect(r.rest).toEqual([]);
  });

  test("裸 --worktree 后跟另一个选项 → 不吞掉后续选项", () => {
    const r = extractWorktreeArg(["--worktree", "--print"]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("");
    expect(r.rest).toEqual(["--print"]);
  });

  test("裸 --worktree 后跟提示词 → 提示词留在 rest，不当名字", () => {
    const r = extractWorktreeArg(["--worktree", "帮我修登录页"]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("");
    expect(r.rest).toEqual(["帮我修登录页"]);
  });

  test("--worktree= 空值等号形式 → 值为空串（自动命名）", () => {
    const r = extractWorktreeArg(["--worktree="]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("");
    expect(r.rest).toEqual([]);
  });

  test("--worktree=<name> 等号形式 → 带值", () => {
    const r = extractWorktreeArg(["--worktree=my-feature"]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("my-feature");
    expect(r.rest).toEqual([]);
  });

  test("--worktree=name 后跟提示词 → 名字与提示词分开", () => {
    const r = extractWorktreeArg(["--worktree=my-feature", "帮我修登录页"]);
    expect(r.value).toBe("my-feature");
    expect(r.rest).toEqual(["帮我修登录页"]);
  });

  test("空格分隔的 --worktree foo 不当名字（foo 留 rest）", () => {
    const r = extractWorktreeArg(["--worktree", "foo"]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("");
    expect(r.rest).toEqual(["foo"]);
  });

  test("与其它选项混排 → 其它选项进 rest", () => {
    const r = extractWorktreeArg(["--model", "opus", "--worktree=feat", "--debug"]);
    expect(r.value).toBe("feat");
    expect(r.rest).toEqual(["--model", "opus", "--debug"]);
  });
});
