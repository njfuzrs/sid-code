/**
 * `scripts/northstar-snapshot.ts` —— 快照聚合 / 版本对比 / 防漂移门禁（P1-5 + P0-3 + P2-13）
 *
 * ## 这个文件在防什么
 *
 * 本脚本产出的数字会被写进 release note 与路线图 —— 也就是说，**它算错了没人会发现，
 * 只会有人照抄**。方案文档记录的三次文档漂移就是这么发生的。所以这里的断言分两类：
 *
 * A) **口径正确性**：分位数不可再平均、命中率必须在 token 总量上算、`null` 不得退化成 0。
 * B) **反向自证**：人为构造违反场景，断言/门禁**必须变红**。只验"正常时全绿"测不出
 *    那些逻辑是否真的在判 —— 这一条是本仓库反复强调的（"防线全在、单测全过、
 *    真实调用零触发"）。
 *
 * 其中三条对应实测踩过的坑，删掉任何一条都会让对应缺陷静默复活：
 *
 * 1. **`--version` 必须真的过滤数据**，不能只做标签。实测：只做标签时
 *    `--version 0.1.601 --emit` 写出的文件标着 v0.1.601 却混着全部历史版本，
 *    连续两次发版的 delta 恒等于 +0.0% —— 读起来像"性能稳定"，真相是分组键失效。
 * 2. **首次快照必须说"无对比对象"而不是 0%**。「与上版持平」和「上版不存在」
 *    在结论上完全相反。
 * 3. **样本不足必须被标记**。两个 n=3 的快照之间能算出几十个百分点的"改善"。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SessionIndexEntry } from "@sid-code/core/trace/session-index.ts";
import type { UsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger.ts";

import {
  KNOWN_FLAGS,
  MARKDOWN_BEGIN,
  MARKDOWN_END,
  MIN_SAMPLES_FOR_CONCLUSION,
  buildSnapshot,
  checkStaleness,
  compareSnapshots,
  findPreviousSnapshot,
  percentile,
  renderComparison,
  renderDeltaMarkdown,
  renderMarkdown,
  renderSnapshot,
  selfTest,
  type NorthstarSnapshot,
} from "../../scripts/northstar-snapshot.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "northstar-snapshot.ts");
const NOW = new Date("2026-08-14T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

// ─── 固件 ───

function idx(over: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    session_id: `s-${Math.random().toString(36).slice(2)}`,
    ts: NOW_SEC,
    app_version: "0.1.600",
    model: "claude-opus-4-8",
    exit_status: "end_turn",
    duration_ms: 60_000,
    turns: 5,
    total_steps: 5,
    cost_usd: 0.1,
    tokens_sent: 1000,
    tokens_received: 200,
    ttft_p50: 3000,
    ttft_p95: 5000,
    ttft_n: 4,
    e2e_p50: 30_000,
    e2e_p95: 60_000,
    e2e_n: 1,
    real_errors: 0,
    anomalies_count: 0,
    pathological: [],
    compactions: 0,
    defense_triggered: false,
    traj_corrupt: false,
    ...over,
  };
}

function led(over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    ts: NOW_SEC,
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    model: "claude-opus-4-8",
    provider: "anthropic",
    promptTotal: 1000,
    cacheHit: 800,
    cacheWrite: 100,
    uncachedInput: 100,
    output: 200,
    costUSD: 0.1,
    savingsUSD: 0.05,
    durationMs: 60_000,
    appVersion: "0.1.600",
    ...over,
  };
}

const DENOM = {
  activeSessions: 100,
  trajValidSessions: 20,
  ledgerSessions: 30,
  indexSessions: 30,
};

function snap(
  index: SessionIndexEntry[],
  ledger: UsageLedgerEntry[],
  over: Partial<Parameters<typeof buildSnapshot>[0]> = {},
): NorthstarSnapshot {
  return buildSnapshot({
    data: { index, ledger },
    denominators: DENOM,
    appVersion: "0.1.600",
    now: NOW,
    ...over,
  });
}

// ─── 分位数与口径 ───

describe("northstar · 分位数口径", () => {
  test("空样本返回 null 而不是 0（0 会被读成「0 毫秒」）", () => {
    expect(percentile([], 0.5)).toBeNull();
    const s = snap([], []);
    expect(s.faster.e2e_p50.value).toBeNull();
    expect(s.faster.e2e_p50.n).toBe(0);
  });

  test("p50/p95 从原始样本重排算出", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 100], 0.95)).toBe(100);
  });

  test("每个指标都带 n 与取数源（说不出源的数字就是自我感觉）", () => {
    const s = snap([idx()], [led()]);
    for (const m of [
      s.faster.e2e_p50,
      s.faster.ttft_p50,
      s.cheaper.cost_per_session,
      s.cheaper.cache_hit_rate,
      s.fewerRedos.real_errors_per_session,
      s.foundation.defense_trigger_rate,
      s.foundation.traj_corrupt_rate,
    ]) {
      expect(typeof m.n).toBe("number");
      expect(m.source.length).toBeGreaterThan(0);
    }
  });

  test("缓存命中率在 token 总量上算，不是各会话命中率的平均", () => {
    // 一个小会话 100% 命中 + 一个大会话 0% 命中。
    // 会话平均会得出 50%（错），token 总量口径得出 100/(100+10000)≈1.0%（对，且有计费意义）。
    const ledger = [
      led({ promptTotal: 100, cacheHit: 100 }),
      led({ promptTotal: 10_000, cacheHit: 0 }),
    ];
    const s = snap([], ledger);
    expect(s.cheaper.cache_hit_rate.value).toBeCloseTo(100 / 10_100, 9);
    // 若退化成会话平均，这里会是 0.5
    expect(s.cheaper.cache_hit_rate.value).not.toBeCloseTo(0.5, 2);
  });

  test("单会话分位数缺失时整条不进分布，而不是当 0", () => {
    const s = snap([idx({ e2e_p50: undefined }), idx({ e2e_p50: 10_000 })], []);
    expect(s.faster.e2e_p50.n).toBe(1);
    expect(s.faster.e2e_p50.value).toBe(10_000);
  });

  test("返工类指标只统计有终态会话（增量行 real_errors 恒 0，混进来会读成「零错误」）", () => {
    const s = snap(
      [
        idx({ exit_status: "incomplete", real_errors: 0 }),
        idx({ exit_status: "end_turn", real_errors: 4 }),
      ],
      [],
    );
    expect(s.fewerRedos.real_errors_per_session.n).toBe(1);
    expect(s.fewerRedos.real_errors_per_session.value).toBe(4);
  });

  test("时间窗过滤按 ts，不依赖文件 mtime", () => {
    const old = idx({ ts: NOW_SEC - 40 * 86400, e2e_p50: 99_000 });
    const recent = idx({ ts: NOW_SEC - 1 * 86400, e2e_p50: 10_000 });
    const s = snap([old, recent], [], { windowDays: 7 });
    expect(s.faster.e2e_p50.n).toBe(1);
    expect(s.faster.e2e_p50.value).toBe(10_000);
  });
});

// ─── 命中率口径收口：与 /cache 视图共用同一个聚合器 ───

describe("northstar · 缓存命中率口径（与 /cache 视图共用聚合器）", () => {
  /**
   * 这一组防的是本次修复的缺陷复发：命中率此前在本脚本里是一段裸循环
   * （`hitSum / inputSum`），三层清洗一个都没做，于是同一份 `usage-ledger.jsonl`
   * 在 `/cache` 里是 76.4%、在这份**进 release 曲线**的快照里是 68.2%。
   * 现在两边都调 `telemetry/cache-hit-aggregate.ts`。
   */

  test("重复会话行只算一次（账本里有 append 时代的残留）", () => {
    const s = snap(
      [],
      [
        led({ sessionId: "dup", promptTotal: 1_000, cacheHit: 100 }),
        led({ sessionId: "dup", promptTotal: 1_000, cacheHit: 900 }),
      ],
    );
    // latest-wins → 900/1000；漏了去重则 1000/2000 = 0.5
    expect(s.cheaper.cache_hit_rate.value).toBeCloseTo(0.9, 9);
    expect(s.cheaper.cache_hit_rate.value).not.toBeCloseTo(0.5, 2);
    expect(s.cacheHitCaliber.duplicateRows).toBe(1);
  });

  test("无 appVersion 的存量行排除出干净口径，且对照值仍可算", () => {
    const s = snap(
      [],
      [
        led({ sessionId: "new", promptTotal: 10_000, cacheHit: 8_000 }),
        led({ sessionId: "old", appVersion: undefined, promptTotal: 90_000, cacheHit: 9_000 }),
      ],
    );
    expect(s.cheaper.cache_hit_rate.value).toBeCloseTo(0.8, 9);
    expect(s.cacheHitCaliber.legacyRows).toBe(1);
    // 对照值必须在：只报"已排除 N 行"分不清"存量不脏"与"排除没接上"
    expect(s.cacheHitCaliber.hitRateIncludingLegacy).toBeCloseTo(17_000 / 100_000, 9);
    expect(s.cacheHitCaliber.legacyHitRate).toBeCloseTo(0.1, 9);
  });

  test("n 是干净口径的会话数，不是账本总行数（虚报 n 会绕过样本不足护栏）", () => {
    // 实测本机 378 行里 377 行是存量，干净口径只由 1 个会话支撑。
    // 报 n=378 会让一个 n=1 的数字在版本对比里被当成结论。
    const ledger = [
      led({ sessionId: "clean" }),
      ...Array.from({ length: 20 }, (_, i) => led({ sessionId: `old${i}`, appVersion: undefined })),
    ];
    const s = snap([], ledger);
    expect(s.cheaper.cache_hit_rate.n).toBe(1);
    expect(s.cheaper.cache_hit_rate.n).not.toBe(ledger.length);
  });

  test("source 串如实反映清洗口径（口径变了描述必须跟着变）", () => {
    const s = snap([], [led()]);
    const src = s.cheaper.cache_hit_rate.source;
    expect(src).toContain("usage-ledger.jsonl");
    expect(src).toContain("去重");
    expect(src).toContain("untrusted");
    expect(src).toContain("appVersion");
  });

  test("清洗账无条件渲染在命中率下面，排除量为 0 时也说", () => {
    const text = renderSnapshot(snap([], [led()]));
    expect(text).toContain("口径:");
    expect(text).toContain("对照:");
    expect(text).toContain("去重 0 行");
  });

  test("时间窗与版本过滤仍作用于命中率", () => {
    const ledger = [
      led({ sessionId: "recent", ts: NOW_SEC - 86400, promptTotal: 1_000, cacheHit: 900 }),
      led({ sessionId: "ancient", ts: NOW_SEC - 60 * 86400, promptTotal: 1_000, cacheHit: 100 }),
    ];
    expect(snap([], ledger, { windowDays: 7 }).cheaper.cache_hit_rate.value).toBeCloseTo(0.9, 9);
    expect(snap([], ledger).cheaper.cache_hit_rate.value).toBeCloseTo(0.5, 9);

    const versioned = [
      led({ sessionId: "a", appVersion: "0.1.600", promptTotal: 1_000, cacheHit: 100 }),
      led({ sessionId: "b", appVersion: "0.1.601", promptTotal: 1_000, cacheHit: 900 }),
    ];
    expect(
      snap([], versioned, { onlyVersion: "0.1.601" }).cheaper.cache_hit_rate.value,
    ).toBeCloseTo(0.9, 9);
    // 反向自证：过滤不存在的版本得到 null，而不是静默回落到全量
    const none = snap([], versioned, { onlyVersion: "9.9.9" });
    expect(none.cheaper.cache_hit_rate.value).toBeNull();
    expect(none.cheaper.cache_hit_rate.n).toBe(0);
  });

  test("全是存量行时命中率为 null，n=0，且自洽断言仍通过", () => {
    const s = snap(
      [],
      [
        led({ sessionId: "o1", appVersion: undefined }),
        led({ sessionId: "o2", appVersion: undefined }),
      ],
    );
    expect(s.cheaper.cache_hit_rate.value).toBeNull();
    expect(s.cheaper.cache_hit_rate.n).toBe(0);
    const a = s.assertions.find((x) => x.name.startsWith("缓存命中率的 n"));
    expect(a?.ok).toBe(true);
  });
});

