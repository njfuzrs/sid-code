/**
 * K3 键位校验 + K2 合并逻辑单测
 *
 * 覆盖：
 * - validateUserBindings：schema 校验、保留键保护、冲突检测、重复 action
 * - mergeBindings：用户覆盖默认、stroke 抢占移除旧默认、新增追加
 * - isReservedStroke / strokeSignature
 */

import { test, expect, describe } from "bun:test";
import {
  validateUserBindings,
  formatStroke,
  type BindingIssue,
} from "@sid-code/cli/ui/keybindings/validate.ts";
import {
  isReservedStroke,
  strokeSignature,
} from "@sid-code/cli/ui/keybindings/reservedShortcuts.ts";
import { mergeBindings } from "@sid-code/cli/ui/keybindings/loadUserBindings.ts";
import { DEFAULT_BINDINGS, matchBinding, type KeyBinding } from "@sid-code/cli/ui/keybindings/defaultBindings.ts";
import type { Key } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

function key(name: string, mods: Partial<Key> = {}): Key {
  return {
    name,
    ctrl: false,
    shift: false,
    alt: false,
    cmd: false,
    insertable: false,
    sequence: "",
    ...mods,
  };
}

describe("K3 — strokeSignature / isReservedStroke", () => {
  test("签名对修饰键稳定且 name 小写", () => {
    expect(strokeSignature({ ctrl: true, name: "K" })).toBe("C+k");
    expect(strokeSignature({ name: "enter" })).toBe("+enter");
    expect(strokeSignature({ ctrl: true, shift: true, alt: true, cmd: true, name: "x" })).toBe(
      "CSAM+x",
    );
  });

  test("Ctrl+C / enter / tab / Ctrl+D 是保留键", () => {
    expect(isReservedStroke({ ctrl: true, name: "c" })).toBe(true);
    expect(isReservedStroke({ ctrl: true, name: "d" })).toBe(true);
    expect(isReservedStroke({ name: "enter" })).toBe(true);
    expect(isReservedStroke({ name: "tab" })).toBe(true);
  });

  test("非保留键返回 false", () => {
    expect(isReservedStroke({ ctrl: true, name: "k" })).toBe(false);
    expect(isReservedStroke({ alt: true, name: "m" })).toBe(false);
  });
});

describe("K3 — validateUserBindings schema", () => {
  test("结构非法（缺 stroke）报 schema 错误", () => {
    const { accepted, issues } = validateUserBindings(
      [{ action: "foo" }],
      DEFAULT_BINDINGS,
    );
    expect(accepted).toHaveLength(0);
    expect(issues.some((i: BindingIssue) => i.code === "schema")).toBe(true);
  });

  test("接受 { bindings: [...] } 包裹形式", () => {
    const { accepted, issues } = validateUserBindings(
      { bindings: [{ action: "my:action", stroke: { alt: true, name: "g" } }] },
      DEFAULT_BINDINGS,
    );
    expect(issues.filter((i: BindingIssue) => i.level === "error")).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].action).toBe("my:action");
  });

  test("空 action 报错", () => {
    const { issues } = validateUserBindings(
      [{ action: "", stroke: { name: "g" } }],
      DEFAULT_BINDINGS,
    );
    expect(issues.some((i: BindingIssue) => i.code === "schema")).toBe(true);
  });
});

describe("K3 — 保留键保护", () => {
  test("把 Ctrl+C 重绑到别的 action 被拒", () => {
    const { accepted, issues } = validateUserBindings(
      [{ action: "my:evil", stroke: { ctrl: true, name: "c" } }],
      DEFAULT_BINDINGS,
    );
    expect(accepted).toHaveLength(0);
    expect(issues.some((i: BindingIssue) => i.code === "reserved")).toBe(true);
  });

  test("把 Ctrl+C 绑回 app:quit（原 action）被豁免", () => {
    const { accepted, issues } = validateUserBindings(
      [{ action: "app:quit", stroke: { ctrl: true, name: "c" } }],
      DEFAULT_BINDINGS,
    );
    expect(issues.filter((i: BindingIssue) => i.code === "reserved")).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });
});

describe("K3 — 冲突检测", () => {
  test("两个 action 抢同一组合键报 conflict 错误", () => {
    const { accepted, issues } = validateUserBindings(
      [
        { action: "a:one", stroke: { alt: true, name: "g" } },
        { action: "a:two", stroke: { alt: true, name: "g" } },
      ],
      DEFAULT_BINDINGS,
    );
    // 第一个被接受，第二个冲突丢弃
    expect(accepted).toHaveLength(1);
    expect(accepted[0].action).toBe("a:one");
    expect(issues.some((i: BindingIssue) => i.code === "conflict")).toBe(true);
  });

  test("同 action 重复出现：后者覆盖，记 warning", () => {
    const { accepted, issues } = validateUserBindings(
      [
        { action: "a:one", stroke: { alt: true, name: "g" } },
        { action: "a:one", stroke: { alt: true, name: "h" } },
      ],
      DEFAULT_BINDINGS,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].stroke.name).toBe("h");
    expect(issues.some((i: BindingIssue) => i.code === "duplicate_action")).toBe(true);
  });
});

describe("K3 — formatStroke", () => {
  test("组合键人类可读", () => {
    expect(formatStroke({ ctrl: true, shift: true, name: "k" })).toBe("Ctrl+Shift+K");
    expect(formatStroke({ name: "enter" })).toBe("Enter");
    expect(formatStroke({ alt: true, name: "m" })).toBe("Alt+M");
  });
});

describe("K2 — mergeBindings", () => {
  test("用户按 action 覆盖默认（同 action 改 stroke）", () => {
    const userBindings = [
      {
        action: "app:toggleMarkdown",
        stroke: { alt: true, name: "n" },
        display: "Alt+N",
        description: "切换 Markdown 渲染",
        showInHelp: true,
      },
    ];
    const merged = mergeBindings(userBindings);
    const found = merged.filter((b: KeyBinding) => b.action === "app:toggleMarkdown");
    expect(found).toHaveLength(1);
    expect(found[0].stroke.name).toBe("n");
  });

  test("用户抢占某 stroke 时，原默认持有者被移除（防一键双义）", () => {
    // 把 Alt+M（默认属 toggleMarkdown）抢给新 action
    const userBindings = [
      {
        action: "my:custom",
        stroke: { alt: true, name: "m" },
        display: "Alt+M",
        description: "自定义",
        showInHelp: true,
      },
    ];
    const merged = mergeBindings(userBindings);
    // Alt+M 现在只匹配 my:custom，不再匹配 toggleMarkdown
    const matched = matchBinding(key("m", { alt: true }), merged);
    expect(matched?.action).toBe("my:custom");
    // 默认的 toggleMarkdown 因 stroke 被抢已移除
    expect(merged.some((b: KeyBinding) => b.action === "app:toggleMarkdown")).toBe(false);
  });

  test("用户新增 action 追加到表尾", () => {
    const userBindings = [
      {
        action: "my:new",
        stroke: { ctrl: true, shift: true, name: "p" },
        display: "Ctrl+Shift+P",
        description: "命令面板",
        showInHelp: true,
      },
    ];
    const merged = mergeBindings(userBindings);
    expect(merged.length).toBe(DEFAULT_BINDINGS.length + 1);
    expect(merged[merged.length - 1].action).toBe("my:new");
  });

  test("空用户绑定返回默认表副本", () => {
    const merged = mergeBindings([]);
    expect(merged).toEqual(DEFAULT_BINDINGS);
  });
});
