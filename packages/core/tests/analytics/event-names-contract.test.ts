/**
 * 事件名契约快照（与 agent-backend 白名单逐项对齐）。
 *
 * 为什么要这份快照：agent-backend 的 `POST /api/v1/events` 对事件名是 fail-closed 白名单
 * （`backend/app/modules/event/service/guard.py` 的 `ALLOWED_EVENT_NAMES`）。客户端加了新事件、
 * 服务端没同步，新事件就被记为 `unknown_event_name` 静默丢掉 —— `memory_read` 就这样被拒收了
 * 28 次才被人发现，两边各自的测试都是绿的。
 *
 * 做法同 `fixtures/backend-paths.json`：本仓从源码生成快照并断言一致；agent-backend 把同一份
 * 文件拷到 `tests/fixtures/sid-code-event-names.json`，断言白名单与它逐项相等。
 * 改了事件名 → 本测试红 → `UPDATE_EVENT_NAMES=1` 重新生成 → 把文件同步到 agent-backend。
 *
 * 快照 = `EVENT_NAMES` 全部取值 + 生产代码里直调 `logEvent("字面量")` 的事件名
 * （目前只有 app.ts 的 `startup_timing`，它不在 EVENT_NAMES 表里，但同样会上报）。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_NAMES } from "@sid-code/core/analytics/events.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/event-names.json");

/** 与 instrumentation-sentinel 同口径：tui 是上游 fork，不参与埋点约定 */
const PKG_SRC_ROOTS = ["shared", "core", "cli"].map((p) =>
  join(import.meta.dir, "..", "..", "..", "..", "packages", p, "src"),
);

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/**
 * 生产代码里 `logEvent("xxx"` 的字面量事件名。
 * 用 readFileSync 而非 grep：app.ts 含 NUL 字节，grep 会把它当二进制静默跳过。
 */
function directLogEventNames(): { names: Set<string>; fileCount: number } {
  const names = new Set<string>();
  let fileCount = 0;
  for (const root of PKG_SRC_ROOTS) {
    for (const file of collectSourceFiles(root)) {
      fileCount++;
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/\blogEvent\(\s*["'`]([a-z0-9_]+)["'`]/g)) {
        names.add(m[1]!);
      }
    }
  }
  return { names, fileCount };
}

function buildSnapshot(): string {
  const { names } = directLogEventNames();
  const all = new Set<string>([...Object.values(EVENT_NAMES), ...names]);
  return `${JSON.stringify({ events: [...all].sort() }, null, 2)}\n`;
}

describe("事件名契约快照", () => {
  test("快照与客户端实际上报的事件名一致（不一致时用 UPDATE_EVENT_NAMES=1 重新生成，并同步到 agent-backend）", () => {
    const expected = buildSnapshot();
    if (process.env.UPDATE_EVENT_NAMES === "1") writeFileSync(FIXTURE, expected);
    expect(readFileSync(FIXTURE, "utf-8")).toBe(expected);
  });

  test("扫描面非空，且确实扫到了 app.ts 的 startup_timing（防正则 / 路径失效后静默空转）", () => {
    const { names, fileCount } = directLogEventNames();
    expect(fileCount).toBeGreaterThan(200);
    expect(names.has("startup_timing")).toBe(true);
  });

  test("memory_read 在快照里（agent-backend 曾漏同步它，回归锚点）", () => {
    const snap = JSON.parse(readFileSync(FIXTURE, "utf-8")) as { events: string[] };
    expect(snap.events).toContain("memory_read");
  });
});