// ─── P2-13：三个分母 + 一致性断言 ───

describe("P2-13 · 三个会话数分母与一致性断言", () => {
  test("输出头部固定打印三个分母及定义", () => {
    const text = renderSnapshot(snap([idx()], [led()]));
    for (const needle of [
      "active-sessions/",
      "trajectories/sessions",
      "usage-ledger.jsonl",
      "session-index.jsonl",
    ]) {
      expect(text).toContain(needle);
    }
    // 必须写明"互不一致是口径不同"，否则读者会当成 bug 去查
    expect(text).toContain("口径不同");
  });

  test("账本 >= 轨迹有效：正常场景通过", () => {
    const s = snap([idx()], [led()], {
      denominators: { ...DENOM, ledgerSessions: 377, trajValidSessions: 55 },
    });
    const a = s.assertions.find((x) => x.name.startsWith("账本会话数"));
    expect(a?.ok).toBe(true);
    expect(a?.detail).toContain("377");
  });

  test("【反向自证】账本 < 轨迹有效时断言必须变红", () => {
    // 只验"正常时全绿"测不出断言是否真的在判 —— 这一条才是门禁。
    const s = snap([idx()], [led()], {
      denominators: { ...DENOM, ledgerSessions: 5, trajValidSessions: 50 },
    });
    const a = s.assertions.find((x) => x.name.startsWith("账本会话数"));
    expect(a?.ok).toBe(false);
  });

  test("【反向自证】索引 < 轨迹有效时断言变红（索引不该受 LRU 影响）", () => {
    const s = snap([idx()], [led()], {
      denominators: { ...DENOM, indexSessions: 3, trajValidSessions: 50 },
    });
    const a = s.assertions.find((x) => x.name.startsWith("索引会话数"));
    expect(a?.ok).toBe(false);
  });

  test("【反向自证】e2e < ttft 时口径断言变红", () => {
    // 端到端必然 >= 首字节。违反说明两个口径基准点不一致（TTFT 曾因基准不重设虚高）。
    const s = snap([idx({ e2e_p50: 1000, ttft_p50: 5000 })], []);
    const a = s.assertions.find((x) => x.name.startsWith("端到端 p50"));
    expect(a?.ok).toBe(false);
  });

  test("数据源为空时不产出假 pass 断言（报 skip 比报 pass 诚实）", () => {
    const s = snap([], [], {
      denominators: {
        activeSessions: 0,
        trajValidSessions: 0,
        ledgerSessions: 0,
        indexSessions: 0,
      },
    });
    expect(s.assertions.length).toBe(0);
    expect(renderSnapshot(s)).toContain("无可判定的断言");
  });

  test("P2-14 轨迹损坏率可见", () => {
    const s = snap([idx({ traj_corrupt: true }), idx(), idx(), idx()], []);
    expect(s.foundation.traj_corrupt_rate.value).toBeCloseTo(0.25, 9);
    expect(renderSnapshot(s)).toContain("轨迹损坏率");
  });

  test("无版本标记的行数被报告出来（静默排除读起来像「数据全在这儿」）", () => {
    const s = snap([idx({ app_version: undefined }), idx()], []);
    expect(s.foundation.rows_without_version).toBe(1);
    expect(renderSnapshot(s)).toContain("无版本标记");
  });
});

