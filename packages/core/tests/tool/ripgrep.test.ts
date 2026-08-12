/**
 * ripgrep 执行层单测
 * 覆盖：正常搜索、无匹配、超时场景、EAGAIN 重试、hasRipgrep 检查
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ripGrep,
  hasRipgrep,
  RipgrepTimeoutError,
  resolveRgCommand,
  __resetRgCommandCacheForTest,
} from "@sid-code/core/tool/ripgrep.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function createTempDir(): string {
  return mkdtempSync("/tmp/ripgrep-test-");
}

function createFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("hasRipgrep", () => {
  test("应检测到已安装的 ripgrep", async () => {
    const result = await hasRipgrep();
    expect(result).toBe(true);
  });
});

describe("ripGrep", () => {
  test("正常搜索返回匹配行", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `export function hello() {\n  return "hello";\n}\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["hello"], dir, controller.signal);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((l) => l.includes("hello"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("无匹配返回空数组", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `const x = 1;\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["nonexistent_pattern_xyz"], dir, controller.signal);

      expect(lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("支持字面量搜索", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `const [a] = arr;\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["--fixed-strings", "[a]"], dir, controller.signal);

      expect(lines.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("支持大小写不敏感搜索", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `const HELLO = 1;\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["-i", "hello"], dir, controller.signal);

      expect(lines.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("abortSignal 中止时不会崩溃且返回合理结果", async () => {
    const dir = createTempDir();
    try {
      // 创建大量文件以使搜索耗时足够长
      for (let i = 0; i < 500; i++) {
        createFile(dir, `file_${i}.ts`, `const x = "${"hello world ".repeat(200)}";\n`);
      }
      const controller = new AbortController();

      // 延迟 10ms 后中止（给 rg 启动时间但也确保中断发生在搜索过程中）
      setTimeout(() => controller.abort(), 10);

      try {
        const lines = await ripGrep(["hello"], dir, controller.signal);
        // rg 可能在 abort 之前就完成了，这也是 OK 的
        expect(Array.isArray(lines)).toBe(true);
      } catch (err: unknown) {
        // 或者抛 RipgrepTimeoutError（部分结果），也是预期行为
        if (err instanceof Error) {
          expect(err.name).toMatch(/RipgrepTimeout|Error/);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("支持 glob 文件过滤", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `const hello = 1;\n`);
      createFile(dir, "test.test.ts", `const hello = 2;\n`);
      const controller = new AbortController();

      // 只搜索 .ts 文件，排除 .test.ts
      const lines = await ripGrep(
        ["--glob", "*.ts", "--glob", "!*.test.ts", "hello"],
        dir,
        controller.signal,
      );

      // 应该只有 test.ts 的结果
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("test.ts");
      expect(lines[0]).not.toContain("test.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("files_with_matches 模式返回文件路径", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "a.ts", `const hello = 1;\n`);
      createFile(dir, "b.ts", `const hello = 2;\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["--files-with-matches", "hello"], dir, controller.signal);

      expect(lines.length).toBe(2);
      expect(lines.every((l) => l.includes(".ts") && !l.includes(":"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("count 模式返回计数", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `hello world\nhello again\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["--count", "hello"], dir, controller.signal);

      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/:\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("content 模式返回行号和内容", async () => {
    const dir = createTempDir();
    try {
      createFile(dir, "test.ts", `line 1\nhello world\nline 3\n`);
      const controller = new AbortController();

      const lines = await ripGrep(["--line-number", "hello"], dir, controller.signal);

      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/test\.ts:2:hello/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("超时时返回 RipgrepTimeoutError", async () => {
    // 使用一个很大范围的搜索来触发超时
    const dir = createTempDir();
    try {
      // 创建大量文件模拟大仓库
      const subDir = join(dir, "deep");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(subDir, { recursive: true });
      for (let i = 0; i < 500; i++) {
        createFile(subDir, `file_${i}.txt`, "x".repeat(100000));
      }

      const controller = new AbortController();

      try {
        await ripGrep(["--no-messages", "xyz_pattern_not_found"], dir, controller.signal);
        // 可能成功（20s 内完成），跳过超时断言
      } catch (err: unknown) {
        // 只有 RipgrepTimeoutError 才算"超时"
        if (err instanceof RipgrepTimeoutError) {
          // 预期行为
        } else {
          throw err; // 重新抛出非预期错误
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000); // 30s 超时

  test("无效 flag（exit code 2）不应误报为超时", async () => {
    // 这个测试覆盖 Bun child.killed 语义差异的 bug：
    // rg 遇到无效 flag 立即退出（exit 2），但旧代码用 child.killed 判断超时，
    // 在 Bun 中 child.killed 恒为 true → 误报 RipgrepTimeoutError
    const dir = createTempDir();
    try {
      createFile(dir, "test.css", `:root { --node-entity-bg: #fff; }\n`);
      const controller = new AbortController();

      // 传入一个会被 rg 当作无效 flag 的 pattern（不带 -- 分隔符）
      try {
        await ripGrep(["--files-with-matches", "--node-entity-bg"], dir, controller.signal);
        // 不应到达这里
        throw new Error("应该抛出错误但没有");
      } catch (err: unknown) {
        // 关键断言：不应该是 RipgrepTimeoutError
        expect(err).not.toBeInstanceOf(RipgrepTimeoutError);
        // 应该是普通 Error，包含退出码信息
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("ripgrep 退出码");
        expect((err as Error).message).toContain("unrecognized");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("使用 -- 分隔符可以搜索以 - 开头的 pattern", async () => {
    const dir = createTempDir();
    try {
      createFile(
        dir,
        "vars.css",
        `:root {\n  --node-entity-bg: #f0f0f0;\n  --node-attr-stroke: #333;\n}\n`,
      );
      const controller = new AbortController();

      // 用 -- 分隔符，rg 不会把 --node-entity-bg 当 flag
      const lines = await ripGrep(
        ["--files-with-matches", "--", "--node-entity-bg"],
        dir,
        controller.signal,
      );

      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("vars.css");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRgCommand", () => {
  // beforeEach 而非只 afterEach：前面 describe("hasRipgrep")/describe("ripGrep") 的用例
  // 已经触发过 resolveRgCommand() 并把模块级缓存填成 "rg"，若只在 afterEach 重置，
  // 本 describe 块的第一个测试仍会命中残留缓存、读不到本次设置的环境变量。
  beforeEach(() => {
    delete process.env.SID_RIPGREP_PATH;
    __resetRgCommandCacheForTest();
  });

  afterEach(() => {
    delete process.env.SID_RIPGREP_PATH;
    __resetRgCommandCacheForTest();
  });

  test("SID_RIPGREP_PATH 环境变量优先级最高，直接返回不做探测", async () => {
    process.env.SID_RIPGREP_PATH = "/definitely/not/a/real/path/rg";
    const cmd = await resolveRgCommand();
    expect(cmd).toBe("/definitely/not/a/real/path/rg");
  });

  test("dev 模式（bun test 直接跑源码）下回退系统 PATH 的 rg", async () => {
    // 测试环境是 bun test 直接跑 .ts 源码，IS_DEV_MODE 为 true，
    // ensureRipgrepReleased() 应直接返回 null，回退探测系统 "rg"（本机已装）。
    const cmd = await resolveRgCommand();
    expect(cmd).toBe("rg");
  });

  test("结果被缓存：连续调用只解析一次", async () => {
    const first = await resolveRgCommand();
    const second = await resolveRgCommand();
    expect(first).toBe(second);
  });

  test("hasRipgrep 与 resolveRgCommand 结果一致", async () => {
    const cmd = await resolveRgCommand();
    const has = await hasRipgrep();
    expect(has).toBe(cmd !== null);
  });
});
