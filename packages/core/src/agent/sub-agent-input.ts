/**
 * sub_agent 入参里「子代理类型」的唯一取值入口。
 *
 * 为什么需要它：schema 里的字段名是 `type`，但模型常按 Claude Code 的习惯写成
 * `subagent_type`（2026-10-28 与 2026-11-03 两次实测，deepseek 一次发 3–4 个 explore）。
 * 此前四处各自只读 `input.type`，读不到时的后果全是静默的：
 * - isConcurrencySafe 返回 false → 本该并行的只读子代理被分进串行批次；
 * - execute 兜底成 general-purpose → explore 的只读工具边界失效，子代理拿到写/bash 能力；
 * - TUI header 拿不到类型 → 卡片样式和正常时不一样。
 * 权限层（permission/rules.ts）早就两个名字都认，只有这几处漏了。
 *
 * 所以别名归一化收口到这一个函数，读类型的地方都调它，不要再各写一遍 `input.type`。
 * 这个文件刻意零依赖：TUI 也会 import 它，不能把 agent 定义注册表等重模块带进渲染层。
 *
 * 优先级：`type`（schema 正式字段）> `subagent_type`（CC 命名）> `agentType`（历史轨迹里的旧形态）。
 * 只认非空字符串，空串/非字符串视为未提供，交给调用方的默认值逻辑。
 */
export function resolveSubAgentTypeParam(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ["type", "subagent_type", "agentType"] as const) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}
