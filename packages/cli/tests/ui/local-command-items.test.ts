/**
 * 命令结果插回全量重建的 historyItems。
 *
 * 缺陷背景：命令结果不进 ctxMgr，syncDisplay 每次从 ctxMgr 全量重建 historyItems，
 * 于是 /status 的输出在用户发下一句话后就从屏幕上消失了。这里锁住插回的位置。
 */

import { describe, test, expect } from "bun:test";
import { mergeAnchoredItems, type AnchoredItem } from "@sid-code/cli/ui/local-command-items.ts";
import type { HistoryItemWithoutId } from "@sid-code/cli/ui/types.ts";

const user = (text: string): HistoryItemWithoutId => ({ type: "user", text });
const asst = (text: string): HistoryItemWithoutId => ({ type: "assistant", text });
const cmd = (input: string): HistoryItemWithoutId => ({ type: "command", input, output: "x" });

// 2 条消息 → 2 个历史项（1:1，便于推算）
const ITEMS = [user("u1"), asst("a1"), user("u2"), asst("a2")];
const countAt = (n: number) => n;

describe("mergeAnchoredItems", () => {
  test("侧表为空 → 原样返回同一数组引用（不白白换引用触发重渲）", () => {
    expect(mergeAnchoredItems(ITEMS, [], 4, countAt)).toBe(ITEMS);
  });

  test("锚点在中间 → 插在对应消息之后", () => {
    const side: AnchoredItem[] = [{ anchor: 2, item: cmd("/status") }];
    expect(mergeAnchoredItems(ITEMS, side, 4, countAt)).toEqual([
      user("u1"),
      asst("a1"),
      cmd("/status"),
      user("u2"),
      asst("a2"),
    ]);
  });

  test("锚点 = 当前消息数 → 追加在末尾（刚敲完命令的常态）", () => {
    const side: AnchoredItem[] = [{ anchor: 4, item: cmd("/doctor") }];
    expect(mergeAnchoredItems(ITEMS, side, 4, countAt).at(-1)).toEqual(cmd("/doctor"));
  });

  test("同一锚点多条 → 保持追加顺序", () => {
    const side: AnchoredItem[] = [
      { anchor: 0, item: cmd("/a") },
      { anchor: 0, item: cmd("/b") },
    ];
    const merged = mergeAnchoredItems(ITEMS, side, 4, countAt);
    expect(merged.slice(0, 2)).toEqual([cmd("/a"), cmd("/b")]);
  });

  test("锚点越界（rewind 删掉了后面的消息）→ 夹到末尾，不丢", () => {
    const side: AnchoredItem[] = [{ anchor: 9, item: cmd("/status") }];
    const merged = mergeAnchoredItems(ITEMS.slice(0, 2), side, 2, countAt);
    expect(merged).toEqual([user("u1"), asst("a1"), cmd("/status")]);
  });

  test("前缀计数异常（大于总数）也不越界", () => {
    const side: AnchoredItem[] = [{ anchor: 1, item: cmd("/x") }];
    const merged = mergeAnchoredItems(ITEMS, side, 4, () => 99);
    expect(merged).toHaveLength(5);
    expect(merged.at(-1)).toEqual(cmd("/x"));
  });
});
