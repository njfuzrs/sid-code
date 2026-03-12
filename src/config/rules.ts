/**
 * CLAUDE.md 规则文件加载
 * 向上查找项目根目录的 CLAUDE.md 文件，作为系统提示词的一部分
 */

import { join, dirname } from "path";
import { existsSync } from "fs";

/** 向上查找 CLAUDE.md 文件 */
export async function findCLAUDEmd(startDir: string): Promise<string | null> {
  let currentDir = startDir;
  const root = "/";

  while (currentDir !== root) {
    const candidatePath = join(currentDir, "CLAUDE.md");
    if (existsSync(candidatePath)) {
      return candidatePath;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/** 加载 CLAUDE.md 内容 */
export async function loadCLAUDEmd(startDir: string): Promise<string | null> {
  const path = await findCLAUDEmd(startDir);
  if (!path) {
    return null;
  }

  try {
    const file = Bun.file(path);
    return await file.text();
  } catch (err) {
    console.error(`读取 CLAUDE.md 失败: ${err}`);
    return null;
  }
}
