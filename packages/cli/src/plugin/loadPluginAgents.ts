/**
 * 插件 Agent 加载：从插件 agents/ 目录加载 Agent 定义，添加插件命名空间前缀
 *
 * 命名规则与命令一致：agents/reviewer.md → my-plugin:reviewer
 * 产出 CustomAgentDefinition[]，由调用方包装为 CustomAgentTool 注册到 ToolRegistry。
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, relative, sep } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import { parseFrontmatter } from "@sid-code/core/extension/frontmatter.ts";
import type { CustomAgentDefinition } from "@sid-code/core/agent/custom.ts";
import { parseListField, parseAgentExtendedFrontmatter } from "@sid-code/core/agent/custom.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

function shouldIgnore(name: string): boolean {
  return name.startsWith("_") || name.startsWith(".") || name === "node_modules";
}

/** agents/sub/reviewer.md → my-plugin:sub:reviewer */
function getAgentName(filePath: string, baseDir: string, pluginName: string): string {
  // SKILL.md / AGENT.md 子目录模式用父目录名
  const base = relative(baseDir, filePath);
  const fileName = base.split(sep).pop() ?? base;
  if (fileName === "AGENT.md" || fileName === "index.md") {
    const dirRel = relative(baseDir, join(filePath, "..")).split(sep).join(":");
    return `${pluginName}:${dirRel}`;
  }
  const rel = base.replace(/\.md$/, "");
  const namespace = rel.split(sep).join(":");
  return `${pluginName}:${namespace}`;
}

async function scanAgentFiles(
  dir: string,
  baseDir: string,
  pluginName: string,
  out: CustomAgentDefinition[],
): Promise<void> {
  if (!existsSync(dir)) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    getLogger().warn("PLUGIN", `扫描插件 Agent 目录失败 ${dir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // 子目录模式：优先 AGENT.md / index.md
      const candidate = ["AGENT.md", "index.md"].map((c) => join(fullPath, c)).find(existsSync);
      if (candidate) {
        await loadAgentFile(candidate, baseDir, pluginName, out);
      } else {
        await scanAgentFiles(fullPath, baseDir, pluginName, out);
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      await loadAgentFile(fullPath, baseDir, pluginName, out);
    }
  }
}

async function loadAgentFile(
  filePath: string,
  baseDir: string,
  pluginName: string,
  out: CustomAgentDefinition[],
): Promise<void> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const { frontmatter, body, error: fmError } = parseFrontmatter(raw);
    // 审计第 4 条：畸形 frontmatter fail-closed 跳过。此处后果与自定义命令同构——
    // 实测闭合符缺失时 frontmatter={}、`tools` 白名单丢失（子代理拿到全部工具）、
    // YAML 原文进 agent prompt。降级方向更宽松，必须拒绝加载而非静默放行。
    if (fmError) {
      getLogger().warn("PLUGIN", `插件 Agent frontmatter 格式错误，已跳过 ${filePath}: ${fmError}`);
      return;
    }
    const name = getAgentName(filePath, baseDir, pluginName);
    out.push({
      name,
      description: (frontmatter.description as string) || (frontmatter.whenToUse as string) || "",
      tools: parseListField(frontmatter.tools),
      prompt: body,
      source: "user", // 插件 Agent 视为 user 级来源（ExtensionSource 无 plugin 值）
      filePath,
      // P0-2/P1-1/P1-2/P2-1：消费扩展 frontmatter 字段（与自定义 agent 同源解析）。
      ...parseAgentExtendedFrontmatter(frontmatter, name),
    });
  } catch (err: any) {
    getLogger().warn("PLUGIN", `加载插件 Agent 失败 ${filePath}: ${err.message}`);
  }
}

/** 加载单个插件的所有 Agent 定义 */
export async function loadAgentsForPlugin(plugin: LoadedPlugin): Promise<CustomAgentDefinition[]> {
  const agents: CustomAgentDefinition[] = [];
  for (const baseDir of plugin.agentsPaths) {
    await scanAgentFiles(baseDir, baseDir, plugin.name, agents);
  }
  return agents;
}

/** 加载所有已启用插件的 Agent 定义（memoized） */
export const loadPluginAgents = memoize(async (): Promise<CustomAgentDefinition[]> => {
  const { enabled } = await loadAllPluginsCacheOnly();
  const all: CustomAgentDefinition[] = [];
  for (const plugin of enabled) {
    const agents = await loadAgentsForPlugin(plugin);
    all.push(...agents);
  }
  if (all.length > 0) {
    getLogger().info("PLUGIN", `加载了 ${all.length} 个插件 Agent`);
  }
  return all;
});

registerPluginCache(loadPluginAgents.clear);
