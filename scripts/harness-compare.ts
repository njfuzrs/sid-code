#!/usr/bin/env bun
/**
 * harness-compare —— sid-code 与 Claude Code 同任务轨迹的统一解析 + 逐调用宽表（对比大纲 T0.4）
 *
 * ## 为什么要单独一个脚本
 *
 * 对比大纲的 P1 四组维度分析都读同一份「逐调用」数据。不先统一解析，每组会各自重写一遍，
 * 口径必然打架（例如命中率用末次快照还是累计值、标题调用算不算分母）。这里把口径写死一次。
 *
 * ## 两边数据源不对称（口径细节见对比文档 T0.1 节）
 *
 * sid-code：
 *   - 主代理调用：`raw.jsonl` 的 pair 行（跳过 `type: "request_sent"` 预写行）。
 *     `timestamp` 是发出时刻，`ended_at` 是返回时刻。
 *   - system / tools **只在 index=1 记录**（collector.ts 只在首个 pair 存全量），
 *     后续行的 system_hash / tools_hash 是 null，含义是「没记」，不是「没变」。
 *   - 记录的是转换前的内部请求：system 是一个含 DYNAMIC_BOUNDARY 的字符串，
 *     wire 上会被拆成两块（cache-strategy.ts buildSystemBlocks），这里按同一规则还原分块长度。
 *   - 子代理 / fork / 标题调用不进 raw.jsonl，只能从 events.jsonl 的 `BilledRequest` 拿 usage，
 *     请求体字段一律为 null。
 *
 * Claude Code（claude-trace 在 HTTP 层抓包）：
 *   - 每行一次调用，system / tools 每行都有，是 wire 真实形态。
 *   - 没有返回时刻，returned_ts 恒为 null。
 *   - caller 靠请求形态判：tools 为空且带 output_config.format → title；
 *     最后一条 user 文本以 recap 提示开头 → recap；其余 → main。
 *     子代理先于形态判：计费头带 `cc_is_subagent=true` → subagent（见 classifyCcCaller）。
 *
 * 用法：
 *   bun scripts/harness-compare.ts --sid <会话id|目录> --cc <会话id|目录>
 *   bun scripts/harness-compare.ts --sid ... --cc ... --tsv     # 逐调用宽表
 *   bun scripts/harness-compare.ts --sid ... --cc ... --json    # 宽表 + 汇总
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DYNAMIC_BOUNDARY } from "@sid-code/core/api/cache-strategy.ts";

export type Agent = "sid-code" | "claude-code";
export type Caller = "main" | "subagent" | "fork" | "title" | "recap" | "side";

/** 宽表一行 = 一次 LLM 调用。字段取不到时为 null，不填 0，「没记」和「是 0」必须可区分。 */
export interface CallRow {
  sample_id: string;
  agent: Agent;
  call_index: number;
  caller: Caller;
  agent_id: string | null;
  sent_ts: string | null;
  returned_ts: string | null;
  elapsed_ms: number | null;
  input_tokens: number;
  cache_read: number;
  cache_write: number;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
  output_tokens: number;
  tools_count: number | null;
  tools_hash: string | null;
  tools_chars: number | null;
  system_hash: string | null;
  /** wire 上 system 各块字符数，用 "/" 连接 */
  system_blocks: string | null;
  /** 本次新增消息的 role:块类型 分布，如 "user:tool_result=2,user:text=1" */
  new_msg_kinds: string | null;
  tool_use_count: number | null;
  tool_result_chars: number | null;
  stop_reason: string | null;
}

export interface AgentSummary {
  agent: Agent;
  calls: number;
  calls_by_caller: Record<string, number>;
  /** 命中率 = Σcache_read / Σ(cache_read + cache_write + input)，只算 main，用累计值 */
  main_hit_rate: number | null;
  main_cache_read: number;
  main_cache_write: number;
  main_input: number;
  main_output: number;
  main_tool_use: number;
  first_main_total_input: number | null;
}

const RECAP_PREFIX = "The user stepped away";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 半截行（进程被杀时的最后一行）直接跳过，不让一行坏数据毁掉整份宽表
    }
  }
  return out;
}

function blocksOf(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function resultChars(block: any): number {
  const c = block?.content;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c))
    return c.reduce((n, b) => n + (typeof b?.text === "string" ? b.text.length : 0), 0);
  return 0;
}

