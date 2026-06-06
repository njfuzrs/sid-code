/**
 * 交互状态机测试 — D4-3
 *
 * 系统级查漏补缺方案 §防线4 D4-3：测关键交互状态机（Copy Mode 切换、Esc 中断守卫、
 * 和弦序列）。此前 src/ui 交互逻辑几乎裸奔。
 *
 * 测试策略：交互的核心是"按键 → 动作"的纯状态转移，把它和渲染解耦后可稳定断言：
 *   1. 键位分发：构造 Key 事件 → matchBinding → 命中正确 action（Copy Mode / Esc 中断 / 退出）
 *   2. ChordMachine：idle → chord_started → match / cancel / expire 的状态转移
 *   3. 修饰键精确匹配：裸键不误命中带修饰键的绑定（防 Ctrl+S 误匹配裸 s）
 *
 * 这覆盖了 useInput 背后真正的决策逻辑，比断言渲染帧更稳（不受 spinner/颜色码干扰）。
 * fix_type: entry_code（L2）
 */

import { test, expect, describe } from "bun:test";
import { matchBinding, bindingFor } from "../../src/ui/keybindings/defaultBindings.ts";
import { ChordMachine, defaultChordBindings } from "../../src/ui/keybindings/chord.ts";
import type { Key } from "../../src/ui/contexts/KeypressContext.tsx";

/** 构造一个 Key 事件（默认无修饰键） */
function key(name: string, mods: Partial<Pick<Key, "ctrl" | "shift" | "alt" | "cmd">> = {}): Key {
  return {
    name,
    ctrl: mods.ctrl ?? false,
    shift: mods.shift ?? false,
    alt: mods.alt ?? false,
    cmd: mods.cmd ?? false,
    insertable: false,
    sequence: "",
  };
}

describe("D4-3 — 键位分发状态机", () => {
  test("Ctrl+S → app:toggleCopyMode（Copy Mode 切换）", () => {
    const b = matchBinding(key("s", { ctrl: true }));
    expect(b?.action).toBe("app:toggleCopyMode");
  });

  test("Esc → app:interrupt（中断守卫）", () => {
    const b = matchBinding(key("escape"));
    expect(b?.action).toBe("app:interrupt");
  });

  test("Ctrl+C → app:quit（退出）", () => {
    const b = matchBinding(key("c", { ctrl: true }));
    expect(b?.action).toBe("app:quit");
  });

  test("Alt+M → app:toggleMarkdown", () => {
    const b = matchBinding(key("m", { alt: true }));
    expect(b?.action).toBe("app:toggleMarkdown");
  });

  test("修饰键精确匹配：裸 s 不命中 Ctrl+S 绑定", () => {
    // 防御本次同类陷阱——裸键误匹配带修饰键的绑定会导致 Copy Mode 被误触
    expect(matchBinding(key("s"))).toBeUndefined();
  });

  test("修饰键精确匹配：裸 c 不命中 Ctrl+C（退出）绑定", () => {
    expect(matchBinding(key("c"))).toBeUndefined();
  });

  test("未注册键返回 undefined（不误触发）", () => {
    expect(matchBinding(key("z"))).toBeUndefined();
    expect(matchBinding(key("f5"))).toBeUndefined();
  });

  test("bindingFor：按 action 反查得到正确 display", () => {
    expect(bindingFor("app:quit")?.display).toBe("Ctrl+C");
    expect(bindingFor("app:interrupt")?.display).toBe("Esc");
    expect(bindingFor("app:toggleCopyMode")?.display).toBe("Ctrl+S");
  });
});

describe("D4-3 — ChordMachine 状态机", () => {
  test("初始状态 idle：isPending=false", () => {
    const m = new ChordMachine(defaultChordBindings);
    expect(m.isPending()).toBe(false);
  });

  test("和弦前缀键 → chord_started，进入 pending", () => {
    const m = new ChordMachine(defaultChordBindings);
    const r = m.process(key("k", { ctrl: true })); // Ctrl+K 是 Ctrl+K Ctrl+C 的前缀
    expect(r.type).toBe("chord_started");
    expect(m.isPending()).toBe(true);
  });

  test("完整和弦序列 Ctrl+K Ctrl+C → match editor:copyLine", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(key("k", { ctrl: true }));
    const r = m.process(key("c", { ctrl: true }));
    expect(r.type).toBe("match");
    if (r.type === "match") expect(r.action).toBe("editor:copyLine");
    // 匹配后回到 idle
    expect(m.isPending()).toBe(false);
  });

  test("和弦第二键不匹配 → cancel，并 replay 该键", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(key("k", { ctrl: true }));
    const r = m.process(key("z")); // z 不是任何 Ctrl+K 和弦的第二键
    expect(r.type).toBe("cancel");
    if (r.type === "cancel") expect(r.replayKey.name).toBe("z");
    expect(m.isPending()).toBe(false);
  });

  test("expire：pending 中超时 → 返回 replayKey 并回 idle", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(key("k", { ctrl: true }));
    expect(m.isPending()).toBe(true);
    const expired = m.expire();
    expect(expired).not.toBeNull();
    expect(expired!.replayKey.name).toBe("k");
    expect(m.isPending()).toBe(false);
  });

  test("非前缀单键 → none（不消费）", () => {
    const m = new ChordMachine(defaultChordBindings);
    const r = m.process(key("x"));
    expect(r.type).toBe("none");
    expect(m.isPending()).toBe(false);
  });

  test("reset：强制回 idle 不返回键", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(key("k", { ctrl: true }));
    m.reset();
    expect(m.isPending()).toBe(false);
  });
});
