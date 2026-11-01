/**
 * scripts/memory-report.ts 口径测试
 *
 * 防的是「报告恒为 0 / 恒为全量」：枚举口径、索引链接格式、读计数文件名或账本字段名
 * 任何一个漂移，报告都会静默给出看似合理的数字而不报错。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirReport, extractCost, indexLinks } from "../../scripts/memory-report.ts";
import type { UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";

const DAY = 86_400_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-mr-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mem(rel: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `---\nname: ${rel}\ntype: project\n---\n\nbody\n`);
}

describe("dirReport", () => {
  test("条数 / 进索引 / 读过 / 30 天未读，archive 与索引本身不计", async () => {
    const now = 100 * DAY;
    mem("a.md");
    mem("b.md");
    mem("sub/c.md");
    mem("archive/old.md");
    writeFileSync(
      join(dir, "MEMORY.md"),
      "# Memory Index\n\n- [a](a.md) — x\n- [c](sub/c.md) — y\n",
    );
    writeFileSync(
      join(dir, ".read-stats.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "a.md": { lastRead: now - DAY, readCount: 3 },
          "sub/c.md": { lastRead: now - 40 * DAY, readCount: 1 },
        },
      }),
    );
    const r = await dirReport(dir, now);
    expect(r).toMatchObject({
      files: 3,
      inIndex: 2,
      readAtLeastOnce: 2,
      unread30d: 2, // b 从未读 + c 40 天前读
      hasReadStats: true,
    });
  });

  test("没有读计数文件：全部算 30 天未读，并标出 hasReadStats=false", async () => {
    mem("a.md");
    const r = await dirReport(dir);
    expect(r).toMatchObject({ files: 1, readAtLeastOnce: 0, unread30d: 1, hasReadStats: false });
  });

  test("indexLinks 与 writeIndex 行格式同形（含年龄注解）", () => {
    writeFileSync(join(dir, "MEMORY.md"), "- [a](a.md) ⏳3 days ago — x\n");
    expect([...indexLinks(dir)]).toEqual(["a.md"]);
  });
});

describe("extractCost", () => {
  const row = (ts: number, byAgent?: UsageLedgerEntry["byAgent"]): UsageLedgerEntry =>
    ({ ts, sessionId: String(ts), byAgent }) as UsageLedgerEntry;

  test("只加总 7 天内、指定 agent 的行", () => {
    const now = 30 * DAY;
    const a = { requests: 2, inputTokens: 100, outputTokens: 10, costUSD: 0.5 };
    const r = extractCost(
      [
        row((now - DAY) / 1000, { "fork:memory-extract": a }),
        row((now - 2 * DAY) / 1000, { "fork:memory-extract": a, "fork:other": a }),
        row((now - 10 * DAY) / 1000, { "fork:memory-extract": a }), // 窗口外
        row((now - DAY) / 1000), // 旧行无 byAgent
      ],
      { now },
    );
    expect(r).toMatchObject({ sessions: 2, requests: 4, inputTokens: 200, outputTokens: 20 });
    expect(r.costUSD).toBeCloseTo(1, 10);
  });
});
