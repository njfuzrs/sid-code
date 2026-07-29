/**
 * MCP Skill 发现（Task 5）
 *
 * 通过 MCP 协议的 skill:// 资源发现远程 Skill。
 * MCP Skill 被视为不可信来源：loadedFrom="mcp"，由 prompt-processor 强制隔离
 * （禁止内联 shell、禁止 ${SKILL_DIR}）。
 */

import { getLogger } from "../debug/logger.ts";
import { parseFrontmatter } from "../extension/frontmatter.ts";
import type { SkillDefinition } from "../skill/types.ts";

/** skill:// 资源 URI 前缀 */
const SKILL_URI_PREFIX = "skill://";

/** MCP 管理器的最小依赖接口（便于测试注入） */
export interface McpResourceProvider {
  /** 列出所有服务器的资源 */
  getAllResources(): Array<{
    serverName: string;
    resource: { uri: string; name: string; description?: string };
  }>;
  /** 读取指定服务器的资源内容 */
  readResource(serverName: string, uri: string): Promise<string>;
}

/** 解析 allowed-tools（逗号分隔字符串或数组） */
function parseAllowedTools(raw: unknown): string[] | undefined {
  if (typeof raw === "string") {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (Array.isArray(raw)) return raw.map(String);
  return undefined;
}

/**
 * 从 MCP 服务器发现 Skill
 * 查找 skill:// 前缀的资源，解析 frontmatter 为 SkillDefinition
 */
export async function discoverMcpSkills(
  provider: McpResourceProvider,
): Promise<SkillDefinition[]> {
  const log = getLogger();
  const skills: SkillDefinition[] = [];

  const all = provider.getAllResources();
  const skillResources = all.filter((r) =>
    r.resource.uri.startsWith(SKILL_URI_PREFIX),
  );

  for (const { serverName, resource } of skillResources) {
    try {
      const text = await provider.readResource(serverName, resource.uri);
      const { frontmatter: fm, body, error: fmError } = parseFrontmatter(text);

      // 审计第 4 条：畸形 frontmatter fail-closed 跳过。MCP Skill 来自外部 server，
      // 更不能因解析失败就丢掉 allowed-tools/context 约束（fork 会退化成 inline）。
      if (fmError) {
        log.warn("MCP", `跳过 frontmatter 格式错误的 MCP Skill: ${serverName}:${resource.name} - ${fmError}`);
        continue;
      }

      const rawName = (fm.name as string) || resource.name;
      const name = `${serverName}:${rawName}`;
      const description =
        (fm.description as string) || resource.description || "";
      if (!description.trim()) {
        log.warn("MCP", `跳过缺少 description 的 MCP Skill: ${name}`);
        continue;
      }

      const rawContext = fm.context as string;
      const context: "inline" | "fork" =
        rawContext === "fork" ? "fork" : "inline";

      skills.push({
        name,
        description,
        whenToUse: (fm["when-to-use"] as string) ?? (fm.whenToUse as string),
        allowedTools: parseAllowedTools(fm["allowed-tools"] ?? fm["allowedTools"]),
        model: fm.model as string,
        context,
        prompt: body,
        source: "mcp",
        loadedFrom: "mcp",
        filePath: resource.uri,
        // MCP Skill 没有本地目录，skillRoot 留空
        userInvocable: fm["user-invocable"] === false ? false : true,
        disableModelInvocation:
          fm["disable-model-invocation"] === true ||
          fm["disableModelInvocation"] === true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("MCP", `从 ${serverName} 发现 Skill 失败 (${resource.uri}): ${msg}`);
    }
  }

  if (skills.length > 0) {
    log.info("MCP", `发现 ${skills.length} 个 MCP Skill`, {
      names: skills.map((s) => s.name),
    });
  }

  return skills;
}
