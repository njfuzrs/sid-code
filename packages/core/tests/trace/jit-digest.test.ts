/**
 * 第 5 批 · JIT 上下文度量闭环单测
 *
 * 背景：第 1 批只做了采集端（`app.ts:recordJitEvent` 打 `jit_context` 事件），
 * 没有任何消费方 —— 「JIT 改好了没有」量不出来。本批补上 `aggregateJitStats`
 * 与 digest 的 JIT 分节，这个文件是它的验收。
 *
 * 断言的重点不是「函数能跑」，而是**四个口径不能算错**：
 *  1. 命中率的分母含未命中（否则覆盖率恒 100%，度量失去意义）
 *  2. 浪费率的分母是「扫到的规则文件数」而非「触发次数」（两者答的是不同问题）
 *  3. 累积字节取**峰值**而非末值（/clear 与 compact 会 reset，末值可能被清零）
 *  4. 无事件返回 null 而非零值对象（区分「没命中」与「没数据」）
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  listSessions,
  buildDigest,
  renderHuman,
  aggregateJitStats,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-jitdigest-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * 造一条 `jit_context` 事件。字段名与 `app.ts:recordJitEvent` 的产出保持一致 ——
 * 这里手写字段名是刻意的：若生产侧改名，本测试会失败，这正是我们要的漂移哨兵。
 */
function jitEvt(opts: {
  hit?: boolean;
  loaded?: Array<{ path: string; bytes: number; reason?: string; oversized?: boolean }>;
  injectedBytes?: number;
  cumulativeBytes?: number;
  scopeSkipped?: number;
  failures?: Array<{ path: string; code: string; phase?: string }>;
  elapsedMs?: number;
}) {
  const loaded = opts.loaded ?? [];
  return {
    event: "jit_context",
    session_id: "x",
    timestamp: "2026-07-31T10:00:00.000Z",
    data: {
      accessed_path: "src/ui/Footer.tsx",
      hit: opts.hit ?? loaded.length > 0,
      loaded_count: loaded.length,
      loaded: loaded.map((l) => ({
        path: l.path,
        bytes: l.bytes,
        reason: l.reason ?? "nested_traversal",
        oversized: l.oversized ?? false,
      })),
      injected_bytes: opts.injectedBytes ?? loaded.reduce((s, l) => s + l.bytes, 0),
      cumulative_bytes: opts.cumulativeBytes ?? 0,
      scope_skipped: opts.scopeSkipped ?? 0,
      failures: opts.failures ?? [],
      elapsed_ms: opts.elapsedMs ?? 5,
    },
  };
}

