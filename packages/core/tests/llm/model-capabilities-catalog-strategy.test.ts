/**
 * D1 §5.1 第 2/3 项 —— miss 触发刷新 + 条件请求单测。
 *
 * 两条能力此前都不存在：目录同步纯 TTL（1 天），新模型上线后最坏要等一天才被我们知道；
 * 且每轮 TTL 到期都要重新拉全量正文，即使上游没有变化。
 *
 * 全部不触网：`fetch` 替换成内联假实现，验证的是**调用节奏**（防抖 / 退避 / 是否带
 * validator），不是真实网络行为。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  lookupCapability,
  syncExternalCatalogs,
  __resetCapabilityCacheForTest,
  __resetMissRefreshStateForTest,
  __enablePersistForTest,
  __persistForTest,
} from "@sid-code/core/llm/model-capabilities.ts";

let origFetch: typeof globalThis.fetch;
let tmpDir: string;
let prevConfigDir: string | undefined;

// ⚠ 落盘隔离：本文件多个用例要真正打开 persist()（验证「触发了刷新」就是验证「真的
// 发起了写盘请求」），必须把 SID_CONFIG_DIR 指到临时目录，否则会碰用户真实缓存文件
// （见 model-capabilities-concurrent-write.test.ts 头部同款注释与事故记录）。
beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "model-cap-strategy-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetCapabilityCacheForTest({});
  __resetMissRefreshStateForTest();
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  __resetCapabilityCacheForTest({}); // 重新置位 persistDisabled，避免泄漏到同批其它文件
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 一个总是返回非空目录正文的假 fetch，记录每次调用的 URL 与请求头。 */
function fakeFetchAlwaysFresh(calls: Array<{ url: string; headers: Record<string, string> }>) {
  return (async (url: any, init: any) => {
    const headers: Record<string, string> = {};
    const h = init?.headers ?? {};
    for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    calls.push({ url: String(url), headers });
    // litellm/openrouter 形态都能被各自 parse 接受空对象（产出 0 条），
    // 这里只关心调用节奏，不关心投票结果。
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
}

describe("miss 触发刷新 — 异步 + 防抖 + 尊重失败退避", () => {
  test("查询未知模型会触发一次后台刷新（异步，不阻塞本次查询）", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = fakeFetchAlwaysFresh(calls);
    // 生产路径 persistDisabled 恒为 false；单测默认置位是为了防止其它用例的海量未知模型名
    // 意外触网，本用例就是要验证触发本身，显式解锁（写盘目标已在 beforeEach 指到临时目录）。
    __enablePersistForTest();

    const result = lookupCapability("brand-new-unknown-model");
    expect(result).toBeNull(); // 本次查询仍是同步 miss，不等刷新结果

    // 让后台的 fire-and-forget 刷新跑完一轮微任务。
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBeGreaterThan(0); // 确实发起了目录同步请求
  });

  test("防抖：10 分钟内重复 miss 查询只触发一次刷新", async () => {
    __enablePersistForTest();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = fakeFetchAlwaysFresh(calls);

    lookupCapability("unknown-a");
    await new Promise((r) => setTimeout(r, 20));
    const firstRoundCalls = calls.length;
    expect(firstRoundCalls).toBeGreaterThan(0);

    // 同一防抖窗口内再查另一个未知模型，不应叠加新一轮请求。
    lookupCapability("unknown-b");
    lookupCapability("unknown-c");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(firstRoundCalls);
  });

  test("命中缓存不触发刷新", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = fakeFetchAlwaysFresh(calls);
    __resetCapabilityCacheForTest({ "known-model": { contextWindow: 128_000 } });
    __resetMissRefreshStateForTest();
    __enablePersistForTest();

    lookupCapability("known-model");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
  });

  test("连续失败退避期内，miss 也不触发刷新（防止把失败源当成 DDoS 靶子反复打）", async () => {
    __enablePersistForTest({ syncedAt: Date.now(), failCount: 3 });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = fakeFetchAlwaysFresh(calls);

    lookupCapability("unknown-during-backoff");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
  });
});

// OpenRouter 形态：`data: [...]`，parseOpenRouter 唯一能从空壳里产出非空条目的形态最简单，
// 供下面几条「必须解析出正文」的用例复用。
const NONEMPTY_BODY = JSON.stringify({
  data: [{ id: "probe-model", context_length: 128_000 }],
});

describe("条件请求 — 只在本地确实有正文时才带 validator", () => {
  test("首次同步（本地无正文）不带 If-None-Match / If-Modified-Since", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = fakeFetchAlwaysFresh(calls);

    await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.headers["if-none-match"]).toBeUndefined();
      expect(c.headers["if-modified-since"]).toBeUndefined();
    }
  });

  test("上一轮拿到 etag 且解析出正文 → 下一轮带 If-None-Match", async () => {
    globalThis.fetch = (async () =>
      new Response(NONEMPTY_BODY, {
        status: 200,
        headers: { "content-type": "application/json", etag: '"v1"' },
      })) as any;

    const first = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(first.sources.length).toBeGreaterThan(0);

    const secondCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {}))
        headers[k.toLowerCase()] = String(v);
      secondCalls.push({ url: String(url), headers });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    await syncExternalCatalogs({ timeoutMs: 5000 });
    // ⚠ NONEMPTY_BODY 是 OpenRouter 的 `{data:[...]}` 形态 —— litellm/models-dev 的 parse
    // 认不出这个结构，只会解析出 0 条，所以只有 openrouter 源该带上 If-None-Match。
    // 逐源断言而非笼统「全部都有」，正是为了锁住「解析为空的源不该有 validator」这条边界。
    const openrouterCall = secondCalls.find((c) => c.url.includes("openrouter.ai"));
    expect(openrouterCall).toBeDefined();
    expect(openrouterCall!.headers["if-none-match"]).toBe('"v1"');
    for (const c of secondCalls) {
      if (c.url.includes("openrouter.ai")) continue;
      expect(c.headers["if-none-match"]).toBeUndefined();
    }
  });

  test("304 视为成功（不记退避），且不清空已有缓存", async () => {
    __resetCapabilityCacheForTest({ "kept-model": { contextWindow: 999_999, source: "catalog" } });
    __enablePersistForTest({
      syncedAt: Date.now() - 1000,
      failCount: 0,
    });

    globalThis.fetch = (async () => new Response(null, { status: 304 })) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.failed.length).toBe(0); // 304 不是失败
    expect(lookupCapability("kept-model")?.contextWindow).toBe(999_999); // 缓存原样保留
  });

  test("解析为空（0 条）时不留存 validator，防止下一轮误用 304 换出空覆盖层", async () => {
    // 第一轮：返回 200 + etag，但正文解析不出任何模型 → 不该记 validator。
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", etag: '"empty"' },
      })) as any;
    await syncExternalCatalogs({ timeoutMs: 5000 });

    const secondCalls: Array<{ headers: Record<string, string> }> = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {}))
        headers[k.toLowerCase()] = String(v);
      secondCalls.push({ headers });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    await syncExternalCatalogs({ timeoutMs: 5000 });
    for (const c of secondCalls) {
      expect(c.headers["if-none-match"]).toBeUndefined();
    }
  });
});
