import { describe, test, expect } from "bun:test";
import { createStore } from "./store.ts";

describe("createStore", () => {
  test("getState 返回初始状态", () => {
    const store = createStore({ count: 0 });
    expect(store.getState()).toEqual({ count: 0 });
  });

  test("setState 更新状态", () => {
    const store = createStore({ count: 0 });
    store.setState(prev => ({ ...prev, count: prev.count + 1 }));
    expect(store.getState().count).toBe(1);
  });

  test("Object.is 短路：返回同一引用时不通知 listener", () => {
    const state = { count: 0 };
    const store = createStore(state);
    let callCount = 0;
    store.subscribe(() => { callCount++; });

    store.setState(prev => prev);
    expect(callCount).toBe(0);
  });

  test("状态变化时通知所有 listener", () => {
    const store = createStore({ count: 0 });
    let callCount = 0;
    store.subscribe(() => { callCount++; });
    store.subscribe(() => { callCount++; });

    store.setState(prev => ({ ...prev, count: 1 }));
    expect(callCount).toBe(2);
  });

  test("unsubscribe 后不再通知", () => {
    const store = createStore({ count: 0 });
    let callCount = 0;
    const unsub = store.subscribe(() => { callCount++; });

    store.setState(prev => ({ ...prev, count: 1 }));
    expect(callCount).toBe(1);

    unsub();
    store.setState(prev => ({ ...prev, count: 2 }));
    expect(callCount).toBe(1);
  });

  test("onChange 回调在 listener 通知前调用", () => {
    const order: string[] = [];
    const store = createStore(
      { count: 0 },
      () => { order.push("onChange"); },
    );
    store.subscribe(() => { order.push("listener"); });

    store.setState(prev => ({ ...prev, count: 1 }));
    expect(order).toEqual(["onChange", "listener"]);
  });

  test("onChange 接收 newState 和 oldState", () => {
    let captured: { newState: any; oldState: any } | null = null;
    const store = createStore(
      { count: 0 },
      (args) => { captured = args; },
    );

    store.setState(prev => ({ ...prev, count: 5 }));
    expect(captured!.oldState.count).toBe(0);
    expect(captured!.newState.count).toBe(5);
  });

  test("并发 setState 不丢失更新", () => {
    const store = createStore({ a: 0, b: 0 });
    store.setState(prev => ({ ...prev, a: 1 }));
    store.setState(prev => ({ ...prev, b: 2 }));
    expect(store.getState()).toEqual({ a: 1, b: 2 });
  });
});
