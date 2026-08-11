/**
 * 路径验证器测试
 * 覆盖：工作区边界、系统目录保护、敏感文件检测、symlink 解析、目录黑白名单
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PathValidator, normalizeCaseForComparison } from "@sid-code/core/permission/path-validator.ts";
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

// SEC-AUDIT-2026-07-19 P2：敏感文件从「需确认」收紧为「硬 deny」。
// needsConfirmation 现在必须是 false —— 凭证泄露不可撤销，不给"点确认就放行"这个选项。
// 逃生舱是 settings.json 里的显式 allow 规则（在 checker 层，见 checker.test.ts）。
describe("PathValidator - 敏感文件检测（默认硬 deny）", () => {
  test(".env 文件硬拒绝", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, ".env"), "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(false);
    expect(result.sensitiveFile).toBe(true);
    expect(result.reason).toContain("敏感文件");
  });

  test(".env.local 文件硬拒绝", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, ".env.local"), "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(false);
    expect(result.sensitiveFile).toBe(true);
  });

  test("credentials 文件硬拒绝", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "credentials.json"), "read");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(false);
    expect(result.sensitiveFile).toBe(true);
  });

  test(".pem 文件硬拒绝", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "server.pem"), "read");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(false);
    expect(result.sensitiveFile).toBe(true);
  });

  // 非敏感类的路径 deny（系统目录 / symlink 逃逸）**不带** sensitiveFile 标记，
  // 因此不享有 allow 规则逃生舱——这条断言防止后续改动把标记误加到别的分支上。
  test("系统目录拒绝不带 sensitiveFile 标记（无逃生舱）", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/etc/passwd", "write");
    expect(result.allowed).toBe(false);
    expect(result.sensitiveFile).toBeFalsy();
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

// ─────────────────────────── 迭代 I：路径安全深化 ───────────────────────────

describe("PathValidator - 大小写归一化（P0-3 迭代 I Step 1）", () => {
  test("normalizeCaseForComparison 全小写", () => {
    expect(normalizeCaseForComparison("/Foo/Bar/.ENV")).toBe("/foo/bar/.env");
  });

  test("大小写混淆的 .ENV 仍被识别为敏感文件", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, ".ENV"), "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("敏感文件");
  });

  test("大小写混淆的 Server.PEM 仍被识别为敏感文件", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "Server.PEM"), "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("敏感文件");
  });

  test("大小写混淆的黑名单目录仍被拦截", () => {
    const blockedDir = path.join(workspaceDir, "Secrets");
    fs.mkdirSync(blockedDir, { recursive: true });
    const v = new PathValidator(workspaceDir, [], [blockedDir]);
    // 用不同大小写访问
    const result = v.validateAccess(path.join(workspaceDir, "secrets", "x.txt"), "write");
    // macOS 大小写不敏感文件系统下应被拦截；Linux 下两者是不同目录，realpath 不同
    // 至少 normalizeCaseForComparison 保证了归一化比较逻辑被走到
    if (process.platform === "darwin") {
      expect(result.allowed).toBe(false);
    }
    fs.rmSync(blockedDir, { recursive: true, force: true });
  });
});

describe("PathValidator - UNC 路径拦截（P0-3 迭代 I Step 2）", () => {
  test("Windows UNC 共享路径被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("\\\\server\\share\\file.txt", "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("UNC");
  });

  test("POSIX 变体 UNC 路径被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("//server/share/file.txt", "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("UNC");
  });

  test("UNC IP 共享路径被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("\\\\192.168.1.1\\c$\\windows", "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("UNC");
  });
});

describe("PathValidator - 三点路径混淆拦截（P0-3 迭代 I Step 4）", () => {
  test("三点段路径被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, ".../etc/passwd"), "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("三点");
  });

  test("四点段路径被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("/foo/..../bar", "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("三点");
  });

  test("正常的两点 .. 不被三点规则误伤", () => {
    const v = new PathValidator(workspaceDir);
    // .. 是合法的目录引用，不应命中三点规则（可能因其他规则拦截，但 reason 不含"三点"）
    const result = v.validateAccess(path.join(workspaceDir, "src", "..", "test.ts"), "read");
    if (!result.allowed) {
      expect(result.reason).not.toContain("三点");
    }
  });
});

describe("PathValidator - 扩展 Windows 绕过模式（P0-3 迭代 I Step 4）", () => {
  test("DOS 设备名带扩展名变体（NUL.txt）被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(workspaceDir, "NUL.txt"), "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("DOS 设备名");
  });

  test("设备路径前缀 \\\\.\\ 被拦截", () => {
    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess("\\\\.\\PhysicalDrive0", "write");
    expect(result.allowed).toBe(false);
    // 命中设备路径前缀或 UNC（两者都是正确拦截）
    expect(result.reason).toBeDefined();
  });
});

describe("PathValidator - Symlink 多路径链逃逸（P0-3 迭代 I Step 3）", () => {
  test("getAllResolvedPaths 至少包含原始路径与 realpath", () => {
    const v = new PathValidator(workspaceDir);
    const target = path.join(workspaceDir, "test.ts");
    const chain = v.getAllResolvedPaths(target);
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain).toContain(fs.realpathSync(target));
  });

  test("中间目录 symlink 逃逸到工作区外被捕获", () => {
    // 构造：workspace/linkdir -> /tmp 外部目录，再访问 workspace/linkdir/file
    const outsideDir = path.join(tmpDir, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "leak.txt"), "secret");
    const linkDir = path.join(workspaceDir, "linkdir");

    try {
      fs.symlinkSync(outsideDir, linkDir);
    } catch {
      return; // 环境不支持 symlink，跳过
    }

    const v = new PathValidator(workspaceDir);
    const result = v.validateAccess(path.join(linkDir, "leak.txt"), "write");
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);

    fs.unlinkSync(linkDir);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
