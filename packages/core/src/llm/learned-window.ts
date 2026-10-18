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
 * - **7 天内累计 ≥2 次溢出才写入**：`isPromptTooLong` 靠措辞匹配，一次误判会把上限锁成某次很小的
 *   成功请求，而压缩会让后续请求永远够不到它 —— 「出现更大的成功请求就上调」这条路等不来。
 *   D1：原方案字面是「**连续** 2 次」，刻意不按「中间有成功请求就重置」实现——每次溢出后
 *   reactive 压缩必然让下一个请求变小并成功，按字面重置的话第二次溢出永远计成「第 1 次」，
 *   学习永远不发生。这里的「连续」只能落在「同一有效期内」。
 * - **TTL 7 天**：错误值最多活一周，不会永久锁小。
 * - **待定计数与已学上限各管各的有效期**（B3）：待定计数按 `firstOverflowAt` 过期重算，
 *   已学上限按 `learnedAt` 过期。旧实现把两者绑在一起，一条仍在有效期内的上限会被下一次
 *   「证明它还不够紧」的溢出整条抹掉，之后要再撞两次 400 才学回来。
 * - **已学上限有效期内再溢出 → 当场收紧**：上限本身就是从两次溢出学来的，再撞一次说明它
 *   仍高于墙，取 min(上限, 本次已放行值) 并续期，不再等第二次。
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

/**
 * 只写一个键（L14）：写之前**重新读盘**再合并，只覆盖自己这个键；临时文件名带 pid + 随机后缀。
 *
 * 旧实现「调用方读全表 → 改 → 整表写回」且临时文件名固定 `${path}.tmp`：两个进程同时溢出时，
 * 后写者把先写者的其他键整表覆盖，或两者写同一个 tmp 互相截断。现在剩下的竞态窗口只有
 * 「重新读盘 → rename」之间的几毫秒，且只会丢**别的键**在这几毫秒里的更新。
 * 不上文件锁：溢出一天也就几次，锁的超时 / 陈旧锁清理的复杂度不值。
 */
function writeEntry(key: string, entry: CeilingEntry): void {
  // 与 model-capabilities 同一守卫：测试态且未重定向时绝不写用户真实目录。
  if (process.env.NODE_ENV === "test" && isRealUserSidHome()) return;
  try {
    const path = sidPaths.learnedInputCeiling();
    mkdirSync(dirname(path), { recursive: true });
    const entries = readAll();
    entries[key] = entry;
    const file: CeilingFile = { schema_version: 1, entries };
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
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

  const key = ceilingKey(opts.model, opts.baseURL);
  const next = nextEntry(readAll()[key], opts.admittedTokens, now);
  writeEntry(key, next);
  return next.ceiling
    ? { status: "learned", ceiling: next.ceiling, overflows: next.overflows }
    : { status: "pending", overflows: next.overflows };
}

/** 一次溢出后的新条目（纯函数，便于对着三天序列断言） */
function nextEntry(prev: CeilingEntry | undefined, admitted: number, now: number): CeilingEntry {
  // 已学上限按 learnedAt 判有效（B3：不能用待定计数的 firstOverflowAt）
  const liveCeiling =
    prev?.ceiling && prev.learnedAt && now - prev.learnedAt <= LEARNED_CEILING_TTL_MS
      ? { ceiling: prev.ceiling, learnedAt: prev.learnedAt }
      : undefined;
  // 待定计数按 firstOverflowAt 判有效；过期只重算计数，不碰已学上限
  const pendingFresh = !prev || now - prev.firstOverflowAt > LEARNED_CEILING_TTL_MS;
  const counted: CeilingEntry = pendingFresh
    ? { overflows: 1, maxAdmitted: admitted, firstOverflowAt: now }
    : {
        overflows: prev.overflows + 1,
        maxAdmitted: Math.max(prev.maxAdmitted, admitted),
        firstOverflowAt: prev.firstOverflowAt,
      };
  if (liveCeiling) {
    // 有效上限下仍撞墙：上限还不够紧，取更小者并续期
    return { ...counted, ceiling: Math.min(liveCeiling.ceiling, admitted), learnedAt: now };
  }
  if (counted.overflows >= LEARN_MIN_OVERFLOWS) {
    return { ...counted, ceiling: counted.maxAdmitted, learnedAt: now };
  }
  return counted;
}
