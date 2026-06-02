/**
 * 子代理颜色身份（Spec 18 §6）
 *
 * 给每个子代理分配稳定的终端颜色，多代理并行时便于在输出中区分。
 * 基于 agentId 哈希取色，保证同一 agent 颜色稳定。
 */

/** 可用的子代理颜色（ANSI 命名色 + 对应 256 色码） */
export interface AgentColor {
  name: string;
  /** ANSI 256 色码 */
  code: number;
}

const PALETTE: AgentColor[] = [
  { name: "cyan", code: 51 },
  { name: "green", code: 46 },
  { name: "yellow", code: 226 },
  { name: "magenta", code: 201 },
  { name: "blue", code: 39 },
  { name: "orange", code: 208 },
  { name: "purple", code: 141 },
  { name: "teal", code: 43 },
];

/** 稳定哈希（FNV-1a） */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 为 agentId 分配稳定颜色 */
export function assignAgentColor(agentId: string): AgentColor {
  const idx = hash(agentId) % PALETTE.length;
  return PALETTE[idx]!;
}

/** 用代理颜色包裹文本（ANSI 256 色） */
export function colorize(text: string, color: AgentColor): string {
  return `\x1b[38;5;${color.code}m${text}\x1b[0m`;
}
