/**
 * 常驻提示（hint）写历史区 + 登记侧表。
 *
 * 抽成纯函数的原因：这段逻辑原本是 `runTUI` 里的闭包，测试只能读源码文本断言
 * 「分支里调了谁」；D9 的回归形态一旦变成「分支还在、中间插了个条件」，文本断言
 * 拦不住（`wait-notice-persistent-routing.test.ts` 文件头自认过这个盲区）。
 * 把语义抽出来后可以用行为断言守住，`app.ts` 只负责提供依赖。
 *
 * `localItems` 与斜杠命令结果共用同一张侧表：`syncDisplay` / `rebuildDisplay`
 * 从 ctxMgr 全量重建 historyItems 时靠 anchor 把它插回原位（见 mergeAnchoredItems）。
 * 这条路径不写 ctxMgr，所以提示不会发给模型。
 */

import type { AnchoredItem } from "./local-command-items.ts";
import type { HistoryItem, HistoryItemWithoutId } from "./types.ts";

export interface PersistentHintTarget {
  /** 追加前的历史区快照（不原地修改） */
  historyItems: readonly HistoryItem[];
  /** 侧表（与斜杠命令结果共用） */
  localItems: AnchoredItem[];
  /** 插入锚点 = 当时的 ctxMgr 消息数 */
  anchor: number;
  /** 分配历史项 id（调用方持有计数器） */
  allocateId: () => number;
}

/** 追加一条常驻提示，返回新的历史区数组。 */
export function appendPersistentHintTo(target: PersistentHintTarget, text: string): HistoryItem[] {
  const item: HistoryItemWithoutId = { type: "hint", text };
  target.localItems.push({ anchor: target.anchor, item });
  return [...target.historyItems, { ...item, id: target.allocateId() }];
}
