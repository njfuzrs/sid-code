/**
 * 插件命令加载：从插件 commands/ 目录加载命令，添加插件命名空间前缀
 *
 * 命名规则（对标 Claude Code 的 {pluginName}:{namespace}:{commandName}）：
 *   commands/deploy.md        → my-plugin:deploy
 *   commands/env/staging.md   → my-plugin:env:staging
 *
 * 命名空间隔离保证：
 *   - 不同插件的命令不冲突（plugin-a:deploy vs plugin-b:deploy）
 *   - 内置命令优先：插件命令不能覆盖 /help 等核心命令（在 merge.ts 处理）
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, relative, sep } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import { parseFrontmatter } from "@sid-code/core/extension/frontmatter.ts";
import { CustomCommand } from "../command/custom.ts";
import type { Command } from "../command/types.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

/** 从 markdown 第一行 HTML 注释提取描述 */
function extractDescription(body: string): string {
  const match = body.trimStart().match(/^<!--\s*(.*?)\s*-->/);
  return match?.[1] ?? "";
}

/** 是否忽略该文件/目录 */
function shouldIgnore(name: string): boolean {
  return name.startsWith("_") || name.startsWith(".") || name === "node_modules";
}

/**
 * 计算命令名（加插件命名空间前缀）
 *   baseDir = commands/，filePath = commands/env/staging.md，pluginName = my-plugin
 *   → my-plugin:env:staging
 */
function getCommandName(filePath: string, baseDir: string, pluginName: string): string {
  const rel = relative(baseDir, filePath).replace(/\.md$/, "");
  const namespace = rel.split(sep).join(":");
  return `${pluginName}:${namespace}`;
}

/** 递归扫描目录下所有 .md 命令文件 */
async function scanCommandFiles(
  dir: string,
  baseDir: string,
  pluginName: string,
  out: Command[],
): Promise<void> {
  if (!existsSync(dir)) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    getLogger().warn("PLUGIN", `扫描插件命令目录失败 ${dir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanCommandFiles(fullPath, baseDir, pluginName, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const raw = await readFile(fullPath, "utf-8");
        const { frontmatter, body, error: fmError } = parseFrontmatter(raw);
        // 审计第 4 条：畸形 frontmatter fail-closed 跳过，避免 YAML 原文被当指令喂给模型。
        if (fmError) {
          getLogger().warn("PLUGIN", `插件命令 frontmatter 格式错误，已跳过 ${fullPath}: ${fmError}`);
          continue;
        }
        const name = getCommandName(fullPath, baseDir, pluginName);
        const description =
          (frontmatter.description as string) || extractDescription(body) || `插件命令: ${name}`;
        out.push(new CustomCommand(name, description, body));
      } catch (err: any) {
        getLogger().warn("PLUGIN", `加载插件命令失败 ${fullPath}: ${err.message}`);
      }
    }
  }
}

/** 加载单个插件的所有命令 */
export async function loadCommandsForPlugin(plugin: LoadedPlugin): Promise<Command[]> {
  const commands: Command[] = [];
  for (const baseDir of plugin.commandsPaths) {
    await scanCommandFiles(baseDir, baseDir, plugin.name, commands);
  }
  return commands;
}

/**
 * 加载所有已启用插件的命令（memoized）
 */
export const getPluginCommands = memoize(async (): Promise<Command[]> => {
  const { enabled } = await loadAllPluginsCacheOnly();
  const all: Command[] = [];
  for (const plugin of enabled) {
    const cmds = await loadCommandsForPlugin(plugin);
    all.push(...cmds);
  }
  if (all.length > 0) {
    getLogger().info("PLUGIN", `加载了 ${all.length} 个插件命令`);
  }
  return all;
});

registerPluginCache(getPluginCommands.clear);
