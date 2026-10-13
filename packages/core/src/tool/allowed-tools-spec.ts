/**
 * `allowed-tools` 声明的公共解析（自定义命令 / skill / agent `tools:` / `--allowed-tools` 共用）。
 *
 * 语义对齐 CC：`allowed-tools` 是**权限层**的概念——一组「免确认」allow 规则，
 * 原样交给规则引擎（它认 CC 名 `Read`、`Bash(git *)` 与 MCP 全名）。
 * 它**不裁剪工具集、不决定是否 fork**。只有 agent 定义的 `tools:` 才是工具白名单，
 * 那里用 `toolNames`（已归一到内部名）。
 *
 * 切分规则对齐 CC `parseToolListFromCLI`（utils/permissions/permissionSetup.ts）：
 * 逗号 / 空白分隔，但**括号内**的逗号与空白不切——`Bash(git -C*, foo)` 是一条规则。
 * 旧实现三处各写一份 `split(",")`，括号内带逗号的写法会被切坏。
 */

import { toInternalToolName } from "./tool-name-aliases.ts";

export interface AllowedToolsSpec {
  /** 原样规则串（交给规则引擎，如 "Read"、"Bash(ls*)"、"mcp__tavily__tavily_search"） */
  rules: string[];
  /** 归一后的工具名（仅给需要白名单的场景用，如 agent `tools:`），已去重 */
  toolNames: string[];
}

/** 括号感知切分：括号内的逗号 / 空白不作分隔符。 */
export function splitToolList(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  const flush = () => {
    const t = current.trim();
    if (t) out.push(t);
    current = "";
  };
  for (const ch of raw) {
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if ((ch === "," || /\s/.test(ch)) && depth === 0) {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return out;
}

/** 规则串 → 工具名：取括号前的部分归一到内部名；MCP 名与表外名原样保留。 */
export function ruleToToolName(rule: string): string {
  const paren = rule.indexOf("(");
  const base = (paren >= 0 ? rule.slice(0, paren) : rule).trim();
  return toInternalToolName(base);
}

/**
 * 解析 `allowed-tools`（字符串或数组）。未声明 → undefined（与「声明为空」区分开）。
 * 数组的每个元素同样过一遍括号感知切分（YAML 里写 `- Bash(git add, git commit)` 也成立）。
 */
export function parseAllowedToolsSpec(
  raw: string | string[] | unknown,
): AllowedToolsSpec | undefined {
  let rules: string[];
  if (typeof raw === "string") {
    rules = splitToolList(raw);
  } else if (Array.isArray(raw)) {
    rules = raw.flatMap((item) => splitToolList(String(item)));
  } else {
    return undefined;
  }
  const toolNames = [...new Set(rules.map(ruleToToolName))];
  return { rules, toolNames };
}
