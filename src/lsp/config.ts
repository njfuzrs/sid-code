/**
 * LSP 配置加载
 *
 * 配置来源（优先级从高到低）：
 * 1. 项目级 .sid-code/lsp.json
 * 2. 全局 ~/.sid-code/lsp.json
 * 3. 内置默认配置（TypeScript，如果 typescript-language-server 可用）
 */

import type { LSPServerConfig } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { readFile } from "fs/promises";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";

/** lsp.json 文件格式：服务器名 → 部分配置（workspaceFolder/name 自动填充） */
type LSPConfigFile = Record<string, Partial<LSPServerConfig> & {
  command: string;
  extensionToLanguage: Record<string, string>;
}>;

export async function loadLSPConfigs(
  workspaceFolder: string,
): Promise<Record<string, LSPServerConfig>> {
  const log = getLogger();
  const configs: Record<string, LSPServerConfig> = {};

  // 1. 内置 TypeScript 支持（如果命令可用）
  if (await isCommandAvailable("typescript-language-server")) {
    configs["typescript"] = {
      name: "typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      workspaceFolder,
      extensionToLanguage: {
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".mjs": "javascript",
        ".cjs": "javascript",
      },
      startupTimeout: 30000,
      maxRestarts: 3,
    };
  }

  // 2. 全局配置覆盖
  await mergeConfigFile(configs, sidPaths.lspConfig(), workspaceFolder, log);
  // 3. 项目配置覆盖（最高优先级）
  await mergeConfigFile(configs, join(workspaceFolder, ".sid-code", "lsp.json"), workspaceFolder, log);

  return configs;
}

/** 从 lsp.json 合并配置（文件不存在时静默跳过） */
async function mergeConfigFile(
  configs: Record<string, LSPServerConfig>,
  filePath: string,
  workspaceFolder: string,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return; // 文件不存在
  }

  try {
    const parsed: LSPConfigFile = JSON.parse(raw);
    for (const [name, partial] of Object.entries(parsed)) {
      if (!partial.command || !partial.extensionToLanguage) {
        log.warn("LSP", `${filePath} 中的 ${name} 缺少 command 或 extensionToLanguage，已跳过`);
        continue;
      }
      configs[name] = {
        name,
        workspaceFolder,
        startupTimeout: 30000,
        maxRestarts: 3,
        ...partial,
      } as LSPServerConfig;
    }
    log.info("LSP", `从 ${filePath} 加载了 ${Object.keys(parsed).length} 个 LSP 配置`);
  } catch (err: any) {
    log.error("LSP", `解析 ${filePath} 失败: ${err.message}`);
  }
}

/** 检查命令是否可用 */
export async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
