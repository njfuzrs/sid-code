/**
 * LSP 配置加载
 *
 * 配置来源（优先级从高到低）：
 * 1. 项目级 .sid-code/lsp.json
 * 2. 全局 ~/.sid-code/lsp.json
 * 3. 内置常见语言目录（builtin-servers.ts）—— 命令在 PATH 中即自动注册（零配置）
 */

import type { LSPServerConfig } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { readFile } from "fs/promises";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";
import { BUILTIN_LSP_SERVERS } from "./builtin-servers.ts";

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

  // 1. 内置常见语言：并行探测各 language server 是否在 PATH 中，可用即自动注册。
  //    这是"企业级开箱即用"的核心——用户装了对应 language server 就零配置可用，
  //    不必再手写 lsp.json。探测并行执行，避免逐个 which 串行拖慢启动。
  const availability = await Promise.all(
    BUILTIN_LSP_SERVERS.map((s) => isCommandAvailable(s.command)),
  );
  const registered: string[] = [];
  BUILTIN_LSP_SERVERS.forEach((server, i) => {
    if (!availability[i]) return;
    configs[server.name] = {
      name: server.name,
      command: server.command,
      args: server.args,
      workspaceFolder,
      extensionToLanguage: server.extensionToLanguage,
      ...(server.initializationOptions
        ? { initializationOptions: server.initializationOptions }
        : {}),
      startupTimeout: 30000,
      maxRestarts: 3,
    };
    registered.push(server.name);
  });
  if (registered.length > 0) {
    log.info("LSP", `内置语言目录自动注册 ${registered.length} 个可用服务器：${registered.join("、")}`);
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
