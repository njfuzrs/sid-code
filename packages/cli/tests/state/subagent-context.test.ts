import { describe, test, expect } from "bun:test";
import { createSubagentContext } from "@sid-code/cli/state/subagent-context.ts";
import { createStore } from "@sid-code/cli/state/store.ts";
import { getDefaultAppState } from "@sid-code/cli/state/app-state.ts";

describe("createSubagentContext", () => {
  test("默认 setAppState 为 no-op", () => {
    const store = createStore(getDefaultAppState());
    const ctx = createSubagentContext(store);

    ctx.setAppState((prev) => ({ ...prev, model: "changed" }));
    expect(store.getState().model).toBe("");
  });

  test("shareSetAppState=true 时共享写入", () => {
    const store = createStore(getDefaultAppState());
    const ctx = createSubagentContext(store, undefined, { shareSetAppState: true });

    ctx.setAppState((prev) => ({ ...prev, model: "shared-model" }));
    expect(store.getState().model).toBe("shared-model");
  });

  test("setAppStateForTasks 始终连接到根 Store", () => {
    const store = createStore(getDefaultAppState());
    const ctx = createSubagentContext(store);

    ctx.setAppStateForTasks((prev) => ({
      ...prev,
      subAgentTasks: {
        ...prev.subAgentTasks,
        "task-1": {
          id: "task-1",
          type: "explore",
          description: "test task",
          status: "running",
          startedAt: Date.now(),
        },
      },
    }));

    expect(store.getState().subAgentTasks["task-1"]).toBeDefined();
    expect(store.getState().subAgentTasks["task-1"].status).toBe("running");
  });

  test("getAppState 读取根 Store 状态", () => {
    const store = createStore(getDefaultAppState());
    store.setState((prev) => ({ ...prev, model: "test-model" }));

    const ctx = createSubagentContext(store);
    expect(ctx.getAppState().model).toBe("test-model");
  });

  test("父 abort 传播到子", () => {
    const store = createStore(getDefaultAppState());
    const parentController = new AbortController();
    const ctx = createSubagentContext(store, parentController.signal);

    let aborted = false;
    ctx.abortController.signal.addEventListener("abort", () => {
      aborted = true;
    });

    parentController.abort("parent cancelled");
    expect(aborted).toBe(true);
    expect(ctx.abortController.signal.aborted).toBe(true);
  });

  test("子 abort 不影响父", () => {
    const store = createStore(getDefaultAppState());
    const parentController = new AbortController();
    const ctx = createSubagentContext(store, parentController.signal);

    ctx.abortController.abort("child cancelled");
    expect(parentController.signal.aborted).toBe(false);
  });
});