// ─── 版本维度 ───

describe("northstar · 版本过滤（scope）", () => {
  test("【不可省】onlyVersion 真的过滤数据，不只是标签", () => {
    // 实测踩过：只做标签时连续两版的 delta 恒 +0.0%，读起来像"性能稳定"，
    // 真相是分组键失效 —— 正是本方案要消灭的那类假信号。
    const index = [
      idx({ app_version: "0.1.600", e2e_p50: 30_000 }),
      idx({ app_version: "0.1.601", e2e_p50: 10_000 }),
    ];
    const s = snap(index, [], { onlyVersion: "0.1.601", appVersion: "0.1.601" });
    expect(s.scope).toBe("version");
    expect(s.faster.e2e_p50.n).toBe(1);
    expect(s.faster.e2e_p50.value).toBe(10_000);
  });

  test("过滤不存在的版本得 n=0，不静默回落到全量", () => {
    const s = snap([idx({ app_version: "0.1.600" })], [led()], { onlyVersion: "9.9.9" });
    expect(s.faster.e2e_p50.n).toBe(0);
    expect(s.cheaper.cost_per_session.n).toBe(0);
  });

  test("未给 onlyVersion 时 scope=cumulative，且渲染明确写「不可用于版本对比」", () => {
    const s = snap([idx()], [led()]);
    expect(s.scope).toBe("cumulative");
    expect(renderSnapshot(s)).toContain("不可用于版本对比");
  });
});

