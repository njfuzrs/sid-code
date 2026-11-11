/**
 * 从破坏性 bash 命令提取受影响文件（P2-1）
 *
 * 背景：checkpoint 原本只对 write/edit 工具快照，通过 bash 跑的 `git reset --hard`、
 * `git checkout .`、`rm file`、`git clean -fd` 造成的破坏无法被 /undo 回退——而这恰恰是
 * 最需要回退保护的操作。这里为破坏性 bash 命令做执行前快照的文件集提取。
 *
 * 分层：
 *   - 精确可提取：与权限侧**共用** `writeTargetsFromExpansion`（B8/L5，2026-11-11）。
 *     修前这里是第二套提取器，`perl -pi` / 解释器 / `find -delete` 在两侧识别结果不一致。
 *   - 范围性破坏（无法逐文件提取）：git reset --hard / checkout . / clean -fd——
 *     改用「工作区级轻量快照」：git diff --name-only + git diff --cached --name-only 的文件集。
 *
 * 触发条件：范围性破坏先判；其余命令直接跑共享提取器，**提不到目标就不建快照**
 * （纯函数解析、不 IO，所以不需要「命令文本里有没有 rm|mv|cp」那类正则预筛）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import {
  expandShellCommand,
  writeTargetsFromExpansion,
} from "../permission/shell-command-variants.ts";
import { getLogger } from "../debug/logger.ts";

const execFileAsync = promisify(execFile);

/**
 * git 子进程的耗时上限。
 *
 * 为什么必须有：checkpoint 的文件集提取在**每次破坏性 bash 执行前**同步等待
 * （`query/tool-executor.ts` 的 bash 分支），而 `git diff` / `git clean --dry-run` 在异常
 * 环境（超大仓库、慢盘、被安全软件挂起）里可能长时间不返回。没有上限时这次 bash 调用会
 * 一起挂住；CI 上的表现是测试撞 bun 的 5s 默认超时（2026-11-06 `test (macos-latest, 1/2)`
 * 实测 5000.77ms 超时）。
 *
 * 超时后由调用点既有的 catch 吞掉并降级为空集，符合本模块「提取失败不阻断」的设计，
 * 代价只是这一次少了快照保护——比让 bash 卡住好。
 *
 * 3s 的取值依据：`git diff --name-only` 在本仓/千文件仓库实测个位数到两位数毫秒，
 * 3s 已覆盖冷启动与慢盘；再大就失去「不挂住」的意义。
 */
export const GIT_SUBPROCESS_TIMEOUT_MS = 3000;

/** 判断命令是否为「范围性破坏」——影响整个工作区、无法逐文件静态提取 */
function isWorkspaceWideDestruction(command: string): boolean {
  return (
    /\bgit\s+reset\s+(--\S+\s+)*--hard\b/.test(command) ||
    /\bgit\s+(checkout|restore)\s+(--\s+)?\.[ \t]*($|[;&|\n])/.test(command) ||
    /\bgit\s+clean\b[^;&|\n]*-[a-zA-Z]*f/.test(command)
  );
}

/** 判断命令是否为 `git clean -f`（会删除**未跟踪**文件，需额外快照未跟踪文件集） */
function isGitClean(command: string): boolean {
  return /\bgit\s+clean\b[^;&|\n]*-[a-zA-Z]*f/.test(command);
}

/** 从工作区 git diff 提取「已修改 + 已暂存」文件集（范围性破坏的快照对象） */
async function getGitWorkingSetFiles(cwd: string): Promise<string[]> {
  const files = new Set<string>();
  const collect = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf-8",
        timeout: GIT_SUBPROCESS_TIMEOUT_MS,
      });
      for (const line of stdout.split("\n")) {
        const rel = line.trim();
        if (rel) files.add(path.isAbsolute(rel) ? rel : path.resolve(cwd, rel));
      }
    } catch {
      /* 非 git 仓库 / git 不可用 / 超时被杀 → 空集，不阻断 */
    }
  };
  // 已修改与已暂存互不依赖：并行让最坏耗时等于单条 timeout，而不是两条之和
  // （串行时两次都卡住就是 2×timeout，仍可能把调用方的等待预算撑爆）。
  await Promise.all([
    collect(["diff", "--name-only"]),
    collect(["diff", "--cached", "--name-only"]),
  ]);
  return [...files];
}

