/**
 * D10：argumentHint 必须走完整条行内补全链路（UnifiedCommand → 屏幕）。
 *
 * 字段级计数拦不住「读了但半路丢了」：此前 /commands 面板读 argumentHint，
 * 让它看起来是活的，而 loadCommandList 的 .map() 在第一跳就把它丢了，
 * 用户敲 /btw 回车被回填后看不到「该填什么」。这里按跳断言，再加一条渲染断言。
 *
 * 同时锁 D6：suggestions.ts 只留 rankCommandInfos 一条真路径，
 * 且它的引用比较缓存在命令列表换新数组后必须跟着变（§8.4 那个前提的机械保障）。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { toCompletionEntries } from "@sid-code/cli/command/completion-list.ts";
import * as suggestions from "@sid-code/cli/command/suggestions.ts";
import { rankCommandInfos } from "@sid-code/cli/command/suggestions.ts";
import { BUILTIN_COMMANDS } from "@sid-code/cli/command/commands/index.ts";
import { buildMcpPromptCommands } from "@sid-code/cli/command/mcp-prompt-commands.ts";
import { SuggestionsDisplay } from "@sid-code/cli/ui/components/SuggestionsDisplay.tsx";
import type { MCPManager } from "@sid-code/core/mcp/manager.ts";

describe("D10：argumentHint 逐跳透传", () => {
  test("每条声明了 argumentHint 的内置命令，在 rankCommandInfos 返回项里该字段非空", () => {
    const entries = toCompletionEntries(BUILTIN_COMMANDS);
    const declared = BUILTIN_COMMANDS.filter(
      (c) => c.argumentHint && !c.isHidden && c.userInvocable !== false,
    );
    // 排除「声明集为空然后全绿」：实测 21 条内置命令声明了 argumentHint
    expect(declared.length).toBeGreaterThan(10);
    for (const c of declared) {
      const hit = rankCommandInfos(entries, c.name, 50).find((r) => r.label === `/${c.name}`);
      expect(hit?.argumentHint).toBe(c.argumentHint);
    }
  });

  test("/bt 的补全里 /btw 带「你的问题」", () => {
    const r = rankCommandInfos(toCompletionEntries(BUILTIN_COMMANDS), "bt");
    const btw = r.find((x) => x.label === "/btw");
    expect(btw?.argumentHint).toBe("你的问题");
    expect(btw?.requiresArgs).toBe(true);
  });

  test("MCP prompt 的必填/选填标记进补全", () => {
    const manager = {
      getAllPrompts: () => [
        {
          serverName: "gh",
          prompt: {
            name: "review",
            arguments: [
              { name: "repo", required: true },
              { name: "pr", required: false },
            ],
          },
        },
      ],
    } as unknown as MCPManager;
    const entries = toCompletionEntries(buildMcpPromptCommands(manager));
    const r = rankCommandInfos(entries, "mcp__gh");
    expect(r[0].argumentHint).toBe("<repo> [pr]");
  });

  test("空串 argumentHint（custom 命令无 frontmatter）归一为 undefined", () => {
    const [e] = toCompletionEntries([
      {
        type: "local",
        name: "x",
        description: "d",
        argumentHint: "",
        load: async () => ({}) as any,
      },
    ]);
    expect(e.argumentHint).toBeUndefined();
  });

  test("SuggestionsDisplay 在命令名后渲染 argumentHint", () => {
    const { lastFrame, unmount } = render(
      <SuggestionsDisplay
        suggestions={[
          { label: "/btw", value: "/btw ", description: "旁路提问", argumentHint: "你的问题" },
        ]}
        activeIndex={0}
        width={80}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    unmount();
    expect(frame).toMatch(/\/btw 你的问题\s+旁路提问/);
  });
});

describe("D6：suggestions.ts 只留一条真路径", () => {
  test("三个零调用导出已删除", () => {
    const mod = suggestions as Record<string, unknown>;
    expect(mod.getCommandSuggestions).toBeUndefined();
    expect(mod.getCategorizedCommands).toBeUndefined();
    expect(mod.clearSuggestionsCache).toBeUndefined();
  });

  test("引用比较缓存：命令列表换新数组后排序结果跟着变", () => {
    const a = [{ name: "alpha", aliases: [], description: "a" }];
    expect(rankCommandInfos(a, "al").map((r) => r.label)).toEqual(["/alpha"]);
    const b = [...a, { name: "alps", aliases: [], description: "b" }];
    expect(rankCommandInfos(b, "al").map((r) => r.label)).toContain("/alps");
    // 回到旧数组，新增项必须消失（不是被缓存粘住）
    expect(rankCommandInfos(a, "al").map((r) => r.label)).toEqual(["/alpha"]);
  });
});

describe("D11：内置命令不声明 disableModelInvocation", () => {
  test("BUILTIN_COMMANDS 上该字段全为 undefined", () => {
    const declared = BUILTIN_COMMANDS.filter((c) => c.disableModelInvocation !== undefined);
    expect(declared.map((c) => c.name)).toEqual([]);
  });
});