// ─── 版本间对比 ───

describe("P1-5 · 版本间对比", () => {
  const before = snap(
    Array.from({ length: 30 }, () => idx({ e2e_p50: 40_000 })),
    Array.from({ length: 30 }, () => led()),
  );
  const after = snap(
    Array.from({ length: 30 }, () => idx({ e2e_p50: 20_000 })),
    Array.from({ length: 30 }, () => led()),
  );

  test("算出相对变化", () => {
    const d = compareSnapshots(before, after).find((x) => x.key === "更快 · 端到端 p50")!;
    expect(d.before).toBe(40_000);
    expect(d.after).toBe(20_000);
    expect(d.deltaRatio).toBeCloseTo(-0.5, 9);
    expect(d.underpowered).toBe(false);
  });

  test("【不可省】样本不足被标记（两个 n=3 之间能算出几十个百分点的假改善）", () => {
    const small = snap([idx({ e2e_p50: 20_000 })], []);
    const d = compareSnapshots(before, small).find((x) => x.key === "更快 · 端到端 p50")!;
    expect(d.nAfter).toBeLessThan(MIN_SAMPLES_FOR_CONCLUSION);
    expect(d.underpowered).toBe(true);
    expect(renderComparison("0.1.600", "0.1.601", [d])).toContain("样本不足");
  });

  test("任一侧缺值时 deltaRatio 为 null，不编一个百分比出来", () => {
    const empty = snap([], []);
    const d = compareSnapshots(empty, after).find((x) => x.key === "更快 · 端到端 p50")!;
    expect(d.deltaRatio).toBeNull();
  });

  test("四个方向都进了对比表（加指标忘了加对比是静默失效）", () => {
    const keys = compareSnapshots(before, after).map((d) => d.key);
    for (const dir of ["更快", "更省", "更少返工", "底座"]) {
      expect(keys.some((k) => k.startsWith(dir))).toBe(true);
    }
  });

  test("渲染带单位，不打印裸浮点（0.5577341458567137 这种没人能读）", () => {
    const text = renderComparison("0.1.600", "0.1.601", compareSnapshots(before, after));
    expect(text).toMatch(/\d+\.\d s|\$\d+\.\d{4}|\d+\.\d%/);
    expect(text).not.toMatch(/\d\.\d{10}/);
    // 只报告不阻断，必须写在输出里
    expect(text).toContain("只报告");
  });
});

