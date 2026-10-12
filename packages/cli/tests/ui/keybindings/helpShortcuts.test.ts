/**
 * ? 面板触发判定 + Ctrl+K 不再被默认和弦吞掉 的回归测试
 */

import { test, expect, describe } from "bun:test";
import {
  isShortcutsHelpTrigger,
  computeHelpLayout,
  buildHelpSections,
} from "@sid-code/cli/ui/keybindings/helpShortcuts.ts";
import { DEFAULT_BINDINGS } from "@sid-code/cli/ui/keybindings/defaultBindings.ts";
import { ChordMachine, defaultChordBindings } from "@sid-code/cli/ui/keybindings/chord.ts";
import type { Key } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

const qKey = { insertable: true, sequence: "?", ctrl: false, alt: false };

describe("isShortcutsHelpTrigger", () => {
  test("空输入框 + 空闲 + ? → 触发", () => {
    expect(isShortcutsHelpTrigger(qKey, true, false)).toBe(true);
  });

  // 回归：此前判定拿不到输入框内容，句中打 what? 也会弹面板
  test("输入框非空（句中的 ?）→ 不触发，照常插字符", () => {
    expect(isShortcutsHelpTrigger(qKey, false, false)).toBe(false);
  });

  test("输出中 → 不触发", () => {
    expect(isShortcutsHelpTrigger(qKey, true, true)).toBe(false);
  });

  test("其它字符 / 带修饰键 → 不触发", () => {
    expect(isShortcutsHelpTrigger({ ...qKey, sequence: "/" }, true, false)).toBe(false);
    expect(isShortcutsHelpTrigger({ ...qKey, alt: true }, true, false)).toBe(false);
  });
});

describe("computeHelpLayout", () => {
  const sections = buildHelpSections(DEFAULT_BINDINGS);

  test("窄终端退化为单列", () => {
    expect(computeHelpLayout(sections, 40).columns).toBe(1);
  });

  test("宽终端最多 3 列", () => {
    expect(computeHelpLayout(sections, 400).columns).toBe(3);
  });
});

describe("默认和弦不再占用 Ctrl+K", () => {
  // 回归：示例和弦 [Ctrl+K, Ctrl+C] / [Ctrl+K, Ctrl+U] 接进运行时后，Ctrl+K 被当前缀吞掉，
  // InputArea 的 killLine（删到行尾）从未生效。
  test("Ctrl+K 在默认和弦表下返回 none，交给单键分支", () => {
    const m = new ChordMachine(defaultChordBindings);
    const ctrlK: Key = {
      name: "k",
      ctrl: true,
      shift: false,
      alt: false,
      cmd: false,
      insertable: false,
      sequence: "\x0b",
    };
    expect(m.process(ctrlK).type).toBe("none");
    expect(m.isPending()).toBe(false);
  });
});
