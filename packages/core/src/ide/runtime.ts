/**
 * IDE diff 运行时共享单例（D1 的接线枢纽）
 *
 * ## 为什么需要这个文件
 *
 * `ide/diff.ts` → `ide/tool-hooks.ts` 这条链**实现完整且正确**，但最外层
 * （`tool/edit.ts` / `tool/write.ts`）**零 import** —— 整条 diff 功能是死代码（D1）。
 *
 * 断层的直接原因是拿不到 `MCPManager`：`EditTool.execute(input)` 只收 input，
 * `ToolUseContext` 里也只有 `mcpClients: unknown[]`（拿不到 manager 本体）。
 *
 * `tool-hooks.ts` 顶部的注释把这个断层**准确地写下来了**：
 *
 * > 「本模块提供可被调用的 diff 展示函数，**由持有 old/new 内容的一方
 * > （编辑工具或其上层）显式调用**」
 *
 * 注释描述的是正确的设计意图 —— **而那个"调用方"就是没实现**。
 * 所以读代码的人不会从注释里发现问题：它读起来完全正常，
 * 它描述的是一个**未完成的计划**。
 *
 * ## 为什么用 holder 而不是改 ToolUseContext
 *
 * 沿用本仓已有的同款范式（`memory/team/runtime.ts` —— `edit.ts` 已经在用它拿
 * 团队记忆配置）：app 启动时注入，工具按需读取。改 `ToolUseContext` 要动
 * 工具执行器、所有 Tool 实现与大量测试夹具，代价与收益不成比例。
 *
 * ## ⚠️ diff 不是"展示"，是一次阻塞的内容协商
 *
 * `DiffResult` 有 `saved{content?}` / `rejected` / `closed` / `unsupported` /
 * `error` 五个分支，说明设计时就知道：用户可以在 diff 视图里**继续手改再保存**，
 * 此时该落盘的是**用户改过的版本**，不是模型生成的那一版。
 * 所以它必须接在**写盘之前**，且返回值必须被消费 —— 不能 fire-and-forget。
 */

import type { MCPManager } from "../mcp/manager.ts";

/** diff 预览的运行时配置 */
export interface IDEDiffRuntime {
  mcpManager: MCPManager;
  /**
   * 是否启用写前 diff 预览。
   *
   * 默认关闭，必须显式开启（`ide.diffPreview: true`）。理由：这个功能会把
   * 每次文件编辑变成**一次等人的交互**，在无人值守/批量场景下会直接把 agent 挂住。
   * 让它默认开启等于把一个便利功能变成一个卡死风险。
   */
  enabled: boolean;
}

let _runtime: IDEDiffRuntime | null = null;

/** app 启动时注入（IDE 连上且 config.ide.diffPreview 开启时） */
export function setIDEDiffRuntime(runtime: IDEDiffRuntime | null): void {
  _runtime = runtime;
}

/**
 * 读取 diff 运行时；未注入或未启用时返回 null。
 *
 * 返回 null 是**正常路径**（没有 IDE、没开开关、跑在无头模式里），
 * 调用方必须能在 null 时完全照旧工作 —— IDE 是可选增强。
 */
export function getIDEDiffRuntime(): IDEDiffRuntime | null {
  if (!_runtime?.enabled) return null;
  return _runtime;
}

/** 复位（测试用） */
export function resetIDEDiffRuntimeForTest(): void {
  _runtime = null;
}
