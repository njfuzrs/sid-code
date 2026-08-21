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
  __getCapabilityCacheForTest,
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

// ─────────────────────────────────────────────────────────────
// D8 响应体字节上限（CATALOG_BODY_MAX_BYTES / readBodyCapped）
// ─────────────────────────────────────────────────────────────

/** 生产常量的镜像值。刻意不 export 生产常量：测试要能独立于实现声明它期望的门在哪。 */
const CAP_BYTES = 32 * 1024 * 1024;

/** models.dev 形态的最小合法目录（parseModelsDev 能从它产出 1 条）。 */
function modelsDevBody(modelId: string, context: number): string {
  return JSON.stringify({
    probeprov: { models: { [modelId]: { limit: { context, output: 8192 } } } },
  });
}

/**
 * 造一个「声称 N 字节、实际只有几十字节」的响应 —— 用来单独验证 content-length 预筛那一支。
 *
 * ⚠ 实际正文是**能正常解析的合法目录**，这是刻意的：如果预筛没起作用，流式读会顺利读完
 * 并解析成功、条目进缓存。于是「条目不在缓存里」这个断言就唯一地归因到预筛，
 * 而不是「反正正文是坏的，两条路径都会失败」那种两义性结果。
 */
function lyingContentLengthResponse(declared: number, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(declared),
    },
  });
}

/**
 * 造一个分多 chunk 的流式响应，并记录被拉取的 chunk 数与 cancel() 是否被调用。
 *
 * ⚠ **不真的分配 totalChunks × chunkBytes 字节**：同一个 Uint8Array 实例反复 enqueue，
 * 所以「40MiB 的流」实际常驻内存只有 1 个 chunk（实测 rss 增量 2.3MiB）。
 * 我们要验证的是**计数与中断行为**，不是运行时能不能扛住 40MiB。
 */
