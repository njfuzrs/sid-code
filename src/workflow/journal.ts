/**
 * Dynamic Workflows M5 — 编排级 resume(journal)
 *
 * 目标:workflow 跑到一半被 kill / 脚本被编辑后重跑时,已完成的 agent() 调用直接返回缓存结果,
 * 只有被改动的调用及其之后才真跑。对齐 cc 的 resumeFromRunId 语义。
 *
 * 缓存键设计(关键,绕开 cc #63102):
 *   cc 早期用"prompt 内容 hash"做键,导致两个**不同调用点**但 prompt 恰好相同的 agent() 串台
 *   (一个的结果被另一个错误复用)。本实现的键 = **调用序号 callIndex + (prompt, opts) 的稳定
 *   指纹**。callIndex 由 runtime 全局自增,贯穿整个 run,天然区分调用点;指纹再保证"同序号但
 *   脚本被改过"时缓存失效、触发重跑。两者结合 = 同脚本同 args → 100% 命中;改了第 N 个 agent →
 *   前 N-1 命中、第 N 起重跑。
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
  /** 调用序号(runtime 全局自增) */
  callIndex: number;
  /** (prompt, opts) 的稳定指纹 */
  fingerprint: string;
  /** agent() 的返回值(已是 JSON 可序列化:string 或 schema 对象或 null) */
  result: unknown;
  /** 显示标签(便于人读 journal) */
  label?: string;
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

/**
 * Journal:append-only 的 agent() 结果缓存。
 *
 * 用法:
 *   const journal = new Journal(path)
 *   journal.load()                              // 重跑时回放已有记录
 *   const hit = journal.lookup(callIndex, fp)   // 命中返回 {result},否则 null
 *   journal.record({callIndex, fingerprint, result})  // 真跑后追加
 */
export class Journal {
  private readonly path: string;
  /** callIndex → entry(回放后填充) */
  private readonly entries = new Map<number, JournalEntry>();
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
          // 后写覆盖先写(同 callIndex 以最新为准)
          this.entries.set(entry.callIndex, entry);
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
   * 查缓存:callIndex 命中且指纹一致 → 返回 {result};否则 null(需真跑)。
   * 指纹不一致表示该调用点的脚本被改过,**该序号及其之后**都应重跑——调用方据此处理。
   */
  lookup(callIndex: number, fingerprint: string): { result: unknown } | null {
    const entry = this.entries.get(callIndex);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) return null; // 脚本改过,失效
    return { result: entry.result };
  }

  /** 追加一条记录(真跑完成后)。同时写内存与磁盘。 */
  record(entry: JournalEntry): void {
    this.entries.set(entry.callIndex, entry);
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
