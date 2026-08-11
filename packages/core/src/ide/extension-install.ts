/**
 * IDE 扩展自动安装
 * 通过 IDE CLI（code / cursor / windsurf）安装 sid-code 扩展。
 */

import { execSync } from "child_process";
import { getLogger } from "../debug/logger.ts";

/** 支持自动安装的 IDE 类型 */
export type InstallableIDE = "vscode" | "cursor" | "windsurf";

/** IDE CLI 命令映射 */
const IDE_CLI_COMMANDS: Record<InstallableIDE, string> = {
  vscode: "code",
  cursor: "cursor",
  windsurf: "windsurf",
};

/** 扩展 ID（扩展发布后替换为正式 ID） */
const EXTENSION_ID = "sid-code.sid-code";

/** 检查 IDE 扩展是否已安装 */
export async function isExtensionInstalled(ideType: InstallableIDE): Promise<boolean> {
  const cli = IDE_CLI_COMMANDS[ideType];
  if (!cli) return false;

  try {
    const output = execSync(`${cli} --list-extensions`, {
      stdio: "pipe",
      timeout: 10000,
    }).toString();
    return output.includes(EXTENSION_ID);
  } catch {
    return false;
  }
}

/** 安装 IDE 扩展 */
export async function installExtension(
  ideType: InstallableIDE,
): Promise<{ installed: boolean; error?: string }> {
  const log = getLogger();
  const cli = IDE_CLI_COMMANDS[ideType];

  if (!cli) {
    return { installed: false, error: `不支持的 IDE 类型: ${ideType}` };
  }

  try {
    log.info("IDE", `正在安装 ${ideType} 扩展...`);
    execSync(`${cli} --force --install-extension ${EXTENSION_ID}`, {
      stdio: "pipe",
      timeout: 60000,
    });
    log.info("IDE", `${ideType} 扩展安装成功`);
    return { installed: true };
  } catch (err: any) {
    log.error("IDE", `${ideType} 扩展安装失败: ${err.message}`);
    return { installed: false, error: err.message };
  }
}

/** 检测当前终端所在的 IDE 类型 */
export function getTerminalIDEType(): InstallableIDE | null {
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (termProgram === "vscode") return "vscode";
  if (termProgram === "cursor") return "cursor";
  if (termProgram === "windsurf") return "windsurf";
  return null;
}