// ─── latest-delta.md 与上一版查找 ───

describe("P1-5 · latest-delta.md", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "northstar-delta-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("【不可省】首次快照输出「无对比对象」而不是 0%", () => {
    // 报 0% 会被读成"本版与上版持平"，而真相是"上版不存在"—— 结论相反。
    const md = renderDeltaMarkdown(snap([idx()], [led()]), null);
    expect(md).toContain("无对比对象");
    expect(md).toContain("基线已建立");
    expect(md).not.toContain("+0.0%");
  });

  test("找上一版按语义化版本，不按 mtime", () => {
    writeFileSync(join(dir, "v0.1.599.json"), JSON.stringify(snap([idx()], [led()])));
    writeFileSync(join(dir, "v0.1.600.json"), JSON.stringify(snap([idx()], [led()])));
    // 后写的是更低版本 —— 按 mtime 排会把它当"上一版"
    writeFileSync(join(dir, "v0.1.598.json"), JSON.stringify(snap([idx()], [led()])));

    const prev = findPreviousSnapshot(dir, "0.1.601");
    expect(prev?.version).toBe("0.1.600");
  });

  test("严格早于当前版本：不会把自己认成上一版", () => {
    const prev = findPreviousSnapshot(dir, "0.1.600");
    expect(prev?.version).toBe("0.1.599");
  });

  test("目录不存在 / 文件损坏时返回 null 而不抛", () => {
    expect(findPreviousSnapshot(join(dir, "不存在"), "0.1.601")).toBeNull();
    const badDir = mkdtempSync(join(tmpdir(), "northstar-bad-"));
    writeFileSync(join(badDir, "v0.1.500.json"), "{ 这不是 json");
    expect(findPreviousSnapshot(badDir, "0.1.601")).toBeNull();
    rmSync(badDir, { recursive: true, force: true });
  });

  test("有上一版时输出逐指标表格 + 样本不足提示", () => {
    const prev = { version: "0.1.600", snapshot: snap([idx({ e2e_p50: 40_000 })], [led()]) };
    const md = renderDeltaMarkdown(snap([idx({ e2e_p50: 20_000 })], [led()]), prev);
    expect(md).toContain("与 v0.1.600 的对比");
    expect(md).toContain("| 指标 |");
    expect(md).toContain("样本不足");
    // P2-13 的三个分母也要在 delta 文件里
    expect(md).toContain("三个口径");
  });
});

