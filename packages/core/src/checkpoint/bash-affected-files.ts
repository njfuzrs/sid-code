/**
 * 从破坏性 bash 命令提取受影响文件（P2-1）
 *
 * 背景：checkpoint 原本只对 write/edit 工具快照，通过 bash 跑的 `git reset --hard`、
 * `git checkout .`、`rm file`、`git clean -fd` 造成的破坏无法被 /undo 回退——而这恰恰是
 * 最需要回退保护的操作。这里为破坏性 bash 命令做执行前快照的文件集提取。
 *
 * 分层：
 *   - 精确可提取：rm <file> / git checkout <file> / mv <src> <dst>——从 AST 提取显式路径。
 *   - 范围性破坏（无法逐文件提取）：git reset --hard / checkout . / clean -fd——
 *     改用「工作区级轻量快照」：git diff --name-only + git diff --cached --name-only 的文件集。
 *
 * 触发条件收敛：只对破坏性命令（matchGitDanger 命中，或 rm/mv 等文件破坏命令）做提取，
 * 不是所有 bash 都快照，避免每条命令都 IO。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import {
  parseBashCommand,
  extractSimpleCommands,
  extractRedirectTargets,
} from "../tool/bash/parser.ts";
import { matchGitDanger } from "../permission/git-danger-patterns.ts";
import { getLogger } from "../debug/logger.ts";

const execFileAsync = promisify(execFile);

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
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
      for (const line of stdout.split("\n")) {
        const rel = line.trim();
        if (rel) files.add(path.isAbsolute(rel) ? rel : path.resolve(cwd, rel));
      }
    } catch {
      /* 非 git 仓库 / git 不可用 → 空集，不阻断 */
    }
  };
  await collect(["diff", "--name-only"]);
  await collect(["diff", "--cached", "--name-only"]);
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
    const simples = extractSimpleCommands(parseBashCommand(command));
    const gitClean = simples.find((s) => s.command === "git" && s.args.some((a) => a === "clean"));
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
 * 从单条 bash 命令的 AST 提取精确的受影响文件路径。
 * 只处理 rm / git checkout <file> / git restore <file> / mv 等显式路径命令。
 */
function extractExplicitPaths(command: string, cwd: string): string[] {
  const files: string[] = [];
  let ast: ReturnType<typeof parseBashCommand>;
  let simpleCommands: Array<{ command: string; args: string[] }>;
  try {
    ast = parseBashCommand(command);
    simpleCommands = extractSimpleCommands(ast);
  } catch {
    return files;
  }

  const resolve = (tok: string) => (path.isAbsolute(tok) ? tok : path.resolve(cwd, tok));
  // 变量拼接 / 命令替换 / 通配符的路径无法静态确定，收进来会写坏 index——一律跳过（保守）。
  const isStatic = (tok: string) => !!tok && !/[$`*?~\[\]{}]/.test(tok);

  // P0-B1：`>`/`>>` 重定向目标（echo x > f、cmd >> log）——parser 已能提取。
  try {
    for (const target of extractRedirectTargets(ast)) {
      if (isStatic(target)) files.push(resolve(target));
    }
  } catch {
    /* 重定向提取失败不阻断其余提取 */
  }

  for (const { command: cmd, args } of simpleCommands) {
    if (cmd === "rm") {
      // rm [-flags] file...：取所有非 flag 参数
      for (const a of args) {
        if (!a || a.startsWith("-") || !isStatic(a)) continue;
        files.push(resolve(a));
      }
    } else if (cmd === "mv" || cmd === "cp") {
      // mv/cp src... dst：源与目标都可能被破坏/覆盖，全收
      for (const a of args) {
        if (!a || a.startsWith("-") || !isStatic(a)) continue;
        files.push(resolve(a));
      }
    } else if (cmd === "tee") {
      // tee [-a] file...：写入目标文件（含 -a 追加）
      for (const a of args) {
        if (!a || a.startsWith("-") || !isStatic(a)) continue;
        files.push(resolve(a));
      }
    } else if (cmd === "sed") {
      // sed [flags] SCRIPT FILE...：仅在带 -i（原地编辑）时提取目标文件。
      const hasInplace = args.some(
        (a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place"),
      );
      if (hasInplace) {
        // 结构=flags + 脚本 + 文件...。脚本是第一个非 flag token（形如 's/a/b/'、'1d'），
        // 跳过它，其余非 flag token 视为文件。`-e <script>` 形式也一并跳过其后紧邻的脚本。
        let scriptSeen = false;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (!a) continue;
          if (a === "-e" || a === "-f") {
            i++;
            scriptSeen = true;
            continue;
          } // 脚本作为独立参数
          if (a.startsWith("-")) continue;
          if (!scriptSeen) {
            scriptSeen = true;
            continue;
          } // 第一个非 flag = 内联脚本，跳过
          if (!isStatic(a)) continue;
          files.push(resolve(a));
        }
      }
    } else if (cmd === "git") {
      const sub = args[0];
      if (sub === "checkout" || sub === "restore") {
        // git checkout/restore <file>（非 "." —— "." 走范围性快照）
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (!a || a.startsWith("-") || a === "." || !isStatic(a)) continue;
          // 跳过 <commit>/<branch>：checkout 的第一个非 flag 参数可能是分支名。
          // 保守起见：只收看起来像路径的（含 / 或 . 或存在后缀）——难精确，
          // 但范围性破坏已由 workspace-wide 兜底，这里只做尽力而为。
          files.push(resolve(a));
        }
      }
    }
  }
  return files;
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

  const isDestructiveGit = matchGitDanger(command) !== null;
  const isFileDestruction = /\b(rm|mv|cp)\b/.test(command);
  // P0-B1：非破坏性但仍会改文件的命令——原地编辑（sed -i）、写入（tee）、重定向（> >>）。
  // 这些此前是 checkpoint 盲区：/undo 够不到用 bash 改的文件。
  const isFileMutation =
    /\bsed\b[^;&|\n]*\s-i\b/.test(command) ||
    /\btee\b/.test(command) ||
    /(^|[^0-9<>])>>?[^&]/.test(command);

  // 触发条件收敛：既不破坏也不改文件的命令不快照
  if (!isDestructiveGit && !isFileDestruction && !isFileMutation) return [];

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
    // 精确路径提取
    return extractExplicitPaths(command, cwd);
  } catch (err: any) {
    getLogger().warn("CHECKPOINT", `bash 受影响文件提取失败（不阻断）: ${err?.message}`);
    return [];
  }
}
