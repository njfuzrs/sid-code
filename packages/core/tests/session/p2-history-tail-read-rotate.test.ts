/**
 * N14 门禁：history.jsonl 只读尾部 + 超阈值轮转。
 *
 * 以前 readFileSync + 全量 JSON.parse 之后才截断到 500 条（注释说「避免超大文件全量入内存」，
 * 代码做的是相反的事），文件永不轮转。断言落在返回值与磁盘文件上。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendHistoryEntry,
  readHistoryEntries,
  readHistoryDisplays,
  rotateHistoryIfNeeded,
} from "@sid-code/core/session/history-index.ts";

const line = (display: string, project = "/p") =>
  JSON.stringify({ display, pastedContents: [], timestamp: "", project, sessionId: "s" });

describe("N14：history.jsonl 尾部倒读与轮转", () => {
  let home: string;
  let prev: string | undefined;
  let file: string;

  beforeEach(() => {
    prev = process.env.SID_CONFIG_DIR;
    home = mkdtempSync(join(tmpdir(), "hist-n14-"));
    process.env.SID_CONFIG_DIR = home;
    file = join(home, "history.jsonl");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  test("跨多个 64KB 块：最新在前、条数正确、与全量解析结果逐条一致", () => {
    // 3000 行、带 48KB 大行与多字节中文，跨越多个块边界
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const big = i % 500 === 7 ? "大".repeat(16 * 1024) : "";
      lines.push(line(`第${i}条-${big}`, i % 2 ? "/a" : "/b"));
    }
    writeFileSync(file, lines.join("\n") + "\n");
    expect(statSync(file).size).toBeGreaterThan(3 * 64 * 1024);

    const expected = lines
      .map((l) => JSON.parse(l).display as string)
      .reverse()
      .slice(0, 500);
    expect(readHistoryEntries().map((e) => e.display)).toEqual(expected);
    // limit 大于总数 ⇒ 全部读回、一条不丢
    expect(readHistoryEntries({ limit: 10_000 }).length).toBe(3000);
    // project 过滤在倒读中完成，仍攒够 limit
    const a = readHistoryEntries({ project: "/a", limit: 50 });
    expect(a.length).toBe(50);
    expect(a.every((e) => e.project === "/a")).toBe(true);
    expect(a[0]!.display.startsWith("第2999条")).toBe(true);
  });

  test("最后一行是无换行符的崩溃半行 / 中间有坏行 ⇒ 跳过，其余照读", () => {
    writeFileSync(file, `${line("x")}\n{"display":"bad...\n${line("y")}\n{"display":"hal`);
    expect(readHistoryDisplays()).toEqual(["y", "x"]);
  });

  test("只读尾部：攒够 limit 就停，前面的垃圾字节不被解析", () => {
    // 前面塞 1MB 非 JSON 垃圾（全量解析也只会跳过，这里验的是「读到够就停」不影响结果）
    writeFileSync(file, "garbage\n".repeat(128 * 1024) + line("old") + "\n" + line("new") + "\n");
    expect(readHistoryDisplays({ limit: 1 })).toEqual(["new"]);
    expect(readHistoryEntries({ limit: 0 })).toEqual([]);
  });

  test("轮转：超阈值后截到最近 keepLines 行，最新一行保留，文件仍可正常读", () => {
    const lines = Array.from({ length: 200 }, (_, i) => line(`e${i}`));
    writeFileSync(file, lines.join("\n") + "\n");
    expect(rotateHistoryIfNeeded({ thresholdBytes: 1024, keepLines: 20 })).toBe(true);
    const after = readFileSync(file, "utf-8").trimEnd().split("\n");
    expect(after.length).toBe(20);
    expect(after[19]).toBe(lines[199]);
    expect(after[0]).toBe(lines[180]);
    expect(readHistoryDisplays({ limit: 3 })).toEqual(["e199", "e198", "e197"]);
  });

  test("轮转：按字节上限先到顶；未超阈值不动文件", () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(`b${i}-${"z".repeat(1000)}`));
    writeFileSync(file, lines.join("\n") + "\n");
    const before = statSync(file).size;
    expect(rotateHistoryIfNeeded({ thresholdBytes: before })).toBe(false);
    expect(statSync(file).size).toBe(before);

    expect(
      rotateHistoryIfNeeded({ thresholdBytes: 1024, keepLines: 1000, keepBytes: 10_000 }),
    ).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(10_000);
    expect(readHistoryDisplays({ limit: 1 })[0]!.startsWith("b99-")).toBe(true);
  });

  test("appendHistoryEntry 走生产入口：默认阈值下小文件不轮转，追加的条目读得回", () => {
    appendHistoryEntry({
      display: "q",
      pastedContents: [],
      timestamp: "",
      project: "/p",
      sessionId: "s",
    });
    appendHistoryEntry({
      display: "w",
      pastedContents: [],
      timestamp: "",
      project: "/p",
      sessionId: "s",
    });
    expect(readHistoryDisplays()).toEqual(["w", "q"]);
  });
});
