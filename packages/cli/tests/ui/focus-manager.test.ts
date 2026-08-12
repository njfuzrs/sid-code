import { describe, expect, test } from "bun:test";
import { FocusManager, type FocusableElement } from "@sid-code/cli/ui/focus/focus-manager.ts";

function elem(id: string, log?: string[]): FocusableElement {
  return {
    id,
    onFocus: () => log?.push(`focus:${id}`),
    onBlur: () => log?.push(`blur:${id}`),
  };
}

describe("FocusManager 基础", () => {
  test("focus 设置 activeElement 并触发 onFocus", () => {
    const log: string[] = [];
    const m = new FocusManager();
    const a = elem("a", log);
    m.focus(a);
    expect(m.activeElement).toBe(a);
    expect(log).toEqual(["focus:a"]);
  });

  test("切换焦点触发旧元素 blur + 新元素 focus", () => {
    const log: string[] = [];
    const m = new FocusManager();
    const a = elem("a", log);
    const b = elem("b", log);
    m.focus(a);
    m.focus(b);
    expect(m.activeElement).toBe(b);
    expect(log).toEqual(["focus:a", "blur:a", "focus:b"]);
  });

  test("重复 focus 同一元素是 no-op", () => {
    const log: string[] = [];
    const m = new FocusManager();
    const a = elem("a", log);
    m.focus(a);
    m.focus(a);
    expect(log).toEqual(["focus:a"]);
  });
});

describe("焦点栈与自动恢复", () => {
  test("对话框关闭后焦点恢复到上一个元素", () => {
    const log: string[] = [];
    const m = new FocusManager();
    const input = elem("input", log);
    const dialog = elem("dialog", log);

    m.focus(input);
    m.focus(dialog);
    log.length = 0;

    m.handleElementRemoved(dialog);
    expect(m.activeElement).toBe(input);
    expect(log).toEqual(["focus:input"]);
  });

  test("多层嵌套:input → d1 → d2,逐层关闭逐层恢复", () => {
    const m = new FocusManager();
    const input = elem("input");
    const d1 = elem("d1");
    const d2 = elem("d2");

    m.focus(input);
    m.focus(d1);
    m.focus(d2);
    expect(m.activeElement).toBe(d2);

    m.handleElementRemoved(d2);
    expect(m.activeElement).toBe(d1);

    m.handleElementRemoved(d1);
    expect(m.activeElement).toBe(input);
  });

  test("移除非活跃元素不改变当前焦点", () => {
    const m = new FocusManager();
    const a = elem("a");
    const b = elem("b");
    m.focus(a);
    m.focus(b);
    m.handleElementRemoved(a); // a 在栈中但非活跃
    expect(m.activeElement).toBe(b);
    // a 已从栈移除:b 关闭后无可恢复
    m.handleElementRemoved(b);
    expect(m.activeElement).toBeNull();
  });

  test("栈去重:重新聚焦已有元素将其移到栈顶,关闭后恢复正确", () => {
    const m = new FocusManager();
    const a = elem("a");
    const b = elem("b");
    m.focus(a);
    m.focus(b);
    m.focus(a); // a 重新到栈顶,栈应为 [b, a]
    expect(m.focusStack.map((e) => e.id)).toEqual(["b", "a"]);
    m.handleElementRemoved(a);
    expect(m.activeElement).toBe(b);
  });

  test("最后一个元素移除后 activeElement 为 null", () => {
    const m = new FocusManager();
    const a = elem("a");
    m.focus(a);
    m.handleElementRemoved(a);
    expect(m.activeElement).toBeNull();
    expect(m.focusStack.length).toBe(0);
  });
});

describe("blur", () => {
  test("blur 恢复到栈中前一个元素", () => {
    const m = new FocusManager();
    const a = elem("a");
    const b = elem("b");
    m.focus(a);
    m.focus(b);
    m.blur();
    expect(m.activeElement).toBe(a);
  });

  test("无焦点时 blur 是 no-op", () => {
    const m = new FocusManager();
    expect(() => m.blur()).not.toThrow();
    expect(m.activeElement).toBeNull();
  });
});

describe("栈上限", () => {
  test("超过 MAX_STACK_SIZE 时丢弃最旧元素", () => {
    const m = new FocusManager();
    const n = FocusManager.MAX_STACK_SIZE;
    const elems = Array.from({ length: n + 5 }, (_, i) => elem(`e${i}`));
    for (const e of elems) m.focus(e);
    expect(m.focusStack.length).toBe(n);
    // 最旧的 5 个被丢弃
    expect(m.focusStack[0].id).toBe("e5");
    expect(m.activeElement?.id).toBe(`e${n + 4}`);
  });
});

describe("Tab 循环", () => {
  const tabbable = [elem("t0"), elem("t1"), elem("t2")];

  test("focusNext 循环前进并回绕", () => {
    const m = new FocusManager();
    m.focus(tabbable[0]);
    m.focusNext(tabbable);
    expect(m.activeElement).toBe(tabbable[1]);
    m.focusNext(tabbable);
    expect(m.activeElement).toBe(tabbable[2]);
    m.focusNext(tabbable); // 回绕
    expect(m.activeElement).toBe(tabbable[0]);
  });

  test("focusPrevious 循环后退并回绕", () => {
    const m = new FocusManager();
    m.focus(tabbable[0]);
    m.focusPrevious(tabbable); // 回绕到末尾
    expect(m.activeElement).toBe(tabbable[2]);
  });

  test("当前焦点不在列表中时,focusNext 从头开始", () => {
    const m = new FocusManager();
    m.focus(elem("outsider"));
    m.focusNext(tabbable);
    expect(m.activeElement).toBe(tabbable[0]);
  });

  test("空列表是 no-op", () => {
    const m = new FocusManager();
    const a = elem("a");
    m.focus(a);
    m.focusNext([]);
    expect(m.activeElement).toBe(a);
  });
});

describe("reset", () => {
  test("清空所有状态", () => {
    const m = new FocusManager();
    m.focus(elem("a"));
    m.reset();
    expect(m.activeElement).toBeNull();
    expect(m.focusStack.length).toBe(0);
  });
});
