import { describe, expect, test } from "bun:test";
import { dispatch, collectPath, addHandler } from "@sid-code/cli/ui/events/dispatcher.ts";
import {
  createEventTarget,
  KeyboardEvent,
  TerminalEvent,
} from "@sid-code/cli/ui/events/terminal-event.ts";
import type { Key } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

function key(name: string): Key {
  return {
    name,
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: true,
    sequence: name,
  };
}

/** 构造 root → mid → leaf 三层树,返回各节点 */
function buildTree() {
  const root = createEventTarget(null);
  const mid = createEventTarget(root);
  const leaf = createEventTarget(mid);
  return { root, mid, leaf };
}

describe("collectPath", () => {
  test("从 target 收集到 root", () => {
    const { root, mid, leaf } = buildTree();
    expect(collectPath(leaf)).toEqual([leaf, mid, root]);
  });

  test("环路保护:不会无限循环", () => {
    const a = createEventTarget(null);
    const b = createEventTarget(a);
    a.parentNode = b; // 人为制造环
    const path = collectPath(b);
    expect(path.length).toBeLessThanOrEqual(2);
  });
});

describe("dispatch 两阶段顺序", () => {
  test("捕获 root→target,冒泡 target→root", () => {
    const { root, mid, leaf } = buildTree();
    const order: string[] = [];

    addHandler(root, "keyboard", () => order.push("root-capture"), "capture");
    addHandler(mid, "keyboard", () => order.push("mid-capture"), "capture");
    addHandler(leaf, "keyboard", () => order.push("leaf-capture"), "capture");
    addHandler(root, "keyboard", () => order.push("root-bubble"), "bubble");
    addHandler(mid, "keyboard", () => order.push("mid-bubble"), "bubble");
    addHandler(leaf, "keyboard", () => order.push("leaf-bubble"), "bubble");

    dispatch(new KeyboardEvent(key("a")), leaf);

    expect(order).toEqual([
      "root-capture",
      "mid-capture",
      "leaf-capture",
      "leaf-bubble",
      "mid-bubble",
      "root-bubble",
    ]);
  });

  test("target 即 root 时也能正常分发", () => {
    const root = createEventTarget(null);
    const order: string[] = [];
    addHandler(root, "keyboard", () => order.push("cap"), "capture");
    addHandler(root, "keyboard", () => order.push("bub"), "bubble");
    dispatch(new KeyboardEvent(key("x")), root);
    expect(order).toEqual(["cap", "bub"]);
  });
});

describe("stopPropagation", () => {
  test("冒泡阶段内层 stopPropagation 阻止外层处理", () => {
    const { root, mid, leaf } = buildTree();
    const order: string[] = [];

    addHandler(
      leaf,
      "keyboard",
      (e) => {
        order.push("leaf");
        e.stopPropagation();
      },
      "bubble",
    );
    addHandler(mid, "keyboard", () => order.push("mid"), "bubble");
    addHandler(root, "keyboard", () => order.push("root"), "bubble");

    const consumed = dispatch(new KeyboardEvent(key("a")), leaf);
    expect(order).toEqual(["leaf"]);
    expect(consumed).toBe(true);
  });

  test("捕获阶段外层 stopPropagation 阻止内层与冒泡", () => {
    const { root, mid, leaf } = buildTree();
    const order: string[] = [];

    addHandler(
      root,
      "keyboard",
      (e) => {
        order.push("root-cap");
        e.stopPropagation();
      },
      "capture",
    );
    addHandler(mid, "keyboard", () => order.push("mid-cap"), "capture");
    addHandler(leaf, "keyboard", () => order.push("leaf-bub"), "bubble");

    dispatch(new KeyboardEvent(key("a")), leaf);
    expect(order).toEqual(["root-cap"]);
  });
});

describe("stopImmediatePropagation", () => {
  test("当前节点剩余 handler 也不执行", () => {
    const root = createEventTarget(null);
    const order: string[] = [];
    addHandler(root, "keyboard", (e) => {
      order.push("h1");
      e.stopImmediatePropagation();
    });
    addHandler(root, "keyboard", () => order.push("h2"));
    dispatch(new KeyboardEvent(key("a")), root);
    expect(order).toEqual(["h1"]);
  });
});

describe("addHandler 注销", () => {
  test("注销函数移除 handler,集合为空时删除 key", () => {
    const node = createEventTarget(null);
    const off = addHandler(node, "keyboard", () => {});
    expect(node.bubbleHandlers.has("keyboard")).toBe(true);
    off();
    expect(node.bubbleHandlers.has("keyboard")).toBe(false);
  });

  test("handler 内部注销其他 handler 不影响本次迭代", () => {
    const node = createEventTarget(null);
    const order: string[] = [];
    let off2 = () => {};
    addHandler(node, "keyboard", () => {
      order.push("h1");
      off2(); // 迭代中删除 h2
    });
    off2 = addHandler(node, "keyboard", () => order.push("h2"));
    dispatch(new KeyboardEvent(key("a")), node);
    // 快照迭代:本次 h2 仍执行
    expect(order).toEqual(["h1", "h2"]);
  });
});

describe("未消费事件", () => {
  test("无 handler 调用 stop/preventDefault → 返回 false", () => {
    const { leaf } = buildTree();
    const consumed = dispatch(new KeyboardEvent(key("a")), leaf);
    expect(consumed).toBe(false);
  });

  test("preventDefault 也算消费", () => {
    const root = createEventTarget(null);
    addHandler(root, "keyboard", (e) => e.preventDefault());
    expect(dispatch(new KeyboardEvent(key("a")), root)).toBe(true);
  });

  test("只触发匹配 type 的 handler", () => {
    const root = createEventTarget(null);
    const order: string[] = [];
    addHandler(root, "click", () => order.push("click"));
    dispatch(new KeyboardEvent(key("a")), root);
    expect(order).toEqual([]);
  });
});

describe("TerminalEvent 基础", () => {
  test("eventPhase 在分发结束后重置为 none", () => {
    const root = createEventTarget(null);
    const ev = new TerminalEvent("keyboard");
    dispatch(ev, root);
    expect(ev.eventPhase).toBe("none");
    expect(ev.currentTarget).toBeNull();
    expect(ev.target).toBe(root);
  });
});
