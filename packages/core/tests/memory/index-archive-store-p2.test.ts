/**
 * C3-C 集成门禁：索引截断时 `set()` 真的把低频记忆归档到 `archive/`（2026-11-03）。
 *
 * `index-archive-p2.test.ts` 锁的是**判据**（纯函数）；本文件锁**接线**：
 * 判据正确但没接进写路径，等于没修 —— 这正是「防线装好了但没人调用」那类事故。
 *
 * 场景按本机实测构造（project 记忆 201 个文件、索引只列 63 条）：
 * 造 140 个「60 天前写入、从未被 Read」的 project 记忆 → 索引截断 →
 * `set()` 触发归档 20 条（单次上限）→ 索引重新放得下。
 *
 * 隔离：`SID_CONFIG_DIR` + 显式传 `projectMemoryDir` / `globalMemoryDir`，双保险。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";

let tmpRoot: string;
let prevConfigDir: string | undefined;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-mem-index-archive-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpRoot;
});

afterAll(() => {
  // 存/恢复原值，不无条件 delete —— 同批测试同进程，别抹掉 preload 的兜底
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 写一条记忆 .md（frontmatter 的 updated 决定 store 的 updatedAt） */
function writeMemory(dir: string, i: number, updatedAt: number, descChars = 150): void {
  // key 取真实长度（本机实测 key 平均 45 字节）：否则可能根本撑不到 25KB，
  // 测试就成了「因为没触发截断所以没归档」的假绿。
  const key = `project_person_interview_prep_topic_number_${i}`;
  const desc = "这是一条足够长的中文摘要用于把索引撑到字节上限".repeat(8).slice(0, descChars);
  const body = [
    "---",
    `name: ${key}`,
    `description: ${desc}`,
    "type: project",
    `created: ${updatedAt}`,
    `updated: ${updatedAt}`,
    "---",
    "",
    `正文 ${i}：这条记忆很久没被写过，也从未被 Read 过。`,
    "",
  ].join("\n");
  writeFileSync(join(dir, `project_topic_${i}.md`), body, "utf8");
}

describe("C3-C 接线：索引截断 → set() 归档低频记忆 → 索引重新放得下", () => {
  test("140 条陈旧 project 记忆下，set() 归档 20 条最旧的并重建索引", async () => {
    clearMemorySummaryCache();
    const projDir = join(tmpRoot, "proj-memory");
    const globalDir = join(tmpRoot, "global-memory");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    const now = Date.now();
    const OLD = now - 60 * DAY;
    for (let i = 0; i < 140; i++) {
      // updatedAt 递增：i 越小越旧，归档应优先拿 i 小的
      writeMemory(projDir, i, OLD + i * 1000);
    }
    // 读统计文件「存在但为空」→ 走 30 天门槛（hasReadStats=true），而不是 90 天兜底
    writeFileSync(
      join(projDir, ".read-stats.json"),
      JSON.stringify({ version: 1, entries: {} }) + "\n",
      "utf8",
    );

    const store = new MemoryStore(join(tmpRoot, "fake-project"), {
      projectMemoryDir: projDir,
      globalMemoryDir: globalDir,
    });

    // 触发写路径：新增一条记忆 → writeIndex 发现截断 → 归档 → 重建索引
    await store.set("new_topic", "刚写下的新记忆正文", "project", {
      type: "project",
      description: "刚写下的新记忆",
    });

    // ① 归档目录真的出现了，且正好是单次上限 20 条
    const archiveDir = join(projDir, "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archived = readdirSync(archiveDir).filter((f) => f.endsWith(".md"));
    expect(archived.length).toBe(20);

    // ② 归档的是**最旧**的一批（i = 0..19），不是随机挑的
    for (let i = 0; i < 20; i++) {
      expect(archived).toContain(`project_topic_${i}.md`);
    }
    expect(archived).not.toContain("project_topic_20.md");

    // ③ 被归档的文件从原目录消失、字节仍在 archive/（不是删除）
    expect(existsSync(join(projDir, "project_topic_0.md"))).toBe(false);
    expect(existsSync(join(archiveDir, "project_topic_0.md"))).toBe(true);

    // ④ 索引在归档后重新放得下：140 + 1 - 20 = 121 条，无截断警告
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).not.toContain("索引已截断");
    const pointers = index.split("\n").filter((l) => l.startsWith("- ["));
    expect(pointers.length).toBe(121);
  });

  test("没有陈旧记忆时 set() 不归档（新目录不被误伤）", async () => {
    clearMemorySummaryCache();
    const projDir = join(tmpRoot, "fresh-memory");
    const globalDir = join(tmpRoot, "fresh-global");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    const store = new MemoryStore(join(tmpRoot, "fake-project-2"), {
      projectMemoryDir: projDir,
      globalMemoryDir: globalDir,
    });
    await store.set("fresh", "刚写的正文", "project", { type: "project" });

    expect(existsSync(join(projDir, "archive"))).toBe(false);
    // 索引正常写了这一条
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).toContain("[fresh]");
  });
});
