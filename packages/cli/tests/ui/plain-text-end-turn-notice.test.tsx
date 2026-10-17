/**
 * S1 L1：「本轮以纯文本结束」提示在 `done` 之后仍在帧里。
 *
 * 旧方案（info → `system:transient` 状态条）会被同一轮 `done` 的
 * removeStatusMessage("system:transient") 清掉。新方案写进历史区并登记到 localCommandItems 侧表；
 * `done` 走 syncDisplay：`assignIds(mergeLocalCommandItems(allMsgs, messagesToHistoryItems(allMsgs)))`
 * 从 ctxMgr 全量重建。这里按同一条重建链路取帧，断言提示仍可见、字形来自 figures、无 emoji。
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { HistoryItemDisplay } from "@sid-code/cli/ui/components/HistoryItemDisplay.tsx";
import { messagesToHistoryItems } from "@sid-code/cli/ui/history-adapter.ts";
import { mergeAnchoredItems, type AnchoredItem } from "@sid-code/cli/ui/local-command-items.ts";
import { ARROW_PROMPT } from "@sid-code/cli/ui/constants/figures.ts";
import { PLAIN_TEXT_END_TURN_NOTICE } from "@sid-code/core/query/promise-nudge.ts";
import type { HistoryItem } from "@sid-code/cli/ui/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("纯文本收尾提示常驻", () => {
  test("done 之后按 syncDisplay 同一链路重建，提示仍在帧里", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "修正问题然后提 PR" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "继续。先读取 website 安装的输出，然后开始逐处修改。" }],
      },
    ];
    // 收到 persistent system 事件时 app.ts 记下的侧表项（anchor = 当时消息数）
    const side: AnchoredItem[] = [
      { anchor: msgs.length, item: { type: "hint", text: PLAIN_TEXT_END_TURN_NOTICE } },
    ];
    // done → syncDisplay：从消息全量重建 + 侧表插回
    const rebuilt = mergeAnchoredItems(
      messagesToHistoryItems(msgs),
      side,
      msgs.length,
      (n) => messagesToHistoryItems(msgs.slice(0, n)).length,
    ).map((it, i) => ({ ...it, id: i + 1 }) as HistoryItem);

    expect(rebuilt[rebuilt.length - 1]).toMatchObject({ type: "hint" });

    // 逐项取帧再拼接（与 Static 列表逐项输出同形），断言最后一项（提示）在帧里
    const frame = rebuilt
      .map((it) => {
        const { lastFrame, unmount } = render(
          <UIStateProvider>
            <HistoryItemDisplay item={it} terminalWidth={100} />
          </UIStateProvider>,
        );
        const f = stripAnsi(lastFrame() ?? "");
        unmount();
        return f;
      })
      .join("");
    expect(frame).toContain("本轮以纯文本结束（模型未调用工具）");
    expect(frame).toContain(`${ARROW_PROMPT} `);
    // 禁用彩色 emoji（ui/CLAUDE.md L1.1）
    expect(/\p{Extended_Pictographic}/u.test(PLAIN_TEXT_END_TURN_NOTICE)).toBe(false);
  });

  test("后续再追加消息重建时，提示停留在原位（不漂到末尾、不丢）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "继续。" }] },
    ];
    const side: AnchoredItem[] = [
      { anchor: 2, item: { type: "hint", text: PLAIN_TEXT_END_TURN_NOTICE } },
    ];
    const later: Message[] = [
      ...msgs,
      { role: "user", content: [{ type: "text", text: "继续" }] },
      { role: "assistant", content: [{ type: "text", text: "好的，已完成。" }] },
    ];
    const rebuilt = mergeAnchoredItems(
      messagesToHistoryItems(later),
      side,
      later.length,
      (n) => messagesToHistoryItems(later.slice(0, n)).length,
    );
    const idx = rebuilt.findIndex((it) => it.type === "hint");
    expect(idx).toBe(messagesToHistoryItems(msgs).length);
  });
});

describe("app.ts 路由：persistent 提示不走 system:transient", () => {
  test("info 分支里 persistent 先于 transient 判断，且写进本地侧表", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf8")
      // 去掉行注释，只断言代码
      .replace(/^\s*\/\/.*$/gm, "");
    const persistentAt = src.indexOf("} else if (event.persistent) {");
    const transientAt = src.indexOf('addStatusMessage("system:transient", event.text);');
    expect(persistentAt).toBeGreaterThan(0);
    expect(transientAt).toBeGreaterThan(persistentAt);
    const branch = src.slice(persistentAt, transientAt);
    expect(branch).toContain("appendPersistentHint(event.text)");
    const helperAt = src.indexOf("const appendPersistentHint = ");
    const helper = src.slice(helperAt, helperAt + 600);
    expect(helper).toContain("localCommandItems.push(");
  });
});