function chunkedStreamResponse(opts: {
  chunkBytes: number;
  totalChunks: number;
  headers?: Record<string, string>;
}): { resp: Response; stats: { pulled: number; cancelled: boolean } } {
  const stats = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(opts.chunkBytes); // 复用同一实例，见上方注释
  const stream = new ReadableStream({
    pull(c) {
      if (stats.pulled >= opts.totalChunks) {
        c.close();
        return;
      }
      stats.pulled++;
      c.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return {
    resp: new Response(stream, { status: 200, headers: opts.headers ?? {} }),
    stats,
  };
}

describe("D8 响应体字节上限 —— 超限即丢弃该源，且不抛异常阻塞启动", () => {
  test("content-length 声明超过上限 → 该源被丢弃，旧缓存条目仍在，且不抛异常", async () => {
    // 旧缓存：超限那一轮必须原样保住它（上游记 failed + 保留旧缓存，不清空）。
    __resetCapabilityCacheForTest({
      "kept-across-oversize": { contextWindow: 777_777, source: "catalog" },
    });
    __resetMissRefreshStateForTest();

    globalThis.fetch = (async () =>
      // 声明 2 倍上限，实际正文是合法且能解析出 oversize-declared-model 的目录。
      lyingContentLengthResponse(
        CAP_BYTES * 2,
        modelsDevBody("oversize-declared-model", 262_144),
      )) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });

    // ① 全部 4 个源都被这道门挡下 → 全员 failed、零 sources、零 updated。
    expect(r.failed.length).toBe(4);
    expect(r.sources).toEqual([]);
    expect(r.updated).toBe(0);
    // ② 正文里那条模型**没有**进缓存 —— 这是「预筛真的拦住了」的正面证据：
    //    正文本身是合法的，只要放它读完就必然解析成功。
    expect(lookupCapability("oversize-declared-model")).toBeNull();
    // ③ 旧缓存原样保留（不是「失败就清空」）。
    expect(lookupCapability("kept-across-oversize")?.contextWindow).toBe(777_777);
  });

  test("实际流式字节超限（content-length 缺失）→ 边读边计数、超限即 cancel 上游流，不读完", async () => {
    __resetCapabilityCacheForTest({});
    __resetMissRefreshStateForTest();

    // 4MiB × 40 = 160MiB「声称体积」，上限 32MiB → 期望在第 9 个 chunk（36MiB）就断。
    // content-length 刻意不给（模拟 chunked 传输），迫使判据只能来自流式累加。
    const CHUNK_BYTES = 4 * 1024 * 1024;
    const TOTAL_CHUNKS = 40;
    // 8 个 chunk 刚好 32MiB（未超），第 9 个到 36MiB 才越线 → 最少拉 9 次。
    const MIN_PULLS = Math.floor(CAP_BYTES / CHUNK_BYTES) + 1; // 9
    // ⚠ 上界要 +1：ReadableStream 默认 highWaterMark=1，会在我们处理当前 chunk 时**预拉一个**。
    // 实测同一段逻辑在直连 probe 里是 9、经 fetch + await 链路是 10 —— 这一格差异属于
    // 队列预拉，不是限额逻辑。所以断言写成区间，不写死等值（写死会变成一条脆断言）。
    const MAX_PULLS = MIN_PULLS + 1; // 10
    const made: Array<{ pulled: number; cancelled: boolean }> = [];

    globalThis.fetch = (async () => {
      const { resp, stats } = chunkedStreamResponse({
        chunkBytes: CHUNK_BYTES,
        totalChunks: TOTAL_CHUNKS,
      });
      made.push(stats);
      return resp;
    }) as any;

    // 不抛异常：syncExternalCatalogs 正常返回，超限只表现为「该源失败」。
    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.failed.length).toBe(4);
    expect(r.updated).toBe(0);

    expect(made.length).toBe(4);
    for (const stats of made) {
      // ⚠ 这两条断言是本用例的**全部价值**，也是它与「只断言被丢弃」的区别所在：
      // 「超限时丢弃」这个结果在流式实现和「先 arrayBuffer() 全收进内存再检查」的实现下
      // **都成立**，只看丢弃是抓不到退化的（典型 false gate）。能区分两者的只有：
      //   a) 上游流被提前中断 —— 后续 chunk 再也不会被拉取；
      //   b) reader.cancel() 确实调用到了底层 source。
      // 实测 arrayBuffer() 路径：pulled = 40（全拉完）且 cancelled = false。
      expect(stats.pulled).toBeGreaterThanOrEqual(MIN_PULLS);
      expect(stats.pulled).toBeLessThanOrEqual(MAX_PULLS);
      expect(stats.pulled).toBeLessThan(TOTAL_CHUNKS);
      expect(stats.cancelled).toBe(true);
    }
  });

  test("实际流式字节超限时，旧缓存不被清空且不抛异常（撒谎的 content-length 也拦不住流式计数）", async () => {
    __resetCapabilityCacheForTest({
      "kept-across-stream-overflow": { contextWindow: 555_555, source: "catalog" },
    });
    __resetMissRefreshStateForTest();

    // content-length 撒谎报「很小」：预筛这一支放行（16 字节 < 32MiB），
    // 于是唯一能拦住它的就是流式累加那一支。
    const CHUNK_BYTES = 8 * 1024 * 1024;
    globalThis.fetch = (async () => {
      const { resp } = chunkedStreamResponse({
        chunkBytes: CHUNK_BYTES,
        totalChunks: 20, // 声称 160MiB
        headers: { "content-type": "application/json", "content-length": "16" },
      });
      return resp;
    }) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.failed.length).toBe(4);
    expect(lookupCapability("kept-across-stream-overflow")?.contextWindow).toBe(555_555);
  });

  test("正常体积（远小于上限）→ 正常解析入库（正向对照：上限没把正常路径也挡了）", async () => {
    __resetCapabilityCacheForTest({});
    __resetMissRefreshStateForTest();

    const body = modelsDevBody("normal-size-model", 262_144);
    expect(body.length).toBeLessThan(CAP_BYTES); // 前提自证：正文确实远小于上限
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        // 声明真实长度：预筛这一支也要放行。
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      })) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.updated).toBeGreaterThan(0);
    expect(r.sources).toContain("models-dev-opencode");
    expect(lookupCapability("normal-size-model")?.contextWindow).toBe(262_144);
  });
});

// ─────────────────────────────────────────────────────────────
// zstd 解压路径（models-dev-stencil 源）
// ─────────────────────────────────────────────────────────────

