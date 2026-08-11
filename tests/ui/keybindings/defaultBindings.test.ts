/**
 * K1 键位集中声明单测 — defaultBindings
 *
 * 验证「键 → 动作」映射的正确性,以及 action ID 唯一性等表级不变量。
 * 这是 K1 重构的核心安全网:matchBinding 的行为必须与重构前散落的硬编码逐键等价。
 */

import { test, expect, describe } from "bun:test";
import { matchBinding, bindingFor, DEFAULT_BINDINGS } from "@sid-code/cli/ui/keybindings/defaultBindings.ts";
import type { Key } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

const mkKey = (p: Partial<Key>): Key => ({
  name: "",
  shift: false,
  alt: false,
  ctrl: false,
  cmd: false,
  insertable: false,
  sequence: "",
  ...p,
});

describe("K1 — defaultBindings 集中声明", () => {
  test("Ctrl+C 命中 app:quit", () => {
    expect(matchBinding(mkKey({ ctrl: true, name: "c" }))?.action).toBe("app:quit");
  });

  test("裸 c(无 ctrl)不命中 app:quit", () => {
    expect(matchBinding(mkKey({ name: "c" }))?.action).not.toBe("app:quit");
  });

  test("Ctrl+S 命中 app:toggleCopyMode", () => {
    expect(matchBinding(mkKey({ ctrl: true, name: "s" }))?.action).toBe("app:toggleCopyMode");
  });

  test("Alt+M 命中 app:toggleMarkdown", () => {
    expect(matchBinding(mkKey({ alt: true, name: "m" }))?.action).toBe("app:toggleMarkdown");
  });

  test("Ctrl+O 命中 app:toggleHeight", () => {
    expect(matchBinding(mkKey({ ctrl: true, name: "o" }))?.action).toBe("app:toggleHeight");
  });

  test("escape 命中 app:interrupt", () => {
    expect(matchBinding(mkKey({ name: "escape" }))?.action).toBe("app:interrupt");
  });

  test("修饰键必须精确匹配:Ctrl+Alt+M 不命中纯 Alt+M", () => {
    // keystrokeMatches 要求修饰键逐位相等,Ctrl+Alt+M 多了 ctrl,不应命中 Alt+M 的绑定
    expect(matchBinding(mkKey({ ctrl: true, alt: true, name: "m" }))?.action).not.toBe(
      "app:toggleMarkdown",
    );
  });

  test("未注册的键返回 undefined", () => {
    expect(matchBinding(mkKey({ name: "z" }))).toBeUndefined();
  });

  test("每个 action ID 唯一(防重复声明)", () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.action);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("showInHelp 的项都有非空 display 和 description", () => {
    for (const b of DEFAULT_BINDINGS.filter((x) => x.showInHelp)) {
      expect(b.display.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  test("bindingFor 能按 action 反查", () => {
    expect(bindingFor("app:quit")?.stroke).toEqual({ ctrl: true, name: "c" });
    expect(bindingFor("不存在的action")).toBeUndefined();
  });
});
