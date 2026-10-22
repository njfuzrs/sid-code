/**
 * DialogSwitch 的浮层分支必须包在 Transient 里，Composer 不能包。
 *
 * 为什么锁这一层：主屏关闭对话框后整帧重画（复原打开时顶进 scrollback 的历史）的判定只认 Transient 标记
 * （底座 ink.tsx diffFrame）。漏包 → 关闭后留一整块与对话框等高的空白；把 Composer 也包进去 →
 * 帧里恒有浮层，判定永远不成立，同样留白。两种错法测试都要红。
 *
 * 变异自证：DialogSwitch 去掉 Transient 包裹 → 「/model」用例红；去掉 Composer 判断 → 「Composer」用例红。
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { DialogSwitch } from "@sid-code/cli/ui/components/DialogSwitch.tsx";
import { Composer } from "@sid-code/cli/ui/components/Composer.tsx";
import { ModelDialog } from "@sid-code/cli/ui/components/ModelDialog.tsx";
import { CommandOutputDialog } from "@sid-code/cli/ui/components/CommandOutputDialog.tsx";
import { Transient } from "@sid-code/cli/ui/render-port/components.ts";

const noop = () => {};
const base = {
  permissionRequest: null,
  shellConfirmRequest: null,
  planApprovalRequest: null,
  askUserQuestionRequest: null,
  conflictRequest: null,
  activeDialog: null,
  commandPanel: null,
  onCommandPanelClose: noop,
  onDialogClose: noop,
  availableModels: [],
  onModelSelect: noop,
  availableThemes: [],
  currentTheme: "dark",
  onThemeSelect: noop,
  onLanguageSelect: noop,
  model: "m",
  callbacks: {},
  usage: { inputTokens: 0, outputTokens: 0 },
  stockInputTokens: 0,
  costUSD: 0,
  costLimit: 0,
  contextPercent: 0,
  provider: "p",
  onSubmit: noop,
  isLoading: false,
  commands: [],
  cwd: "/tmp",
  isEmpty: false,
} as unknown as Parameters<typeof DialogSwitch>[0];

const call = (over: Record<string, unknown>) =>
  (DialogSwitch as (p: unknown) => React.ReactElement | null)({ ...base, ...over });

describe("DialogSwitch：浮层包 Transient，Composer 不包", () => {
  test("/model 对话框包在 Transient 里", () => {
    const el = call({ activeDialog: "model" })!;
    expect(el.type).toBe(Transient);
    expect((el.props as { children: React.ReactElement }).children.type).toBe(ModelDialog);
  });

  test("命令输出面板包在 Transient 里", () => {
    const el = call({ commandPanel: { title: "t", lines: ["a", "b", "c"] } })!;
    expect(el.type).toBe(Transient);
    expect((el.props as { children: React.ReactElement }).children.type).toBe(CommandOutputDialog);
  });

  test("Composer（含 activeDialog 缺依赖落回 Composer）不包", () => {
    expect(call({})!.type).toBe(Composer);
    // "hooks" 缺 callbacks.hookSystem → 落回 Composer
    expect(call({ activeDialog: "hooks" })!.type).toBe(Composer);
  });

  test("mcp-approval 队列为空返回 null，不包空壳", () => {
    expect(call({ activeDialog: "mcp-approval" })).toBeNull();
  });
});
