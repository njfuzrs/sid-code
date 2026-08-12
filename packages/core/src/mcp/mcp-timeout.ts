/**
 * MCP 超时配置（G6-1）
 *
 * 对齐 claude-code MCP_TIMEOUT / MCP_TOOL_TIMEOUT env。此前 sid-code 连接/请求超时
 * 硬编码 `config.timeout ?? 30000`，无 env 覆盖入口。集中在此读取，优先级：
 *   env > per-server config.timeout > 默认值。
 */

/** 默认连接/请求超时（ms） */
const DEFAULT_MCP_TIMEOUT = 30000;
/** 默认工具调用超时（ms）——CC 默认近乎无限，此处收紧到 120s 更安全，可 env 调 */
const DEFAULT_MCP_TOOL_TIMEOUT = 120000;

function readEnvMs(...names: string[]): number | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return undefined;
}

/**
 * 连接/请求超时（ms）。
 * 优先级：SID_CODE_MCP_TIMEOUT / MCP_TIMEOUT(兜底) > configTimeout > 30000。
 */
export function getMcpTimeout(configTimeout?: number): number {
  return readEnvMs("SID_CODE_MCP_TIMEOUT", "MCP_TIMEOUT") ?? configTimeout ?? DEFAULT_MCP_TIMEOUT;
}

/**
 * 工具调用超时（ms）。
 * 优先级：SID_CODE_MCP_TOOL_TIMEOUT / MCP_TOOL_TIMEOUT(兜底) > configTimeout > 120000。
 */
export function getMcpToolTimeout(configTimeout?: number): number {
  return (
    readEnvMs("SID_CODE_MCP_TOOL_TIMEOUT", "MCP_TOOL_TIMEOUT") ??
    configTimeout ??
    DEFAULT_MCP_TOOL_TIMEOUT
  );
}