// ─── P0-3：markdown 生成块与陈旧检测 ───

describe("P0-3 · 生成块与陈旧检测", () => {
  const md = renderMarkdown(snap([idx()], [led()]));

  test("生成块带定界标记、生成时间与样本量", () => {
    expect(md).toContain(MARKDOWN_BEGIN);
    expect(md).toContain(MARKDOWN_END);
    expect(md).toContain("生成于");
    expect(md).toContain("勿手改");
    expect(md).toContain("| 方向 | 主指标 | 当前值 | 样本 n | 数据源 |");
  });

  test("29 天不拦、31 天拦（边界双向，只测一侧会漏掉写反）", () => {
    const d29 = new Date(NOW.getTime() + 29 * 86400_000);
    const d31 = new Date(NOW.getTime() + 31 * 86400_000);
    expect(checkStaleness(md, 30, d29).stale).toBe(false);
    expect(checkStaleness(md, 30, d31).stale).toBe(true);
  });

  test("找不到生成块时不拦（否则会在无关文件上误报，人会直接卸掉 hook）", () => {
    const r = checkStaleness("一份普通文档，没有生成块", 30, NOW);
    expect(r.found).toBe(false);
    expect(r.stale).toBe(false);
  });

  test("块在但时间戳读不出 → 判陈旧（fail-closed，防手改绕过门禁）", () => {
    const tampered = `${MARKDOWN_BEGIN} 由脚本生成，勿手改 -->\n表格\n${MARKDOWN_END}`;
    const r = checkStaleness(tampered, 30, NOW);
    expect(r.found).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.message).toContain("手改");
  });

  test("时间戳非法 → 同样 fail-closed", () => {
    const bad = `${MARKDOWN_BEGIN} 生成于 昨天（v0.1.600），勿手改 -->\n${MARKDOWN_END}`;
    expect(checkStaleness(bad, 30, NOW).stale).toBe(true);
  });

  test("陈旧提示里给出刷新命令（否则用户只知道错了，不知道该做什么）", () => {
    const d31 = new Date(NOW.getTime() + 31 * 86400_000);
    expect(checkStaleness(md, 30, d31).message).toContain("--emit-markdown");
  });
});

// ─── self-test 自身 ───

describe("northstar · self-test", () => {
  test("selfTest() 在当前实现下无失败项", () => {
    expect(selfTest()).toEqual([]);
  });

  test("self-test 覆盖反向自证（否则它只是一份「正常路径全绿」的假保证）", () => {
    // 读源码确认 self-test 里真的构造了违反场景。这是元断言：
    // 防的是有人把 self-test 里的反向用例删掉，只留正向 —— 那样 CI 依然全绿。
    const src = readFileSync(SCRIPT_PATH, "utf-8");
    const selfTestBody = src.slice(src.indexOf("export function selfTest"));
    expect(selfTestBody).toContain("反向自证");
    expect(selfTestBody).toContain("ledgerSessions: 5");
  });
});

// ─── flag 双向对账（照 trace-digest-flags 的既有模式）───

/**
 * 从脚本源码抽出真实被消费的 flag。
 *
 * 刻意切掉 `KNOWN_FLAGS` 声明块再扫，否则两个事实源塌缩成一个，
 * 对账变成自己跟自己比（永远绿）。
 */
