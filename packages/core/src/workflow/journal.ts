/**
 * Dynamic Workflows M5 — 编排级 resume(journal)
 *
 * 目标:workflow 跑到一半被 kill / 脚本被编辑后重跑时,已完成的 agent() 调用直接返回缓存结果,
 * 只有被改动的调用及其之后才真跑。对齐 cc 的 resumeFromRunId 语义。
 *
 * 缓存键设计(关键,绕开 cc #63102):
 *   cc 早期用"prompt 内容 hash"做键,导致两个**不同调用点**但 prompt 恰好相同的 agent() 串台
 *   (一个的结果被另一个错误复用)。本实现的键 = **结构性调用键 key + (prompt, opts) 的稳定指纹**。
 *
 *   key 由 runtime 的调用作用域生成(见 runtime.ts 的 CallScope):形如 `3`(顶层第 3 个位置)、
 *   `1p2/0`(顶层第 1 个位置是 parallel,其第 2 个 thunk 内第 0 个调用)、`0l4/1`(pipeline 第 4 条
 *   item 链内第 1 个调用)、`2w/0`(第 2 个位置是内联子 workflow)。它只由脚本结构决定,
 *   与完成顺序无关——曾经用全局自增的 callIndex,pipeline/parallel 下时序一变就串台(P0-3)。
 *   纯串行脚本的 key 恰好是 "0","1",…,与老 journal 的 callIndex 一致,老记录照常命中。
 *
 *   失效游标(P0-2):某个 key 没命中(指纹变了 / 没记录 / 上次失败)就记下它,此后**结构上排在
 *   它之后、且可能依赖它**的调用一律不走缓存。「之后」= 同一顺序作用域里序号更大;parallel 的
 *   兄弟 thunk、pipeline 的兄弟 item 链彼此独立,不连坐。于是改了第 N 个 agent → 前 N-1 命中、
 *   第 N 起重跑,且在扇出里只连坐真正的下游。
 *
 *   失败不缓存(P0-1):runner 的契约是失败返回 null,null 不写盘;老 journal 里已有的 null 记录
 *   回放时也视为未命中。
 *
 * 持久化:append-only JSONL(对齐 session/store.ts 的 appendRecord 模式),落 workflow 运行目录。
 * append-only 的好处:崩溃中断也不会损坏已写记录;重跑时顺序回放即可重建缓存。
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { getLogger } from "../debug/logger.ts";

/** 单条 journal 记录(一次 agent() 调用的结果) */
export interface JournalEntry {
  /** 调用序号(runtime 全局自增;只用于展示排序,不再作缓存键) */
  callIndex: number;
  /** 结构性调用键(缓存键)。老 journal 没有该字段,按 String(callIndex) 处理。 */
  key?: string;
  /** (prompt, opts) 的稳定指纹 */
  fingerprint: string;
  /** agent() 的返回值(已是 JSON 可序列化:string 或 schema 对象或 null) */
  result: unknown;
  /** 显示标签(便于人读 journal) */
  label?: string;
  /**
   * 该调用所属的 phase 标题（phase() 切换时的值，opts.phase 优先）。
   * 只为 /workflows 进度树分组用，不参与指纹——phase 是展示维度，
   * 改 phase 名不应让 resume 缓存失效（computeFingerprint 已排除 phase）。
   * 老 journal 没有该字段，读取方按「未分组」处理。
   */
  phase?: string;
}

