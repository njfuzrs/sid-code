/**
 * 规则持久化
 * 将运行时规则写入设置文件（用户级 / 项目级）
 * 支持 "Always Allow" 弹窗选择后的持久化写入
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { addFileGlobRuleToGitignore } from "../config/gitignore.ts";
import type { SettingsPermissions } from "./types.ts";

/** 设置文件 JSON 格式 */
interface SettingsFile {
  permissions?: SettingsPermissions;
  [key: string]: unknown;
}

/**
 * 将规则持久化到设置文件
 * @param target 目标文件："user" | "project" | "local"
 * @param behavior 规则行为
 * @param rawRule 原始规则字符串
 * @param workspacePath 工作区路径（project/local 需要）
 */
export async function persistRule(
  target: "user" | "project" | "local",
  behavior: "allow" | "deny" | "ask",
  rawRule: string,
  workspacePath?: string,
): Promise<void> {
  const log = getLogger();
  const filePath = getSettingsPath(target, workspacePath);
  const dir = join(filePath, "..");

  // 确保目录存在
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 读取现有设置
  let settings: SettingsFile = {};
  if (existsSync(filePath)) {
    try {
      const content = await Bun.file(filePath).text();
      settings = JSON.parse(content);
    } catch {
      log.warn("RULE_PERSIST", `读取 ${filePath} 失败，将创建新文件`);
    }
  }

  // 确保 permissions 结构存在
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions[behavior]) {
    settings.permissions[behavior] = [];
  }

  // 避免重复添加
  const list = settings.permissions[behavior]!;
  if (!list.includes(rawRule)) {
    list.push(rawRule);
  }

  // 写入文件
  await Bun.write(filePath, JSON.stringify(settings, null, 2) + "\n");
  log.info("RULE_PERSIST", `规则已持久化到 ${filePath}: ${behavior} ${rawRule}`);

  // 对标 claude-code：写 .sid-code/settings.local.json 时，把它加入全局 gitignore
  //（~/.config/git/ignore），使这份「私有、不应提交」的本地配置默认被忽略。
  // fire-and-forget，不阻塞主流程，失败仅记日志。
  if (target === "local") {
    void addFileGlobRuleToGitignore(
      ".sid-code/settings.local.json",
      workspacePath || process.cwd(),
    );
  }
}

/**
 * 从设置文件中移除规则
 */
export async function removePersistedRule(
  target: "user" | "project" | "local",
  behavior: "allow" | "deny" | "ask",
  rawRule: string,
  workspacePath?: string,
): Promise<boolean> {
  const filePath = getSettingsPath(target, workspacePath);

  if (!existsSync(filePath)) return false;

  try {
    const content = await Bun.file(filePath).text();
    const settings: SettingsFile = JSON.parse(content);

    if (!settings.permissions?.[behavior]) return false;

    const list = settings.permissions[behavior]!;
    const idx = list.indexOf(rawRule);
    if (idx === -1) return false;

    list.splice(idx, 1);
    await Bun.write(filePath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** 获取设置文件路径 */
function getSettingsPath(target: "user" | "project" | "local", workspacePath?: string): string {
  switch (target) {
    case "user":
      return join(homedir(), ".sid-code", "settings.json");
    case "project":
      return join(workspacePath || process.cwd(), ".sid-code", "settings.json");
    case "local":
      return join(workspacePath || process.cwd(), ".sid-code", "settings.local.json");
  }
}
