/**
 * MCP Skill 发现（Task 5）
 *
 * 通过 MCP 协议的 skill:// 资源发现远程 Skill。
 * MCP Skill 被视为不可信来源：loadedFrom="mcp"，由 prompt-processor 强制隔离
 * （禁止内联 shell、禁止 ${SKILL_DIR}）。
 */

import { getLogger } from "../debug/logger.ts";
import { parseFrontmatter } from "../extension/frontmatter.ts";
import { parseSkillFrontmatterFields } from "../skill/loader.ts";
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

/**
 * 从 MCP 服务器发现 Skill
 * 查找 skill:// 前缀的资源，解析 frontmatter 为 SkillDefinition
 */
export async function discoverMcpSkills(provider: McpResourceProvider): Promise<SkillDefinition[]> {
  const log = getLogger();
  const skills: SkillDefinition[] = [];

  const all = provider.getAllResources();
  const skillResources = all.filter((r) => r.resource.uri.startsWith(SKILL_URI_PREFIX));

  for (const { serverName, resource } of skillResources) {
    try {
      const text = await provider.readResource(serverName, resource.uri);
      const { frontmatter: fm, body, error: fmError } = parseFrontmatter(text);

      // 审计第 4 条：畸形 frontmatter fail-closed 跳过。MCP Skill 来自外部 server，
      // 更不能因解析失败就丢掉 allowed-tools/context 约束（fork 会退化成 inline）。
      if (fmError) {
        log.warn(
          "MCP",
          `跳过 frontmatter 格式错误的 MCP Skill: ${serverName}:${resource.name} - ${fmError}`,
        );
        continue;
      }

      const rawName = (fm.name as string) || resource.name;
      const name = `${serverName}:${rawName}`;
      const description = (fm.description as string) || resource.description || "";
      if (!description.trim()) {
        log.warn("MCP", `跳过缺少 description 的 MCP Skill: ${name}`);
        continue;
      }

      if (fm.disabled === true) {
        log.debug("MCP", `跳过已禁用的 MCP Skill: ${name}`);
        continue;
      }

      // P2-1：字段映射复用 loader 的单一事实源，不再并列维护一份（此前漏了 paths / mode /
      // maxTurns / timeoutMins / effort / agent / argumentNames 等 14 个字段）。
      const fields = parseSkillFrontmatterFields(fm);

      skills.push({
        ...fields,
        // MCP 历史默认 inline（未声明 context / mode 时）；声明了则以单一事实源推导为准。
        context: fields.context ?? "inline",
        // 刻意剔除的安全字段：executor 拒绝 MCP 注册 hooks、prompt-processor 禁 MCP 内联 shell，
        // 解析了也用不上，显式置空少一层风险面。
        hooks: undefined,
        shell: undefined,
        name,
        description,
        prompt: body,
        source: "mcp",
        loadedFrom: "mcp",
        filePath: resource.uri,
        // MCP Skill 没有本地目录，skillRoot 留空
        skillRoot: undefined,
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
