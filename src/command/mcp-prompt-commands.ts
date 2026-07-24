/**
 * MCP Prompts → slash 命令（G2）
 *
 * 把每个 MCP 服务器暴露的 prompt 动态转成 `mcp__<server>__<prompt>` slash 命令，
 * 进 / 菜单、可补全、可执行。执行时调 prompts/get 并把结果作为用户输入提交给 LLM。
 * 对齐 claude-code：prompt 命令 type="prompt"、source="mcp"。
 *
 * 注意：命令列表是动态的——服务器连接/断开、prompts/list_changed 后 getAllPrompts()
 * 返回值随之变化。因此不做一次性注册，而是每次 getCommands 时按当前状态实时构建
 * （与 UnifiedCommandRegistry.getCommands 的 mcpCommands 动态合并入口配套）。
 */

import type { UnifiedCommand } from "./types.ts";
import type { MCPManager } from "../mcp/manager.ts";
import { normalizeMcpName } from "../mcp/normalization.ts";

/**
 * 按当前 MCP 连接状态构建 prompt slash 命令列表。
 * @param manager MCP 管理器（未连接/无 prompt 时返回空数组）
 */
export function buildMcpPromptCommands(manager?: MCPManager): UnifiedCommand[] {
  if (!manager) return [];

  const prompts = manager.getAllPrompts();
  const commands: UnifiedCommand[] = [];

  for (const { serverName, prompt } of prompts) {
    const name = `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(prompt.name)}`;
    const argHint = prompt.arguments
      ?.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
      .join(" ");

    commands.push({
      name,
      description: prompt.description
        ? `${prompt.description} (MCP: ${serverName})`
        : `MCP 提示词 ${serverName}:${prompt.name}`,
      argumentHint: argHint || undefined,
      source: "mcp",
      type: "prompt",
      context: "inline",
      async getPromptForCommand(args: string): Promise<string> {
        // 参数映射：优先 key=value 形式；否则按 prompt.arguments 顺序位置映射。
        const promptArgs = parsePromptArgs(args, prompt.arguments?.map((a) => a.name) ?? []);
        const messages = await manager.getPrompt(
          serverName,
          prompt.name,
          Object.keys(promptArgs).length > 0 ? promptArgs : undefined,
        );
        return messages.map((m) => m.content).join("\n\n");
      },
    });
  }

  return commands;
}

/**
 * 解析 prompt 命令参数。
 * - 含 `=` 的 token 按 key=value 解析。
 * - 其余 token 按 argNames 顺序做位置映射（跳过已被 key=value 占用的名字）。
 */
function parsePromptArgs(argStr: string, argNames: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = argStr.trim();
  if (!trimmed) return result;

  const tokens = trimmed.split(/\s+/);
  const positional: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0) {
      result[tok.slice(0, eq)] = tok.slice(eq + 1);
    } else {
      positional.push(tok);
    }
  }

  // 位置参数按 argNames 顺序填入尚未被 key=value 占用的名字
  let pi = 0;
  for (const argName of argNames) {
    if (pi >= positional.length) break;
    if (argName in result) continue;
    result[argName] = positional[pi++];
  }

  return result;
}
