/**
 * PR-A（2026-11-06）：满额淘汰按价值选择 + 删除时回填被挤走的记忆。
 *
 * 锁两条真实缺陷（方案文档《20261106-记忆写入-临时内容误存与满额驱逐真实记忆》）：
 * - **D3**：旧排序只看 `updatedAt`（LWU），满额时把 `user` 类真实记忆先挤走，
 *   而索引（S9 的 `indexTypeRank`）恰恰认为 user 最该保留 —— 两套口径互相矛盾。
 * - **D2**：被挤走的记忆进了 `archive/` 但系统不会主动恢复；删掉造成淘汰的
 *   临时记忆后，真实记忆仍然回不到索引（静默数据损失）。
 *
 * 验收用例对应方案 §5.1 的 8 条：价值排序（2 条）、返回值、工具可见（A2）、
 * 删除回填、重名不覆盖、未满额不记账、遥测字段（A3）。
 *
 * 隔离：`SID_CONFIG_DIR` 指向 tmpdir（遥测会落盘），并显式传
 * `projectMemoryDir` / `globalMemoryDir`（双保险，记忆文件不写真实 `~/.sid-code/`）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";
import { EVICTIONS_FILE, readEvictionRecords } from "@sid-code/core/memory/eviction-log.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;
let projDir: string;
let globalDir: string;

const BASE = Date.UTC(2026, 9, 1);
const pad = (n: number) => String(n).padStart(3, "0");

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-evict-value-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
  projDir = join(tmpHome, "proj-mem");
  globalDir = join(tmpHome, "global-mem");
  clearMemorySummaryCache();
  __resetAnalyticsForTest();
});

afterEach(() => {
  clearMemorySummaryCache();
  __resetAnalyticsForTest();
  // 存/恢复原值，不无条件 delete —— 同批测试同进程，别抹掉 preload 的兜底
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 写一条记忆 .md（frontmatter 的 type / updated 决定 store 的内存条目） */
function writeMem(dir: string, file: string, name: string, type: string, updatedAt: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    [
      "---",
      `name: ${name}`,
      `description: d-${name}`,
      `type: ${type}`,
      `created: ${updatedAt}`,
      `updated: ${updatedAt}`,
      "---",
      "",
      `body of ${name}`,
      "",
    ].join("\n"),
  );
}

/**
 * 预置满额（200 条）：100 条 user（**最旧**）+ 100 条 reference（较新）。
 *
 * 这个形状直接复刻 2026-11-06 的事故现场：旧 LWU 排序下最新写入的是 reference，
 * 最旧的一批是 user ⇒ 每写一条临时记忆就挤掉一条 user 真实记忆。
 */
function seedFull(dir: string): void {
  for (let i = 0; i < 100; i++) {
    writeMem(dir, `user_u${pad(i)}.md`, `u${pad(i)}`, "user", BASE - 100_000 + i);
  }
  for (let i = 0; i < 100; i++) {
    writeMem(dir, `reference_r${pad(i)}.md`, `r${pad(i)}`, "reference", BASE - 50_000 + i);
  }
}

function newStore(): MemoryStore {
  return new MemoryStore(undefined, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

function captureEvents(): Array<{ name: string; meta: EventMetadata }> {
  const seen: Array<{ name: string; meta: EventMetadata }> = [];
  attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  return seen;
}

describe("A1 满额淘汰按价值排序", () => {
  test("200 条（100 user 最旧 + 100 reference 较新）时挤走的是 reference，user 一条不少", async () => {
    seedFull(projDir);
    const store = newStore();
    const result = await store.set("newbie", "新写的正文", "project", { type: "project" });

    expect(result.isNewKey).toBe(true);
    expect(result.evicted).toHaveLength(1);
    // 旧排序（LWU）会挤走 u000（user 里最旧的一条）——这正是事故形态
    expect(result.evicted[0]).toMatchObject({ key: "r000", type: "reference" });
    expect(existsSync(join(projDir, "archive", "reference_r000.md"))).toBe(true);

    const all = await store.list();
    expect(all.filter((e) => e.type === "user")).toHaveLength(100);
    expect(all.filter((e) => e.type === "reference")).toHaveLength(99);
  });

  test("最旧的 reference 被读过（readCount=3）时，挤走另一条从未被读的 reference", async () => {
    seedFull(projDir);
    // `.read-stats.json` 的键 = 相对记忆目录的文件名（与索引链接同形）
    writeFileSync(
      join(projDir, ".read-stats.json"),
      JSON.stringify({
        version: 1,
        entries: { "reference_r000.md": { lastRead: BASE, readCount: 3 } },
      }),
    );
    const store = newStore();
    const result = await store.set("newbie", "新写的正文", "project", { type: "project" });

    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0].key).toBe("r001");
    expect(existsSync(join(projDir, "archive", "reference_r001.md"))).toBe(true);
  });

  test("永不淘汰本次刚写入的 key", async () => {
    seedFull(projDir);
    const store = newStore();
    // 重复写同一个（已满额）key 不增加条数，本来就不该触发淘汰
    const result = await store.set("newbie", "v1", "project", { type: "project" });
    const again = await store.set("newbie", "v2", "project", { type: "project" });
    // 首次写入会淘汰 1 条；第二次是更新，条数不变 ⇒ 不再淘汰
    expect(result.evicted).toHaveLength(1);
    expect(again.isNewKey).toBe(false);
    expect(again.evicted).toHaveLength(0);
    expect(existsSync(join(projDir, "project_newbie.md"))).toBe(true);
  });
});

