/**
 * P1-6 / P1-10 / P1-11 防复发：口径分裂、写空半死状态、多实例缓存不失效
 *
 * 三条都是「实现自洽、单测全绿、行为仍错」的形态：
 * - P1-6：`scan` 递归、`MemoryStore` 平铺 ⇒ 子目录记忆「manifest 里有、索引里没有」；
 * - P1-10：写空既不进内存也不进索引，但**文件与 manifest 都还在** ⇒ dream 反复"删"同一批；
 * - P1-11：`loaded` 单向锁死 ⇒ 写入后同进程其它实例继续拿旧快照。
 *
 * ⚠️ 变异自证：逐条确认过「把对应修复还原就变红」。
 * 隔离口径沿用 store-data-loss-p0.test.ts：SID_CONFIG_DIR + 显式传两个目录覆盖。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  MemoryStore,
  clearMemorySummaryCache,
  invalidateMemoryCaches,
} from "@sid-code/core/memory/store.ts";
import { enumerateMemoryFiles } from "@sid-code/core/memory/scan.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-p1-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-p1-"));
  projDir = join(tmpProject, "mem-project");
  globalDir = join(tmpProject, "mem-global");
  clearMemorySummaryCache();
});

afterEach(() => {
  try {
    rmSync(tmpProject, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeStore(): MemoryStore {
  return new MemoryStore(tmpProject, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

function writeMemFile(
  dir: string,
  relPath: string,
  opts: { name: string; description: string; body: string; updated?: number },
): void {
  const full = join(dir, relPath);
  const parent = full.slice(0, full.lastIndexOf("/"));
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const ts = opts.updated ?? Date.now();
  writeFileSync(
    full,
    [
      "---",
      `name: ${opts.name}`,
      `description: ${opts.description}`,
      "type: reference",
      `created: ${ts}`,
      `updated: ${ts}`,
      "---",
      "",
      opts.body,
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("P1-6 子目录记忆：scan 与 MemoryStore 不再两套口径", () => {
  test("子目录里的记忆同时出现在 scan 枚举与 store.list()", async () => {
    writeMemFile(projDir, "reference_top.md", {
      name: "top",
      description: "平铺的一条",
      body: "顶层内容",
    });
    writeMemFile(projDir, "sub/reference_nested.md", {
      name: "nested",
      description: "子目录里的一条",
      body: "子目录内容",
    });

    // 枚举侧（提取 / dream manifest 的口径）
    const scanned = await enumerateMemoryFiles(projDir);
    expect(scanned.sort()).toEqual(["reference_top.md", "sub/reference_nested.md"]);

    // store 侧（索引 / 注入的口径）—— 旧实现这里只有 ["top"]，两套口径分裂
    const store = makeStore();
    await store.load();
    const keys = (await store.list()).map((e) => e.key).sort();
    expect(keys).toEqual(["nested", "top"]);
  });

  test("子目录记忆进索引时链接带相对路径，模型拼 dir+链接 可直接 Read", async () => {
    writeMemFile(projDir, "sub/reference_nested.md", {
      name: "nested",
      description: "子目录里的一条",
      body: "子目录内容",
    });
    const store = makeStore();
    await store.load();
    // 触发索引重建
    await store.set("other", "另一条内容", "project");

    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).toContain("(sub/reference_nested.md)");
    // 拼接后必须真能落到文件上——这是「链接指不到东西」那类 bug 的直接判据
    const linked = join(projDir, "sub/reference_nested.md");
    expect(existsSync(linked)).toBe(true);
  });

  test("archive/ 仍被排除：归档过的记忆不会因递归而重新进索引", async () => {
    writeMemFile(projDir, "archive/reference_old.md", {
      name: "old",
      description: "已归档",
      body: "旧内容",
    });
    writeMemFile(projDir, "reference_live.md", {
      name: "live",
      description: "在用",
      body: "新内容",
    });

    // 这条是 P1-6 与 P0-2 的交叉点：枚举改递归后若漏了 skip 名单，
    // 归档等于没归档，且淘汰循环会把它再归档一次 —— 来回震荡。
    const scanned = await enumerateMemoryFiles(projDir);
    expect(scanned).toEqual(["reference_live.md"]);

    const store = makeStore();
    await store.load();
    expect((await store.list()).map((e) => e.key)).toEqual(["live"]);
  });
});

describe("P1-10 写空 = 删除手势，不再留半死状态", () => {
  test("正文为空的记忆被移进 archive/，索引与枚举都不再列出它", async () => {
    // dream 的 prune 指令教模型「用 write 写空」来删除记忆。
    // 旧实现下：不进内存 ✅、不进索引 ✅、但**文件还在**且 scan 仍列出 ⇒
    // 下一轮 dream 看到 manifest 里还有它，再写一次空，白烧一轮配额。
    writeFileSync(
      join(mkdirSync(projDir, { recursive: true }) ?? projDir, "reference_pruned.md"),
      ["---", "name: pruned", "description: 该删的一条", "type: reference", "---", "", ""].join(
        "\n",
      ),
      "utf8",
    );
    writeMemFile(projDir, "reference_keep.md", {
      name: "keep",
      description: "保留",
      body: "有效内容",
    });

    const store = makeStore();
    await store.load();

    // 原位置已空出，字节搬进了 archive/（不是 unlink —— 无从区分"故意写空"与"写坏了"）
    expect(existsSync(join(projDir, "reference_pruned.md"))).toBe(false);
    expect(existsSync(join(projDir, "archive", "reference_pruned.md"))).toBe(true);

    // 三个视角终于一致：内存没有、枚举没有、索引没有
    expect((await store.list()).map((e) => e.key)).toEqual(["keep"]);
    const scanned = await enumerateMemoryFiles(projDir);
    expect(scanned).toEqual(["reference_keep.md"]);
  });

  test("正常记忆不受影响（不误判非空正文）", async () => {
    writeMemFile(projDir, "reference_normal.md", {
      name: "normal",
      description: "正常",
      body: "有正文",
    });
    const store = makeStore();
    await store.load();
    expect(existsSync(join(projDir, "reference_normal.md"))).toBe(true);
    expect(existsSync(join(projDir, "archive", "reference_normal.md"))).toBe(false);
    expect((await store.list()).map((e) => e.key)).toEqual(["normal"]);
  });
});

describe("P1-11 多实例缓存失效：写入后其它实例能看到", () => {
  test("A 写入后 B（已 load 过）重新 load 能看到新记忆", async () => {
    const a = makeStore();
    const b = makeStore();

    await a.load();
    await b.load();
    expect(await b.get("fresh")).toBeNull();

    // A 写入 —— 生产里这相当于 save_memory 走 cli.ts 那个实例
    await a.set("fresh", "新写入的内容", "project");

    // B 是另一个实例、已经 load 过。旧实现 `loaded` 单向锁死 ⇒ 永远看不到这条，
    // 于是 save_memory 之后注入侧索引不更新（本条缺陷的用户可感形态）。
    await b.load();
    const got = await b.get("fresh");
    expect(got).not.toBeNull();
    expect(got?.value).toContain("新写入的内容");
  });

  test("A 删除后 B 重新 load 不再残留已删记忆", async () => {
    const a = makeStore();
    await a.set("doomed", "将被删除", "project");

    const b = makeStore();
    await b.load();
    expect(await b.get("doomed")).not.toBeNull();

    await a.delete("doomed", "project");
    await b.load();
    // 重读必须**先清空**内存映射，否则已删记忆会作为残留留在 entries 里，
    // 索引重建时又被写回去（指向一个不存在的文件）——那比陈旧更糟。
    expect(await b.get("doomed")).toBeNull();
  });

  test("外部写入（write/edit 路径）经 invalidateMemoryCaches 生效", async () => {
    const store = makeStore();
    await store.load();
    expect(await store.get("byhand")).toBeNull();

    // 模拟提取代理经 write 工具直接落盘：不经过 store.set()
    writeMemFile(projDir, "reference_byhand.md", {
      name: "byhand",
      description: "手写落盘",
      body: "外部写入的内容",
    });

    // 不声明失效时，已 load 的实例理应仍看不到（缓存语义正确）
    await store.load();
    expect(await store.get("byhand")).toBeNull();

    // 声明失效后必须能看到 —— 这是 write/edit 工具里 afterMemoryFileWrite 的作用
    invalidateMemoryCaches();
    await store.load();
    expect((await store.get("byhand"))?.value).toContain("外部写入的内容");
  });
});
