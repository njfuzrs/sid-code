/**
 * Settings 来源定义与优先级
 *
 * 数组顺序即合并优先级——后面的覆盖前面的。
 * 完整优先级链（低→高）：
 *   User → Project → Local → Flag → Policy
 *
 * 设计决策（见 Spec 15 §3.1）：
 * - 不引入 Plugin Settings 层（sid-code 暂无独立插件 Settings 生态）
 * - Policy Settings 走 sidPaths.managedPolicyCandidates（系统级优先、~/.sid-code 回退）
 */

import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { resolveProjectRoot } from "../../memory/paths.ts";
import { existsSync, readdirSync, realpathSync } from "fs";
import {
  getSidHome,
  isInsideSidHome,
  managedSettingsSystemDir,
  resolveManagedPolicyFile,
} from "../paths.ts";

export const SETTING_SOURCES = [
  "userSettings", // ~/.sid-code/settings.json — 用户全局
  "projectSettings", // <project>/.sid-code/settings.json — 项目共享（可提交 git）
  "localSettings", // <project>/.sid-code/settings.local.json — 本地私有（gitignored）
  "flagSettings", // --settings CLI 参数（内存来源，无文件）
  "policySettings", // sidPaths.managedPolicyCandidates 首个存在者 — 企业管控
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
      return join(resolveLocalSettingsBase(projectBase), ".sid-code", "settings.local.json");
    case "policySettings":
      // D6：与 PolicyManager / rule-loader 共用 sidPaths.managedPolicyCandidates 候选链
      // （系统级优先、用户级回退）。都不存在时返回系统级路径，供变更监听挂在正确位置。
      return resolveManagedPolicyFile() ?? managedSettingsPath();
    case "flagSettings":
      return null;
  }
}

/**
 * P1b：settings.local.json 的基准目录 = B2（git root，见 config/project-bases.ts）。
 *
 * 对齐 CC v2.1.211+：子目录启动时 local settings 读写都在仓库根，于是同一仓库任意子目录
 * 共享一份本机私有配置（权限规则的「不再询问」也落在这里，见 permission/rule-persistence.ts）。
 * 共享 settings.json 刻意**不**跟着改（B1，CC 明文只读启动目录那份）。
 *
 * 退回启动目录的情形（照 CC）：非 git 仓库（resolveProjectRoot 本身就退回 cwd）、
 * 仓库根就是家目录（否则 ~/.sid-code/settings.local.json 会与用户级配置目录混在一起）、Windows。
 */
export function resolveLocalSettingsBase(workspacePath: string): string {
  if (process.platform === "win32") return workspacePath;
  const root = resolveProjectRoot(workspacePath);
  if (sameDir(root, homedir())) return workspacePath;
  // git toplevel 返回的是 realpath（macOS 上 /var → /private/var）。cwd 本身就是仓库根时
  // 保留调用方给的写法，否则同一个文件会以两种路径出现（旧位置判定、日志、监听键全会分叉）。
  if (sameDir(root, workspacePath)) return workspacePath;
  return root;
}

/** 两个目录是否指向同一处（尽量 realpath，不存在时退回字面 resolve） */
function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * P1b 兼容：启动目录里旧位置的 settings.local.json（基准迁到 git root 之前写下的）。
 * 与新位置相同时返回 null。读取时与新位置合并、同 key 以新位置为准（照 CC 文档）。
 */
export function getLegacyLocalSettingsPath(workspacePath: string = process.cwd()): string | null {
  const projectBase = isInsideSidHome(workspacePath) ? homedir() : workspacePath;
  const legacy = join(projectBase, ".sid-code", "settings.local.json");
  const current = getSettingsFilePath("localSettings", workspacePath);
  if (!current) return legacy;
  return sameDir(dirname(current), dirname(legacy)) ? null : legacy;
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
 * 企业管控文件的系统级路径（平台目录见 paths.ts managedSettingsSystemDir）。
 * 完整查找顺序是 sidPaths.managedPolicyCandidates（系统级优先、~/.sid-code 回退）。
 *
 * 历史的 /etc/sid-code/policy.json 与 policy.yaml 已废弃，不再读取。
 */
export function managedSettingsPath(): string {
  return join(managedSettingsSystemDir(), "managed-settings.json");
}

/** 企业管控 drop-in 目录：managed-settings.d/*.json，字母序后者覆盖前者。只认系统级目录。 */
export function managedSettingsDropInDir(): string {
  return join(managedSettingsSystemDir(), "managed-settings.d");
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
