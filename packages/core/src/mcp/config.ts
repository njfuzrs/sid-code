/**
 * MCP 配置合并
 * 多源配置加载、签名去重、Scope 标记
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { ConfigScope, ScopedMcpServerConfig, McpPolicy } from "./types.ts";
import { isMcpServerAllowed } from "./policy.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 基于签名去重：相同 command+args 或相同 url 视为同一 Server
 */
export function getMcpServerSignature(
  config: MCPServerConfig | ScopedMcpServerConfig,
): string | null {
  if (config.transport === "stdio" && config.command) {
    return `stdio:${JSON.stringify([config.command, ...(config.args || [])])}`;
  }
  if (config.url) {
    return `url:${config.url}`;
  }
  return null;
}

/**
 * Scope 优先级（数字小=高优先，同名/同签名以高优先级为准）：dynamic > user > local > project
 *
 * dynamic 提到最高（B1）：IDE 等动态注册的 server 是运行时注入的活连接，
 * 不应被静态配置文件里的同名项顶掉（否则用户 settings 里误写同名会挤掉 IDE 连接）。
 * user > local > project 对齐文档 10.5：个人全局 > 本地实验 > 团队共享。
 */
const SCOPE_PRIORITY: Record<ConfigScope, number> = {
  dynamic: -1,
  user: 0,
  local: 1,
  project: 2,
};

/**
 * 合并多源 MCP 配置
 * 去重优先级：user > local > project > dynamic
 */
export function mergeMcpConfigs(
  sources: Array<{ scope: ConfigScope; servers: Record<string, MCPServerConfig> }>,
  policy?: McpPolicy,
): Record<string, ScopedMcpServerConfig> {
  const log = getLogger();
  const result: Record<string, ScopedMcpServerConfig> = {};
  const seenSignatures = new Map<string, { name: string; scope: ConfigScope }>();

  // 按优先级排序（高优先级先处理）
  const sorted = [...sources].sort((a, b) => SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope]);

  for (const { scope, servers } of sorted) {
    for (const [name, config] of Object.entries(servers)) {
      const scoped: ScopedMcpServerConfig = { ...config, scope } as ScopedMcpServerConfig;

      // 策略过滤
      if (policy && !isMcpServerAllowed(name, config, policy)) {
        log.info("MCP", `策略过滤: ${name} (scope=${scope}) 被拒绝`);
        continue;
      }

      // 签名去重
      const sig = getMcpServerSignature(config);
      if (sig) {
        const existing = seenSignatures.get(sig);
        if (existing) {
          log.debug(
            "MCP",
            `签名去重: ${name} (scope=${scope}) 与 ${existing.name} (scope=${existing.scope}) 重复，跳过`,
          );
          continue;
        }
        seenSignatures.set(sig, { name, scope });
      }

      // 名称去重（同名以高优先级为准）
      if (result[name]) {
        const existingPriority = SCOPE_PRIORITY[result[name].scope];
        const newPriority = SCOPE_PRIORITY[scope];
        if (newPriority >= existingPriority) {
          continue;
        }
      }

      result[name] = scoped;
    }
  }

  return result;
}
