/**
 * 交互式 Shell 输入解析。
 *
 * 输入框中的行首 `!` 是用户输入 shell 命令的专用前缀，
 * 这里仅负责去掉前缀并返回原始命令，不把它伪装成斜杠命令。
 */

/**
 * 解析行首 Shell 输入。
 *
 * @returns 去掉 `!` 前缀后的 shell 命令；不是 Shell 输入或命令为空时返回 null。
 */
export function parseShellInput(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("!")) return null;

  const command = trimmed.slice(1).trim();
  return command || null;
}

/**
 * 构造交互式 Bash 工具调用的最小协议载荷。
 *
 * 该纯函数与 App 的执行闭包分离，便于锁定“用户输入必须生成 bash tool_use，
 * 不能再生成 /bash 斜杠命令”的契约。
 */
export function buildInteractiveBashToolUse(
  command: string,
  id = "interactive-bash-test",
): {
  type: "tool_use";
  id: string;
  name: "bash";
  input: { command: string; description: string };
} | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  return {
    type: "tool_use",
    id,
    name: "bash",
    input: {
      command: trimmed,
      description: `用户通过 ! 前缀执行：${trimmed}`,
    },
  };
}
