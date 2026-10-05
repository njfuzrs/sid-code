/**
 * core 的 PLUGIN_MCP_SERVER_PREFIX 必须与 cli 的 PLUGIN_MCP_PREFIX 同值。
 *
 * core 不能依赖 cli（lint:boundary），tool_invoked 的 MCP 归因只能在 core 里复写这个前缀。
 * 两边漂开时不会报任何错，只会让市场插件的 MCP 调用全部静默不计数 —— 所以用这条断言钉住。
 */

import { describe, test, expect } from "bun:test";
import { PLUGIN_MCP_PREFIX, addPluginScopeToServers } from "@sid-code/cli/plugin/scope.ts";
import {
  PLUGIN_MCP_SERVER_PREFIX,
  mcpPluginOrigin,
} from "@sid-code/core/analytics/plugin-attribution.ts";

describe("插件 MCP 作用域前缀：cli ↔ core 一致", () => {
  test("前缀同值", () => {
    expect(PLUGIN_MCP_SERVER_PREFIX).toBe(PLUGIN_MCP_PREFIX);
  });

  test("cli 施加作用域后的 serverName，core 能精确还原插件名", () => {
    const scoped = addPluginScopeToServers({ "files_srv-1": {} as any }, "acme_kit-2");
    const [serverName] = Object.keys(scoped);
    expect(mcpPluginOrigin(serverName!, "echo")).toEqual({
      pluginName: "acme_kit-2",
      component: "mcp",
      pluginTool: "echo",
    });
  });
});