function extractConsumedFlags(source: string): Set<string> {
  const declStart = source.indexOf("KNOWN_FLAGS = new Set([");
  let body = source;
  if (declStart >= 0) {
    const declEnd = source.indexOf("]);", declStart);
    body = source.slice(0, declStart) + source.slice(declEnd >= 0 ? declEnd + 3 : declStart);
  }
  const found = new Set<string>();
  for (const re of [
    /flags\.has\(\s*"(--[a-z-]+)"\s*\)/g,
    /args\.indexOf\(\s*"(--[a-z-]+)"\s*\)/g,
    /argOf\(\s*args,\s*"(--[a-z-]+)"\s*\)/g,
  ]) {
    for (const m of body.matchAll(re)) found.add(m[1]!);
  }
  return found;
}

describe("northstar · flag 双向对账", () => {
  const source = readFileSync(SCRIPT_PATH, "utf-8");
  const consumed = extractConsumedFlags(source);

  test("提取器自身有效（正则失效会导致空对空的假绿）", () => {
    expect(consumed.size).toBeGreaterThanOrEqual(6);
    expect(consumed.has("--self-test")).toBe(true);
  });

  test("① 消费的每个 flag 都在 KNOWN_FLAGS 里（防漏登记 → 被兜底拒掉）", () => {
    expect([...consumed].filter((f) => !KNOWN_FLAGS.has(f))).toEqual([]);
  });

  test("② KNOWN_FLAGS 里每个 flag 都被真的消费（防登记了却没实现，即 --health 那个形态）", () => {
    expect([...KNOWN_FLAGS].filter((f) => !consumed.has(f))).toEqual([]);
  });
});

// ─── 端到端（真起子进程）───

/**
 * 静态扫描证明不了"兜底真的接线了"。这一节必须起真进程。
 *
 * ⚠ 落盘隔离：脚本会读 `~/.sid-code/`。子进程**不继承**进程内 env 改动，
 * 必须显式传 `SID_CONFIG_DIR` 指向 tmpdir —— 否则测试去读用户真实数据，
 * 本机有没有轨迹会让断言时绿时红。
 */
