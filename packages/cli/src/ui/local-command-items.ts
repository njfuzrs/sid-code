/**
 * 本地命令结果（不进 ctxMgr 的历史项）插回全量重建的 historyItems。
 *
 * 斜杠命令的结果只在 UI 上，而 syncDisplay / rebuildDisplay 每次都从 ctxMgr 全量重建
 * historyItems——不记下来就会在下一次同步时消失（此前 /status 的输出在用户发下一句话后
 * 就从屏幕上没了）。app.ts 把每条结果连同「当时 ctxMgr 的消息数」(anchor) 记进侧表，
 * 重建时用本函数插回原位。
 *
 * 纯函数，抽出来是为了单测能锁住插入位置，不必拉起整个 TUI 闭包。
 */

import type { HistoryItemWithoutId } from "./types.ts";

export interface AnchoredItem {
  /** 追加时 ctxMgr 的消息数 */
  anchor: number;
  item: HistoryItemWithoutId;
}

/**
 * @param items          由全部消息重建出的历史项
 * @param anchored       侧表（按追加顺序，anchor 单调不减）
 * @param messageCount   当前消息总数（越界锚点夹到末尾：rewind 删掉了锚点之后的消息）
 * @param itemCountAt    前 n 条消息生成的历史项数（调用方负责缓存）
 */
export function mergeAnchoredItems(
  items: HistoryItemWithoutId[],
  anchored: readonly AnchoredItem[],
  messageCount: number,
  itemCountAt: (n: number) => number,
): HistoryItemWithoutId[] {
  if (anchored.length === 0) return items;
  const merged: HistoryItemWithoutId[] = [];
  let cursor = 0;
  for (const { anchor, item } of anchored) {
    const at = Math.min(anchor, messageCount);
    const raw = at >= messageCount ? items.length : itemCountAt(at);
    // 夹进 [cursor, items.length]：保证插入顺序与追加顺序一致、不越界
    const count = Math.min(Math.max(raw, cursor), items.length);
    merged.push(...items.slice(cursor, count), item);
    cursor = count;
  }
  merged.push(...items.slice(cursor));
  return merged;
}
