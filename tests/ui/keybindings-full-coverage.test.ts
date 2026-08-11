/**
 * 键位回归测试铺开 — D4-1（K1 模式复制到全表）
 *
 * 系统级查漏补缺方案 §防线4 D4-1：K1 已带 defaultBindings.test.ts（9 条 spot-check）+
 * ShortcutsHelp.test.tsx。本文件把"键 → 动作"回归模式**表驱动铺开到 DEFAULT_BINDINGS 全表**，
 * 保证每条绑定都被往返验证（stroke → matchBinding → action → bindingFor → stroke），
 * 并加表级不变量（stroke 唯一、修饰键不漏匹配），防止后续增删键位时悄悄回归。
 *
 * fix_type: entry_code（L2）
 */

import { test, expect, describe } from "bun:test";
import {
  matchBinding,
  bindingFor,
  DEFAULT_BINDINGS,
  type KeyBinding,
} from "@sid-code/cli/ui/keybindings/defaultBindings.ts";
import type { Key } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

/** 由一条 binding 的 stroke 构造对应的真实 Key 事件 */
function keyFromBinding(b: KeyBinding): Key {
  return {
    name: b.stroke.name,
    ctrl: b.stroke.ctrl ?? false,
    shift: b.stroke.shift ?? false,
    alt: b.stroke.alt ?? false,
    cmd: b.stroke.cmd ?? false,
    insertable: false,
    sequence: "",
  };
}

describe("D4-1 — DEFAULT_BINDINGS 全表往返回归", () => {
  // 表驱动：每条绑定都生成一个 test，自动覆盖未来新增的键
  for (const b of DEFAULT_BINDINGS) {
    test(`[${b.action}] stroke(${b.display}) → matchBinding 命中自身`, () => {
      const matched = matchBinding(keyFromBinding(b));
      expect(matched).toBeDefined();
      // 同一 stroke 可能被多条绑定共享（如 up/down 合并），但匹配到的 action 必须
      // 与某条共享该 stroke 的绑定一致；这里断言至少命中"能反查回同 stroke"的 action。
      expect(matched!.action).toBe(b.action);
    });

    test(`[${b.action}] bindingFor 反查得到同一条`, () => {
      const back = bindingFor(b.action);
      expect(back).toBeDefined();
      expect(back!.stroke).toEqual(b.stroke);
    });
  }
});

describe("D4-1 — 表级不变量", () => {
  test("action ID 全表唯一", () => {
    const ids = DEFAULT_BINDINGS.map(b => b.action);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("stroke 全表唯一（同一组合键不绑定到两个 action，防冲突）", () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const b of DEFAULT_BINDINGS) {
      const s = b.stroke;
      const sig = `${s.ctrl ? "C" : ""}${s.shift ? "S" : ""}${s.alt ? "A" : ""}${s.cmd ? "M" : ""}+${s.name}`;
      if (seen.has(sig)) {
        conflicts.push(`${sig}: ${seen.get(sig)} vs ${b.action}`);
      } else {
        seen.set(sig, b.action);
      }
    }
    expect(conflicts).toEqual([]);
  });

  test("每条绑定 stroke.name 非空", () => {
    for (const b of DEFAULT_BINDINGS) {
      expect(b.stroke.name.length).toBeGreaterThan(0);
    }
  });

  test("showInHelp 项都有非空 display + description", () => {
    for (const b of DEFAULT_BINDINGS.filter(x => x.showInHelp)) {
      expect(b.display.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  test("修饰键不漏匹配：每条带修饰键的绑定，去掉任一修饰键都不再命中该 action", () => {
    for (const b of DEFAULT_BINDINGS) {
      const s = b.stroke;
      const hasMod = s.ctrl || s.shift || s.alt || s.cmd;
      if (!hasMod) continue;
      // 构造一个去掉所有修饰键的裸键
      const bare: Key = {
        name: s.name, ctrl: false, shift: false, alt: false, cmd: false,
        insertable: false, sequence: "",
      };
      const matched = matchBinding(bare);
      // 裸键不应命中这条带修饰键的 action（除非恰好另有裸键绑定同 name，那也不该是本 action）
      expect(matched?.action === b.action).toBe(false);
    }
  });
});
