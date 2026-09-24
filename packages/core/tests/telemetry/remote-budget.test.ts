/**
 * M5 PR-5.2：远程预算加载 + 双计窗口估计。
 *
 * 隔离：SID_CONFIG_DIR 指 tmpdir。fetch 一律 mock。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  __resetRemoteBudgetForTest,
  __setLastPushedUsageForTest,
  __setLastRemoteBudgetForTest,
  checkLoadedRemoteBudget,
  checkRemoteBudget,
  estimateRemoteBudgetUsed,
  formatRemoteBudgetWarning,
  loadRemoteBudget,
  sanitizeRemoteBudget,
  type RemoteBudget,
} from "@sid-code/core/telemetry/remote-budget.ts";
import { __resetUsageLedgerRemoteForTest } from "@sid-code/core/telemetry/usage-ledger-remote.ts";
import { __resetIdentityForTest, saveDeviceCredential } from "@sid-code/core/identity/index.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";

const realFetch = globalThis.fetch;

const sample: RemoteBudget = {
  source: "remote",
  scope_type: "org",
  scope_id: "acme",
  period: "monthly",
  period_key: "2026-09",
  limit_usd: 500,
  used_usd: 127.35,
  enforcement: "alert",
  updated_at: "2026-09-23T10:00:00Z",
};

describe("sanitizeRemoteBudget", () => {
  test("剥自举字段，强制 source=remote", () => {
    const s = sanitizeRemoteBudget({
      source: "local",
      budgetEndpoint: "http://evil",
      limit_usd: 10,
      used_usd: 1,
      enforcement: "block",
      period: "monthly",
      period_key: "2026-09",
      scope_type: "org",
      scope_id: "x",
    });
    expect(s).not.toBeNull();
    expect(s!.source).toBe("remote");
    expect((s as any).budgetEndpoint).toBeUndefined();
    expect(s!.enforcement).toBe("block");
  });

  test("不认识的 enforcement 当 alert（不硬停）", () => {
    const s = sanitizeRemoteBudget({
      limit_usd: 10,
      used_usd: 1,
      enforcement: "downgrade",
    });
    expect(s!.enforcement).toBe("alert");
  });

  test("缺 limit/used 返回 null", () => {
    expect(sanitizeRemoteBudget({ enforcement: "alert" })).toBeNull();
  });
});

describe("双计窗口估计", () => {
  test("本会话尚未 upsert：estimated = used + current", () => {
    expect(
      estimateRemoteBudgetUsed({
        usedUsd: 100,
        currentCostUsd: 5,
        currentSessionId: "s1",
      }),
    ).toBe(105);
  });

  test("本会话已 upsert：减去 lastPushed 再加当前，避免双计", () => {
    expect(
      estimateRemoteBudgetUsed({
        usedUsd: 105,
        currentCostUsd: 8,
        currentSessionId: "s1",
        lastPushedSessionId: "s1",
        lastPushedCostUsd: 5,
      }),
    ).toBe(108);
  });

  test("减出来为负则当 0", () => {
    expect(
      estimateRemoteBudgetUsed({
        usedUsd: 1,
        currentCostUsd: 0,
        currentSessionId: "s1",
        lastPushedSessionId: "s1",
        lastPushedCostUsd: 9,
      }),
    ).toBe(0);
  });

  test("别的会话的 lastPushed 不减", () => {
    expect(
      estimateRemoteBudgetUsed({
        usedUsd: 100,
        currentCostUsd: 5,
        currentSessionId: "s2",
        lastPushedSessionId: "s1",
        lastPushedCostUsd: 50,
      }),
    ).toBe(105);
  });

  test("本会话已 upsert 后再超限：block 才 exceeded", () => {
    const budget: RemoteBudget = { ...sample, used_usd: 498, limit_usd: 500, enforcement: "block" };
    // SUM 已含本会话 4；当前会话涨到 7 → estimated = 498 - 4 + 7 = 501
    const check = checkRemoteBudget({
      budget,
      currentCostUsd: 7,
      currentSessionId: "s1",
      lastPushedSessionId: "s1",
      lastPushedCostUsd: 4,
    });
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.estimated).toBeCloseTo(501, 10);
    expect(check.exceeded).toBe(true);
    expect(check.enforcement).toBe("block");
  });

  test("若错误地 used+current 会提前硬停；修正后未超", () => {
    const budget: RemoteBudget = { ...sample, used_usd: 498, limit_usd: 500, enforcement: "block" };
    const naive = 498 + 4;
    expect(naive).toBeGreaterThan(500);
    const check = checkRemoteBudget({
      budget,
      currentCostUsd: 4,
      currentSessionId: "s1",
      lastPushedSessionId: "s1",
      lastPushedCostUsd: 4,
    });
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.estimated).toBeCloseTo(498, 10);
    expect(check.exceeded).toBe(false);
  });
});

describe("RemoteBudgetLoader HTTP", () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let prevEndpoint: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    prevEndpoint = process.env.SID_CODE_BUDGET_ENDPOINT;
    dir = mkdtempSync(join(tmpdir(), "sid-budget-"));
    process.env.SID_CONFIG_DIR = dir;
    delete process.env.SID_CODE_BUDGET_ENDPOINT;
    assertIsolated();
    __resetIdentityForTest();
    __resetUsageLedgerRemoteForTest();
    __resetRemoteBudgetForTest();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetIdentityForTest();
    __resetUsageLedgerRemoteForTest();
    __resetRemoteBudgetForTest();
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    if (prevEndpoint === undefined) delete process.env.SID_CODE_BUDGET_ENDPOINT;
    else process.env.SID_CODE_BUDGET_ENDPOINT = prevEndpoint;
    rmSync(dir, { recursive: true, force: true });
  });

  test("不配 endpoint：零 fetch", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Response("{}", { status: 200 });
    }) as any;
    expect(await loadRemoteBudget()).toBeNull();
    expect(n).toBe(0);
  });

  test("明文非本地：零 fetch，fail-open", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "http://corp.example.com/api/v1/ctl/budget";
    saveDeviceCredential({ credential: "tok" });
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Response("{}", { status: 200 });
    }) as any;
    expect(await loadRemoteBudget()).toBeNull();
    expect(n).toBe(0);
  });

  test("无凭据：零 fetch，fail-open", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://example.com/api/v1/ctl/budget";
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Response("{}", { status: 200 });
    }) as any;
    expect(await loadRemoteBudget()).toBeNull();
    expect(n).toBe(0);
  });

  test("200 写入 budget-cache.json", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://example.com/api/v1/ctl/budget";
    saveDeviceCredential({ credential: "tok" });
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(sample), {
        status: 200,
        headers: { ETag: '"g1"' },
      });
    }) as any;
    const b = await loadRemoteBudget();
    expect(b?.limit_usd).toBe(500);
    expect(b?.used_usd).toBeCloseTo(127.35, 10);
    expect(existsSync(sidPaths.budgetCache())).toBe(true);
    const disk = JSON.parse(readFileSync(sidPaths.budgetCache(), "utf-8"));
    expect(disk.last_status).toBe(200);
    expect(disk.budget.limit_usd).toBe(500);
  });

  test("401 fail-open 当没配", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://example.com/api/v1/ctl/budget";
    saveDeviceCredential({ credential: "tok" });
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as any;
    expect(await loadRemoteBudget()).toBeNull();
  });

  test("5xx fail-open", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://example.com/api/v1/ctl/budget";
    saveDeviceCredential({ credential: "tok" });
    globalThis.fetch = (async () => new Response("err", { status: 503 })) as any;
    expect(await loadRemoteBudget()).toBeNull();
  });

  test("204 负缓存", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://example.com/api/v1/ctl/budget";
    saveDeviceCredential({ credential: "tok" });
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as any;
    expect(await loadRemoteBudget()).toBeNull();
    const disk = JSON.parse(readFileSync(sidPaths.budgetCache(), "utf-8"));
    expect(disk.last_status).toBe(204);
    expect(disk.budget).toBeUndefined();
  });

  test("304 用缓存 used_usd", async () => {
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://example.com/api/v1/ctl/budget";
    saveDeviceCredential({ credential: "tok" });
    writeFileSync(
      sidPaths.budgetCache(),
      JSON.stringify({
        etag: '"g1"',
        fetched_at: new Date().toISOString(),
        endpoint: process.env.SID_CODE_BUDGET_ENDPOINT,
        last_status: 200,
        budget: sample,
      }),
    );
    globalThis.fetch = (async () =>
      new Response(null, { status: 304, headers: { ETag: '"g1"' } })) as any;
    const b = await loadRemoteBudget();
    expect(b?.used_usd).toBeCloseTo(127.35, 10);
  });
});

describe("checkLoadedRemoteBudget + 文案", () => {
  beforeEach(() => {
    __resetRemoteBudgetForTest();
  });
  afterEach(() => {
    __resetRemoteBudgetForTest();
  });

  test("alert 超限文案不含自动停止", () => {
    __setLastRemoteBudgetForTest({ ...sample, used_usd: 500, enforcement: "alert" });
    const check = checkLoadedRemoteBudget("s1", 1);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.exceeded).toBe(true);
    expect(formatRemoteBudgetWarning(check)).toContain("告警放行");
    expect(formatRemoteBudgetWarning(check)).not.toContain("自动停止");
  });

  test("block 超限文案含自动停止", () => {
    __setLastRemoteBudgetForTest({ ...sample, used_usd: 500, enforcement: "block" });
    __setLastPushedUsageForTest("s1", 500);
    const check = checkLoadedRemoteBudget("s1", 500);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(formatRemoteBudgetWarning(check)).toContain("自动停止");
  });

  test("不足半分的限额显示四位，不写成 $0.00（验收 B3 的 $0.001）", () => {
    // 验收文案是 `$0.0055 / $0.00`。限额 $0.001 经 toFixed(2) 就是 0.00；
    // 已用量保持四位。这是展示问题，不是比较问题。
    __setLastRemoteBudgetForTest({
      ...sample,
      limit_usd: 0.001,
      used_usd: 0.0055,
      enforcement: "block",
    });
    const check = checkLoadedRemoteBudget("other-session", 0);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    const text = formatRemoteBudgetWarning(check);
    expect(text).toContain("$0.0055 / $0.0010");
    // 限额金额本身不能是 $0.00。不能对整句断言 not.toContain("$0.00")：
    // 已用量 $0.0055 的前缀就是 $0.00；也不能 startsWith，因为 "$0.0010"
    // 同样以 "$0.00" 开头。
    const limitShown = text.split(" / ")[1]?.match(/\$[0-9.]+/)?.[0];
    expect(limitShown).toBe("$0.0010");
  });

  test("float32 读回的 0.01 仍显示 $0.01（toFixed(2) 会把它四舍五入回去）", () => {
    // 验收把 `$0.00` 归因到 float4 漂移。实测这个漂移值 toFixed(2) 是 "0.01"，
    // 不是 "0.00"。锁住这个事实，避免下次再为它改列类型。
    const drifted = new Float32Array([0.01])[0];
    expect(drifted).toBeLessThan(0.01);
    __setLastRemoteBudgetForTest({
      ...sample,
      limit_usd: drifted,
      used_usd: 0.0055,
      enforcement: "block",
    });
    const check = checkLoadedRemoteBudget("other-session", 0);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    const text = formatRemoteBudgetWarning(check);
    expect(text.split(" / ")[1]?.match(/\$[0-9.]+/)?.[0]).toBe("$0.01");
  });

  test("整额限额仍是两位（不把 $500 显示成四位）", () => {
    __setLastRemoteBudgetForTest({
      ...sample,
      limit_usd: 500,
      used_usd: 100,
      enforcement: "alert",
    });
    const check = checkLoadedRemoteBudget("other-session", 0);
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(formatRemoteBudgetWarning(check)).toContain("/ $500.00");
  });
});

describe("生产接线（防死加载器）", () => {
  // ⚠ 这三条断言刻意匹配**调用形态**（含 `(`），不是裸标识符 includes。
  // 变异自证时发现 `src.includes("loadEnterpriseBudgetOnce")` 在把调用改名成
  // `loadEnterpriseBudgetOnceXXX` 之后**仍然绿**（子串命中）—— 那是个假门禁。
  test("loop.ts 在本地配额之后调用 checkLoadedRemoteBudget", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf-8");
    expect(/\bcheckLoadedRemoteBudget\(/.test(src)).toBe(true);
    expect(/\bformatRemoteBudgetWarning\(/.test(src)).toBe(true);
    // 顺序：远程预算段必须在本地 BudgetTracker / QuotaManager 之后，
    // 否则远程会抢在本地硬停之前改变行为（R5）。
    const budgetIdx = src.indexOf("预算追踪器检查");
    const quotaIdx = src.indexOf("成本配额检查");
    const remoteIdx = src.indexOf("远程预算检查");
    expect(budgetIdx).toBeGreaterThan(0);
    expect(quotaIdx).toBeGreaterThan(budgetIdx);
    expect(remoteIdx).toBeGreaterThan(quotaIdx);
    // block 才 terminal + done；alert 只 warning（R5）。
    const seg = src.slice(remoteIdx, remoteIdx + 1500);
    expect(seg).toContain('enforcement === "block"');
    expect(seg).toContain("terminal: true");
  });

  test("三条硬停路径都在 done 上声明 budgetExceeded（F1 归因，防再掉进 user_interrupt）", () => {
    // 断言的是**字段赋值**而不是标识符出现：只写注释、不写字段，这条必须红。
    const src = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf-8");
    const declared = src.match(/budgetExceeded: \{ source: "(budget_rule|quota|remote)" \}/g) ?? [];
    expect(declared.sort()).toEqual([
      'budgetExceeded: { source: "budget_rule" }',
      'budgetExceeded: { source: "quota" }',
      'budgetExceeded: { source: "remote" }',
    ]);
    // 上报口必须在 engine 里、且在 done 返回之前读这个字段。
    // 漏了这一接，loop 声明了也到不了 collector，exit_status 照旧是 user_interrupt。
    const engine = readFileSync(join(import.meta.dir, "../../src/query/engine.ts"), "utf-8");
    expect(/event\.budgetExceeded/.test(engine)).toBe(true);
    // `?.` 可选调用也算接上：traceCollector 本身是可选依赖，写成 `.` 反而编不过。
    expect(/\brecordBudgetExceeded\?\.\(/.test(engine)).toBe(true);
  });

  test("cli.ts 启动路径调 loadEnterpriseBudgetOnce()", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/cli.ts"), "utf-8");
    expect(/\bawait loadEnterpriseBudgetOnce\(\)/.test(src)).toBe(true);
  });

  test("init-helpers.ts 同时接账本重放与预算加载", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/init-helpers.ts"), "utf-8");
    expect(/\bstartUsageLedgerRemoteRecovery\(\)/.test(src)).toBe(true);
    expect(/\bawait loadEnterpriseBudgetOnce\(\)/.test(src)).toBe(true);
  });
});
