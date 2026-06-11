/**
 * builtin Skill 磁盘释放
 *
 * 把编译期嵌入的 builtin Skill（builtin-embedded.generated.ts）释放到磁盘目录
 * ~/.sid-code/builtin-skills/<name>/SKILL.md，使 builtin / user / project 三类 skill
 * 走同一条磁盘加载链（ExtensionLoader.scan）。
 *
 * 为什么要释放到磁盘（而非编译时直接读 src/skill/builtin/）：
 * - 编译二进制运行时 import.meta.url=/$bunfs/root，无法用相对路径定位 src/skill/builtin/；
 * - 把数据释放到标准磁盘目录后，二进制自包含、可拷贝到任意机器运行，不依赖 repo 路径；
 * - 这是 Claude Code「bundled skill 释放到磁盘」的同款思路。
 *
 * 释放时机：首次运行自动释放（由 SkillManager.discoverBuiltin 调用）。
 * 幂等：用 .hash 标记文件记录上次释放的内容哈希，哈希不变则跳过；
 *       哈希变化（升级了二进制 / 改了 builtin skill）则清理并重新释放。
 */

import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSidHome } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import {
  EMBEDDED_BUILTIN_SKILLS,
  EMBEDDED_BUILTIN_SKILLS_HASH,
} from "./builtin-embedded.generated.ts";

/** builtin skill 释放根目录：~/.sid-code/builtin-skills/ */
export function getBuiltinSkillsDir(): string {
  return join(getSidHome(), "builtin-skills");
}

/** 内容哈希标记文件路径 */
function getHashMarkerPath(): string {
  return join(getBuiltinSkillsDir(), ".hash");
}

/**
 * 确保 builtin Skill 已释放到磁盘，返回释放目录路径。
 *
 * - 磁盘哈希标记与当前嵌入哈希一致 → 跳过释放，直接返回目录。
 * - 不一致或不存在 → 清理旧内容并全量重新释放。
 * - 释放失败不抛错（降级：返回目录路径，调用方扫描到空目录即可，不阻断启动）。
 */
export async function ensureBuiltinSkillsReleased(): Promise<string> {
  const log = getLogger();
  const dir = getBuiltinSkillsDir();
  const markerPath = getHashMarkerPath();

  try {
    // 检查哈希标记：一致则无需重新释放
    let existingHash: string | null = null;
    try {
      existingHash = (await readFile(markerPath, "utf-8")).trim();
    } catch {
      existingHash = null;
    }

    if (existingHash === EMBEDDED_BUILTIN_SKILLS_HASH) {
      return dir;
    }

    // 哈希变化或首次释放：清理旧的 builtin skill 子目录后重新释放。
    // 只删本目录内容（不碰用户其它数据），目录本身保留。
    await cleanBuiltinDir(dir);
    await mkdir(dir, { recursive: true });

    for (const skill of EMBEDDED_BUILTIN_SKILLS) {
      const skillDir = join(dir, skill.name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), skill.rawContent, "utf-8");
    }

    // 最后写哈希标记（写在所有 skill 落盘之后，保证标记存在即内容完整）
    await writeFile(markerPath, EMBEDDED_BUILTIN_SKILLS_HASH, "utf-8");

    log.info(
      "SKILL",
      `已释放 ${EMBEDDED_BUILTIN_SKILLS.length} 个 builtin Skill 到 ${dir}（hash=${EMBEDDED_BUILTIN_SKILLS_HASH}）`,
    );
  } catch (error) {
    // 释放失败不阻断启动：降级为"无 builtin skill"，与旧行为一致
    log.warn(
      "SKILL",
      `释放 builtin Skill 失败（降级，不影响启动）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return dir;
}

/**
 * 清理释放目录下的内容（保留目录本身）。
 * 目录不存在时静默返回。
 */
async function cleanBuiltinDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // 目录不存在
  }
  for (const name of entries) {
    await rm(join(dir, name), { recursive: true, force: true });
  }
}
