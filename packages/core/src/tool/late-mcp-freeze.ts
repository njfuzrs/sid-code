/**
 * 多代理 F2：一次 queryLoop 内晚到的 MCP 工具不进本轮 schema。
 *
 * `mcpManager.connectAll` 不 await，MCP 工具会在会话首轮之后才进 registry。
 * 延迟加载开着时它们走 deferred 池（mcp__ 默认延迟），首轮 schema 不受影响；
 * 但延迟加载关闭（或 auto 在 MCP 未连上时判为关）时，主循环每轮直接发 `definitions()`，
 * 工具数组在一次任务的中途变长。字典序还会把新工具插到中间，从插入点起整段前缀缓存作废。
 *
 * 做法：queryLoop 开始时记下已有的 MCP 工具名，本次 loop 内只发这一批 MCP 工具；
 * 晚到的从下一条用户消息起可见（模型在本次任务开始时本来也不知道它们）。
 * 只冻结 MCP 这一类变化源——内置工具的 isEnabled 随模式切换（如 plan 模式）是有意的，不能冻。
 * 不缓存 description()：缓存住会让模型看到过期工具集，这里只控制「哪些工具」而不控制字节。
 */

import type { ToolDefinition } from "../llm/types.ts";

const MCP_PREFIX = "mcp__";

/** 取当前定义里的 MCP 工具名快照。 */
export function snapshotMcpToolNames(defs: ToolDefinition[]): Set<string> {
  return new Set(defs.filter((d) => d.name.startsWith(MCP_PREFIX)).map((d) => d.name));
}

/** 过滤掉快照之后才出现的 MCP 工具；返回保留的定义与被暂缓的工具名。 */
export function withholdLateMcpTools(
  defs: ToolDefinition[],
  baseline: ReadonlySet<string>,
): { defs: ToolDefinition[]; withheld: string[] } {
  const withheld: string[] = [];
  const kept = defs.filter((d) => {
    if (!d.name.startsWith(MCP_PREFIX) || baseline.has(d.name)) return true;
    withheld.push(d.name);
    return false;
  });
  return { defs: kept, withheld };
}