describe("aggregateJitStats 口径正确性", () => {
  it("无 jit_context 事件返回 null（区分「没命中」与「没数据」）", () => {
    expect(aggregateJitStats([])).toBeNull();
    // 有别的事件但没有 jit_context 也要返回 null，否则老会话会显示一节全 0
    expect(
      aggregateJitStats([{ event: "AfterModelRaw", data: { provider: "anthropic" } }]),
    ).toBeNull();
  });

  it("命中率分母含未命中事件（覆盖率的分子分母不能都取命中）", () => {
    const stats = aggregateJitStats([
      jitEvt({ loaded: [{ path: "src/CLAUDE.md", bytes: 100 }] }),
      jitEvt({ hit: false }), // 触达了但没规则
      jitEvt({ hit: false }),
      jitEvt({ loaded: [{ path: "src/ui/CLAUDE.md", bytes: 200 }] }),
    ])!;
    expect(stats.injections).toBe(4);
    expect(stats.hits).toBe(2);
    expect(stats.hitRate).toBe(0.5);
  });

  it("浪费率分母是「扫到的规则文件数」而非「触发次数」", () => {
    // 1 次触发：加载 1 份 + 作用域跳过 3 份 → 浪费率 3/4，不是 3/1 也不是 3/(1+1)
    const stats = aggregateJitStats([
      jitEvt({ loaded: [{ path: "a/CLAUDE.md", bytes: 50 }], scopeSkipped: 3 }),
    ])!;
    expect(stats.scopeSkipped).toBe(3);
    expect(stats.loadedCount).toBe(1);
    expect(stats.wasteRate).toBeCloseTo(0.75, 5);
  });

  it("扫到 0 份规则时浪费率为 0 而非 NaN", () => {
    const stats = aggregateJitStats([jitEvt({ hit: false })])!;
    expect(stats.wasteRate).toBe(0);
    expect(Number.isNaN(stats.wasteRate)).toBe(false);
  });

  it("累积字节取峰值而非末值（/clear 与 compact 会 reset 到 0）", () => {
    const stats = aggregateJitStats([
      jitEvt({ loaded: [{ path: "a.md", bytes: 100 }], cumulativeBytes: 100 }),
      jitEvt({ loaded: [{ path: "b.md", bytes: 900 }], cumulativeBytes: 1000 }),
      // 这里模拟 compact 后 reset：末值 0 不能覆盖掉刚才的 1000
      jitEvt({ hit: false, cumulativeBytes: 0 }),
    ])!;
    expect(stats.cumulativeBytes).toBe(1000);
  });

  it("注入字节是各次之和，累积量是去重后峰值（两者语义不同，不可互相替代）", () => {
    // 同一份文件被重载两次：injectedBytes 计两次（注入动作之和），
    // cumulativeBytes 只反映 manager 当前持有量（去重）
    const stats = aggregateJitStats([
      jitEvt({ loaded: [{ path: "a.md", bytes: 300 }], cumulativeBytes: 300 }),
      jitEvt({ loaded: [{ path: "a.md", bytes: 300 }], cumulativeBytes: 300 }),
    ])!;
    expect(stats.injectedBytes).toBe(600);
    expect(stats.cumulativeBytes).toBe(300);
    expect(stats.loadedCount).toBe(2);
    expect(stats.uniqueFiles).toBe(1); // 去重后只有一份
  });

  it("按 reason 聚合归因分布", () => {
    const stats = aggregateJitStats([
      jitEvt({
        loaded: [
          { path: "a.md", bytes: 10, reason: "nested_traversal" },
          { path: "b.md", bytes: 10, reason: "path_glob_match" },
          { path: "c.md", bytes: 10, reason: "rules_dir" },
        ],
      }),
      jitEvt({ loaded: [{ path: "d.md", bytes: 10, reason: "nested_traversal" }] }),
    ])!;
    expect(stats.reasonCounts).toEqual({
      nested_traversal: 2,
      path_glob_match: 1,
      rules_dir: 1,
    });
  });

  it("失败按 code 聚合（ENOENT 已在生产侧排除，这里都是真错误）", () => {
    const stats = aggregateJitStats([
      jitEvt({
        failures: [
          { path: "a.md", code: "EACCES" },
          { path: "b.md", code: "EACCES" },
        ],
      }),
      jitEvt({ failures: [{ path: "c.md", code: "EISDIR" }] }),
    ])!;
    expect(stats.failures).toBe(3);
    expect(stats.failureCodes).toEqual({ EACCES: 2, EISDIR: 1 });
  });

  it("统计 oversized 份数（P2-2 仅告警不截断）", () => {
    const stats = aggregateJitStats([
      jitEvt({
        loaded: [
          { path: "big.md", bytes: 50_000, oversized: true },
          { path: "ok.md", bytes: 100, oversized: false },
        ],
      }),
    ])!;
    expect(stats.oversized).toBe(1);
  });

  it("0ms 是真实值而非缺失（命中缓存时常见，不可渲染成 ?）", () => {
    const stats = aggregateJitStats([
      jitEvt({ loaded: [{ path: "a.md", bytes: 10 }], elapsedMs: 0 }),
      jitEvt({ loaded: [{ path: "b.md", bytes: 10 }], elapsedMs: 0 }),
    ])!;
    expect(stats.elapsedP50).toBe(0);
    // 关键：0 必须能与 undefined 区分，否则渲染层会把「快」误报成「没采到」
    expect(stats.elapsedP50).not.toBeUndefined();
  });

  it("耗时分位数取自 elapsed_ms（P2-3 的实测验收依据）", () => {
    const stats = aggregateJitStats([
      jitEvt({ elapsedMs: 1 }),
      jitEvt({ elapsedMs: 2 }),
      jitEvt({ elapsedMs: 3 }),
      jitEvt({ elapsedMs: 100 }),
    ])!;
    expect(stats.elapsedP50).toBe(2);
    expect(stats.elapsedP95).toBe(100);
  });

  it("topFiles 按字节降序，同文件重载取最大值而非累加", () => {
    const stats = aggregateJitStats([
      jitEvt({ loaded: [{ path: "small.md", bytes: 100 }] }),
      jitEvt({ loaded: [{ path: "big.md", bytes: 5000 }] }),
      // big.md 重载一次：topFiles 不能变成 10000（那会把重载次数当体积）
      jitEvt({ loaded: [{ path: "big.md", bytes: 5000 }] }),
    ])!;
    expect(stats.topFiles[0]).toEqual({ path: "big.md", bytes: 5000, reason: "nested_traversal" });
    expect(stats.topFiles[1].path).toBe("small.md");
  });

  it("字段缺失/类型异常不产出 NaN（轨迹是外部数据，不可信任其形状）", () => {
    const stats = aggregateJitStats([
      { event: "jit_context", data: {} },
      {
        event: "jit_context",
        data: { injected_bytes: "abc", scope_skipped: null, loaded: "not-an-array" },
      },
    ])!;
    expect(stats.injections).toBe(2);
    expect(stats.injectedBytes).toBe(0);
    expect(stats.scopeSkipped).toBe(0);
    expect(stats.loadedCount).toBe(0);
    expect(Number.isNaN(stats.hitRate)).toBe(false);
  });
});

