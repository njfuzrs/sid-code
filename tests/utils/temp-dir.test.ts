/**
 * 临时目录多用户隔离单测（对标 claude-code getClaudeTempDir）
 *
 * 覆盖：UID 隔离目录名、symlink 解析、env 覆盖、0o700 权限、会话级隔离。
 */

import { test, expect, describe, afterEach } from "bun:test";
import { statSync, rmSync } from "node:fs";
import {
  getSidTempDirName,
  getSidTempDir,
  ensureSidTempDir,
  ensureSessionTempDir,
  ensureSidTempSubdir,
  __resetSidTempDirCache,
} from "@sid-code/shared/utils/temp-dir.ts";

const origEnv = process.env.SID_CODE_TMPDIR;

afterEach(() => {
  // 还原 env 与缓存，避免污染其它用例
  if (origEnv === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = origEnv;
  __resetSidTempDirCache();
});

describe("temp-dir 多用户隔离", () => {
  test("Unix 目录名带 UID（与 claude-code claude-{uid} 同构）", () => {
    const name = getSidTempDirName();
    if (process.platform === "win32") {
      expect(name).toBe("sid-code");
    } else {
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      expect(name).toBe(`sid-code-${uid}`);
    }
  });

  test("根路径包含隔离目录名", () => {
    __resetSidTempDirCache();
    const root = getSidTempDir();
    expect(root.endsWith(getSidTempDirName())).toBe(true);
  });

  test("根路径在进程内记忆化（多次调用返回同一值）", () => {
    __resetSidTempDirCache();
    const a = getSidTempDir();
    const b = getSidTempDir();
    expect(a).toBe(b);
  });

  test("SID_CODE_TMPDIR 覆盖 base", () => {
    process.env.SID_CODE_TMPDIR = "/tmp";
    __resetSidTempDirCache();
    const root = getSidTempDir();
    // macOS 下 /tmp → /private/tmp（symlink 解析），故只断言以隔离名结尾且含 tmp
    expect(root.endsWith(getSidTempDirName())).toBe(true);
    expect(root.includes("tmp")).toBe(true);
  });

  test("ensureSidTempDir 以 0o700 创建（仅 owner 可访问）", () => {
    const dir = ensureSidTempDir();
    const mode = statSync(dir).mode & 0o777;
    // Windows 不强制 POSIX 权限位，跳过严格断言
    if (process.platform !== "win32") {
      expect(mode).toBe(0o700);
    }
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test("会话级临时目录按 sessionId 隔离且 0o700", () => {
    const s1 = ensureSessionTempDir("sess-A", "masked-outputs");
    const s2 = ensureSessionTempDir("sess-B", "masked-outputs");
    expect(s1).not.toBe(s2);
    expect(s1.includes("sess-A")).toBe(true);
    expect(s2.includes("sess-B")).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(s1).mode & 0o777).toBe(0o700);
    }
    rmSync(s1, { recursive: true, force: true });
    rmSync(s2, { recursive: true, force: true });
  });

  test("ensureSessionTempDir 缺省 sessionId 落到 default", () => {
    const d = ensureSessionTempDir();
    expect(d.includes("default")).toBe(true);
  });

  test("ensureSidTempSubdir 在根下创建子目录且 0o700", () => {
    const dir = ensureSidTempSubdir("bundled-skills", "nonce-test");
    expect(dir.includes("bundled-skills")).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
