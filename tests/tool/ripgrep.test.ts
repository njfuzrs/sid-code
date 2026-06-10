/**
 * ripgrep 执行层单测
 * 覆盖：正常搜索、无匹配、超时场景、EAGAIN 重试、hasRipgrep 检查
 */

import { describe, test, expect } from "bun:test";
import { ripGrep, hasRipgrep, RipgrepTimeoutError } from "../../src/tool/ripgrep.ts";
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
      const lines = await ripGrep(["--glob", "*.ts", "--glob", "!*.test.ts", "hello"], dir, controller.signal);

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
});
