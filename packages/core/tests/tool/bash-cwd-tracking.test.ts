/**
 * 持久 Shell 会话 — bash cwd 追踪 + 跨工具 cwd 一致性测试
 *
 * 验证：
 * 1. bash 执行 `cd <dir>` 后写回全局 cwd 状态
 * 2. read/glob 等工具通过 normalizeToolPath 读全局 cwd，跟随 bash 的 cd
 * 3. 后台命令不写回 cwd
 * 4. cwd 指向已删除目录时回退
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { normalizeToolPath } from "@sid-code/core/tool/path-utils.ts";
import { getCwd, setCwd, getOriginalCwd } from "@sid-code/core/bootstrap/state.ts";

let tmpRoot: string;
let originalGlobalCwd: string;

beforeEach(() => {
  originalGlobalCwd = getCwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-cwd-test-"));
});

afterEach(() => {
  // 恢复全局 cwd，避免污染其它测试
  setCwd(originalGlobalCwd);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("bash cwd 追踪", () => {
  it("cd 后写回全局 cwd 状态", async () => {
    if (process.platform === "win32") return; // Windows 不追踪 cwd
    const subDir = join(tmpRoot, "sub");
    mkdirSync(subDir);

    const bash = new BashTool();
    // 从 tmpRoot 起步
    setCwd(tmpRoot);
    const result = await bash.execute({
      command: "cd sub",
      description: "进入 sub 目录",
    });
    expect(result.isError).toBeFalsy();
    // 全局 cwd 应更新为 subDir（pwd -P 解析符号链接，tmpdir 在 macOS 上是符号链接，用 endsWith 容错）
    expect(getCwd().endsWith("/sub")).toBe(true);
  });

  it("跨工具一致性：cd 后 normalizeToolPath 解析相对路径基于新 cwd", async () => {
    if (process.platform === "win32") return;
    const subDir = join(tmpRoot, "proj");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "foo.ts"), "// test", "utf8");

    const bash = new BashTool();
    setCwd(tmpRoot);
    await bash.execute({ command: "cd proj", description: "进入 proj" });

    // read/glob 等工具用 normalizeToolPath("foo.ts") 解析，应基于新 cwd 指向 proj/foo.ts
    const resolved = normalizeToolPath("foo.ts");
    expect(resolved.endsWith("/proj/foo.ts")).toBe(true);
  });

  it("命令失败时不写回 cwd（pwd -P 未执行）", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    setCwd(tmpRoot);
    const before = getCwd();
    // cd 到不存在目录 → 命令失败
    const result = await bash.execute({
      command: "cd /nonexistent-dir-xyz-12345",
      description: "进入不存在目录",
    });
    expect(result.isError).toBe(true);
    // cwd 不应改变
    expect(getCwd()).toBe(before);
  });

  it("显式传 cwd 参数优先于全局 cwd", async () => {
    if (process.platform === "win32") return;
    const subDir = join(tmpRoot, "explicit");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "marker.txt"), "found", "utf8");

    const bash = new BashTool();
    setCwd(tmpRoot); // 全局 cwd 是 tmpRoot
    const result = await bash.execute({
      command: "cat marker.txt",
      cwd: subDir, // 显式指定
      description: "读 marker",
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("found");
  });
});

describe("cwd 删除回退", () => {
  it("全局 cwd 指向已删除目录时回退到原始启动目录", async () => {
    if (process.platform === "win32") return;
    const doomed = join(tmpRoot, "doomed");
    mkdirSync(doomed);
    setCwd(doomed);
    rmSync(doomed, { recursive: true, force: true }); // 删除当前 cwd

    const bash = new BashTool();
    // resolveCwd 应检测到 doomed 不存在，回退到 getOriginalCwd()
    const result = await bash.execute({
      command: "pwd",
      description: "打印当前目录",
    });
    // 不应因 cwd 不存在而崩溃
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(getOriginalCwd());
  });
});
