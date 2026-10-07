/**
 * settings 文件的写入安全：原子写 + 写前备份 + 损坏文件留档（D9）。
 *
 * 为什么 settings.json 比 app.json 更需要这一层：app.json 丢了只是运行状态，settings.json
 * 里是用户手写的 availableModels / hooks / mcpServers / permissions，丢了无法自动重建。
 * 此前 patchSettingsFile 是裸 writeFileSync（open(O_TRUNC) + write），进程在中间被杀就
 * 留下半截 JSON；而解析失败时 fail-closed 抛错——挡住了覆盖，却没有任何恢复路径。
 *
 * 备份放在 `<SID_HOME>/backups/`，不放在文件旁边：project / local 来源的文件在仓库的
 * `.sid-code/` 里，备份落在那里会污染工作树、甚至被误提交。文件名带来源与路径哈希，
 * 同名来源（不同项目的 projectSettings）互不挤占保留窗口。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { basename, join } from "path";
import { getSidHome } from "../paths.ts";

/** 每个文件保留的写前备份数 */
const MAX_SETTINGS_BACKUPS = 5;

export function getSettingsBackupDir(): string {
  return join(getSidHome(), "backups");
}

/** 备份文件名前缀：`settings.<来源>.<路径哈希8位>.<文件名>` */
function backupPrefix(source: string, path: string): string {
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `settings.${source}.${hash}.${basename(path)}`;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * 写前备份：只备份能解析的内容，并只保留最近 MAX_SETTINGS_BACKUPS 份。
 * 备份失败不阻塞写入（与 app.json 的 createTimestampBackup 同一取舍）。
 */
export function backupSettingsFile(source: string, path: string): void {
  try {
    if (!existsSync(path)) return;
    // 损坏内容不进备份：否则它会把仅存的好备份挤出保留窗口（D8 在 app.json 上踩过）
    try {
      JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return;
    }
    const dir = getSettingsBackupDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const prefix = `${backupPrefix(source, path)}.backup.`;
    copyFileSync(path, join(dir, `${prefix}${stamp()}`));
    const old = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
      .reverse()
      .slice(MAX_SETTINGS_BACKUPS);
    for (const f of old) unlinkSync(join(dir, f));
  } catch {
    // 备份失败不影响主流程
  }
}

/**
 * 损坏文件留档：解析失败时把原文件复制一份再抛错，返回留档路径（失败返回 null）。
 * 不删、不改原文件——让用户自己决定是修还是从备份恢复。
 */
export function preserveCorruptedSettingsFile(source: string, path: string): string | null {
  try {
    const dir = getSettingsBackupDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const target = join(dir, `${backupPrefix(source, path)}.corrupted.${stamp()}`);
    copyFileSync(path, target);
    return target;
  } catch {
    return null;
  }
}

/** 列出某文件现有的写前备份（新→旧），供报错提示恢复路径 */
export function listSettingsBackups(source: string, path: string): string[] {
  try {
    const dir = getSettingsBackupDir();
    if (!existsSync(dir)) return [];
    const prefix = `${backupPrefix(source, path)}.backup.`;
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
      .reverse()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
