/**
 * VCR（录制/回放）框架 — tests/llm/vcr/vcr.ts（T8.13）
 *
 * § 定位
 * 对标 Ruby VCR / Python vcrpy / Nock：把 provider 与真实 API 之间的 HTTP 交互序列化为
 * JSON fixture，回放时从 fixture 还原 response stream（含 timing 模拟），让流解析逻辑的
 * 任何退化都能被离线、确定性地检测——无需真实网络、无需 API key、无成本。
 *
 * § 为什么需要
 * 最近 4 次 provider 生产事故都是"生产中发现而非测试提前捕获"。单测覆盖了协议转换，
 * 但缺少"从真实字节流还原 → 验证解析结果"这一层（L3）。VCR 填补此空白：
 * 录制一次真实/构造的 SSE 字节序列，之后永久回放。
 *
 * § fixture 格式（tests/fixtures/vcr/{provider}-{scenario}.json）
 * {
 *   "provider": "openai" | "anthropic",
 *   "scenario": "normal-stream",
 *   "request": { "model": "...", "url": "..." },       // 录制时的请求快照（诊断用）
 *   "response": {
 *     "status": 200,
 *     "headers": { "content-type": "text/event-stream" },
 *     "chunks": [                                        // 按到达顺序的 SSE 字节块
 *       { "data": "data: {...}\n\n", "delayMs": 0 },     // data = 原始 SSE 文本；delayMs = 相对上一块的间隔
 *       ...
 *     ]
 *   }
 * }
 *
 * § 两种消费方式
 * - `installFetchFromFixture(fixture)`：替换 globalThis.fetch，返回一个 body 为 ReadableStream
 *   的 Response，按 chunks 的 delayMs 逐块 enqueue（回放 openai/fetch 路径）。
 * - `loadFixture(provider, scenario)`：从磁盘读取 fixture JSON。
 * - `buildSseBytes(chunks)`：把 chunk 列表拼成完整字节流（供不走 fetch 的场景直接喂）。
 *
 * § timing
 * delayMs 支持"确定性快放"：设 `timeScale: 0` 可零延迟回放（单测默认，避免慢），
 * 设 `timeScale: 1` 按录制的真实间隔回放（timing 敏感的 stall/idle 测试用）。
 *
 * § 录制 / 回放开关（PR-1 新增，机制抄 opencode `test/recorded-runner.ts:68`）
 * 默认**永远是回放**——CI 与本地 `bun test` 都不需要 key、不打网络、不写盘。
 * 只有显式设 `SID_VCR_RECORD=1` **且**该 provider 的 key 存在时才进录制模式：
 *
 * ```bash
 * SID_VCR_RECORD=1 OPENAI_API_KEY=sk-... bun test packages/core/tests/llm/vcr
 * ```
 *
 * 三条与 opencode 一致的判据（{@link vcrMode} / {@link shouldRunRecorded}）：
 *   1. 录制模式缺 key → **跳过**该用例（不是失败）：没 key 的人跑全量测试不该红。
 *   2. 回放模式缺夹具 → **跳过**该用例：夹具是资产，缺了说明还没录，不是回归。
 *   3. 回放模式**绝不写盘**——`saveFixture` 在回放模式下直接抛错。这条是硬约定：
 *      测试隔离铁律要求「除返回值外还写盘」的函数必须能被重定向，
 *      `SID_VCR_FIXTURE_DIR` 就是那个重定向口（录制落盘目标也走它）。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** VCR fixture 中单个 SSE 字节块 */
export interface VcrChunk {
  /** 原始 SSE 文本（含 `data: ` 前缀与结尾的 `\n\n`） */
  data: string;
  /** 相对上一块的到达间隔（毫秒）。第一块通常为 0。 */
  delayMs?: number;
}

/**
 * VCR fixture 完整结构。
 *
 * ⚠️ `scenario` 是**可选**的，这不是疏忽：仓里实际存在**两种夹具方言**——
 * `openai-*.json` / `deepseek-*.json` 带 `provider` + `scenario`（本模块的原生形态），
 * 而 `responses-*.json` 只有 `description` + `provider` + `model`，无 `scenario`
 * （它由 `openai-responses.test.ts:37` 自己手写的 loader 按文件名直读）。
 * 把 `scenario` 收成可选 + 加 `description`/`model`，是为了让**同一个 loader
 * 能吃下两种方言**，而不是再写第三份 loader —— 那正是 `openai-usage.ts` 文件头
 * 记的那个教训（两条路径各写一份提取逻辑 → 其中一条漏采了整族的 cache 字段）。
 */
