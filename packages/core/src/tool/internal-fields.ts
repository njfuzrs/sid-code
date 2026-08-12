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
 */

/** 内部字段名单：这些字段只应由 harness 注入，绝不接受模型自行生成 */
export const INTERNAL_FIELDS = ["_agentId", "_simulatedSedEdit", "_hookInjected"] as const;

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