/**
 * 提取 `git clean` 将要删除的**未跟踪**文件集。
 *
 * 为什么单独一条路径：`git diff` 只看得到已跟踪文件的改动，而 `git clean -fd` 删的恰恰是
 * 未跟踪的新文件——这些文件不进快照就永远回退不了（P2-1 待决策项 3 拍板：要快照）。
 *
 * 做法：直接用 `git clean --dry-run` 把用户实际给的 flag（`-x`/`-X`/`-d`/pathspec）原样传给
 * git 自己算删除清单，比我们复刻 clean 的语义可靠得多。`-f` 换成 `-n` 保证只预演不删。
 *
 * 目录项（以 `/` 结尾）会展开为其下所有文件——快照按文件粒度存内容，目录本身存不了。
 */
async function getGitCleanTargets(command: string, cwd: string): Promise<string[]> {
  const files = new Set<string>();
  // 从原命令里取出 clean 的参数（去掉 -f/--force，加 -n 预演）
  let cleanArgs: string[];
  try {
    // 口径与主路径（`extractExplicitPaths`）一致：复用 `expandShellCommand`。它已正确处理
    // 换行分隔、heredoc 剥离与 `sh -c` 递归展开，也认得 `sudo` / `timeout` 这类包装命令。
    //
    // 修前这里是**第二套提取器**（`parseBashCommand` + `extractSimpleCommands`）：多行命令下
    // 后一条命令的参数会被并进 `git clean` 的参数里（2026-11-11 的 D4），
    // 比如 `git clean -fd`⏎`rm -rf /tmp/x` 会把 `rm`/`-rf`/`/tmp/x` 当成 clean 的 pathspec。
    const gitClean = expandShellCommand(command).commands.find(
      (c) => c.program === "git" && c.args.includes("clean"),
    );
    if (!gitClean) return [];
    const idx = gitClean.args.indexOf("clean");
    const rest = gitClean.args
      .slice(idx + 1)
      .filter((a) => {
        if (a === "--force") return false;
        // 短 flag 组合（-fd / -fdx）里剥掉 f，其余保留
        return true;
      })
      .map((a) => (/^-[a-zA-Z]+$/.test(a) ? a.replace(/f/g, "") : a))
      .filter((a) => a !== "-" && a !== "");
    cleanArgs = ["clean", "-n", ...rest];
  } catch {
    cleanArgs = ["clean", "-n", "-d"];
  }

  try {
    const { stdout } = await execFileAsync("git", cleanArgs, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_SUBPROCESS_TIMEOUT_MS,
      // ⚠️ 必须强制英文 + 关 quotepath：
      //   - git 会按 locale 本地化输出（中文环境下是「将删除 xxx」），
      //     不锁 LC_ALL 则解析正则全部失配 → 未跟踪文件静默不进快照（回退不了还以为保护了）。
      //   - core.quotepath=false 让非 ASCII 文件名原样输出，不被转义成 \344\270\255。
      env: {
        ...process.env,
        LC_ALL: "C",
        LANG: "C",
        GIT_CONFIG_PARAMETERS: "'core.quotepath=false'",
      },
    });
    // 输出形如 `Would remove path/to/file` / `Would remove dir/`
    for (const line of stdout.split("\n")) {
      const m = /^Would (?:remove|skip repository) (.+)$/.exec(line.trim());
      if (!m?.[1]) continue;
      const rel = m[1].trim();
      const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
      if (rel.endsWith("/")) {
        // 目录：展开其下所有文件（快照是文件粒度）
        for (const f of await listFilesRecursive(abs)) files.add(f);
      } else {
        files.add(abs);
      }
    }
  } catch {
    /* 非 git 仓库 / clean 不可用 → 空集，不阻断 */
  }
  return [...files];
}