export interface VcrFixture {
  provider: string;
  /** 场景名。原生方言必有；`responses-*` 方言无此字段，由 {@link loadFixtureByName} 回填。 */
  scenario?: string;
  /** `responses-*` 方言的人类可读说明。 */
  description?: string;
  /** `responses-*` 方言把 model 放在顶层（原生方言放 `request.model`）。 */
  model?: string;
  request?: {
    model?: string;
    url?: string;
    [k: string]: unknown;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    /** SSE 字节块序列（流式）。与 body 二选一。 */
    chunks?: VcrChunk[];
    /** 非流式 body（JSON 字符串）。与 chunks 二选一。 */
    body?: string;
  };
}

/**
 * fixture 根目录。默认 `tests/fixtures/vcr/`（本文件在 `tests/llm/vcr/`）。
 *
 * `SID_VCR_FIXTURE_DIR` 是**落盘重定向口**：录制模式往它指的目录写。测试若要断言
 * 录制副作用，必须设它指向 tmpdir —— 与 `SID_CODE_CACHE_BREAKS` 同一形态的专用变量。
 * 每次调用都重读 env（不缓存进模块常量），否则测试里设的变量对已加载的模块无效。
 */
function fixtureDir(): string {
  return process.env.SID_VCR_FIXTURE_DIR || join(import.meta.dir, "..", "..", "fixtures", "vcr");
}

/** fixture 文件路径 */
export function fixturePath(provider: string, scenario: string): string {
  return join(fixtureDir(), `${provider}-${scenario}.json`);
}

/** 夹具是否已存在（回放模式的跳过判据，见 {@link shouldRunRecorded}） */
export function fixtureExists(provider: string, scenario: string): boolean {
  return existsSync(fixturePath(provider, scenario));
}

/** 从磁盘加载 fixture（不存在则抛错，提示先录制） */
export function loadFixture(provider: string, scenario: string): VcrFixture {
  return loadFixtureByName(`${provider}-${scenario}.json`);
}

/**
 * 按**文件名**加载 fixture —— 两种方言的统一入口。
 *
 * 为什么按文件名而不是 `provider`+`scenario`：`responses-normal-text.json` 的
 * `provider` 字段是 `"openai-responses"`，按 `${provider}-${scenario}` 拼出来是
 * `openai-responses-normal-text.json`，**与真实文件名不符**。文件名是唯一可靠的键。
 */
export function loadFixtureByName(fileName: string): VcrFixture {
  const p = join(fixtureDir(), fileName.endsWith(".json") ? fileName : `${fileName}.json`);
  if (!existsSync(p)) {
    throw new Error(
      `VCR fixture 不存在: ${p}（回放模式请确认夹具已入库；录制请设 SID_VCR_RECORD=1 + 对应 API key）`,
    );
  }
  const fx = JSON.parse(readFileSync(p, "utf-8")) as VcrFixture;
  // 回填 scenario：responses-* 方言没这个字段，但断言失败信息里要能看出是哪个场景。
  if (!fx.scenario) fx.scenario = fileName.replace(/\.json$/, "");
  return fx;
}

// ─── 录制 / 回放开关（机制抄 opencode test/recorded-runner.ts:68） ──────────────

/** 当前 VCR 模式。默认 `"replay"`——录制必须显式开，避免误打真实网络/产生成本。 */
export function vcrMode(): "record" | "replay" {
  const v = process.env.SID_VCR_RECORD;
  return v === "1" || v === "true" ? "record" : "replay";
}

/**
 * 判断一条录制用例本次该不该跑，不该跑就给出跳过原因。
 *
 * 两个方向的跳过都是**刻意设计**，不是掩盖失败：
 * - 录制模式缺 key → 跳过。没有 key 的贡献者跑全量测试不该看到红色
 *   （`CONTRIBUTING.md` 明确写了「贡献者不需要任何 LLM API key」）。
 * - 回放模式缺夹具 → 跳过。夹具是要入库的资产，缺失说明还没录，不是代码回归。
 */
export function shouldRunRecorded(input: {
  provider: string;
  scenario: string;
  /** 录制该场景所需的环境变量名（如 `["OPENAI_API_KEY"]`） */
  requires?: string[];
}): { run: boolean; reason?: string } {
  if (vcrMode() === "record") {
    const missing = (input.requires ?? []).filter((k) => !process.env[k]);
    if (missing.length > 0)
      return { run: false, reason: `录制模式缺环境变量: ${missing.join(", ")}` };
    return { run: true };
  }
  if (!fixtureExists(input.provider, input.scenario)) {
    return { run: false, reason: `回放模式缺夹具: ${input.provider}-${input.scenario}.json` };
  }
  return { run: true };
}

