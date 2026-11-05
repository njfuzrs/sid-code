/**
 * TraceCollector 自定义事件的**启动期排队补发**（2026-11-05 review 补的单测）。
 *
 * 背景：`sandbox_init` 由 cli.ts 在 App / TraceCollector 构造**之前**记录，那一秒
 * collector 还没 `initialized`。原实现直接丢弃，于是「开了沙箱的会话里多少条 bash
 * 真进了沙箱」永远没有分母 —— B2（沙箱开启即全挂）坏了两三个月没人发现，直接原因
 * 就是这条链在轨迹上是瞎的。
 *
 * 该行为在 PR #601 里只有端到端手工验证，没有单测；这里把两条时序都锁住：
 * 1. collector 未初始化 → 排队 → SessionStart 后补发；
 * 2. sandbox.ts 的模块级 pending → sink 注入后补发，且只补发一次。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import {
  recordSandboxInit,
  setSandboxInitTraceSink,
  __resetSandboxInitForTest,
  SANDBOX_INIT_EVENT_NAME,
  type SandboxInitReport,
} from "@sid-code/core/permission/sandbox.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;
let hookSystem: HookSystem;
let collector: TraceCollector;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `trace-pending-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  hookSystem = new HookSystem();
  hookSystem.setSessionId("sess-pending");
  hookSystem.setCwd("/tmp/test");
  collector = new TraceCollector({ outputDir: testDir });
  collector.registerHooks(hookSystem);
});

/** 读 events.jsonl 里指定 event 名的事件（文件不存在时返回空数组）。 */
function readEvents(name: string): Array<{ data?: Record<string, unknown> }> {
  const path = join(testDir, "sessions", "sess-pending", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { event?: string; data?: Record<string, unknown> })
    .filter((r) => r.event === name);
}

describe("TraceCollector.recordCustomEvent：SessionStart 之前排队补发", () => {
  test("未初始化时记录的事件不丢，SessionStart 后落盘且 data 完整", async () => {
    // SessionStart 之前：writer 尚未创建，事件只能排队
    expect(readEvents("git_operation")).toHaveLength(0);
    collector.recordCustomEvent("git_operation", { op: "commit", ok: true });

    await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });

    const rows = readEvents("git_operation");
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ op: "commit", ok: true });
  });

  test("初始化之后记录的事件直接落盘，不会被重复补发", async () => {
    collector.recordCustomEvent("before_init", { n: 1 });
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });
    collector.recordCustomEvent("before_init", { n: 2 });

    const rows = readEvents("before_init");
    // 1 条排队补发 + 1 条直接落盘；不是 3 条（补发不重复）
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.data as { n: number }).n)).toEqual([1, 2]);
  });

  test("排队上限 200 条：超出部分丢弃但不抛错", async () => {
    for (let i = 0; i < 205; i++) collector.recordCustomEvent("flood", { i });
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });
    expect(readEvents("flood")).toHaveLength(200);
  });
});

describe("sandbox_init 延迟接线（模块级 pending → sink）", () => {
  afterEach(() => {
    __resetSandboxInitForTest();
  });

  const report: SandboxInitReport = {
    enabled: true,
    platform: "darwin",
    probe_ok: true,
    network: "localhost",
    write_paths_count: 5,
  };

  test("sink 注入前只暂存，注入时补发一次；重复注入不重复发", () => {
    __resetSandboxInitForTest();
    const seen: SandboxInitReport[] = [];
    recordSandboxInit(report);
    // 还没有 sink：报告留在模块级，不应有任何发送
    expect(seen).toHaveLength(0);

    setSandboxInitTraceSink((d) => seen.push(d));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ enabled: true, probe_ok: true, network: "localhost" });

    // 二次注入（例如 App 重建）：pending 已清空，分母不能被同一会话重复计数
    setSandboxInitTraceSink((d) => seen.push(d));
    expect(seen).toHaveLength(1);
  });

  test("sink 已就绪时立即发送", () => {
    __resetSandboxInitForTest();
    const seen: SandboxInitReport[] = [];
    setSandboxInitTraceSink((d) => seen.push(d));
    recordSandboxInit(report);
    expect(seen).toHaveLength(1);
  });

  test("事件名常量与落盘通道对齐（防别名漂移）", () => {
    expect(SANDBOX_INIT_EVENT_NAME).toBe("sandbox_init");
  });
});
