/**
 * LSP 诊断注入口径（LspDiagnostics 事件 → digest）与接线门禁。
 *
 * 接线门禁存在的理由：sink 是模块级通道，app.ts 不接线时一切照常运行、测试照样全绿，
 * 只是 events.jsonl 里永远没有这条事件——修复「能不能在数据上体现」就无从回答。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateLspDiagnosticsStats } from "@sid-code/core/trace/digest.ts";
import { LSP_DIAGNOSTICS_EVENT_NAME } from "@sid-code/core/lsp/manager.ts";

describe("aggregateLspDiagnosticsStats", () => {
  test("无事件 → undefined（老会话不出这一节）", () => {
    expect(aggregateLspDiagnosticsStats([{ event: "TurnComplete", data: {} }])).toBeUndefined();
  });

  test("累加计数、outcome 分布、子代理分组", () => {
    const ev = (data: Record<string, unknown>) => ({ event: LSP_DIAGNOSTICS_EVENT_NAME, data });
    const s = aggregateLspDiagnosticsStats([
      ev({
        outcome: "injected",
        injected: 10,
        carried: 5,
        omitted_info: 2,
        publishes: 3,
        publishes_with_version: 0,
        stale_syncing: 1,
        stale_version: 0,
      }),
      ev({
        outcome: "info_only",
        injected: 0,
        carried: 0,
        omitted_info: 30,
        publishes: 3,
        publishes_with_version: 0,
        stale_syncing: 0,
        stale_version: 0,
      }),
      ev({
        outcome: "injected",
        injected: 1,
        carried: 0,
        omitted_info: 0,
        publishes: 1,
        publishes_with_version: 1,
        stale_syncing: 0,
        stale_version: 1,
        agent_id: "sub-1",
      }),
    ])!;
    expect(s.collects).toBe(3);
    expect(s.outcomes).toEqual({ injected: 2, info_only: 1 });
    expect(s.injected).toBe(11);
    expect(s.carried).toBe(5);
    expect(s.omittedInfo).toBe(32);
    expect(s.publishes).toBe(7);
    expect(s.publishesWithVersion).toBe(1);
    expect(s.staleSyncing).toBe(1);
    expect(s.staleVersion).toBe(1);
    expect(s.byAgent).toEqual({ "sub-1": { collects: 1, injected: 1 } });
  });
});

describe("接线门禁：LspDiagnostics 必须真正写进轨迹", () => {
  // app.ts 含 NUL 字节，grep 会当二进制静默跳过；用 readFileSync
  const app = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");

  test("app.ts 把 sink 接到 collector.recordCustomEvent", () => {
    expect(app).toMatch(
      /setLspDiagnosticsTraceSink\(\s*traceCollectorInstance\s*\?\s*\(data\)\s*=>\s*traceCollectorInstance\.recordCustomEvent\(LSP_DIAGNOSTICS_EVENT_NAME,\s*data\)/,
    );
  });

  test("事件名常量值固定（digest 按字面量匹配）", () => {
    expect(LSP_DIAGNOSTICS_EVENT_NAME).toBe("LspDiagnostics");
  });
});
