/**
 * @ 提及内联防线回归测试（2026-10-22 事故）
 *
 * 用户输入里的 `@sid-code/`（本意是包名）被当成路径，`resolve()` 吞掉末尾 `/`
 * 命中仓库根 78MB 编译产物 `sid-code`，按 utf-8 整个内联进 user 消息，
 * 估算 4500 万 token，压缩三轮 no_reduction → 熔断 → 网关 413。
 *
 * 固化三道防线：末尾 `/` 不当文件、二进制不内联、超上限不内联；并保留正常文件放行的对照。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandAtReferences } from "@sid-code/cli/app.ts";

let root: string;
let originalCwd: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "atref-guard-"));
  // 复刻事故现场：与包名同名的二进制文件 + 同名目录前缀
  const bin = Buffer.alloc(4096);
  bin.write("\xcf\xfa\xed\xfe", 0, "latin1"); // Mach-O magic，后面全是 NUL
  writeFileSync(join(root, "sid-code"), bin);
  writeFileSync(join(root, "big.txt"), "a".repeat(200 * 1024));
  writeFileSync(join(root, "small.md"), "# small doc\n");
  // 与包名同名的**文本**文件：单独锁「末尾 /」防线，不让二进制判定替它兜底
  writeFileSync(join(root, "mypkg"), "TEXT_FILE_SHOULD_NOT_INLINE\n");
  mkdirSync(join(root, "pkgdir"));
  originalCwd = process.cwd();
  process.chdir(root);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("@ 提及内联防线", () => {
  test("末尾带 / 的提及不命中同名文件（事故原形 @sid-code/）", async () => {
    const r = await expandAtReferences("主仓 @sid-code/ 下没有 tui 链接");
    expect(r.injectedContent ?? "").not.toContain("\u0000");
    // 同名文件是文本时也不能内联：resolve() 吞掉 / 是这条防线存在的理由
    const t = await expandAtReferences("看下 @mypkg/ 的导出");
    expect(t.injectedContent ?? "").not.toContain("TEXT_FILE_SHOULD_NOT_INLINE");
  });

  test("二进制文件不内联，且告知模型未注入", async () => {
    const r = await expandAtReferences("看下 @sid-code");
    expect(r.injectedContent ?? "").not.toContain("\u0000");
    expect(r.skippedPaths?.[0]?.reason).toBe("二进制文件");
    expect(r.injectedContent).toContain("未注入");
  });

  test("超过内联上限的文本文件不内联，引导 Read 分段读取", async () => {
    const r = await expandAtReferences("看下 @big.txt");
    expect((r.injectedContent ?? "").length).toBeLessThan(2000);
    expect(r.skippedPaths?.[0]?.reason).toContain("超过 @ 内联上限");
    expect(r.injectedContent).toContain("Read");
  });

  // 契约随「目录引用注入条目列表」（对齐 CC）变更：此前目录直接跳过、injectedContent 为 null。
  test("目录提及（无末尾 /）注入条目列表而不是文件内容", async () => {
    const r = await expandAtReferences("看下 @pkgdir");
    expect(r.injectedContent).toContain("目录 `pkgdir` 为空");
  });

  test("对照：小文本文件正常内联", async () => {
    const r = await expandAtReferences("看下 @small.md");
    expect(r.injectedContent).toContain("# small doc");
    expect(r.skippedPaths).toBeUndefined();
  });
});

describe("MCP 资源 @server:uri 内联上限", () => {
  // 只用到 readResource：按 uri 返回固定大小的文本
  const fakeMcp = (sizes: Record<string, number>) =>
    ({
      readResource: async (_server: string, uri: string) => "r".repeat(sizes[uri] ?? 0),
    }) as unknown as Parameters<typeof expandAtReferences>[1];

  test("单个资源超过单条上限：不注入内容，告知用户并引导 ReadMcpResource", async () => {
    const r = await expandAtReferences("看下 @srv:big", fakeMcp({ big: 200 * 1024 }));
    expect((r.injectedContent ?? "").length).toBeLessThan(2000);
    expect(r.skippedPaths?.[0]?.path).toBe("srv:big");
    expect(r.skippedPaths?.[0]?.reason).toContain("超过 @ 内联上限");
    expect(r.injectedContent).toContain("ReadMcpResource");
  });

  test("多个资源累计超过总预算：超出的那个不注入", async () => {
    const r = await expandAtReferences(
      "看 @srv:a @srv:b @srv:c",
      fakeMcp({ a: 90 * 1024, b: 90 * 1024, c: 90 * 1024 }),
    );
    expect(r.skippedPaths?.map((s) => s.path)).toEqual(["srv:c"]);
    expect(r.skippedPaths?.[0]?.reason).toContain("总量");
  });

  test("对照：小资源正常注入", async () => {
    const r = await expandAtReferences("看 @srv:s", fakeMcp({ s: 10 }));
    expect(r.injectedContent).toContain("rrrrrrrrrr");
    expect(r.skippedPaths).toBeUndefined();
  });
});
