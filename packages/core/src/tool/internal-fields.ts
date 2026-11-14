/**
 * GAP-08：防御性输入清理（内部字段剥离）
 *
 * 对标 claude-code toolExecution.ts 在执行前显式剥离内部字段（如 _simulatedSedEdit），
 * 即使 Zod schema 的 strictObject 理论上已拒绝它——"safeguard against future regressions"。
 *
 * 纵深防御原则：不信任 schema 层一定能拦住（并非所有工具都用 strict schema，
 * 部分工具走 passthrough），在执行层再加一道，防止模型伪造内部字段（如 _agentId
 * 绕过子代理套娃检测）。
 *
 * 说明：子代理执行器在校验通过后需要**主动注入** _agentId="sub-agent" 防套娃。
 * 因此正确顺序是「先剥离模型可能伪造的内部字段 → 再由执行器注入受控的 _agentId」，
 * stripInternalFields 只负责剥离，注入由调用方在其后完成。
 *
 * ⚠️ 注入是**按需**的（2026-11-04 起）：只有自报 `consumesAgentId: true` 的工具
 * （`enter_plan_mode` / `sub_agent` / `save_memory`）才拿得到 `_agentId` /
 * `_parentToolUseId`，契约见 `tool/types.ts`。无差别注入会把内部字段漏给
 * StructuredOutput 的 JSON Schema 校验、workflow 的结果、以及 MCP server 的 arguments。
 * 本模块的剥离职责不变——它对**所有**工具都生效，防的是模型伪造。
 */

/** 内部字段名单：这些字段只应由 harness 注入，绝不接受模型自行生成 */
export const INTERNAL_FIELDS = [
  "_agentId",
  "_simulatedSedEdit",
  "_hookInjected",
  // E1（2026-10-14）：派发子代理的那次 sub_agent 调用 id，由执行器在剥离后注入。
  // 模型伪造它会让 SubagentStart.parent_tool_use_id 指向别的调用，关联键就失真了。
  "_parentToolUseId",
  // R3（2026-11-12）：**本次**工具调用 id，由执行器在剥离后注入给自报
  // `consumesToolUseId: true` 的工具（bash / monitor）。它们把 id 存进后台任务，
  // 让完成通知带 `<tool-use-id>` —— 模型因此能核对「这条通知对应我哪一次调用」，
  // 而不是把上一轮的旧通知当成刚挂的这次等待的结果。
  // 必须剥离：模型伪造它会让通知指向别的调用，锚点反而变成误导。
  "_toolUseId",
  // P0-2（MD2）：本次 fork 的后台任务标签（memory-extract / auto-dream / …），由
  // runForkedAgent 剥离后注入给自报 `consumesQuerySource: true` 的工具。
  // 必须剥离：save_memory 的 feedback 原话闸门只对 memory-extract 生效，
  // 模型若能伪造它，就能把自己的写入伪装成主会话路径，闸门等于没有。
  "_querySource",
] as const;

/**
 * 剥离 input 中的内部字段，返回浅拷贝（不改原对象）。
 * 非对象输入（null/数组/原始值）原样返回。
 */
export function stripInternalFields(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const cleaned: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const field of INTERNAL_FIELDS) {
    delete cleaned[field];
  }
  return cleaned;
}