/** 计算 (prompt, opts) 的稳定指纹。opts 里只取影响结果的字段,顺序无关。 */
export function computeFingerprint(
  prompt: string,
  opts: Record<string, unknown> | undefined,
): string {
  // 只纳入影响"agent 会产出什么"的字段;label/phase 是展示用,不影响结果,排除。
  const relevant = {
    prompt,
    schema: opts?.schema ?? null,
    model: opts?.model ?? null,
    effort: opts?.effort ?? null,
    agentType: opts?.agentType ?? null,
    isolation: opts?.isolation ?? null,
  };
  // 稳定序列化:键排序
  const json = stableStringify(relevant);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** 稳定 JSON 序列化(对象键排序,保证指纹可复现) */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

/** 解析 key 的一段:`3`(叶子)/ `3p2`(parallel 分支)/ `3l2`(pipeline 链)/ `3w`(子 workflow) */
function parseSegment(seg: string): { seq: number; branch: number | null } {
  const m = /^(\d+)(?:[plw](\d+)?)?$/.exec(seg);
  if (!m) return { seq: Number.NaN, branch: null };
  return { seq: Number(m[1]), branch: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * b 是否在结构上排在 a 之后、可能依赖 a 的结果。
 * 逐段比较:同一顺序作用域里序号更大 → 之后;序号相同但分支不同(兄弟 thunk / item 链)→ 独立。
 * 无法解析的段一律按「之后」处理(宁可多重跑,不给错答案)。
 */
export function isStructurallyAfter(b: string, a: string): boolean {
  const bs = b.split("/");
  const as = a.split("/");
  const n = Math.min(bs.length, as.length);
  for (let i = 0; i < n; i++) {
    const sb = parseSegment(bs[i]!);
    const sa = parseSegment(as[i]!);
    if (Number.isNaN(sb.seq) || Number.isNaN(sa.seq)) return b !== a;
    if (sb.seq !== sa.seq) return sb.seq > sa.seq;
    if (sb.branch !== sa.branch) return false;
  }
  return false;
}

/**
 * Journal:append-only 的 agent() 结果缓存。
 *
 * 用法:
 *   const journal = new Journal(path)
 *   journal.load()                              // 重跑时回放已有记录
 *   const hit = journal.lookup(key, fp)         // 命中返回 {result},否则 null(并推进失效游标)
 *   journal.record({callIndex, key, fingerprint, result})  // 真跑成功后追加
 */
export class Journal {
  private readonly path: string;
  /** key → entry(回放后填充) */
  private readonly entries = new Map<string, JournalEntry>();
  /** 本次 run 里没命中的 key(失效游标):结构上在它们之后的调用不走缓存 */
  private readonly invalidated: string[] = [];
  /** 是否启用(无 path 时为纯内存 no-op,便于测试/无 resume 场景) */
  private readonly enabled: boolean;

  constructor(path: string | null) {
    this.path = path ?? "";
    this.enabled = !!path;
  }

  /** 从磁盘回放已有 journal(重跑时调用一次)。文件不存在则为空。 */
  load(): void {
    if (!this.enabled || !existsSync(this.path)) return;
    const log = getLogger();
    try {
      const content = readFileSync(this.path, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as JournalEntry;
          // 后写覆盖先写(同 key 以最新为准)
          this.entries.set(keyOf(entry), entry);
        } catch {
          log.warn("WORKFLOW", `journal 行解析失败,跳过: ${trimmed.slice(0, 80)}`);
        }
      }
      log.info("WORKFLOW", `journal 回放 ${this.entries.size} 条记录`);
    } catch (err) {
      log.warn("WORKFLOW", `journal 读取失败: ${(err as Error).message}`);
    }
  }

  /**
   * 查缓存:key 命中、指纹一致、结果非 null、且不在任何失效 key 之后 → 返回 {result};否则 null(需真跑)。
   * 没命中时把 key 记进失效游标——该位置之后的依赖调用随之全部重跑(P0-2),由本方法自己执行,
   * 不再靠调用方配合。
   */
  lookup(key: string | number, fingerprint: string): { result: unknown } | null {
    const k = String(key);
    if (this.invalidated.some((bad) => isStructurallyAfter(k, bad))) {
      this.invalidated.push(k);
      return null;
    }
    const entry = this.entries.get(k);
    // 没记录 / 脚本改过 / 上次失败(老 journal 里的 null) → 失效
    if (!entry || entry.fingerprint !== fingerprint || entry.result === null) {
      this.invalidated.push(k);
      return null;
    }
    return { result: entry.result };
  }

  /** 追加一条记录(真跑成功后)。同时写内存与磁盘。null 结果不记录(失败不缓存)。 */
  record(entry: JournalEntry): void {
    if (entry.result === null) return;
    this.entries.set(keyOf(entry), entry);
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      getLogger().warn("WORKFLOW", `journal 写入失败: ${(err as Error).message}`);
    }
  }

  /** 已回放/记录的条目数 */
  get size(): number {
    return this.entries.size;
  }

  /** 按 callIndex 升序返回所有条目（/workflows 详情展示用，只读快照）。 */
  all(): JournalEntry[] {
    return [...this.entries.values()].sort((a, b) => a.callIndex - b.callIndex);
  }
}

/** 条目的缓存键(老 journal 无 key 字段 → 退回 callIndex,与纯串行脚本的结构键一致) */
function keyOf(entry: JournalEntry): string {
  return entry.key ?? String(entry.callIndex);
}