describe("northstar · 端到端 CLI", () => {
  let tempHome: string;
  let outDir: string;

  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sid-northstar-home-"));
    outDir = join(tempHome, "northstar");
    mkdirSync(outDir, { recursive: true });
  });
  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function run(args: string[]): { code: number; stdout: string; stderr: string } {
    const p = spawnSync("bun", ["run", SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, SID_CONFIG_DIR: tempHome },
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
  }

  test("--self-test 零退出（这是 CI 唯一该跑的模式）", () => {
    const r = run(["--self-test"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("self-test 通过");
    // 必须点明"未读真实用量"—— CI 里聚合真实数据会产出 n=0 的假快照
    expect(r.stdout).toContain("未读真实用量");
  });

  test("未识别 flag 报错且非零退出，不静默降级", () => {
    const r = run(["--emit-markdow"]); // 少个 n，最常见的真实场景
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("未识别参数");
    expect(r.stderr).toContain("--emit-markdown"); // 告警要列出可用参数
    expect(r.stdout).toBe("");
  });

  test("--emit 写出 v<version>.json + latest-delta.md", () => {
    const r = run(["--version", "0.1.600", "--emit", outDir]);
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(join(outDir, "v0.1.600.json"), "utf-8")) as NorthstarSnapshot;
    expect(j.appVersion).toBe("0.1.600");
    expect(j.scope).toBe("version"); // --version 必须真过滤
    expect(j.generatedAt.length).toBeGreaterThan(0);
    // 每个主指标都带 n（§五.4 验收）
    expect(typeof j.faster.e2e_p50.n).toBe("number");
    expect(readFileSync(join(outDir, "latest-delta.md"), "utf-8")).toContain("基线已建立");
  });

  test("第二次 --emit 能算出与上一版的 diff（不再是「无对比对象」）", () => {
    const r = run(["--version", "0.1.601", "--emit", outDir]);
    expect(r.code).toBe(0);
    const md = readFileSync(join(outDir, "latest-delta.md"), "utf-8");
    expect(md).toContain("与 v0.1.600 的对比");
    expect(md).not.toContain("基线已建立");
  });

  test("--emit-markdown 输出生成块（含时间戳）", () => {
    const r = run(["--emit-markdown"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(MARKDOWN_BEGIN);
    expect(r.stdout).toContain("生成于");
  });

  test("--check-staleness：新鲜块零退出、陈旧块非零退出", () => {
    const fresh = join(tempHome, "fresh.md");
    writeFileSync(fresh, renderMarkdown(snap([idx()], [led()], { now: new Date() })));
    expect(run(["--check-staleness", "30", fresh]).code).toBe(0);

    const stale = join(tempHome, "stale.md");
    writeFileSync(
      stale,
      renderMarkdown(snap([idx()], [led()], { now: new Date(Date.now() - 60 * 86400_000) })),
    );
    const r = run(["--check-staleness", "30", stale]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("未更新");
  });

  test("--check-staleness 文件不存在时不拦（门禁职责是拦陈旧，不是强制到处都有块）", () => {
    expect(run(["--check-staleness", "30", join(tempHome, "无此文件.md")]).code).toBe(0);
  });

  test("--check-staleness 非法天数报错，不静默用默认值", () => {
    const r = run(["--check-staleness", "三十天"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("正数天数");
  });

  test("空数据环境下正常输出而不是崩溃（新机器 / CI runner 的形态）", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("北极星指标快照");
    expect(r.stdout).toContain("无可判定的断言");
  });

  test("--weekly 明确标注为「人工触发」而不是全自动", () => {
    // 把它写成"已自动化"就是 P0-3 要防的那类漂移，而且写在最容易被引用的地方。
    const r = run(["--weekly"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("非全自动");
  });
});

// ─── 接线门禁：release.sh / workflow / pre-push ───

describe("northstar · 接线门禁", () => {
  test("release.sh 调了快照脚本，且用 || warn 不阻断发版", () => {
    // 禁令之二：快照是观测产物，不该让它写不下去而中止一次已构建+冒烟全过的发布。
    const sh = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf-8");
    expect(sh).toContain("northstar-snapshot.ts");
    expect(sh).toContain("--emit");
    expect(sh).toMatch(/warn "北极星快照生成失败/);
  });

  test("release.sh 里的快照步骤不含任何 LLM 调用（发布路径必须确定性+离线+幂等）", () => {
    const sh = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf-8");
    const start = sh.indexOf("北极星指标快照");
    const end = sh.indexOf("─── 上传", start);
    const block = sh.slice(start, end);
    for (const forbidden of ["changelog:curate", "anthropic", "openai", "deepseek"]) {
      expect(block.toLowerCase()).not.toContain(forbidden);
    }
  });

  test("【不可省】weekly workflow 不依赖任何 secret（防又造一个稳定失败堆红叉的 workflow）", () => {
    const yml = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "northstar-weekly.yml"),
      "utf-8",
    );
    // 这是 §五.4 那条"无 secret 的 fork 环境下绿色通过"的静态保证
    expect(yml).not.toContain("secrets.");
    expect(yml).toContain("--self-test");
    // cron 刻意避开 :00 / :30
    const cron = yml.match(/cron:\s*"(\d+)\s/);
    expect(cron).not.toBeNull();
    expect(["0", "30"]).not.toContain(cron![1]);
  });

  test("eval-weekly.yml 有 secret 前置检查，且 cron 仍保持停用", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github", "workflows", "eval-weekly.yml"), "utf-8");
    expect(yml).toContain("前置检查");
    expect(yml).toContain("::error::缺少 secret");
    // 恢复 cron 是一次需要人确认的独立动作，不该由改注释的 PR 顺手打开
    expect(yml).toMatch(/#\s*schedule:/);
  });

  test("pre-push 挂了陈旧检测，阈值 30 天", () => {
    const sh = readFileSync(join(REPO_ROOT, "scripts", "git-hooks", "pre-push.sh"), "utf-8");
    expect(sh).toContain("--check-staleness 30");
    // 必须点破跨仓库门禁管不到 docs-research/ —— 这是无法机制化的那部分
    expect(sh).toContain("docs-research");
  });
});
