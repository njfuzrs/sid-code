/**
 * 工具进度路由判定回归测试 —— 直接盯住问题三的**根因那一行**
 *
 * 根因（docs/bugfixes/todo/20260803-TUI子代理呈现四问题 §3.3）：app.ts 的
 * onToolProgress 有一道 `isShell` 白名单，只有 bash/shell/execute_command 的进度能进
 * 工具卡片，子代理不在名单里 → 降级成状态栏 2s 一闪 → 用户眼中"跑了 1m35s，屏幕上
 * 一个字都没有"。
 *
 * 这段判定原先是私有方法闭包里的三行 inline 分支，外部拿不到引用 → 零覆盖 → 改坏了
 * 全量单测照样绿（与注入层那次教训同源）。提成 routeToolProgress 后可直接驱动。
 *
 * 铁律：调生产函数，不在测试里重写判定。
 */

import { describe, test, expect } from "bun:test";
import { routeToolProgress, type ToolProgressRouteInput } from "../../src/ui/tool-progress-route.ts";

/** TUI 就绪（两个 sink 都在）的默认场景 */
function input(over: Partial<ToolProgressRouteInput> = {}): ToolProgressRouteInput {
  return {
    toolName: "sub_agent",
    eventType: "agent_progress",
    hasText: false,
    agentSinkReady: true,
    shellSinkReady: true,
    ...over,
  };
}

describe("routeToolProgress — 子代理进度（治过程黑盒）", () => {
  test("agent_progress → agentCard，不再被降级到状态栏", () => {
    expect(routeToolProgress(input())).toBe("agentCard");
  });

  test("判定只看事件类型，不看工具名（避免白名单式漂移）", () => {
    // 将来子代理换个工具名（如 Task / spawn_agent）也不该失效——
    // 按名字二次确认属于重复判据，其中一处漂移就静默失效。
    expect(routeToolProgress(input({ toolName: "Task" }))).toBe("agentCard");
    expect(routeToolProgress(input({ toolName: "whatever" }))).toBe("agentCard");
  });

  test("agent sink 未就绪（无头模式）→ 回落状态栏，不崩", () => {
    expect(routeToolProgress(input({ agentSinkReady: false }))).toBe("statusBar");
  });
});

describe("routeToolProgress — shell 实时输出（既有行为不许回归）", () => {
  test("bash/shell/execute_command 带 text → shellCard", () => {
    for (const name of ["bash", "shell", "execute_command"]) {
      expect(routeToolProgress(input({ toolName: name, eventType: "output", hasText: true }))).toBe("shellCard");
    }
  });

  test("shell 但事件不带 text → 状态栏（没有尾部快照可渲染）", () => {
    expect(routeToolProgress(input({ toolName: "bash", eventType: "output", hasText: false }))).toBe("statusBar");
  });

  test("shell sink 未就绪 → 回落状态栏", () => {
    expect(
      routeToolProgress(input({ toolName: "bash", eventType: "output", hasText: true, shellSinkReady: false })),
    ).toBe("statusBar");
  });

  test("非 shell 工具即使带 text 也不占用 shell 实时输出区", () => {
    // 这条是原白名单**唯一正确**的部分：多行 stdout 尾部快照的渲染形态只适用 shell。
    expect(routeToolProgress(input({ toolName: "web_fetch", eventType: "output", hasText: true }))).toBe("statusBar");
  });
});

describe("routeToolProgress — 其余进度", () => {
  test("MCP 单行进度 → 状态栏 2s 提示（保持原行为）", () => {
    expect(routeToolProgress(input({ toolName: "mcp__foo__bar", eventType: "progress" }))).toBe("statusBar");
  });

  test("agent_progress 优先于 shell 判定（同时满足时不会走错）", () => {
    // 防御性：即便某天 sub_agent 被误起名为 bash 或事件同时带 text，也该走 agentCard
    expect(routeToolProgress(input({ toolName: "bash", eventType: "agent_progress", hasText: true }))).toBe("agentCard");
  });
});