describe("A2 淘汰结果回传与工具可见", () => {
  test("set 返回值带 evicted / archivedAs，账本记下因果", async () => {
    seedFull(projDir);
    const store = newStore();
    const result = await store.set("newbie", "新写的正文", "project", { type: "project" });

    expect(result.evicted).toEqual([
      { key: "r000", type: "reference", archivedAs: "reference_r000.md" },
    ]);
    const ledger = readEvictionRecords(projDir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      evictedKey: "r000",
      archivedAs: "reference_r000.md",
      evictedBy: "newbie",
    });
  });

  test("MemoryTool.execute 输出包含「移到了 archive/」和被淘汰的 key", async () => {
    seedFull(projDir);
    const tool = new MemoryTool(newStore());
    const out = await tool.execute({ key: "newbie", value: "新写的正文", type: "project" });

    expect(out.isError).toBeFalsy();
    expect(out.output).toContain("移到了 archive/");
    expect(out.output).toContain("r000");
    expect(out.output).toContain("reference");
    expect(out.output).toContain("被移走的记忆会自动放回");
  });

  test("未满额时 set 返回空 evicted，且不写账本", async () => {
    writeMem(projDir, "user_only.md", "only", "user", BASE);
    const store = newStore();
    const result = await store.set("newbie", "新写的正文", "project", { type: "project" });

    expect(result.evicted).toEqual([]);
    expect(existsSync(join(projDir, EVICTIONS_FILE))).toBe(false);
  });
});

describe("A4 删除时回填被挤走的记忆", () => {
  test("delete(造成淘汰的 key) → 被挤走的记忆回到原文件名、重新进索引、archive 里没了", async () => {
    seedFull(projDir);
    const store = newStore();
    await store.set("newbie", "临时暗号 GAMMA-333", "project", { type: "project" });
    expect(existsSync(join(projDir, "reference_r000.md"))).toBe(false);

    const deleted = await store.delete("newbie");
    expect(deleted).toBe(true);

    // 文件回到原处，archive 里不再有
    expect(existsSync(join(projDir, "reference_r000.md"))).toBe(true);
    expect(existsSync(join(projDir, "archive", "reference_r000.md"))).toBe(false);
    // 索引里重新出现（模型重新看得见它）
    expect(readFileSync(join(projDir, "MEMORY.md"), "utf-8")).toContain("r000");
    // 内存视角也回来了，且 total 仍是 200（删 1 补 1）
    expect(await store.get("r000")).not.toBeNull();
    expect(await store.list()).toHaveLength(200);
  });

  test("回填目标文件名已被占用时不覆盖，归档文件保持原样", async () => {
    seedFull(projDir);
    const store = newStore();
    await store.set("newbie", "临时暗号", "project", { type: "project" });
    // 模拟「原文件名被占用」：手动放一个同名文件（内容不同，且不进内存快照）
    writeFileSync(
      join(projDir, "reference_r000.md"),
      "---\nname: occupied\ntype: reference\n---\n\n占位内容\n",
    );

    const deleted = await store.delete("newbie");
    expect(deleted).toBe(true);

    // 归档文件原样保留（没被搬走/覆盖）
    expect(existsSync(join(projDir, "archive", "reference_r000.md"))).toBe(true);
    expect(readFileSync(join(projDir, "reference_r000.md"), "utf-8")).toContain("占位内容");
  });

  test("删的不是造成淘汰的那条时不回填（语义精确，不恢复无关记忆）", async () => {
    seedFull(projDir);
    const store = newStore();
    await store.set("newbie", "临时暗号", "project", { type: "project" });
    // 删一条与本次淘汰无关的记忆（u001）
    expect(await store.delete("u001")).toBe(true);
    expect(existsSync(join(projDir, "reference_r000.md"))).toBe(false);
    expect(existsSync(join(projDir, "archive", "reference_r000.md"))).toBe(true);
  });
});

describe("A3 遥测字段", () => {
  test("memory_write 带 is_new_key / evicted_count；回填时有 restored_from_archive", async () => {
    seedFull(projDir);
    const seen = captureEvents();
    const tool = new MemoryTool(newStore());
    await tool.execute({ key: "newbie", value: "新写的正文", type: "project" });

    const writes = seen.filter((e) => e.name === "memory_write").map((e) => e.meta);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ is_new_key: true, evicted_count: 1 });

    const store = newStore();
    await store.delete("newbie");
    const guards = seen
      .filter((e) => e.name === "memory_guard")
      .map((e) => String(e.meta.guard_kind));
    expect(guards).toContain("evicted_to_archive");
    expect(guards).toContain("restored_from_archive");
  });

  test("更新已有 key 时 is_new_key=false、evicted_count=0", async () => {
    writeMem(projDir, "user_only.md", "only", "user", BASE);
    const seen = captureEvents();
    const tool = new MemoryTool(newStore());
    await tool.execute({ key: "only", value: "更新后的正文", type: "user" });
    const again = await tool.execute({ key: "only", value: "再更新一次", type: "user" });

    const writes = seen.filter((e) => e.name === "memory_write").map((e) => e.meta);
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w).toMatchObject({ is_new_key: false, evicted_count: 0 });
    }
    expect(again.output).not.toContain("移到了 archive/");
  });
});
