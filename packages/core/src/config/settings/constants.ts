/**
 * Settings 来源定义与优先级
 *
 * 数组顺序即合并优先级——后面的覆盖前面的。
 * 完整优先级链（低→高）：
 *   User → Project → Local → Flag → Policy
 *
 * 设计决策（见 Spec 15 §3.1）：
 * - 不引入 Plugin Settings 层（sid-code 暂无独立插件 Settings 生态）
 * - Policy Settings 简化为单文件 /etc/sid-code/policy.json（暂不需要 MDM/远程下发）
 */

import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readdirSync } from "fs";
import { getSidHome, isInsideSidHome } from "../paths.ts";

export const SETTING_SOURCES = [
  "userSettings", // ~/.sid-code/settings.json — 用户全局
  "projectSettings", // <project>/.sid-code/settings.json — 项目共享（可提交 git）
  "localSettings", // <project>/.sid-code/settings.local.json — 本地私有（gitignored）
  "flagSettings", // --settings CLI 参数（内存来源，无文件）
  "policySettings", // /etc/sid-code/policy.json — 企业管控
] as const;

export type SettingSource = (typeof SETTING_SOURCES)[number];

/** 不参与文件监听的内存来源（flagSettings 来自 CLI，无对应磁盘文件） */
export const IN_MEMORY_SOURCES: ReadonlySet<SettingSource> = new Set(["flagSettings"]);

/**
 * 解析每个来源对应的文件路径。
 * flagSettings 无文件路径（来自 CLI 参数，运行时注入），返回 null。
 *
 * @param workspacePath 项目根目录，默认 process.cwd()
 */
export function getSettingsFilePath(
  source: SettingSource,
  workspacePath: string = process.cwd(),
): string | null {
  // 防御（P0-2）：项目级基准落在 ~/.sid-code 内时回退 homedir()，避免自嵌套
  const projectBase = isInsideSidHome(workspacePath) ? homedir() : workspacePath;
  switch (source) {
    case "userSettings":
      return join(getSidHome(), "settings.json");
    case "projectSettings":
      return join(projectBase, ".sid-code", "settings.json");
    case "localSettings":
      return join(projectBase, ".sid-code", "settings.local.json");
    case "policySettings":
      // B2：平台差异化的企业管控文件。macOS/Windows 没有 /etc，硬编码 /etc 在那两个平台永不存在。
      return managedSettingsPath();
    case "flagSettings":
      return null;
  }
}

/**
 * 返回所有「有文件路径」的来源及其路径（用于变更检测器注册监听）。
 */
export function getSettingsFilePaths(
  workspacePath: string = process.cwd(),
): Map<string, SettingSource> {
  const map = new Map<string, SettingSource>();
  for (const source of SETTING_SOURCES) {
    const path = getSettingsFilePath(source, workspacePath);
    if (path) map.set(path, source);
  }
  return map;
}

/**
 * 企业管控文件的平台路径（B2，对齐 CC managedPath）。
 * - macOS：/Library/Application Support/SidCode/managed-settings.json
 * - Windows：%PROGRAMDATA%\SidCode\managed-settings.json（缺省 C:\ProgramData）
 * - Linux 及其它：/etc/sid-code/managed-settings.json
 *
 * 历史的 /etc/sid-code/policy.json 与 policy.yaml 已废弃，不再读取。
 */
export function managedSettingsPath(): string {
  return join(managedSettingsDir(), "managed-settings.json");
}

/** 企业管控 drop-in 目录：managed-settings.d/*.json，字母序后者覆盖前者。 */
export function managedSettingsDropInDir(): string {
  return join(managedSettingsDir(), "managed-settings.d");
}

function managedSettingsDir(): string {
  const p = platform();
  if (p === "darwin") return "/Library/Application Support/SidCode";
  if (p === "win32") return join(process.env.PROGRAMDATA || "C:\\ProgramData", "SidCode");
  return "/etc/sid-code";
}

/**
 * drop-in 目录下的 json 文件，按文件名字母序排列。
 * 目录不存在或不可读时返回空数组，不抛。
 */
export function listManagedSettingsDropIns(): string[] {
  const dir = managedSettingsDropInDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}
