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

import { mkdirSync } from "fs";
import { appendFile, readFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { getLogger } from "../debug/logger.ts";

/** 全局 gitignore 路径：~/.config/git/ignore（git 默认的 core.excludesFile 之一） */
export function getGlobalGitignorePath(): string {
  return join(homedir(), ".config", "git", "ignore");
}

/**
 * 异步跑一条 git 命令，返回 {code, stdout}。失败（没装 git / 超时）返回 code=-1。
 *
 * X1（PR-D）：原先是 spawnSync。启动时 ensureRuntimeFilesGitignored 对 6 个文件各做
 * rev-parse + check-ignore，12 次同步 fork 合计 ~50ms，是首帧前最早的阻塞源（80ms 处）。
 * 调用方本来就是 fire-and-forget（void），改成异步后不再占事件循环。
 */
async function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 3000);
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
}

/** 「cwd 是否在 git 仓库内」的进程内缓存：启动时 6 个文件共用同一个答案，不必各问一次 */
const inRepoCache = new Map<string, Promise<boolean>>();

/** 当前目录是否在 git 仓库内（fail-open：出错视为否） */
function dirIsInGitRepo(cwd: string): Promise<boolean> {
  let p = inRepoCache.get(cwd);
  if (!p) {
    p = runGit(["rev-parse", "--is-inside-work-tree"], cwd).then(
      (r) => r.code === 0 && r.stdout.trim() === "true",
    );
    inRepoCache.set(cwd, p);
  }
  return p;
}

/**
 * 某路径是否已被现有 gitignore 规则覆盖（含全局 / 项目 / .git/info/exclude）。
 * `git check-ignore` 退出码：0=被忽略，1=未被忽略，128=非 git 仓库。
 */
async function isPathGitignored(testPath: string, cwd: string): Promise<boolean> {
  return (await runGit(["check-ignore", testPath], cwd)).code === 0;
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
    if (!(await dirIsInGitRepo(cwd))) return;

    // 目录规则（以 / 结尾）用一个示例文件来判重
    const testPath = filename.endsWith("/") ? `${filename}sample-file.txt` : filename;
    if (await isPathGitignored(testPath, cwd)) {
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

    await appendFile(globalGitignorePath, `${needsLeadingNewline ? "\n" : ""}${entry}\n`, "utf-8");
    log.debug("GITIGNORE", `已将 ${entry} 加入全局 gitignore ${globalGitignorePath}`);
  } catch (err: any) {
    log.warn("GITIGNORE", `写入全局 gitignore 失败: ${err?.message ?? err}`);
  }
}
