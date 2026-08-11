/**
 * 全局 gitignore 配套（对标 claude-code src/utils/git/gitignore.ts）
 *
 * 用途：当 sid-code 在用户项目目录写入「私有、不应提交」的运行时配置
 *（如 .sid-code/settings.local.json）时，把对应规则追加进**全局** gitignore
 *（~/.config/git/ignore），让该文件在所有仓库里默认被忽略——而不是去改每个
 * 项目自己的 .gitignore（那属于项目内容，不该由工具擅自改动）。
 *
 * 关键设计（与 claude-code 一致）：
 * - 写**全局** gitignore（~/.config/git/ignore），非项目 .gitignore
 * - 写入前先用 `git check-ignore` 判重：若已被任意 gitignore（含全局/项目/exclude）
 *   覆盖，则跳过，避免重复条目
 * - 非 git 仓库直接 no-op（fail-open）
 * - 调用方 fire-and-forget（void），不阻塞主流程，失败仅记日志
 *
 * 注意：cron 的 scheduled_tasks.json/.lock **不**走这里——它们被视为可团队共享的
 * 项目级配置（同 claude-code），刻意不加入 gitignore，详见 cron/lock.ts 文件头注。
 */

import { spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { appendFile, readFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { getLogger } from "../debug/logger.ts";

/** 全局 gitignore 路径：~/.config/git/ignore（git 默认的 core.excludesFile 之一） */
export function getGlobalGitignorePath(): string {
  return join(homedir(), ".config", "git", "ignore");
}

/** 当前目录是否在 git 仓库内（fail-open：出错视为否） */
function dirIsInGitRepo(cwd: string): boolean {
  try {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf-8",
    });
    return r.status === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * 某路径是否已被现有 gitignore 规则覆盖（含全局 / 项目 / .git/info/exclude）。
 * `git check-ignore` 退出码：0=被忽略，1=未被忽略，128=非 git 仓库。
 */
function isPathGitignored(testPath: string, cwd: string): boolean {
  try {
    const r = spawnSync("git", ["check-ignore", testPath], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf-8",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 把一条文件 glob 规则追加进**全局** gitignore（若尚未被任何 gitignore 覆盖）。
 *
 * @param filename 相对仓库的文件/目录名，如 ".sid-code/settings.local.json"
 *                 或目录形式 ".sid-code/tmp/"（以 / 结尾）
 * @param cwd      判定所用工作目录（默认当前进程 cwd）
 */
export async function addFileGlobRuleToGitignore(
  filename: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const log = getLogger();
  try {
    if (!dirIsInGitRepo(cwd)) return;

    // 目录规则（以 / 结尾）用一个示例文件来判重
    const testPath = filename.endsWith("/")
      ? `${filename}sample-file.txt`
      : filename;
    if (isPathGitignored(testPath, cwd)) {
      // 已被某个 gitignore（全局或项目）覆盖，无需重复添加
      return;
    }

    const globalGitignorePath = getGlobalGitignorePath();
    mkdirSync(dirname(globalGitignorePath), { recursive: true });

    // 用 **/ 前缀使规则在任意子目录层级生效，且确保以换行结尾
    const entry = `**/${filename}`;
    let needsLeadingNewline = false;
    try {
      const existing = await readFile(globalGitignorePath, "utf-8");
      // 已存在同条目则跳过（check-ignore 理论上已覆盖，这里是双保险）
      if (existing.split(/\r?\n/).some((l) => l.trim() === entry)) {
        return;
      }
      needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    } catch {
      // 文件不存在，首次创建
    }

    await appendFile(
      globalGitignorePath,
      `${needsLeadingNewline ? "\n" : ""}${entry}\n`,
      "utf-8",
    );
    log.debug("GITIGNORE", `已将 ${entry} 加入全局 gitignore ${globalGitignorePath}`);
  } catch (err: any) {
    log.warn("GITIGNORE", `写入全局 gitignore 失败: ${err?.message ?? err}`);
  }
}
