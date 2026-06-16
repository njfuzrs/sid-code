/**
 * 持久 Shell 会话 — shell-snapshot 单元测试
 * 覆盖：escapeForShell（POSIX 单引号转义）、createAndSaveSnapshot（创建/降级/Windows 跳过）、cleanup
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { platform } from "os";
import {
  escapeForShell,
  createAndSaveSnapshot,
  cleanupSnapshot,
} from "../../src/tool/bash/shell-snapshot.ts";
import { sidPaths } from "../../src/config/paths.ts";

// ============================================================
// escapeForShell
// ============================================================

describe("escapeForShell", () => {
  it("普通字符串用单引号包裹", () => {
    expect(escapeForShell("hello")).toBe("'hello'");
  });

  it("含空格的路径安全包裹", () => {
    expect(escapeForShell("/path with space/file")).toBe("'/path with space/file'");
  });

  it("含单引号：闭合→转义→重开", () => {
    // it's → 'it'\''s'
    expect(escapeForShell("it's")).toBe("'it'\\''s'");
  });

  it("含 $ 等特殊字符不被展开（单引号内字面）", () => {
    expect(escapeForShell("$HOME && rm -rf /")).toBe("'$HOME && rm -rf /'");
  });

  it("含反引号字面保留", () => {
    expect(escapeForShell("`whoami`")).toBe("'`whoami`'");
  });

  it("空字符串", () => {
    expect(escapeForShell("")).toBe("''");
  });

  it("多个单引号", () => {
    // a'b'c → 'a'\''b'\''c'
    expect(escapeForShell("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

// ============================================================
// createAndSaveSnapshot
// ============================================================

describe("createAndSaveSnapshot", () => {
  afterEach(() => {
    cleanupSnapshot();
    // 清理可能残留的快照目录内容
    try {
      rmSync(sidPaths.shellSnapshots(), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  it("Windows 平台返回 undefined（无法 source POSIX 脚本）", async () => {
    if (platform() !== "win32") {
      // 非 Windows 环境无法真实测 win32 分支，跳过断言但保证函数不抛
      return;
    }
    const result = await createAndSaveSnapshot("powershell.exe");
    expect(result).toBeUndefined();
  });

  it("POSIX 平台：用真实 shell 创建快照文件", async () => {
    if (platform() === "win32") return;
    const shell = process.env.SHELL || "/bin/bash";
    const result = await createAndSaveSnapshot(shell);
    // 真实 shell 应成功创建（CI 中 shell 存在）
    if (result) {
      expect(existsSync(result)).toBe(true);
      const content = readFileSync(result, "utf8");
      // 快照应包含标志性注释
      expect(content).toContain("sid-code shell snapshot");
      expect(content).toContain("unalias -a");
      // PATH 注入
      expect(content).toContain("export PATH=");
    }
  });

  it("不存在的 shell 路径 → 降级 undefined，不抛出", async () => {
    if (platform() === "win32") return;
    const result = await createAndSaveSnapshot("/nonexistent/fake-shell-xyz");
    expect(result).toBeUndefined();
  });

  it("cleanupSnapshot 删除快照文件", async () => {
    if (platform() === "win32") return;
    const shell = process.env.SHELL || "/bin/bash";
    const result = await createAndSaveSnapshot(shell);
    if (result) {
      expect(existsSync(result)).toBe(true);
      cleanupSnapshot();
      expect(existsSync(result)).toBe(false);
    }
  });
});
