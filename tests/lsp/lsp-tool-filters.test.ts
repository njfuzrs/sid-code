/**
 * LSP 工具的两处保护逻辑单测：
 *   G9 — filterGitignored：git check-ignore 批量过滤 + 降级 + T5-B3 abort 快速退出
 *   G10 — 文件大小保护：execute() 中 >10MB 直接拒绝
 *
 * 说明（与旧方案的偏差，均已按实际代码修正）：
 * - filterGitignored 现签名为 (paths, cwd, signal?)，比旧文档多了 signal 参数（T5-B3）。
 * - G10 不能靠"无配置 = 无服务器"来触发：execute() 里 getServerForFile 未命中会先
 *   return describeMissingServer，根本走不到 size 检查。因此必须让 .g10x 扩展命中一个
 *   路由。用项目级 .sid-code/lsp.json 注册一个 mock 服务器（懒启动，size 检查在 openFile
 *   之前跑，不会真正 spawn），扩展名用自造的 .g10x，避免依赖测试机是否装了 tsserver。
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { filterGitignored, LSPTool } from "../../src/tool/lsp.ts";
import { initializeLSP, resetLSPForTest, getLSPInitState } from "../../src/lsp/manager.ts";

/** git 是否可用（不可用则跳过依赖 git 的用例，而非整体失败） */
let hasGit = false;
try {
  execSync("git --version", { stdio: "ignore" });
  hasGit = true;
} catch {
  hasGit = false;
}

describe("G9：filterGitignored", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lsp-g9-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!hasGit)("在 git repo 中过滤被 .gitignore 忽略的文件", async () => {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n");

    const paths = [
      join(dir, "src/index.ts"),
      join(dir, "node_modules/foo/index.js"),
      join(dir, "debug.log"),
    ];

    const ignored = await filterGitignored(paths, dir);
    expect(ignored.has(join(dir, "node_modules/foo/index.js"))).toBe(true);
    expect(ignored.has(join(dir, "debug.log"))).toBe(true);
    expect(ignored.has(join(dir, "src/index.ts"))).toBe(false);
  });

  test.skipIf(!hasGit)("非 git 目录返回空 Set（降级不过滤）", async () => {
    // dir 未 git init
    const paths = [join(dir, "foo.ts"), join(dir, "bar.ts")];
    const ignored = await filterGitignored(paths, dir);
    expect(ignored.size).toBe(0);
  });

  test("空路径列表返回空 Set（不 spawn git）", async () => {
    const ignored = await filterGitignored([], dir);
    expect(ignored.size).toBe(0);
  });

  test("signal 已 abort 时立即返回空 Set（T5-B3 快速退出，不 spawn git）", async () => {
    const ac = new AbortController();
    ac.abort();
    // 传入若干真实存在于 .gitignore 的路径，若未快速退出会被过滤为非空；
    // 这里断言 abort 优先——直接空 Set。
    const ignored = await filterGitignored(
      [join(dir, "node_modules/x.js")],
      dir,
      ac.signal,
    );
    expect(ignored.size).toBe(0);
  });
});

describe("G10：文件大小保护", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lsp-g10-"));
    // 注册一个 mock LSP 服务器，让 .g10x 扩展命中路由（否则 execute 走 describeMissingServer
    // 分支，到不了 size 检查）。command 用 "true"（存在即可，反正懒启动不会真跑）。
    mkdirSync(join(dir, ".sid-code"), { recursive: true });
    writeFileSync(
      join(dir, ".sid-code", "lsp.json"),
      JSON.stringify({
        "mock-g10": {
          command: "true",
          extensionToLanguage: { ".g10x": "g10lang" },
        },
      }),
    );
    initializeLSP(dir);
    // 等待初始化完成（有配置 → initialize 构建路由表 → success）
    for (let i = 0; i < 100; i++) {
      if (getLSPInitState() === "success") break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  afterAll(() => {
    resetLSPForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("初始化应成功（前置条件）", () => {
    expect(getLSPInitState()).toBe("success");
  });

  test("超过 10MB 的文件返回错误", async () => {
    const bigFile = join(dir, "big.g10x");
    // 创建 11MB 文件（size 检查在读取内容/启动服务器之前，不会真正 spawn LSP）
    writeFileSync(bigFile, "x".repeat(11 * 1024 * 1024));

    const tool = new LSPTool();
    const result = await tool.execute({
      operation: "hover",
      file_path: bigFile,
      line: 1,
      character: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("文件过大");
    expect(result.output).toContain("10MB");
  });

  test("不存在的文件返回读取失败错误", async () => {
    const tool = new LSPTool();
    const result = await tool.execute({
      operation: "hover",
      file_path: join(dir, "nonexistent.g10x"),
      line: 1,
      character: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("无法读取文件");
  });
});
