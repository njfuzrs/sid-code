/**
 * Bundled Skill 文件提取（Task 6）
 *
 * Bundled Skill 可携带参考文件（模板 / schema），这些文件编译时嵌入二进制，
 * 运行时按需提取到临时目录。提取过程有完整安全防护：
 *   - 路径遍历防护（禁止 .. 和绝对路径逃逸）
 *   - 符号链接攻击防护（O_EXCL 拒绝覆盖已存在文件）
 *   - 进程级 nonce 防止路径预测
 *   - 限制权限（目录 0700 / 文件 0600）
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, normalize, isAbsolute, sep, dirname } from "node:path";
import { getLogger } from "../../debug/logger.ts";
import { getSidTempDir } from "../../utils/temp-dir.ts";

// 进程级 nonce，防止路径预测
const PROCESS_NONCE = randomBytes(8).toString("hex");

/** 计算 bundled skill 的提取目录 */
export function getBundledSkillExtractDir(skillName: string): string {
  // 多用户隔离：根目录带 UID（getSidTempDir），bundled-skills 仍隔进程级 nonce 子目录
  return join(getSidTempDir(), "bundled-skills", PROCESS_NONCE, skillName);
}

/**
 * 路径遍历防护：把相对路径安全地解析到 baseDir 下
 * @throws 路径逃逸时抛错
 */
export function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = normalize(relPath);
  if (isAbsolute(normalized) || normalized.split(sep).includes("..")) {
    throw new Error(`bundled skill 文件路径逃逸 skill 目录: ${relPath}`);
  }
  return join(baseDir, normalized);
}

/** 安全写文件：O_EXCL 拒绝覆盖（防符号链接攻击），限制权限 */
async function safeWriteFile(filePath: string, content: string): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  const SAFE_WRITE_FLAGS =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const fh = await open(filePath, SAFE_WRITE_FLAGS, 0o600);
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

/**
 * 提取 bundled skill 的参考文件到临时目录
 * @returns 提取目录；失败返回 null
 */
export async function extractBundledSkillFiles(
  skillName: string,
  files: Record<string, string>,
): Promise<string | null> {
  const log = getLogger();
  const extractDir = getBundledSkillExtractDir(skillName);

  try {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = resolveSkillFilePath(extractDir, relPath);
      try {
        await safeWriteFile(absPath, content);
      } catch (err: any) {
        // 文件已存在（EEXIST）说明之前已提取过，幂等忽略
        if (err?.code === "EEXIST") continue;
        throw err;
      }
    }
    return extractDir;
  } catch (err: any) {
    log.error("SKILL", `提取 bundled skill 文件失败: ${err?.message}`);
    return null;
  }
}