/** new_messages → 块类型分布 + tool_result 总字符数 */
export function summarizeNewMessages(msgs: unknown): {
  kinds: string | null;
  toolResultChars: number | null;
} {
  if (!Array.isArray(msgs)) return { kinds: null, toolResultChars: null };
  const counts = new Map<string, number>();
  let chars = 0;
  for (const m of msgs) {
    for (const b of blocksOf((m as any)?.content)) {
      const k = `${(m as any)?.role}:${b?.type}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (b?.type === "tool_result") chars += resultChars(b);
    }
  }
  const kinds = [...counts].map(([k, v]) => `${k}=${v}`).join(",");
  return { kinds, toolResultChars: chars };
}

function toolUseCount(content: unknown): number | null {
  if (!Array.isArray(content)) return null;
  return content.filter((b: any) => b?.type === "tool_use").length;
}

/**
 * input_tokens 一律归一成「未命中余量」（Anthropic 口径），命中率分母 cr+cw+inp 才不会重复计数。
 *
 * OpenAI 协议族（deepseek 走网关时 provider=openai）的 input_tokens 是 prompt_tokens，**含命中**
 * （packages/core/src/llm/types.ts normalizeCacheUsage）。不减的话 F0 冒烟实测一次调用
 * cr=53248、inp=54903，命中率被算成 49%，真实是 97%。provider 取不到时按 anthropic 处理（旧数据全是 opus）。
 */
export function uncachedInput(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  provider?: string,
) {
  if (!provider || provider === "anthropic") return input;
  return Math.max(0, input - cacheRead - cacheWrite);
}

function usageOf(u: any, provider?: string) {
  const cr = u?.cache_read_input_tokens ?? 0;
  const cw = u?.cache_creation_input_tokens ?? 0;
  return {
    input_tokens: uncachedInput(u?.input_tokens ?? 0, cr, cw, provider),
    cache_read: u?.cache_read_input_tokens ?? 0,
    cache_write: u?.cache_creation_input_tokens ?? 0,
    cache_write_5m: u?.cache_creation?.ephemeral_5m_input_tokens ?? null,
    cache_write_1h: u?.cache_creation?.ephemeral_1h_input_tokens ?? null,
    output_tokens: u?.output_tokens ?? 0,
  };
}

/** sid-code 内部 system 字符串 → wire 分块长度（与 buildSystemBlocks 同一拆分规则） */
export function sidWireSystemBlocks(system: unknown): number[] | null {
  if (typeof system !== "string") return null;
  const i = system.indexOf(DYNAMIC_BOUNDARY);
  if (i === -1) return [system.length];
  return [i, system.length - i - DYNAMIC_BOUNDARY.length];
}

const SID_CALLER: Record<string, Caller> = {
  "agent:builtin": "subagent",
  "agent:fork": "fork",
  title_generation: "title",
};

export function parseSidSession(dir: string, sampleId: string): CallRow[] {
  const rows: CallRow[] = [];
  const events = readJsonl(join(dir, "events.jsonl"));
  // raw.jsonl 不记 provider；主代理调用的 provider 从同 index、无 caller 的 BilledRequest 取
  const mainProvider = new Map<number, string>();
  for (const e of events) {
    const d = e.event === "BilledRequest" ? (e.data ?? {}) : null;
    if (d && !d.caller && typeof d.provider === "string")
      mainProvider.set(d.pair_index ?? d.index, d.provider);
  }
  for (const r of readJsonl(join(dir, "raw.jsonl"))) {
    if (r.type === "request_sent" || !r.usage) continue;
    const req = r.request ?? {};
    const nm = summarizeNewMessages(req.new_messages);
    const blocks = sidWireSystemBlocks(req.system);
    const tools = Array.isArray(req.tools) ? req.tools : null;
    rows.push({
      sample_id: sampleId,
      agent: "sid-code",
      call_index: r.index,
      caller: "main",
      agent_id: null,
      sent_ts: r.timestamp ?? null,
      returned_ts: r.ended_at ?? null,
      elapsed_ms: r.elapsed_ms ?? null,
      ...usageOf(r.usage, mainProvider.get(r.index)),
      tools_count: tools ? tools.length : null,
      tools_hash: tools ? sha(JSON.stringify(tools)) : null,
      tools_chars: tools ? JSON.stringify(tools).length : null,
      system_hash: typeof req.system === "string" ? sha(req.system) : null,
      system_blocks: blocks ? blocks.join("/") : null,
      new_msg_kinds: nm.kinds,
      tool_use_count: toolUseCount(r.response?.content),
      tool_result_chars: nm.toolResultChars,
      stop_reason: r.stop_reason || null,
    });
  }
  // 主代理之外的调用只有计费事件；caller=undefined 的是主代理，已由 raw.jsonl 覆盖
  for (const e of events) {
    if (e.event !== "BilledRequest") continue;
    const d = e.data ?? {};
    if (!d.caller) continue;
    rows.push({
      sample_id: sampleId,
      agent: "sid-code",
      call_index: d.index ?? -1,
      caller: SID_CALLER[d.caller] ?? "side",
      agent_id: d.agent_id ?? null,
      sent_ts: null,
      // BilledRequest 在流结束后发出，近似返回时刻
      returned_ts: e.timestamp ?? null,
      elapsed_ms: null,
      input_tokens: uncachedInput(
        d.input_tokens ?? 0,
        d.cache_read_tokens ?? 0,
        d.cache_creation_tokens ?? 0,
        d.provider,
      ),
      cache_read: d.cache_read_tokens ?? 0,
      cache_write: d.cache_creation_tokens ?? 0,
      cache_write_5m: null,
      cache_write_1h: null,
      output_tokens: d.output_tokens ?? 0,
      tools_count: null,
      tools_hash: null,
      tools_chars: null,
      system_hash: null,
      system_blocks: null,
      new_msg_kinds: null,
      tool_use_count: null,
      tool_result_chars: null,
      stop_reason: null,
    });
  }
  return rows;
}

function lastUserText(req: any): string {
  const msgs = req.new_messages ?? req.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== "user") continue;
    const t = blocksOf(msgs[i].content).find((b) => b?.type === "text");
    return typeof t?.text === "string" ? t.text : "";
  }
  return "";
}

/**
 * CC 子代理请求的计费头末尾带 `cc_is_subagent=true;`。子代理请求形态和主代理一样（有 tools、
 * 无 output_config），只靠形态判会全部落进 main：S1v 实测 cc 49 次调用里 42 次是子代理，
 * 旧判据下 S 类 cc 主调用被算成 148（应为 27，对比 README 更正 X3）。所以计费头判据排第一。
 */
function isCcSubagent(req: any): boolean {
  const s = Array.isArray(req.system) ? req.system : [];
  const head = s.find(
    (b: any) => typeof b?.text === "string" && b.text.startsWith("x-anthropic-billing-header"),
  );
  return typeof head?.text === "string" && /\bcc_is_subagent=true\b/.test(head.text);
}

export function classifyCcCaller(req: any): Caller {
  if (isCcSubagent(req)) return "subagent";
  const tools = Array.isArray(req.tools) ? req.tools : [];
  if (tools.length === 0 && req.output_config?.format) return "title";
  if (lastUserText(req).startsWith(RECAP_PREFIX)) return "recap";
  if (tools.length === 0) return "side";
  return "main";
}

/**
 * CC system 第 0 块是计费头（`x-anthropic-billing-header: cc_version=...`），
 * 后缀随调用类型变化（本样本标题调用 .2d1、主调用 .88c）。hash 剔除这一块，
 * 否则「system 变了」会被一个与缓存无关的头字段制造出来。
 */
export function ccSystemHash(system: unknown): string | null {
  if (!Array.isArray(system)) return null;
  const rest = system.filter(
    (b: any) => !(typeof b?.text === "string" && b.text.startsWith("x-anthropic-billing-header")),
  );
  return sha(JSON.stringify(rest.map((b: any) => b?.text ?? "")));
}

export function parseCcSession(dir: string, sampleId: string): CallRow[] {
  const rows: CallRow[] = [];
  for (const r of readJsonl(join(dir, "raw.jsonl"))) {
    if (!r.usage) continue;
    const req = r.request ?? {};
    const nm = summarizeNewMessages(req.new_messages ?? req.messages);
    const tools = Array.isArray(req.tools) ? req.tools : null;
    const sys = Array.isArray(req.system) ? req.system : null;
    rows.push({
      sample_id: sampleId,
      agent: "claude-code",
      call_index: r.index,
      caller: classifyCcCaller(req),
      agent_id: null,
      sent_ts: r.timestamp ?? null,
      returned_ts: null,
      elapsed_ms: null,
      ...usageOf(r.usage),
      tools_count: tools ? tools.length : null,
      tools_hash: tools ? sha(JSON.stringify(tools)) : null,
      tools_chars: tools ? JSON.stringify(tools).length : null,
      system_hash: ccSystemHash(sys),
      system_blocks: sys ? sys.map((b: any) => (b?.text ?? "").length).join("/") : null,
      new_msg_kinds: nm.kinds,
      tool_use_count: toolUseCount(r.response?.content),
      tool_result_chars: nm.toolResultChars,
      stop_reason: r.stop_reason || null,
    });
  }
  return rows;
}

export function summarize(agent: Agent, rows: CallRow[]): AgentSummary {
  const mine = rows.filter((r) => r.agent === agent);
  const main = mine.filter((r) => r.caller === "main").sort((a, b) => a.call_index - b.call_index);
  const byCaller: Record<string, number> = {};
  for (const r of mine) byCaller[r.caller] = (byCaller[r.caller] ?? 0) + 1;
  const sum = (k: keyof CallRow) => main.reduce((n, r) => n + ((r[k] as number) ?? 0), 0);
  const cr = sum("cache_read");
  const cw = sum("cache_write");
  const inp = sum("input_tokens");
  const denom = cr + cw + inp;
  const first = main[0];
  return {
    agent,
    calls: mine.length,
    calls_by_caller: byCaller,
    main_hit_rate: denom > 0 ? cr / denom : null,
    main_cache_read: cr,
    main_cache_write: cw,
    main_input: inp,
    main_output: sum("output_tokens"),
    main_tool_use: sum("tool_use_count"),
    first_main_total_input: first
      ? first.cache_read + first.cache_write + first.input_tokens
      : null,
  };
}

const COLUMNS: (keyof CallRow)[] = [
  "sample_id",
  "agent",
  "call_index",
  "caller",
  "agent_id",
  "sent_ts",
  "returned_ts",
  "elapsed_ms",
  "input_tokens",
  "cache_read",
  "cache_write",
  "cache_write_5m",
  "cache_write_1h",
  "output_tokens",
  "tools_count",
  "tools_hash",
  "tools_chars",
  "system_hash",
  "system_blocks",
  "new_msg_kinds",
  "tool_use_count",
  "tool_result_chars",
  "stop_reason",
];

export function toTsv(rows: CallRow[]): string {
  const lines = [COLUMNS.join("\t")];
  for (const r of rows)
    lines.push(COLUMNS.map((c) => (r[c] === null ? "" : String(r[c]))).join("\t"));
  return lines.join("\n") + "\n";
}

function resolveDir(arg: string, root: string): string {
  return existsSync(arg) ? arg : join(root, arg);
}

function main(argv: string[]): number {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sidArg = get("--sid");
  const ccArg = get("--cc");
  if (!sidArg || !ccArg) {
    console.error(
      "用法: bun scripts/harness-compare.ts --sid <会话id|目录> --cc <会话id|目录> [--tsv|--json]",
    );
    return 2;
  }
  const sidDir = resolveDir(sidArg, join(homedir(), ".sid-code", "trajectories", "sessions"));
  const ccDir = resolveDir(ccArg, join(homedir(), ".claude-trace", "trajectories", "sessions"));
  for (const d of [sidDir, ccDir]) {
    if (!existsSync(join(d, "raw.jsonl"))) {
      console.error(`找不到 ${join(d, "raw.jsonl")}`);
      return 1;
    }
  }
  const sample = get("--sample") ?? "s1";
  const rows = [...parseSidSession(sidDir, sample), ...parseCcSession(ccDir, sample)];
  const summaries = [summarize("sid-code", rows), summarize("claude-code", rows)];

  if (argv.includes("--tsv")) {
    process.stdout.write(toTsv(rows));
  } else if (argv.includes("--json")) {
    console.log(JSON.stringify({ rows, summaries }, null, 2));
  } else {
    for (const s of summaries) {
      const pct = s.main_hit_rate === null ? "n/a" : `${(s.main_hit_rate * 100).toFixed(2)}%`;
      console.log(
        `${s.agent.padEnd(12)} calls=${s.calls} ${JSON.stringify(s.calls_by_caller)} ` +
          `main_hit=${pct} first_input=${s.first_main_total_input} out=${s.main_output} tool_use=${s.main_tool_use}`,
      );
    }
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
