/**
 * Hook 指南页核查发现的代码缺陷 B1–B4 回归测试
 * 来源：docs-research/sid-code/bugfixes/todo/20261019-hook文档核查发现的代码缺陷与文档问题.md
 *
 * - B1：systemMessage 此前没有任何用户可见出口；exit 0 纯文本 stdout 也不该被当成告警
 * - B2：sid 独有事件缺 snake_case 映射
 * - B3：UserPromptExpansion 的纯文本 stdout 进上下文
 * - B4：WorktreeCreate / WorktreeRemove 不再被判「未知事件」
 * （B5 在 tests/worktree/worktree-create-output.test.ts）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName, ConfigSource, LEGACY_EVENT_MAP } from "@sid-code/core/hook/types.ts";
import {
  normalizeHooksConfig,
  INTERNAL_HOOK_EVENTS,
} from "@sid-code/core/hook/config-normalize.ts";
import {
  setHookSystemMessageSink,
  resetHookSystemMessagesForTest,
  type HookSystemMessageSink,
} from "@sid-code/core/hook/diagnostic-sink.ts";

function sysWith(event: string, command: string): HookSystem {
  const sys = new HookSystem();
  sys.initializeFromSources([
    { hooks: { [event]: [{ hooks: [{ type: "command", command }] }] }, source: ConfigSource.User },
  ]);
  sys.setSessionId("s");
  return sys;
}

describe("B1：systemMessage 送到用户可见出口", () => {
  let seen: Array<[string, string]>;
  let prev: HookSystemMessageSink | undefined;
  beforeEach(() => {
    resetHookSystemMessagesForTest();
    seen = [];
    prev = setHookSystemMessageSink((ev, text) => seen.push([ev, text]));
  });
  afterEach(() => {
    setHookSystemMessageSink(prev);
    resetHookSystemMessagesForTest();
  });

  test("PostToolUse exit 1 + stderr → 用户看到 hook error 告警", async () => {
    const r = await sysWith("PostToolUse", `echo "lint 没过" >&2; exit 1`).firePostToolUseEvent(
      "write_file",
      { path: "a.ts" },
      { ok: true },
    );
    expect(r.finalOutput?.isBlockingDecision()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("PostToolUse");
    expect(seen[0]![1]).toContain("hook error: lint 没过");
  });

  test("JSON systemMessage 也会展示", async () => {
    await sysWith("PostToolUse", `echo '{"systemMessage":"已记录审计"}'`).firePostToolUseEvent(
      "write_file",
      {},
      {},
    );
    expect(seen.map((s) => s[1])).toEqual(["已记录审计"]);
  });

  test("反面：exit 0 纯文本 stdout 不当告警（否则每个 echo ok 的审计 hook 都刷屏）", async () => {
    const r = await sysWith("PostToolUse", "echo ok").firePostToolUseEvent("write_file", {}, {});
    expect(r.finalOutput?.systemMessage).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  test("反面：丢弃名单里的事件（Notification）不展示", async () => {
    await sysWith("Notification", `echo boom >&2; exit 1`).fireNotificationEvent(
      "permission_prompt",
      "m",
    );
    expect(seen).toHaveLength(0);
  });

  test("sink 注册前产生的消息在注册时补发", async () => {
    setHookSystemMessageSink(undefined);
    await sysWith("PostToolUse", `echo early >&2; exit 1`).firePostToolUseEvent("x", {}, {});
    expect(seen).toHaveLength(0);
    setHookSystemMessageSink((ev, text) => seen.push([ev, text]));
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toContain("early");
  });
});

describe("B2：每个用户可配事件都有 snake_case 映射", () => {
  const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

  test("枚举成员（除内部事件）都能用 snake_case 写法注册", () => {
    const missing = (Object.values(HookEventName) as HookEventName[])
      .filter((e) => !INTERNAL_HOOK_EVENTS.has(e))
      .filter((e) => LEGACY_EVENT_MAP[toSnake(e)] !== e);
    expect(missing).toEqual([]);
  });

  test("after_agent / before_model / after_model 不再告警未知事件", () => {
    for (const key of ["after_agent", "before_model", "after_model"]) {
      const r = normalizeHooksConfig(
        { [key]: [{ hooks: [{ type: "command", command: "true" }] }] },
        ConfigSource.User,
      );
      expect(r.diagnostics).toEqual([]);
      expect(r.entries).toHaveLength(1);
    }
  });
});

describe("B3：UserPromptExpansion 的纯文本 stdout 进上下文", () => {
  test("exit 0 文本 → getAdditionalContext", async () => {
    const r = await sysWith("UserPromptExpansion", "echo 展开补充-7").fireUserPromptExpansionEvent(
      "review",
      "/review",
      "expanded",
    );
    expect(r.finalOutput?.getAdditionalContext()).toBe("展开补充-7");
  });
});

describe("B4：WorktreeCreate / WorktreeRemove 不判未知事件", () => {
  test("PascalCase 写法静默跳过（由 worktree 子系统执行）", () => {
    const r = normalizeHooksConfig(
      {
        WorktreeCreate: [{ type: "command", command: "printf /tmp" }],
        WorktreeRemove: [{ type: "command", command: "true" }],
      },
      ConfigSource.User,
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.entries).toEqual([]);
  });

  test("反面：snake_case 写法 worktree 子系统不认，仍告警", () => {
    const r = normalizeHooksConfig(
      { worktree_create: [{ type: "command", command: "printf /tmp" }] },
      ConfigSource.User,
    );
    expect(r.diagnostics.map((d) => d.message).join()).toContain("未知的事件名");
  });
});