describe("digest JIT 分节渲染", () => {
  function writeSessionWithEvents(id: string, events: unknown[]) {
    const dir = join(root, "trajectories", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.traj"),
      JSON.stringify({
        trajectory: [
          { message_type: "action", role: "assistant", tool_name: "read", tool_input: {} },
        ],
        info: { exit_status: "submitted" },
      }),
    );
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return dir;
  }

  it("验收标准：一眼能读到命中率 / 注入字节 / 浪费率三个数", () => {
    writeSessionWithEvents("jitrender1", [
      jitEvt({
        loaded: [{ path: "src/ui/CLAUDE.md", bytes: 800 }],
        cumulativeBytes: 800,
        elapsedMs: 4,
      }),
      jitEvt({ hit: false, scopeSkipped: 1, elapsedMs: 2 }),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.jit).toBeDefined();
    expect(d.jit!.hitRate).toBe(0.5);

    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("JIT 上下文:");
    expect(out).toContain("触发 2 次 / 命中 1 次（50%）");
    expect(out).toContain("浪费率");
    expect(out).toContain("src/ui/CLAUDE.md");
    // 耗时须标注 fire-and-forget，避免读者误以为这段计入 TTFT
    expect(out).toContain("不进 TTFT");
  });

  it("耗时 0ms 渲染成 0ms 而非 ?（把「快」误读成「没采到」是实测踩过的坑）", () => {
    writeSessionWithEvents("jitrender5", [
      jitEvt({ loaded: [{ path: "a.md", bytes: 10 }], elapsedMs: 0 }),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("P50=0ms");
    expect(out).not.toContain("P50=?");
  });

  it("无 JIT 事件时整节不渲染（不显示一堆 0 误导读者）", () => {
    writeSessionWithEvents("jitrender2", [{ event: "SessionEnd", data: {} }]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.jit).toBeUndefined();
    expect(renderHuman(d, { noColor: true })).not.toContain("JIT 上下文:");
  });

  it("累积量超阈值 / 有失败 / 有超大文件时给出显式告警", () => {
    writeSessionWithEvents("jitrender3", [
      jitEvt({
        loaded: [{ path: "huge/CLAUDE.md", bytes: 60_000, oversized: true }],
        cumulativeBytes: 60_000,
        failures: [{ path: "locked.md", code: "EACCES" }],
      }),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("累积偏高");
    expect(out).toContain("超大小告警阈值");
    expect(out).toContain("EACCES");
  });

  it("--json 输出带 jit 字段（供脚本消费，如批量立基线）", () => {
    writeSessionWithEvents("jitrender4", [jitEvt({ loaded: [{ path: "a.md", bytes: 10 }] })]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const parsed = JSON.parse(JSON.stringify(d));
    expect(parsed.jit.injections).toBe(1);
    expect(parsed.jit.hits).toBe(1);
  });
});