describe("zstd 解压路径 —— 压缩源必须能解出正文，坏字节只毁它自己", () => {
  /** stencil 是唯一 decompress: "zstd" 的源；其余源不走这条分支。 */
  const ZSTD_SOURCE_URL = "catalog.stencil.so";

  test("zstd 源返回真实压缩的合法目录 → 解压 + 解析成功，条目进缓存", async () => {
    __resetCapabilityCacheForTest({});
    __resetMissRefreshStateForTest();

    // 现场压，不硬编码二进制字面量：字面量一旦与 Bun 的 zstd 实现漂移就变成一个
    // 「测试挂了但生产没问题」的假失败，而且没人看得懂那串字节是什么。
    const plain = modelsDevBody("zstd-only-model", 262_144);
    const compressed = Bun.zstdCompressSync(Buffer.from(plain));
    // 前提自证：确实是 zstd 帧。判据用 magic bytes（28 b5 2f fd）而不是「比原文小」——
    // 这份 fixture 只有 87 字节，zstd 帧头开销让它压完反而是 89 字节，
    // 拿体积当判据会得到一条与压缩正确性无关的假失败。
    expect([...compressed.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);

    globalThis.fetch = (async (url: any) => {
      if (String(url).includes(ZSTD_SOURCE_URL)) {
        return new Response(compressed, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      // 其余源一律返回解析不出条目的空壳，把 zstd-only-model 的唯一来源锁定为 zstd 源。
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.sources).toContain("models-dev-stencil");
    expect(r.failed).not.toContain("models-dev-stencil");
    // 条目只可能来自 zstd 源 → 它在缓存里就等于「解压这一步真的跑通了」。
    expect(lookupCapability("zstd-only-model")?.contextWindow).toBe(262_144);
  });

  test("zstd 源返回未压缩的明文 JSON → 解压失败被当作该源失败，不抛异常，其它源不受影响", async () => {
    __resetCapabilityCacheForTest({});
    __resetMissRefreshStateForTest();

    // ⚠ 明文正文本身是**合法且能解析**的目录：如果 zstd 分支被摘掉（退化成纯文本解析），
    // 这条就会被解析成功、`zstd-plaintext-model` 进缓存。所以下面那条 toBeNull()
    // 正是「解压分支还在」的判据，而不只是「坏数据没崩」。
    const plainNotCompressed = modelsDevBody("zstd-plaintext-model", 131_072);
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes(ZSTD_SOURCE_URL)) {
        return new Response(plainNotCompressed, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // 另一个源给一份正常的 models.dev 目录，用来证明「一个源坏了不牵连其它源」。
      return new Response(modelsDevBody("healthy-peer-model", 200_000), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.failed).toContain("models-dev-stencil"); // 该源记失败
    expect(r.sources).toContain("models-dev-opencode"); // 邻居照常成功
    expect(lookupCapability("healthy-peer-model")?.contextWindow).toBe(200_000);
    expect(lookupCapability("zstd-plaintext-model")).toBeNull(); // 明文没被当 JSON 吃下去
  });

  test("zstd 源返回随机坏字节 → 同样只记该源失败，缓存不被污染", async () => {
    __resetCapabilityCacheForTest({});
    __resetMissRefreshStateForTest();

    const garbage = new Uint8Array(64);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes(ZSTD_SOURCE_URL)) {
        return new Response(garbage, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const r = await syncExternalCatalogs({ timeoutMs: 5000 });
    expect(r.failed).toContain("models-dev-stencil");
    // 坏字节没有以任何形式沉淀成条目（比「没抛异常」强：它锁住了缓存内容）。
    expect(Object.keys(__getCapabilityCacheForTest()).length).toBe(0);
  });

  test("zstd 源的 accept 头必须是 */* 而不是 application/json（压缩体不是 JSON MIME）", async () => {
    __resetCapabilityCacheForTest({});
    __resetMissRefreshStateForTest();

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = fakeFetchAlwaysFresh(calls);

    await syncExternalCatalogs({ timeoutMs: 5000 });

    const zstdCall = calls.find((c) => c.url.includes(ZSTD_SOURCE_URL));
    expect(zstdCall).toBeDefined();
    expect(zstdCall!.headers["accept"]).toBe("*/*");
    // 逐源对照：非压缩源仍然声明只收 JSON —— 否则「都是 */*」也能让上面那条绿。
    for (const c of calls) {
      if (c.url.includes(ZSTD_SOURCE_URL)) continue;
      expect(c.headers["accept"]).toBe("application/json");
    }
  });
});
