/**
 * D7：MCP 资源工具按「真的有资源」注册。
 *
 * 守两件事：
 * - 没有任何 server 暴露资源时，`ListMcpResources` / `ReadMcpResource` 不进
 *   `activeDefinitions()`（避免白占 883 字节常驻 schema 与 2 个 strict 名额），
 *   但**仍留在注册表里**——历史上下文里的调用不该按名字找不到；
 * - 有 server 暴露资源（`resourceCount > 0`）时它们常驻可见，且不在延迟名单。
 *
 * 不起进程、不连真实 MCP server：`resourceCount` 由 `refreshResources` 在连接后填充，
 * 这里直接注入 `serverStates`，测「判据读的是运行时计数」而不是某个配置开关。
 */

import { describe, expect, test } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { ListMcpResourcesTool, ReadMcpResourceTool } from "@sid-code/core/tool/mcp-resources.ts";

const RESOURCE_TOOLS = ["ListMcpResources", "ReadMcpResource"];

/** 假 manager：工具侧只依赖 hasResources()，不需要真的连上 server */
function fakeManager(hasResources: boolean): MCPManager {
  return { hasResources: () => hasResources } as unknown as MCPManager;
}

function makeRegistry(getManager: () => MCPManager | undefined): Registry {
  const registry = new Registry();
  registry.register(new ListMcpResourcesTool(getManager));
  registry.register(new ReadMcpResourceTool(getManager));
  return registry;
}

describe("MCP 资源工具的 isEnabled 判据（D7）", () => {
  test("manager 尚未就绪 / 没有任何资源时，两个工具不进 schema", () => {
    for (const getManager of [() => undefined, () => fakeManager(false)]) {
      const registry = makeRegistry(getManager);
      const activeNames = registry.activeDefinitions().map((d) => d.name);
      const allNames = registry.definitions().map((d) => d.name);
      for (const name of RESOURCE_TOOLS) {
        expect(activeNames).not.toContain(name);
        expect(allNames).not.toContain(name);
      }
    }
  });

  test("工具仍在注册表里：历史上下文里的调用不按名字找不到", () => {
    const registry = makeRegistry(() => fakeManager(false));
    for (const name of RESOURCE_TOOLS) {
      expect(registry.get(name)?.name()).toBe(name);
    }
  });

  test("有 server 暴露资源时，两个工具常驻出现且不在延迟名单", () => {
    const registry = makeRegistry(() => fakeManager(true));
    const activeNames = registry.activeDefinitions().map((d) => d.name);
    for (const name of RESOURCE_TOOLS) {
      expect(activeNames).toContain(name);
      expect(registry.isDeferred(name)).toBe(false);
    }
  });

  test("每轮重新求值：连接后资源从 0 变 3，下一轮即可见（不是注册时快照）", () => {
    const manager = new MCPManager();
    const registry = makeRegistry(() => manager);

    expect(registry.activeDefinitions().map((d) => d.name)).not.toContain("ListMcpResources");

    // 模拟一次成功的 resources/list：refreshResources 把计数写进 serverStates
    const state = (manager as any).getState("files");
    state.resourceCount = 3;

    const activeNames = registry.activeDefinitions().map((d) => d.name);
    for (const name of RESOURCE_TOOLS) expect(activeNames).toContain(name);
  });

  test("MCPManager.hasResources：无 server 为 false，任一 server 有资源即 true", () => {
    const manager = new MCPManager();
    expect(manager.hasResources()).toBe(false);

    // 0 资源的 server 不改变结论（只有 tools 的 server 是绝大多数）
    (manager as any).getState("tools-only").resourceCount = 0;
    expect(manager.hasResources()).toBe(false);

    (manager as any).getState("files").resourceCount = 1;
    expect(manager.hasResources()).toBe(true);
  });
});
