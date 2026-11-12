/**
 * 请求形状观测（D16，2026-11-12）：BilledRequest 上的 `tools_hash` / `tools_count` / `prefix_source`。
 *
 * 为什么要它：D16 调研「fork 首请求为什么不命中缓存」时，轨迹里看不到 fork 发了哪些工具
 * （raw.jsonl 只有主循环，BilledRequest 只有 thinking_wire / effort_wire），只能靠打线上端点的
 * 对照实验定位，花掉了调研的大部分时间。有了这三个字段，主循环最后一次与 fork 首请求
 * 的两行 BilledRequest 一比就知道工具列表对没对齐、fork 有没有退回全量。
 *
 * 挂在 provider 出口算（与 thinking_wire 同一个落盘点）：那是所有调用链必经的咽喉。
 * 纯观测：任何异常返回空对象，不影响请求。
 */

import { createHash } from "node:crypto";
import type { SendParams, ToolDefinition } from "./types.ts";

export interface RequestShapeFields {
  /** 工具定义 JSON 的 sha256 前 16 位；请求不带 tools 时缺省 */
  toolsHash?: string;
  toolsCount?: number;
  /** 只有 fork 写：`snapshot` = 复用了主循环快照；`fallback` = 退回全量 */
  prefixSource?: "snapshot" | "fallback";
}

/** 按数组引用缓存：主循环同一轮的多次重试、fork 的多轮都共用同一个数组，不重复序列化 */
const cache = new WeakMap<object, { hash: string; count: number }>();

/** 工具列表指纹。数组为空或缺省时返回 undefined */
export function toolsFingerprint(
  tools: ToolDefinition[] | undefined,
): { toolsHash: string; toolsCount: number } | undefined {
  if (!tools) return undefined;
  try {
    let fp = cache.get(tools);
    if (!fp) {
      fp = {
        hash: createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16),
        count: tools.length,
      };
      cache.set(tools, fp);
    }
    return { toolsHash: fp.hash, toolsCount: fp.count };
  } catch {
    return undefined;
  }
}

/** provider 出口直接展开进 recordBilledRequest */
export function observeRequestShape(
  params: Pick<SendParams, "tools" | "forkPrefixSource">,
): RequestShapeFields {
  try {
    const fp = toolsFingerprint(params.tools);
    return {
      ...(fp && fp),
      ...(params.forkPrefixSource && { prefixSource: params.forkPrefixSource }),
    };
  } catch {
    return {};
  }
}
