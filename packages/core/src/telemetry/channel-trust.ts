/**
 * channel-trust.ts —— 渠道 usage 可信度登记表（P0-4）
 *
 * 为什么需要这个模块：**不是所有网关上报的 usage 都是真的。**
 *
 * 实测某月卡网关（`code.ppchat.vip`）的 Anthropic usage 是编造的，四重判据全中：
 *   A 全新随机前缀（服务端必然从未见过）r1 就报 cache_read=13860
 *   B 完全不打 cache_control，仍报 cache_read=12239
 *   C 同一前缀连发 5 次：三段随机跳动而**总和恒定** 13159（把固定总数随机三等分）
 *   D 命中值无规律上下抖动（真实缓存应稳定或单调递增）
 * 同款判据下自建网关对照组行为完全正确 —— 所以这不是判据太严，是渠道在造数。
 *
 * 把这类渠道的"命中"混进总命中率，会凭空抬高整体数字，让"我们的缓存做得很好"
 * 建立在假数据上。所以消费侧（`src/trace/cache-report.ts`）对不可信渠道
 * **打 ⚠ 且排除出总计**，而不是简单丢弃 —— 丢弃会让人以为这个渠道没被用过。
 *
 * 判定结果由 `scripts/cache-trust-probe.ts` 实测产出，落在
 * `~/.sid-code/channel-trust.json`。本模块只负责读取与查询：判定是**实测事实**，
 * 不该硬编码进代码（渠道行为会变，硬编码的黑名单会过期且无法自证）。
 */

import { existsSync, readFileSync } from "node:fs";
import { sidHomePath } from "../config/paths.ts";

/** 单渠道×协议的判定结果 */
export interface ChannelTrustVerdict {
  /** 端点 host，如 `code.ppchat.vip` */
  host: string;
  /** 判定：trusted（判据全过）/ untrusted（任一判据命中）/ unknown（未探测或探测失败） */
  verdict: "trusted" | "untrusted" | "unknown";
  /** 命中的不可信判据（A/B/C/D），trusted 时为空 */
  failedCriteria?: string[];
  /** 人类可读理由（供 ⚠ 文案直接引用） */
  reason?: string;
  /** 探测时间（Unix 秒），用于判断结论是否过期 */
  probedAt?: number;
  /** 探测所用模型（同一渠道不同协议可能表现不同） */
  model?: string;
}

/** 登记表文件结构 */
export interface ChannelTrustRegistry {
  /** key = host */
  channels: Record<string, ChannelTrustVerdict>;
}

/** 登记表路径（测试可经 SID_CODE_CHANNEL_TRUST 重定向） */
export function channelTrustPath(): string {
  const override = process.env.SID_CODE_CHANNEL_TRUST;
  if (override && override.trim() !== "") return override;
  return sidHomePath("channel-trust.json");
}

/**
 * 读取登记表。文件不存在 / 损坏均返回空表（绝不抛错阻断度量）。
 *
 * 空表意味着"什么都还没探测过"，此时所有渠道都是 unknown ——
 * 而 unknown 按**可信**处理。理由：把没探测过的渠道一律打警示，会让警示变成噪声、
 * 最终被忽略，反而掩盖真正不可信的那一个。
 */
export function readChannelTrust(): ChannelTrustRegistry {
  try {
    const path = channelTrustPath();
    if (!existsSync(path)) return { channels: {} };
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ChannelTrustRegistry;
    if (!parsed || typeof parsed !== "object" || !parsed.channels) return { channels: {} };
    return parsed;
  } catch {
    return { channels: {} };
  }
}

/**
 * 查询某 host 的判定。host 为 undefined（旧账本行无 endpointHost）时返回 unknown。
 */
export function lookupChannelTrust(
  host: string | undefined,
  registry?: ChannelTrustRegistry,
): ChannelTrustVerdict {
  if (!host) return { host: "", verdict: "unknown" };
  const reg = registry ?? readChannelTrust();
  return reg.channels[host] ?? { host, verdict: "unknown" };
}

/**
 * 该 host 的用量数字是否应计入总计。
 *
 * 只有**明确判定为 untrusted** 才排除；unknown 计入（见 readChannelTrust 注释）。
 */
export function countsTowardTotals(
  host: string | undefined,
  registry?: ChannelTrustRegistry,
): boolean {
  return lookupChannelTrust(host, registry).verdict !== "untrusted";
}
