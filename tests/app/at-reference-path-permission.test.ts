/**
 * 审计第 20 条回归测试 — `@文件` 提及展开必须走工具层同一道路径校验
 *
 * 缺陷：`expandAtReferences` 直接 `resolve + readFile`，零权限校验，
 * 完整绕过 `PathValidator`（敏感文件 / 系统目录 / symlink 逃逸 / Unicode 混淆）。
 * 一个 `@../outside/.env` 就能把密钥明文注入上下文并随请求发往模型服务端，
 * 而同一路径经 `read` 工具会被 checker.ts Step 4 直接拦下。
 *
 * 本测试固化四个用例（与发现清单第 20 条表格一致），关键是最后一个"应当放行"的
 * 对照：修复必须是"该拦的拦住"，而不是一刀切把工作区外全拦（那会砍掉正常用法）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandAtReferences } from "@sid-code/cli/app.ts";
import { PathValidator } from "@sid-code/core/permission/path-validator.ts";
import type { Checker } from "@sid-code/core/permission/types.ts";

let root: string;
let proj: string;
let outside: string;
let originalCwd: string;

/** 只实现 getPathValidator 的最小 Checker：本条修复只消费这一个方法 */
function makeChecker(workspacePath: string): Checker {
  const validator = new PathValidator(workspacePath, [], []);
  return {
    check: async () => ({ allowed: true }),
    getPathValidator: () => validator,
  } as unknown as Checker;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "atref-perm-"));
  proj = join(root, "proj");
  outside = join(root, "outside");
  mkdirSync(proj, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, ".env"), "SECRET_TOKEN=sk-outside-project-root\n");
  writeFileSync(join(outside, "notes.txt"), "plain notes, not sensitive\n");
  writeFileSync(join(proj, "readme.md"), "# in-workspace file\n");
  // @ 展开以 process.cwd() 为基准解析相对路径，故把 cwd 切到工作区
  originalCwd = process.cwd();
  process.chdir(proj);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("@ 提及展开的路径权限校验（审计第 20 条）", () => {
  test("敏感文件（.env）被拦截：内容不进上下文，且拦截可观测", async () => {
    const r = await expandAtReferences("看下 @../outside/.env", undefined, makeChecker(proj));

    expect(r.injectedContent ?? "").not.toContain("sk-outside-project-root");
    expect(r.blockedPaths).toBeDefined();
    expect(r.blockedPaths!.length).toBe(1);
    expect(r.blockedPaths![0]!.path).toBe("../outside/.env");
    expect(r.blockedPaths![0]!.reason).toContain("敏感文件");
    // 不能静默：模型侧要收到"未注入"的显式说明，否则会以为读到了内容
    expect(r.injectedContent).toContain("未注入");
  });

  test("引号形态同样被拦截（不能只覆盖无引号分支）", async () => {
    const abs = join(outside, ".env");
    const r = await expandAtReferences(`看下 @"${abs}"`, undefined, makeChecker(proj));

    expect(r.injectedContent ?? "").not.toContain("sk-outside-project-root");
    expect(r.blockedPaths?.length).toBe(1);
  });

  test("工作区外的非敏感文件仍放行（防一刀切全拦）", async () => {
    const r = await expandAtReferences("看下 @../outside/notes.txt", undefined, makeChecker(proj));

    expect(r.injectedContent).toContain("plain notes, not sensitive");
    expect(r.blockedPaths).toBeUndefined();
  });

  test("工作区内普通文件正常注入", async () => {
    const r = await expandAtReferences("看下 @readme.md", undefined, makeChecker(proj));

    expect(r.injectedContent).toContain("in-workspace file");
    expect(r.blockedPaths).toBeUndefined();
  });

  test("图片分支不参与路径校验（只推路径不读字节，由 Read 工具走正常权限）", async () => {
    writeFileSync(join(proj, "shot.png"), "fake");
    const r = await expandAtReferences("看下 @shot.png", undefined, makeChecker(proj));

    expect(r.injectedContent).toContain("请用 Read 工具读取");
    expect(r.blockedPaths).toBeUndefined();
  });

  test("无 checker 时保持原行为（权限体系未装配，不是本条修复的责任范围）", async () => {
    const r = await expandAtReferences("看下 @../outside/.env", undefined, null);

    expect(r.injectedContent).toContain("sk-outside-project-root");
    expect(r.blockedPaths).toBeUndefined();
  });
});
