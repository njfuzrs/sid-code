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

  // U11（2026-11-05 新鲜度口径）：新字段要能累加，且老会话（事件里没有这些字段）不报错
  test("U11：新鲜度字段累加正确", () => {
    const ev = (data: Record<string, unknown>) => ({ event: LSP_DIAGNOSTICS_EVENT_NAME, data });
    const s = aggregateLspDiagnosticsStats([
      ev({
        outcome: "injected",
        publishes: 10,
        fresh_by_version: 0,
        fresh_by_barrier: 8,
        unverified: 1,
        baseline: 1,
        drifted_files: 2,
        injected_first_publish: 1,
      }),
      ev({
        outcome: "injected",
        publishes: 5,
        fresh_by_version: 3,
        fresh_by_barrier: 0,
        unverified: 2,
        baseline: 0,
        drifted_files: 0,
        injected_first_publish: 0,
      }),
    ])!;
    expect(s.freshByVersion).toBe(3);
    expect(s.freshByBarrier).toBe(8);
    expect(s.unverified).toBe(3);
    expect(s.baseline).toBe(1);
    expect(s.driftedFiles).toBe(2);
    expect(s.injectedFirstPublish).toBe(1);
    // 恒等式：各类新鲜度之和 = 推送总数（口径自洽，漏一类就会露馅）
    expect(s.freshByVersion + s.freshByBarrier + s.unverified + s.baseline).toBe(s.publishes);
  });

  test("U11：老会话的 LspDiagnostics 事件没有新字段 → 记 0，不 NaN、不报错", () => {
    const s = aggregateLspDiagnosticsStats([
      {
        event: LSP_DIAGNOSTICS_EVENT_NAME,
        // 2026-10-24 版事件的全部字段，没有 fresh_* / unverified / baseline / drifted_files
        data: {
          outcome: "injected",
          injected: 2,
          carried: 0,
          omitted_info: 0,
          publishes: 3,
          publishes_with_version: 0,
          stale_syncing: 0,
          stale_version: 0,
        },
      },
    ])!;
    expect(s.freshByVersion).toBe(0);
    expect(s.freshByBarrier).toBe(0);
    expect(s.unverified).toBe(0);
    expect(s.baseline).toBe(0);
    expect(s.driftedFiles).toBe(0);
    expect(s.injectedFirstPublish).toBe(0);
    expect(Number.isNaN(s.unverified)).toBe(false);
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
