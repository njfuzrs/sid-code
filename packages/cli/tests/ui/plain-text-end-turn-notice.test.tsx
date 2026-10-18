/**
 * S1 L1：「本轮以纯文本结束」提示在 `done` 之后仍在帧里。
 *
 * 旧方案（info → `system:transient` 状态条）会被同一轮 `done` 的
 * removeStatusMessage("system:transient") 清掉。新方案写进历史区并登记到 localCommandItems 侧表；
 * `done` 走 syncDisplay：`assignIds(mergeLocalCommandItems(allMsgs, messagesToHistoryItems(allMsgs)))`
 * 从 ctxMgr 全量重建。这里按同一条重建链路取帧，断言提示仍可见、字形来自 figures、无 emoji。
 *
 * 复审 T7：前两条用例的消息与锚点是手写的，没经过生产事件序列。第三组驱动真实 `queryLoop`，
 * 按 app.ts 的路由在收到 persistent 事件那一刻用 `ctxMgr.getMessages().length` 取锚点
 * （与 `appendPersistentHint` 同口径），`done` 后从同一个 ctxMgr 全量重建 —— 锁住
 * 「提示紧跟在那句承诺之后、在 done 之前到达、重建不丢」。
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
import type {
  AccumulatedResponse,
  ContentBlock,
  Message,
  StreamEvent,
} from "@sid-code/core/llm/types.ts";
import { queryLoop, type QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { clearAllTasks } from "@sid-code/core/task/registry.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import { clearQueue } from "@sid-code/core/query/message-queue-manager.ts";

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

describe("真实 queryLoop 事件序列 → app 路由 → syncDisplay 重建（T7）", () => {
  const PROMISE = "继续。先读取 website 安装的输出，确认安装成功，然后开始逐处修改。";
  async function* emptyStream(): AsyncIterable<StreamEvent> {}
  const tool = (id: string): AccumulatedResponse =>
    ({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "read", input: { file_path: "/tmp/a.ts" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    }) as AccumulatedResponse;
  const text = (t: string): AccumulatedResponse =>
    ({
      role: "assistant",
      content: [{ type: "text", text: t }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    }) as AccumulatedResponse;

  async function run(responses: AccumulatedResponse[]) {
    clearAllTasks();
    dequeuePendingNotifications();
    clearQueue();
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "修正问题然后提 PR" }] });
    let call = 0;
    const deps: QueryDeps = {
      sendWithRetry: () => emptyStream(),
      processStream: async () => responses[call++] ?? text("全部完成，已经提交。"),
      executeTools: async (content) => ({
        results: content
          .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
      }),
      autoCompact: async () => {},
      handleContextOverflow: () => null,
      getAbortSignal: () => undefined,
      uuid: () => `uuid-${call}`,
    };
    const loopConfig: QueryLoopConfig = {
      config: { model: "claude-opus-4-8", provider: "anthropic", maxTurns: 20 } as any,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("t7"),
      fallback: new ModelFallback(),
      deps,
    };
    // app.ts 路由：persistent → appendPersistentHint（anchor = 当时消息数）；done → syncDisplay
    const side: AnchoredItem[] = [];
    const order: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && (ev as any).persistent) {
        side.push({
          anchor: ctxMgr.getMessages().length,
          item: { type: "hint", text: (ev as any).text },
        });
        order.push("hint");
      } else if (ev.kind === "done") order.push("done");
    }
    const all = ctxMgr.getMessages();
    const rebuilt = mergeAnchoredItems(
      messagesToHistoryItems(all),
      side,
      all.length,
      (n) => messagesToHistoryItems(all.slice(0, n)).length,
    );
    return { rebuilt, order };
  }

  const textOf = (it: HistoryItem | any) => JSON.stringify(it);

  test("工具 → 承诺 → nudge → 再承诺：提示在 done 前到达，重建后紧跟最后那句承诺", async () => {
    const { rebuilt, order } = await run([tool("c1"), text(PROMISE), text(PROMISE)]);
    expect(order).toEqual(["hint", "done"]);
    const hints = rebuilt.filter((it) => it.type === "hint");
    expect(hints).toHaveLength(1);
    const idx = rebuilt.findIndex((it) => it.type === "hint");
    // 锚点口径：提示必须落在最后一条 assistant 承诺之后（即重建结果末尾），而不是夹在它前面
    expect(idx).toBe(rebuilt.length - 1);
    expect(textOf(rebuilt[idx - 1])).toContain("先读取 website");
    // nudge 是内部消息：不进历史区
    expect(rebuilt.some((it) => textOf(it).includes("你上一条消息说要继续执行"))).toBe(false);
  });

  test("nudge 后真的调了工具并完成：不出提示", async () => {
    const { rebuilt, order } = await run([tool("c1"), text(PROMISE), tool("c2")]);
    expect(order).toEqual(["done"]);
    expect(rebuilt.some((it) => it.type === "hint")).toBe(false);
  });
});
