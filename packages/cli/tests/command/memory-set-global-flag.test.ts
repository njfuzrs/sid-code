/**
 * /memory set 的 --global 标志解析（20261017 排查，docs-research 20261017-memory-set-global-flag-parsing.md）
 *
 * 修复前的两处缺陷：
 * 1. `value.replace("--global", "")` 是子串替换，value 正文含 "--global"（含子串，如
 *    `value-with---global-inside`）会被静默删改；且 `String.replace` 字符串形式只删首个匹配。
 * 2. scope 判定用原始 `args.includes()`（子串命中），与 value 清理的数据源不同，
 *    正文子串命中时 scope 被误判为 global。
 * 3. 空值检查在剥离之前，`/memory set key --global` 会通过检查并存入**空 value**。
 *
 * 落盘隔离：本测试会真实写记忆目录，必须把 SID_CONFIG_DIR 指向 tmpdir
 * （getSidHome 每次调用重读 env，无缓存）。存/恢复原值，不要无条件 delete——
 * bunfig preload 兜底会被一起抹掉。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCommand } from "../../src/command/builtins.ts";

let isolatedHome: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), "mem-set-global-test-"));
  savedConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = isolatedHome;
});

afterEach(() => {
  // 存/恢复而非 delete：同批其它测试文件可能依赖 preload 兜底设置的值
  if (savedConfigDir === undefined) {
    delete process.env.SID_CONFIG_DIR;
  } else {
    process.env.SID_CONFIG_DIR = savedConfigDir;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
});

/** 执行 /memory set 并断言返回的确认消息，再用独立 store 实例读回落盘内容 */
async function setAndReadBack(args: string): Promise<{ scope: string; value: string }> {
  const result = await new MemoryCommand().execute(args, {} as never);
  const message = (result as { kind: string; message: string }).message;
  const m = message.match(/^记忆已保存: \[(global|project)\] (.+?) = (.*)$/);
  if (!m) throw new Error(`意外的返回: ${JSON.stringify(result)}`);

  // 读回：新实例走磁盘，验证真实落盘而非内存缓存
  const { MemoryStore } = await import("@sid-code/core/memory/store.ts");
  const store = new MemoryStore(process.cwd());
  await store.load();
  const entry = await store.get(m[2]);
  if (!entry) throw new Error(`落盘后读不回 ${m[2]}`);
  return { scope: entry.scope, value: entry.value };
}

describe("/memory set --global 解析", () => {
  test("flag 后置：scope=global，value 不含 flag", async () => {
    const r = await setAndReadBack("set key1 hello --global");
    expect(r.scope).toBe("global");
    expect(r.value).toBe("hello");
  });

  test("无 flag：scope=project，多词 value 原样保留", async () => {
    const r = await setAndReadBack("set key2 hello world");
    expect(r.scope).toBe("project");
    expect(r.value).toBe("hello world");
  });

  test("正文含 --global 子串：不再误删、scope 不再误判（修复点 ①③）", async () => {
    // 修复前：value 被删成 "value-with-inside"，且 args.includes 子串命中把 scope 误判为 global
    const r = await setAndReadBack("set key3 value-with---global-inside");
    expect(r.scope).toBe("project");
    expect(r.value).toBe("value-with---global-inside");
  });

  test("flag 夹在 value 中间：两侧拼接、scope=global", async () => {
    const r = await setAndReadBack("set key4 use --global flag");
    expect(r.scope).toBe("global");
    expect(r.value).toBe("use flag");
  });

  test("多个 --global 全部剥离（修复前 String.replace 只删首个）", async () => {
    const r = await setAndReadBack("set key5 a --global b --global");
    expect(r.scope).toBe("global");
    expect(r.value).toBe("a b");
  });

  test("value 仅剩 flag 时报用法错误，不再静默存空 value（修复点 ②）", async () => {
    // 修复前：!value 检查在剥离前，"--global" 非空通过检查，replace 后存入空串
    const result = await new MemoryCommand().execute("set key6 --global", {} as never);
    expect((result as { kind: string }).kind).toBe("error");

    // 且真的没落盘
    const { MemoryStore } = await import("@sid-code/core/memory/store.ts");
    const store = new MemoryStore(process.cwd());
    await store.load();
    const entry = await store.get("key6");
    // MemoryStore.get 查不到时返回 null（不是 undefined）
    expect(entry).toBeNull();
  });

  test("key 名含 --global 子串不影响判定（数据源统一为 rest）", async () => {
    // 修复前 scope 用 args.includes 判定，key 含子串时被误判为 global
    const r = await setAndReadBack("set --global-flag note1 x");
    expect(r.scope).toBe("project");
    expect(r.value).toBe("note1 x");
  });
});
