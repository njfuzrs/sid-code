/**
 * 路径验证器测试
 * 覆盖：工作区边界、系统目录保护、敏感文件检测、symlink 解析、目录黑白名单
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PathValidator } from "../../src/permission/path-validator.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 测试用临时目录
let tmpDir: string;
let workspaceDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-validator-test-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  // 创建一些测试文件
  fs.writeFileSync(path.join(workspaceDir, "test.ts"), "// test");
  fs.writeFileSync(path.join(workspaceDir, ".env"), "SECRET=123");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "src", "index.ts"), "// index");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PathValidator - 工作区边界", () => {
  test("工作区内写入允许", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "new-file.ts"), "write");
    expect(result.allowed).toBe(true);
  });

  test("工作区内子目录写入允许", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "src", "new.ts"), "write");
    expect(result.allowed).toBe(true);
  });

  test("工作区外写入需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/tmp/outside.txt", "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.reason).toContain("工作区外");
  });

  test("工作区外读取允许（读取通常安全）", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/tmp/outside.txt", "read");
    expect(result.allowed).toBe(true);
  });
});

describe("PathValidator - 系统目录保护", () => {
  test("写入 /etc/ 需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/etc/passwd", "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.reason).toContain("系统目录");
  });

  test("写入 /usr/ 需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/usr/local/bin/foo", "write");
    expect(result.allowed).toBe(false);
  });

  test("读取 /proc/ 需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/proc/cpuinfo", "read");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
  });

  test("读取 /etc/ 允许（不在读取保护列表中）", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/etc/hosts", "read");
    // /etc/ 不在 PROTECTED_READ_DIRS 中，但在工作区外 → 读取允许
    expect(result.allowed).toBe(true);
  });
});

describe("PathValidator - 敏感文件检测", () => {
  test(".env 文件需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, ".env"), "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.reason).toContain("敏感文件");
  });

  test(".env.local 文件需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, ".env.local"), "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
  });

  test("credentials 文件需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "credentials.json"), "read");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
  });

  test(".pem 文件需确认", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "server.pem"), "read");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
  });

  test("普通 .ts 文件允许", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "src", "index.ts"), "write");
    expect(result.allowed).toBe(true);
  });
});

describe("PathValidator - symlink 解析", () => {
  test("symlink 指向工作区外被检测", () => {
    // 创建一个 symlink 指向工作区外
    const linkPath = path.join(workspaceDir, "escape-link");
    const targetPath = path.join(tmpDir, "outside-target.txt");
    fs.writeFileSync(targetPath, "outside content");

    try {
      fs.symlinkSync(targetPath, linkPath);
    } catch {
      // 某些环境不支持 symlink，跳过
      return;
    }

    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(linkPath, "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    // 可能被 symlink 逃逸或工作区边界检查拦截，两者都是正确行为
    expect(result.reason).toBeDefined();

    // 清理
    fs.unlinkSync(linkPath);
    fs.unlinkSync(targetPath);
  });

  test("symlink 指向工作区内允许", () => {
    const linkPath = path.join(workspaceDir, "internal-link");
    const targetPath = path.join(workspaceDir, "test.ts");

    try {
      fs.symlinkSync(targetPath, linkPath);
    } catch {
      return;
    }

    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(linkPath, "write");
    expect(result.allowed).toBe(true);

    fs.unlinkSync(linkPath);
  });
});

describe("PathValidator - 目录黑白名单", () => {
  test("黑名单目录被拒绝", () => {
    const blockedDir = path.join(workspaceDir, "node_modules");
    fs.mkdirSync(blockedDir, { recursive: true });

    const v = new PathValidator(workspaceDir, [], [blockedDir]);
    const result = v.validateAccess(path.join(blockedDir, "pkg", "index.js"), "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("禁止访问");

    fs.rmSync(blockedDir, { recursive: true, force: true });
  });

  test("白名单外目录被拒绝", () => {
    const allowedDir = path.join(workspaceDir, "src");
    const v = new PathValidator(workspaceDir, [allowedDir], []);
    const result = v.validateAccess(path.join(workspaceDir, "dist", "out.js"), "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("白名单");
  });

  test("白名单内目录允许", () => {
    const allowedDir = path.join(workspaceDir, "src");
    const v = new PathValidator(workspaceDir, [allowedDir], []);
    const result = v.validateAccess(path.join(allowedDir, "index.ts"), "write");
    expect(result.allowed).toBe(true);
  });
});

describe("PathValidator - resolveRealPath", () => {
  test("存在的文件返回真实路径", () => {
    const v = new PathValidator(workspaceDir);
    const realPath = v.resolveRealPath(path.join(workspaceDir, "test.ts"));
    expect(realPath).toBe(fs.realpathSync(path.join(workspaceDir, "test.ts")));
  });

  test("不存在的文件返回基于父目录的路径", () => {
    const v = new PathValidator(workspaceDir);
    const realPath = v.resolveRealPath(path.join(workspaceDir, "nonexistent.ts"));
    // 父目录存在，应该基于父目录的 realpath 拼接
    expect(realPath).toContain("nonexistent.ts");
  });
});
