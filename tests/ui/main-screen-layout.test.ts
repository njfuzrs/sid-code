/**
 * MainScreenLayout / 主屏 Static 渲染不变量单测（ADR-040）
 *
 * 核心保护对象：buildStaticItems —— 主屏模式下"进 <Static> 的历史项数组"的派生逻辑。
 * 最致命的回归是"流式尾巴泄漏进 Static"（导致重复显示）或"header 规则错乱"。
 */

import { describe, test, expect } from "bun:test";
import { buildStaticItems } from "@sid-code/cli/ui/history-adapter.ts";
import type { HistoryItem } from "@sid-code/cli/ui/types.ts";

const VERSION = "9.9.9";

/** 构造一条最简用户历史项 */
function userItem(id: number, text: string): HistoryItem {
  return { id, type: "user", text } as HistoryItem;
}

describe("buildStaticItems（主屏 Static 历史派生）", () => {
  test("空历史 → 空数组（不插 header，让 EmptyLogo 显示）", () => {
    expect(buildStaticItems([], VERSION)).toEqual([]);
  });

  test("非空历史 → 顶部恰好一个 app_header，其后接全部历史", () => {
    const history = [userItem(1, "hi"), userItem(2, "yo")];
    const result = buildStaticItems(history, VERSION);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: "app_header", version: VERSION });
    // header 之后顺序、内容与原历史一致
    expect(result.slice(1)).toEqual(history);
  });

  test("header 只出现一次（不重复插入）", () => {
    const history = [userItem(1, "a"), userItem(2, "b"), userItem(3, "c")];
    const headers = buildStaticItems(history, VERSION).filter(i => i.type === "app_header");
    expect(headers).toHaveLength(1);
  });

  test("绝不包含流式虚拟项 STREAMING_ITEM_ID(-1)", () => {
    // historyItems 只含已完成项；流式项(id=-1)永不在其中
    const history = [userItem(1, "done")];
    const result = buildStaticItems(history, VERSION);
    expect(result.some(i => i.id === -1)).toBe(false);
  });

  test("纯函数：不修改入参数组", () => {
    const history = [userItem(1, "x")];
    const snapshot = [...history];
    buildStaticItems(history, VERSION);
    expect(history).toEqual(snapshot);
  });

  test("header 使用传入的版本号", () => {
    const result = buildStaticItems([userItem(1, "x")], "1.2.3");
    expect(result[0]).toMatchObject({ type: "app_header", version: "1.2.3" });
  });
});
