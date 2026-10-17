/**
 * S6：运行时学习「已被服务端放行的输入上限」（admitted input ceiling）。
 *
 * ## 为什么需要
 *
 * 实测（2026-10-16 事故）：配置窗口 1M 的网关路由在 ≈0.665× 处就回 400 prompt-too-long，
 * 三层压缩阈值（780K / 820K / 860K）全在真实墙之后，5/5 次溢出全靠 reactive 兜底，
 * 且压缩后窗口估计不变、几小时后再撞。网关不报窗口、报错文案不带数字，
 * 所以只能从运行时观测学：**撞墙前最后一次成功请求的真实输入 token 是一个被放行过的下界**。
 *
 * ## 四条不能改回去的设计
 *
 * - **键 = (model, base_url)，不做名字归一**：同底层模型走不同网关路由，墙不同
 *   （CLAUDE.md TTFB 铁律同一类错误）。能力缓存按单 model 键 + 剥 `origin-` 前缀，放进去就会串路由。
 * - **连续 ≥2 次溢出才写入**：`isPromptTooLong` 靠措辞匹配，一次误判会把上限锁成某次很小的
 *   成功请求，而压缩会让后续请求永远够不到它 —— 「出现更大的成功请求就上调」这条路等不来。
 * - **TTL 7 天**：错误值最多活一周，不会永久锁小。
 * - **不叠加安全系数**：下界本身就保守；再乘一个比例 = 再引入一个拍脑袋的数（禁止按模型硬编码分级）。
 *
 * 诚实边界：前两次撞墙仍会发生，之后不再撞。不是「消灭 400」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRealUserSidHome, sidPaths } from "../config/paths.ts";

/** 学到的上限有效期（也是溢出记录的有效期：超过它的旧溢出不计入「连续」）。 */
export const LEARNED_CEILING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 同一键累计多少次溢出才写入上限。 */
export const LEARN_MIN_OVERFLOWS = 2;
/** 文件条目上限：防被篡改成异常大的文件后自我延续。 */
const MAX_ENTRIES = 500;

interface CeilingEntry {
  /** 有效期内的溢出次数 */
  overflows: number;
  /** 这些溢出里「已放行值」的最大者 */
  maxAdmitted: number;
  firstOverflowAt: number;
  /** 已学到的上限（达到 LEARN_MIN_OVERFLOWS 后才有） */
  ceiling?: number;
  learnedAt?: number;
}

interface CeilingFile {
  schema_version: 1;
  entries: Record<string, CeilingEntry>;
}

/** 键：原始模型名 + 规范化 base_url。刻意不经 normalizeCandidates（见头注释）。 */
export function ceilingKey(model: string, baseURL: string): string {
  return `${model.trim().toLowerCase()}@${baseURL.trim().replace(/\/+$/, "").toLowerCase()}`;
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

function sanitize(raw: unknown): CeilingEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r.overflows) || !isPosInt(r.maxAdmitted) || !isPosInt(r.firstOverflowAt)) {
    return null;
  }
  const e: CeilingEntry = {
    overflows: r.overflows,
    maxAdmitted: r.maxAdmitted,
    firstOverflowAt: r.firstOverflowAt,
  };
  if (isPosInt(r.ceiling) && isPosInt(r.learnedAt)) {
    e.ceiling = r.ceiling;
    e.learnedAt = r.learnedAt;
  }
  return e;
}

/** 每次都读盘：调用频率极低（换模型 / 溢出时），多进程并存时也总能看到别人学到的值。 */
function readAll(): Record<string, CeilingEntry> {
  try {
    const path = sidPaths.learnedInputCeiling();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CeilingFile>;
    if (parsed?.schema_version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return {};
    }
    const out: Record<string, CeilingEntry> = {};
    let n = 0;
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (n >= MAX_ENTRIES || k.length > 1024) break;
      const clean = sanitize(v);
      if (clean) {
        out[k] = clean;
        n++;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(entries: Record<string, CeilingEntry>): void {
  // 与 model-capabilities 同一守卫：测试态且未重定向时绝不写用户真实目录。
  if (process.env.NODE_ENV === "test" && isRealUserSidHome()) return;
  try {
    const path = sidPaths.learnedInputCeiling();
    mkdirSync(dirname(path), { recursive: true });
    const file: CeilingFile = { schema_version: 1, entries };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    /* 学习是优化项：落盘失败不影响本次恢复，本会话仍由调用方 setMaxTokens 生效 */
  }
}

/** 查已学到且未过期的上限；无 / 过期 → undefined。 */
export function lookupAdmittedCeiling(
  model: string,
  baseURL: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!model || !baseURL) return undefined;
  const e = readAll()[ceilingKey(model, baseURL)];
  if (!e?.ceiling || !e.learnedAt) return undefined;
  if (now - e.learnedAt > LEARNED_CEILING_TTL_MS) return undefined;
  return e.ceiling;
}

export type OverflowRecordResult =
  | { status: "skipped"; reason: "no_admitted_sample" | "no_key" }
  | { status: "pending"; overflows: number }
  | { status: "learned"; ceiling: number; overflows: number };

/**
 * 记录一次 prompt-too-long 溢出。
 *
 * @param admittedTokens 溢出前最后一次**成功**响应的真实输入 token
 *   （`ContextManager.getLastActualInputTokens()`）。任何压缩都会把它清零 —— 为 0 时跳过，
 *   0 不是观测值。它与失败请求之间差一轮输出 + 工具结果，所以它是下界而不是墙。
 */
export function recordContextOverflow(opts: {
  model: string;
  baseURL: string | undefined;
  admittedTokens: number;
  now?: number;
}): OverflowRecordResult {
  const now = opts.now ?? Date.now();
  if (!isPosInt(opts.admittedTokens)) return { status: "skipped", reason: "no_admitted_sample" };
  if (!opts.model || !opts.baseURL) return { status: "skipped", reason: "no_key" };

  const all = readAll();
  const key = ceilingKey(opts.model, opts.baseURL);
  const prev = all[key];
  // 上一轮溢出记录已过期 → 重新起算（「连续」的语义落在有效期内）。
  const fresh = !prev || now - prev.firstOverflowAt > LEARNED_CEILING_TTL_MS;
  const next: CeilingEntry = fresh
    ? { overflows: 1, maxAdmitted: opts.admittedTokens, firstOverflowAt: now }
    : {
        ...prev,
        overflows: prev.overflows + 1,
        maxAdmitted: Math.max(prev.maxAdmitted, opts.admittedTokens),
      };
  if (next.overflows >= LEARN_MIN_OVERFLOWS) {
    next.ceiling = next.maxAdmitted;
    next.learnedAt = now;
  }
  all[key] = next;
  writeAll(all);
  return next.ceiling
    ? { status: "learned", ceiling: next.ceiling, overflows: next.overflows }
    : { status: "pending", overflows: next.overflows };
}
