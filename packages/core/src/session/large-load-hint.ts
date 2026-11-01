/**
 * R2：恢复巨型会话前的可见提示。
 *
 * 加载本身是 O(文件大小)（本机 222MB 单文件 load 实测 682ms、RSS +1.1GB），以前全程无任何输出，
 * 用户看到的是「回车之后什么都没发生」。这里只做**可见**：先 stat，超阈值就给出体积 + 预计耗时，
 * 并提示 Ctrl+C 可取消。加载的流式化不在本次范围（见方案 4.7 R2）。
 *
 * 只 stat 一次，O(1)，不读内容。
 */
import { statSync } from "node:fs";
import { resolveSessionFileAcrossProjects } from "./store.ts";

/** 超过它才提示。小于它的会话加载在百毫秒内，提示反而是噪声 */
export const LARGE_SESSION_HINT_BYTES = 50 * 1024 * 1024;

/**
 * 每 MB 的预计加载毫秒数。实测 222MB → 682ms（≈3.1ms/MB，M 系列本机、文件已在页缓存）；
 * 冷缓存 / 慢盘会更慢，取 2 倍余量，宁可高估——提示的目的是让人知道「它在动、要等多久」。
 */
const MS_PER_MB_ESTIMATE = 6;

export interface LargeSessionHint {
  bytes: number;
  estimatedMs: number;
  message: string;
}

/** 会话文件超过阈值时返回提示，否则 null（含文件不存在 / stat 失败）。 */
export function largeSessionLoadHint(
  sessionId: string,
  thresholdBytes = LARGE_SESSION_HINT_BYTES,
): LargeSessionHint | null {
  const file = resolveSessionFileAcrossProjects(sessionId);
  if (!file) return null;
  let bytes: number;
  try {
    bytes = statSync(file).size;
  } catch {
    return null;
  }
  if (bytes < thresholdBytes) return null;
  const mb = bytes / 1024 / 1024;
  const estimatedMs = Math.round(mb * MS_PER_MB_ESTIMATE);
  const eta = estimatedMs >= 1000 ? `${Math.ceil(estimatedMs / 1000)}s` : "1s";
  return {
    bytes,
    estimatedMs,
    message: `正在加载大会话 ${sessionId}（${mb.toFixed(0)}MB，预计约 ${eta}），按 Ctrl+C 取消…`,
  };
}
