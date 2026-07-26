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

// ============================================================
// P1-2：frontmatter 显式色注册（对齐 CC setAgentColor / agentColorManager）
//
// agent 可在 frontmatter 声明 `color: blue`，注册进此表；TUI 渲染该 agent 的
// 进度/结果行时优先用声明色，未声明走 assignAgentColor 哈希分配（现状行为）。
// ============================================================

/** agentType → 显式声明色 的映射（frontmatter color 注册端）。 */
const explicitAgentColors = new Map<string, AgentColor>();

/** 允许的色名（= PALETTE 的 name 集合），供 frontmatter 校验用。 */
export function isValidAgentColorName(name: string): boolean {
  return PALETTE.some((c) => c.name === name.toLowerCase());
}

/** 按色名查 PALETTE 项（不区分大小写）；未命中返回 undefined。 */
export function getColorByName(name: string): AgentColor | undefined {
  const lower = name.toLowerCase();
  return PALETTE.find((c) => c.name === lower);
}

/**
 * 注册 agent 的显式声明色（P1-2）。
 * 非法色名 → 返回 false（调用方 warn，回退哈希分配）；合法 → 注册并返回 true。
 */
export function setAgentColor(agentType: string, colorName: string): boolean {
  const color = getColorByName(colorName);
  if (!color) return false;
  explicitAgentColors.set(agentType, color);
  return true;
}

/**
 * 获取 agent 的颜色：优先显式声明色（setAgentColor），否则按 agentType 哈希分配。
 * 这是 TUI 渲染 agent 进度/结果行的统一取色入口。
 */
export function getAgentColor(agentType: string): AgentColor {
  return explicitAgentColors.get(agentType) ?? assignAgentColor(agentType);
}

/** 清空显式色注册（测试用）。 */
export function clearExplicitAgentColors(): void {
  explicitAgentColors.clear();
}

/** 用代理颜色包裹文本（ANSI 256 色） */
export function colorize(text: string, color: AgentColor): string {
  return `\x1b[38;5;${color.code}m${text}\x1b[0m`;
}

/**
 * 转成 Ink `<Text color>` 可用的形式（`ansi256(<code>)`）。
 *
 * TUI 组件不该自己拼 ANSI 转义（会被 ink 的宽度计算当成可见字符），
 * 统一走这个入口把 AgentColor 交给 ink 渲染。
 */
export function toInkColor(color: AgentColor): string {
  return `ansi256(${color.code})`;
}

/** agentType → Ink 颜色字符串的直达入口（TUI 渲染取色统一走这里）。 */
export function getAgentInkColor(agentType: string): string {
  return toInkColor(getAgentColor(agentType));
}
