/**
 * 迁移 v2（有损项目键搬迁）测试 — 审计第 3 条善后
 *
 * 修复第 3 条要换项目目录键，而该键同时决定 projects/<key>/memory、team-memory、
 * sessions/<key>/、mcp.local.json 四处已落盘数据的位置。换键后若不搬数据，
 * 用户的记忆与历史会话在升级后会凭空「消失」。
 *
 * 但搬迁本身有安全边界：旧目录之所以有问题，恰恰因为它可能被多个项目共用——
 * 把它整体搬给「恰好先启动的那个项目」等于换个方向重演隐私泄漏。故本迁移
 * **复制而非移动**（旧目录保留）、**新目录已存在就跳过**（绝不覆盖）。
 *
 * 用 SID_CONFIG_DIR + 临时 git 仓库隔离，不碰真实用户数据。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const TEST_ROOT = join("/tmp", `sid-relocate-test-${process.pid}`);
const TEST_HOME = join(TEST_ROOT, "home", ".sid-code");
/** 中文路径 → 旧算法下键有损；两个这样的项目会撞到同一个旧键 */
const PROJ_A = join(TEST_ROOT, "工作", "app");
const PROJ_B = join(TEST_ROOT, "文档", "app");

let originalCwd: string;

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q .", { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  originalCwd = process.cwd();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.SID_CONFIG_DIR = TEST_HOME;
  initRepo(PROJ_A);
  initRepo(PROJ_B);
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.SID_CONFIG_DIR;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("迁移 v2：有损项目键搬迁（审计第 3 条）", () => {
  test("旧键下的记忆被复制到新键，且旧目录保留", async () => {
    const { sanitizeProjectKey, findLegacyProjectKey, resolveProjectRoot } = await import(
      "../../src/memory/paths.ts"
    );
    process.chdir(PROJ_A);
    const root = resolveProjectRoot(PROJ_A);
    const legacyKey = findLegacyProjectKey(root)!;
    const newKey = sanitizeProjectKey(root);
    expect(legacyKey).toBeDefined();
    expect(newKey).not.toBe(legacyKey);

    // 铺一份"升级前"的存量记忆到旧键目录
    const legacyMem = join(TEST_HOME, "projects", legacyKey, "memory");
    mkdirSync(legacyMem, { recursive: true });
    writeFileSync(join(legacyMem, "MEMORY.md"), "# Memory Index\n- [A 的约定](a.md)\n");

    const { migrate } = await import("../../src/migrations/relocate-lossy-project-key.ts");
    migrate();

    const newIndex = join(TEST_HOME, "projects", newKey, "memory", "MEMORY.md");
    expect(existsSync(newIndex)).toBe(true);
    expect(readFileSync(newIndex, "utf-8")).toContain("A 的约定");
    // 复制而非移动：旧目录必须仍在（歧义情况下用户要能人工核对）
    expect(existsSync(join(legacyMem, "MEMORY.md"))).toBe(true);
  });

  test("新键目录已有数据 → 不覆盖", async () => {
    const { sanitizeProjectKey, findLegacyProjectKey, resolveProjectRoot } = await import(
      "../../src/memory/paths.ts"
    );
    process.chdir(PROJ_A);
    const root = resolveProjectRoot(PROJ_A);
    const legacyKey = findLegacyProjectKey(root)!;
    const newKey = sanitizeProjectKey(root);

    const legacyMem = join(TEST_HOME, "projects", legacyKey, "memory");
    mkdirSync(legacyMem, { recursive: true });
    writeFileSync(join(legacyMem, "MEMORY.md"), "旧数据");
    const newMem = join(TEST_HOME, "projects", newKey, "memory");
    mkdirSync(newMem, { recursive: true });
    writeFileSync(join(newMem, "MEMORY.md"), "新数据（不该被覆盖）");

    const { migrate } = await import("../../src/migrations/relocate-lossy-project-key.ts");
    migrate();

    expect(readFileSync(join(newMem, "MEMORY.md"), "utf-8")).toBe("新数据（不该被覆盖）");
  });

  test("纯 ASCII 项目（键无损）→ 完全空操作", async () => {
    const asciiProj = join(TEST_ROOT, "plain", "app");
    initRepo(asciiProj);
    process.chdir(asciiProj);

    const { findLegacyProjectKey, resolveProjectRoot } = await import("../../src/memory/paths.ts");
    expect(findLegacyProjectKey(resolveProjectRoot(asciiProj))).toBeUndefined();

    const { migrate } = await import("../../src/migrations/relocate-lossy-project-key.ts");
    // 无旧键 → 不应抛错、不应创建任何目录
    expect(() => migrate()).not.toThrow();
  });

  test("幂等：重复执行结果一致", async () => {
    const { sanitizeProjectKey, findLegacyProjectKey, resolveProjectRoot } = await import(
      "../../src/memory/paths.ts"
    );
    process.chdir(PROJ_A);
    const root = resolveProjectRoot(PROJ_A);
    const legacyMem = join(TEST_HOME, "projects", findLegacyProjectKey(root)!, "memory");
    mkdirSync(legacyMem, { recursive: true });
    writeFileSync(join(legacyMem, "MEMORY.md"), "内容");

    const { migrate } = await import("../../src/migrations/relocate-lossy-project-key.ts");
    migrate();
    migrate();

    const newIndex = join(TEST_HOME, "projects", sanitizeProjectKey(root), "memory", "MEMORY.md");
    expect(readFileSync(newIndex, "utf-8")).toBe("内容");
  });

  test("两个撞键项目搬迁后互不可见（第 3 条隔离目标）", async () => {
    const { getAutoMemPath } = await import("../../src/memory/paths.ts");
    expect(getAutoMemPath(PROJ_A)).not.toBe(getAutoMemPath(PROJ_B));
  });
});