/**
 * 保存 fixture 到磁盘（仅录制模式）。
 *
 * 回放模式直接抛错而不是静默写：静默落盘正是测试隔离铁律要防的那类
 * 「除返回值外还有进程外副作用」——一旦回放路径也能写盘，跑一次 `bun test`
 * 就会改动已入库的夹具，而测试依然全绿。
 */
export function saveFixture(fixture: VcrFixture): string {
  if (vcrMode() !== "record") {
    throw new Error(
      "saveFixture 只能在录制模式调用（设 SID_VCR_RECORD=1）。回放模式写盘会篡改已入库夹具。",
    );
  }
  const p = fixturePath(fixture.provider, fixture.scenario ?? "unnamed");
  writeFileSync(p, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
  return p;
}

/**
 * 把 chunk 列表拼成一个 ReadableStream<Uint8Array>，按 delayMs 逐块 enqueue。
 * @param timeScale 时间缩放：0 = 零延迟快放（默认），1 = 按录制间隔真实回放
 */
export function buildReplayStream(chunks: VcrChunk[], timeScale = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[idx++]!;
      const delay = (chunk.delayMs ?? 0) * timeScale;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      controller.enqueue(encoder.encode(chunk.data));
      if (idx >= chunks.length) controller.close();
    },
  });
}

/** 把 chunk 列表拼成完整字节串（供直接喂给 parseSSE 的场景） */
export function buildSseBytes(chunks: VcrChunk[]): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(chunks.map((c) => c.data).join(""));
}

/**
 * 用 fixture 替换 globalThis.fetch，返回一个还原函数。
 * fetch 被调用时返回 body 为回放流的 Response（回放 openai/fetch 路径）。
 *
 * ```ts
 * const restore = installFetchFromFixture(loadFixture("openai", "normal-stream"));
 * try { ...consume provider... } finally { restore(); }
 * ```
 */
export function installFetchFromFixture(
  fixture: VcrFixture,
  opts: { timeScale?: number } = {},
): () => void {
  const realFetch = globalThis.fetch;
  const { status, headers = {}, chunks, body } = fixture.response;

  globalThis.fetch = (async () => {
    if (chunks) {
      const stream = buildReplayStream(chunks, opts.timeScale ?? 0);
      return new Response(stream, {
        status,
        headers: { "content-type": "text/event-stream", ...headers },
      });
    }
    return new Response(body ?? "", {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = realFetch;
  };
}

/**
 * 便捷构造器：把一组 OpenAI SSE JSON 事件对象转为 VcrChunk[]（每个对象一块 + 结尾 [DONE]）。
 * 用于手工构造 fixture（无需真实 API 录制）。
 */
export function openaiChunksFromEvents(
  events: Record<string, unknown>[],
  perChunkDelayMs = 0,
): VcrChunk[] {
  const chunks: VcrChunk[] = events.map((e, i) => ({
    data: `data: ${JSON.stringify(e)}\n\n`,
    delayMs: i === 0 ? 0 : perChunkDelayMs,
  }));
  chunks.push({ data: "data: [DONE]\n\n", delayMs: perChunkDelayMs });
  return chunks;
}

/**
 * 便捷构造器：Anthropic Messages 协议的 SSE 块。
 *
 * 与 OpenAI 族有两处协议差异，都必须体现在字节里，否则夹具回放不出真实行为：
 *   1. **必须带 `event: <type>` 行**。Anthropic SDK 的 SSE 解析器按 event 名分派；
 *      只发 `data:` 行会被静默丢弃（这正是 `sse-event-line-shim.ts` 存在的原因）。
 *   2. **没有 `[DONE]` 哨兵**，流的终点是 `message_stop` 事件本身。
 */
export function anthropicChunksFromEvents(
  events: Array<Record<string, unknown> & { type: string }>,
  perChunkDelayMs = 0,
): VcrChunk[] {
  return events.map((e, i) => ({
    data: `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
    delayMs: i === 0 ? 0 : perChunkDelayMs,
  }));
}

/**
 * 便捷构造器：Responses API 的 SSE 块（带 `event:` 行，无 `[DONE]`）。
 * 与 {@link anthropicChunksFromEvents} 同形，单列一个是为了让调用点自解释走哪族协议。
 */
export function responsesChunksFromEvents(
  events: Array<Record<string, unknown> & { type: string }>,
  perChunkDelayMs = 0,
): VcrChunk[] {
  return events.map((e, i) => ({
    data: `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
    delayMs: i === 0 ? 0 : perChunkDelayMs,
  }));
}
