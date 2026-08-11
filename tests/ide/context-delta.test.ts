/**
 * IDE 上下文增量注入测试（审计第 22 条）
 *
 * 原缺陷：IDE 选区 / @提及 只在 buildInitialSystemPrompt 采集一次，而 IDE 连接是
 * 后台异步的（findAvailableIDE 轮询至 30s 超时）→ 启动瞬间 status 必然还不是
 * connected，collectIDEContext() 恒返回 {}；两处 rebuildSystemPrompt 也不采集。
 * 净效果：IDE 上下文基本永远进不了模型。
 *
 * 修复后走 drainIDEContextDelta（每轮 query loop 调一次，经 reminderParts 注入
 * user 消息）。这组测试覆盖：连接后能拿到、选区去重、选区变更重注、@提及消费语义、
 * 断连复位、以及「未连接返回 null」这个原缺陷的复现点。
 *
 * 隔离：用 fake MCPManager + fake MCPClient 驱动通知，不依赖真实 IDE。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  IDEIntegration,
  getIDEIntegration,
  resetIDEIntegration,
  collectIDEContext,
  drainIDEContextDelta,
  _resetIDEContextDeltaForTesting,
} from "@sid-code/core/ide/integration.ts";
import type { MCPManager } from "@sid-code/core/mcp/manager.ts";
import type { MCPClient } from "@sid-code/core/mcp/client.ts";

/** 通知回调表：method → handlers */
type Handlers = Map<string, ((params: unknown) => void)[]>;

function makeFakeClient(handlers: Handlers): MCPClient {
  return {
    onNotification(method: string, handler: (params: unknown) => void) {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
      return () => {
        const cur = handlers.get(method) ?? [];
        handlers.set(method, cur.filter((h) => h !== handler));
      };
    },
  } as unknown as MCPClient;
}

function makeFakeManager(client: MCPClient): MCPManager {
  return {
    addServer: async () => [],
    isConnected: () => true,
    getClient: () => client,
    removeServer: async () => {},
  } as unknown as MCPManager;
}

let handlers: Handlers;
let integration: IDEIntegration;

/** 触发一条 IDE 通知 */
function notify(method: string, params: unknown): void {
  for (const h of handlers.get(method) ?? []) h(params);
}

function emitSelection(filePath: string, text: string, startLine = 0): void {
  notify("notifications/selection_changed", {
    filePath,
    text,
    selection: {
      start: { line: startLine, character: 0 },
      end: { line: startLine + 2, character: 5 },
    },
  });
}

beforeEach(async () => {
  resetIDEIntegration();
  _resetIDEContextDeltaForTesting();
  handlers = new Map();
  const client = makeFakeClient(handlers);
  // 经单例工厂创建，drainIDEContextDelta 读的是同一个实例
  integration = getIDEIntegration(makeFakeManager(client), "/tmp/ide-test")!;
});

afterEach(() => {
  resetIDEIntegration();
  _resetIDEContextDeltaForTesting();
});

/** 连上 IDE（走 connectToIDE 真实路径，注册通知处理器） */
async function connect(): Promise<void> {
  const ok = await integration.connectToIDE({
    name: "vscode",
    url: "ws://127.0.0.1:1234",
    authToken: "t",
  } as any);
  expect(ok).toBe(true);
  expect(integration.getStatus().status).toBe("connected");
}

describe("drainIDEContextDelta — 未连接时（原缺陷的复现点）", () => {
  test("未连接返回 null", () => {
    expect(drainIDEContextDelta()).toBeNull();
  });

  test("未连接时 collectIDEContext 也是空对象——这正是启动时采集恒失效的原因", () => {
    // buildInitialSystemPrompt 在启动瞬间调用它，那一刻必然还没连上
    expect(collectIDEContext()).toEqual({});
  });
});

describe("drainIDEContextDelta — 选区", () => {
  test("连接后有选区 → 注入 <ide-selection>", async () => {
    await connect();
    emitSelection("/tmp/x.ts", "const a = 1;");

    const delta = drainIDEContextDelta();
    expect(delta).not.toBeNull();
    expect(delta!).toContain("<ide-selection>");
    expect(delta!).toContain("const a = 1;");
    expect(delta!).toContain("/tmp/x.ts");
  });

  test("选区未变 → 第二轮不重复注入（cache 友好 + 不刷屏）", async () => {
    await connect();
    emitSelection("/tmp/x.ts", "const a = 1;");
    expect(drainIDEContextDelta()).not.toBeNull();
    expect(drainIDEContextDelta()).toBeNull();
    expect(drainIDEContextDelta()).toBeNull();
  });

  test("选区变更 → 重新注入新内容", async () => {
    await connect();
    emitSelection("/tmp/x.ts", "const a = 1;");
    drainIDEContextDelta();

    emitSelection("/tmp/x.ts", "const b = 2;");
    const delta = drainIDEContextDelta();
    expect(delta).not.toBeNull();
    expect(delta!).toContain("const b = 2;");
    expect(delta!).not.toContain("const a = 1;");
  });

  test("连接晚于首轮也能拿到——这是本条修复的核心", async () => {
    // 第 1、2 轮：尚未连上（模拟后台 startAutoConnect 还在轮询）
    expect(drainIDEContextDelta()).toBeNull();
    expect(drainIDEContextDelta()).toBeNull();
    // 第 3 轮之前连上并选中代码
    await connect();
    emitSelection("/tmp/late.ts", "late selection");
    expect(drainIDEContextDelta()!).toContain("late selection");
  });
});

describe("drainIDEContextDelta — @提及（消费语义）", () => {
  test("有提及 → 注入 <ide-mentions> 并清空", async () => {
    await connect();
    notify("notifications/at_mentioned", { filePath: "/tmp/y.ts", lineStart: 2, lineEnd: 8 });

    const delta = drainIDEContextDelta();
    expect(delta!).toContain("<ide-mentions>");
    expect(delta!).toContain("/tmp/y.ts:3-9"); // 0-based → 1-based
    // 消费语义：取过即清空
    expect(drainIDEContextDelta()).toBeNull();
  });

  test("选区与提及同轮 → 两块都注入", async () => {
    await connect();
    emitSelection("/tmp/x.ts", "sel-text");
    notify("notifications/at_mentioned", { filePath: "/tmp/y.ts" });

    const delta = drainIDEContextDelta()!;
    expect(delta).toContain("<ide-selection>");
    expect(delta).toContain("<ide-mentions>");
  });
});

describe("drainIDEContextDelta — 断开连接", () => {
  test("断开后返回 null，重连后重新注入当前选区", async () => {
    await connect();
    emitSelection("/tmp/x.ts", "keep-me");
    expect(drainIDEContextDelta()).not.toBeNull();

    await integration.disconnect();
    expect(drainIDEContextDelta()).toBeNull();

    // 重连并重新选中同样内容：指纹已复位 → 应再次注入（模型的上下文已随断连失效）
    await connect();
    emitSelection("/tmp/x.ts", "keep-me");
    expect(drainIDEContextDelta()!).toContain("keep-me");
  });
});