/** 递归列出目录下所有文件（用于把 clean 的目录项展开成文件粒度）。 */
async function listFilesRecursive(dir: string, depth = 0): Promise<string[]> {
  // 深度上限防御：极深目录树不值得为一次快照全量遍历（也避免符号链接环）
  if (depth > 8) return [];
  const out: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await listFilesRecursive(full, depth + 1)));
      else if (e.isFile()) out.push(full);
    }
  } catch {
    /* 读不到就跳过 */
  }
  return out;
}

/**
 * 从单条 bash 命令提取精确的受影响文件路径。
 *
 * 2026-11-11（B8/L5）：改为复用 `writeTargetsFromExpansion`——与 safetyCheck **同一份**
 * 实现。修前这里是第二套提取器（bash parser + 命令白名单），实测 `perl -pi` 在安全侧
 * 能识别、在这里不能，`mv` 源则反过来；解释器 / `find -delete` 两侧都看不见。
 *
 * checkpoint 自己仍要过滤两类候选：
 * - 含变量 / 命令替换 / 通配符的路径静态不可知，收进来会写坏 index；
 * - `.` / `..` 是目录本身，范围性破坏已由 workspace-wide 快照兜底，不在这里逐文件建。
 */
function extractExplicitPaths(command: string, cwd: string): string[] {
  const files = new Set<string>();
  for (const target of writeTargetsFromExpansion(expandShellCommand(command))) {
    if (!isStaticPath(target)) continue;
    if (target === "." || target === ".." || target === "./") continue;
    files.add(path.isAbsolute(target) ? target : path.resolve(cwd, target));
  }
  return [...files];
}

/** 变量拼接 / 命令替换 / 通配符的路径无法静态确定，收进来会写坏 index——一律跳过（保守）。 */
function isStaticPath(token: string): boolean {
  return !!token && !/[$`*?~\[\]{}]/.test(token);
}

/**
 * 判断命令是否需要执行前快照，并返回受影响文件集。
 *
 * @param command bash 命令字符串
 * @param cwd 命令执行目录（相对路径解析基准）
 * @returns 受影响文件绝对路径数组；不需要快照时返回空数组
 */
export async function getBashAffectedFiles(command: string, cwd: string): Promise<string[]> {
  if (!command?.trim()) return [];

  try {
    // 范围性破坏 → 工作区级快照
    if (isWorkspaceWideDestruction(command)) {
      const workingSet = await getGitWorkingSetFiles(cwd);
      // `git clean -f` 额外快照未跟踪文件——它删的正是 git diff 看不到的新文件，
      // 不单独取就永远回退不了（P2-1 待决策项 3）。
      if (isGitClean(command)) {
        const cleanTargets = await getGitCleanTargets(command, cwd);
        return [...new Set([...workingSet, ...cleanTargets])];
      }
      return workingSet;
    }
    // 精确路径：与 safetyCheck 共用同一份提取（B8/L5）。
    //
    // 修前这里用「命令文本里出现 rm|mv|cp / `sed -i` / tee / 重定向」的正则做预筛——
    // 那是与 safetyCheck 平行的**第二套口径**：`perl -pi` 在安全侧能识别、在这里不能，
    // 解释器与 `find -delete` 两侧都看不见，改一处永远不会修另一处。
    // 现在由提取结果自己决定要不要快照（提不到目标 = 空集 = 不建快照），
    // 代价是每条 bash 多一次纯函数解析（不 IO），换来两套口径不再漂移。
    return extractExplicitPaths(command, cwd);
  } catch (err: any) {
    getLogger().warn("CHECKPOINT", `bash 受影响文件提取失败（不阻断）: ${err?.message}`);
    return [];
  }
}
