/**
 * CLAUDE.md 规则文件加载
 * 支持多种文件名 + 向上查找 + 全局配置
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { getLogger } from "../debug/logger.ts";

/** CLAUDE.md 文件名候选列表（对标 Claude Code） */
const CLAUDE_MD_FILES = [
  "CLAUDE.md",
  ".claude.md",
  "claude.md",
  ".claude/CLAUDE.md",
  ".claude/instructions.md",
] as const;

/** 向上查找 CLAUDE.md 文件（支持多种文件名） */
export async function findCLAUDEmd(startDir: string): Promise<string | null> {
  const log = getLogger();
  let currentDir = startDir;
  const root = "/";

  // 向上查找，尝试所有候选文件名
  while (currentDir !== root) {
    for (const filename of CLAUDE_MD_FILES) {
      const candidatePath = join(currentDir, filename);
      if (existsSync(candidatePath)) {
        log.debug("RULES", `找到 CLAUDE.md: ${candidatePath}`);
        return candidatePath;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // 最后检查全局配置
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(globalPath)) {
    log.debug("RULES", `使用全局 CLAUDE.md: ${globalPath}`);
    return globalPath;
  }

  log.debug("RULES", "未找到 CLAUDE.md 文件");
  return null;
}

/** 加载 CLAUDE.md 内容 */
export async function loadCLAUDEmd(startDir: string): Promise<string | null> {
  const log = getLogger();
  const path = await findCLAUDEmd(startDir);
  if (!path) {
    return null;
  }

  try {
    const file = Bun.file(path);
    const content = await file.text();
    log.debug("RULES", `加载 CLAUDE.md 成功: ${path} (${content.length} 字符)`);
    return content;
  } catch (err) {
    log.error("RULES", `读取 CLAUDE.md 失败: ${path}`, err);
    return null;
  }
}
