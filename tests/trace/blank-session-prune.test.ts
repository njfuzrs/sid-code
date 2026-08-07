/**
 * 启动时清理「历史遗留空壳会话」测试
 *
 * 背景（2026-08-07 实测）：空壳本该在 SessionEnd 由 cleanupIfBlankSession() 删掉，
 * 但 `SessionStart` 75 次 : `SessionEnd` 9 次 —— 绝大多数进程走不到 SessionEnd
 * （Ctrl-C / kill / 直接关终端都不触发），于是盘上堆了 42 个只含 SessionStart 的空目录。
 *
 * 真实伤害不是占磁盘，而是**污染度量口径**：按目录数算 traj 覆盖率得 33%（看着像 P0），
 * 按「有真实 LLM 调用的会话」算是 100%。分母被灌水，健康指标长得像故障。
 *
 * ⚠ 本测试的重点是**保守性**：删对 1 个 case，但必须保住 5 类不该删的。
 * 误删等于毁掉用户排查现场，代价远高于留一个多余目录（见 CLAUDE.md §0 铁律）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "../../src/trace/collector.ts";

let root: string;
let sessionsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-blank-prune-"));
  sessionsDir = join(root, "trajectories", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 造一个会话目录；files 为 { 文件名: 内容 } */
function makeSession(
  id: string,
  files: Record<string, string>,
  opts: { ageHours?: number } = {},
): string {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  // 默认推到 3 小时前（超过 1 小时静置门槛）
  const ageHours = opts.ageHours ?? 3;
  if (ageHours > 0) {
    const t = new Date(Date.now() - ageHours * 3600_000);
    utimesSync(dir, t, t);
  }
  return dir;
}

/** 构造 collector 触发启动清理 */
function runPrune(): void {
  new TraceCollector({ outputDir: join(root, "trajectories") }, null);
}

const evt = (...names: string[]) =>
  names.map((n) => JSON.stringify({ event: n })).join("\n") + "\n";

describe("空壳会话清理（该删的）", () => {
  test("只含 SessionStart 的空壳被删除", () => {
    const dir = makeSession("blank1", { "events.jsonl": evt("SessionStart") });
    runPrune();
    expect(existsSync(dir)).toBe(false);
  });

  test("SessionStart + GatewayPricingSync + warn.log + heartbeat.txt 仍是空壳", () => {
    const dir = makeSession("blank2", {
      "events.jsonl": evt("SessionStart", "GatewayPricingSync"),
      "warn.log": "some warning",
      "heartbeat.txt": '{"ts":"2026-08-01T00:00:00Z"}',
    });
    runPrune();
    expect(existsSync(dir)).toBe(false);
  });

  test("正常收尾但零 LLM 调用（含 SessionEnd）也是空壳", () => {
    const dir = makeSession("blank3", { "events.jsonl": evt("SessionStart", "SessionEnd") });
    runPrune();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("空壳会话清理的保守性（绝不能删的）", () => {
  test("有工作类事件 → 保留", () => {
    for (const workEvent of [
      "BeforeModel",
      "AfterModelRaw",
      "PreToolUse",
      "UserPromptSubmit",
      "StreamPhase",
    ]) {
      const dir = makeSession(`work-${workEvent}`, {
        "events.jsonl": evt("SessionStart", workEvent),
      });
      runPrune();
      expect(existsSync(dir)).toBe(true);
    }
  });

  test("有 session.traj / raw.jsonl / messages.json / crash.json → 保留", () => {
    for (const f of ["session.traj", "raw.jsonl", "messages.json", "crash.json"]) {
      const dir = makeSession(`data-${f}`, {
        "events.jsonl": evt("SessionStart"),
        [f]: "{}",
      });
      runPrune();
      expect(existsSync(dir)).toBe(true);
    }
  });

  test("未知（未来新增）事件类型 → 保留（白名单语义，宁可漏删）", () => {
    const dir = makeSession("future1", {
      "events.jsonl": evt("SessionStart", "SomeFutureEventName"),
    });
    runPrune();
    expect(existsSync(dir)).toBe(true);
  });

  test("events.jsonl 有坏行（无法判定）→ 保留", () => {
    const dir = makeSession("badline1", {
      "events.jsonl": '{"event":"SessionStart"}\nNOT JSON AT ALL\n',
    });
    runPrune();
    expect(existsSync(dir)).toBe(true);
  });

  test("目录太新（<1h）→ 保留（可能是其它进程正在跑）", () => {
    const dir = makeSession("fresh1", { "events.jsonl": evt("SessionStart") }, { ageHours: 0 });
    runPrune();
    expect(existsSync(dir)).toBe(true);
  });

  test("没有 events.jsonl → 保留（可能正在初始化，交给 LRU 管）", () => {
    const dir = makeSession("noevents1", {}, { ageHours: 3 });
    runPrune();
    expect(existsSync(dir)).toBe(true);
  });

  test("空的 events.jsonl → 保留（无证据不删）", () => {
    const dir = makeSession("empty1", { "events.jsonl": "" });
    runPrune();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("混合场景", () => {
  test("一次清理只删空壳，其它会话全部完好", () => {
    const blank = makeSession("mix-blank", { "events.jsonl": evt("SessionStart") });
    const work = makeSession("mix-work", { "events.jsonl": evt("SessionStart", "BeforeModel") });
    const withTraj = makeSession("mix-traj", {
      "events.jsonl": evt("SessionStart"),
      "session.traj": '{"metadata":{"total_cost_usd":0.5}}',
    });
    const fresh = makeSession("mix-fresh", { "events.jsonl": evt("SessionStart") }, { ageHours: 0 });

    runPrune();

    expect(existsSync(blank)).toBe(false);
    expect(existsSync(work)).toBe(true);
    expect(existsSync(withTraj)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  test("清理后 traj 覆盖率分母不再被空壳灌水", () => {
    // 3 个空壳 + 2 个有真实调用（其中 2 个都有 traj）
    makeSession("cov-blank1", { "events.jsonl": evt("SessionStart") });
    makeSession("cov-blank2", { "events.jsonl": evt("SessionStart") });
    makeSession("cov-blank3", { "events.jsonl": evt("SessionStart", "GatewayPricingSync") });
    makeSession("cov-real1", {
      "events.jsonl": evt("SessionStart", "AfterModelRaw"),
      "session.traj": "{}",
    });
    makeSession("cov-real2", {
      "events.jsonl": evt("SessionStart", "AfterModelRaw"),
      "session.traj": "{}",
    });

    runPrune();

    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const remaining = readdirSync(sessionsDir).filter((d) => !d.startsWith("."));
    // 分母从 5 变成 2，覆盖率从 40% 回到真实的 100%
    expect(remaining.length).toBe(2);
    expect(remaining.every((d) => existsSync(join(sessionsDir, d, "session.traj")))).toBe(true);
  });
});
