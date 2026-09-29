/**
 * Hook-based VCS 抽象（P1-1 / D20）
 *
 * 非 git 仓库（Perforce / SVN / 企业定制）无法用 git worktree。
 * 允许用户在 settings.json 配置 WorktreeCreate / WorktreeRemove hook，
 * 由外部命令负责"创建隔离工作区"和"清理"，sid-code 只调用并取路径。
 *
 * 优先级（在 WorktreeManager.create 中）：
 *   hasWorktreeCreateHook() → executeWorktreeCreateHook()
 *   else isGitRepo          → git worktree add
 *   else                    → throw
 *
 * 安全：hook 命令执行有 timeout（默认 30s）+ AbortController，防卡死（D20）。
 *
 * W10（2026-09-29）两道补上的边界：
 * 1. **来源**：`filterProjectSettings` 不过滤 `hooks`，所以一个仓库提交的
 *    `.sid-code/settings.json` 能带 WorktreeCreate —— clone 之后第一次
 *    `enter_worktree` 就执行它。启动期信任门控（cli.ts）只 strip 了 `config.hooks`，
 *    而这里读的是 `getSettings()`，那道门对它不生效。现在项目级来源的 worktree hook
 *    只在工作区被信任后才认；user / local / policy / flag 来源照旧。
 * 2. **输出**：hook 打印的路径会被直接 `process.chdir`。现在要求它是绝对路径、
 *    真实存在的目录，且不是文件系统根 / 主仓根本身（后两者 chdir 进去等于没隔离）。
 */

import { spawn } from "child_process";
import { statSync } from "fs";
import { isAbsolute, parse, resolve } from "path";
import { getEnabledSettingSources, getSettingsForSource } from "../config/settings/settings.ts";
import { TrustManager } from "../permission/trust.ts";
import { getLogger } from "../debug/logger.ts";

/** hook 执行超时（ms） */
const HOOK_TIMEOUT_MS = 30_000;

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

/** 从单个来源的 hooks 段里取第一个 command 型条目 */
function pickHook(hooks: unknown, event: "WorktreeCreate" | "WorktreeRemove"): HookEntry | null {
  const entries = (hooks as Record<string, HookEntry[]> | undefined)?.[event];
  if (!Array.isArray(entries)) return null;
  return entries.find((e) => e?.command && (e.type ?? "command") === "command") ?? null;
}

/**
 * 读取指定 worktree hook 的第一个 command 配置。
 *
 * 逐来源读而不是读合并结果：合并后分不出某条 hook 来自哪个文件，
 * 而「来自仓库提交的 settings.json」恰恰是要单独判信任的那一类（W10）。
 * 来源顺序沿用 SETTING_SOURCES（user → project → local → flag → policy），
 * 与合并语义下「数组拼接、第一个命中」的结果一致；并且同样受 --setting-sources 过滤。
 */
function getWorktreeHook(
  event: "WorktreeCreate" | "WorktreeRemove",
  gitRoot?: string,
): HookEntry | null {
  let projectTrusted: boolean | undefined; // 惰性：只在项目级真有 hook 时才读信任记录
  for (const source of getEnabledSettingSources()) {
    let hook: HookEntry | null = null;
    try {
      hook = pickHook(getSettingsForSource(source, gitRoot).settings?.hooks, event);
    } catch {
      continue;
    }
    if (!hook) continue;
    if (source === "projectSettings") {
      projectTrusted ??= new TrustManager(gitRoot ?? process.cwd()).isTrustedSync();
      if (!projectTrusted) {
        getLogger().warn(
          "WORKTREE",
          `忽略项目级 ${event} hook：工作区未被信任（信任后方可由仓库配置接管 worktree 创建/删除）`,
        );
        continue;
      }
    }
    return hook;
  }
  return null;
}

/**
 * 校验 WorktreeCreate hook 打印的路径（W10）。
 * 返回规范化后的绝对路径；不合格直接抛错 —— 调用方拿到它就会 chdir 进去。
 */
export function validateHookWorktreePath(raw: string, gitRoot: string): string {
  if (!isAbsolute(raw)) {
    throw new Error(`WorktreeCreate hook 输出的不是绝对路径: ${raw}`);
  }
  const p = resolve(raw);
  let isDir = false;
  try {
    isDir = statSync(p).isDirectory();
  } catch {
    /* 不存在 */
  }
  if (!isDir) {
    throw new Error(`WorktreeCreate hook 输出的路径不是已存在的目录: ${p}`);
  }
  if (p === parse(p).root) {
    throw new Error(`WorktreeCreate hook 输出了文件系统根目录，拒绝进入: ${p}`);
  }
  if (p === resolve(gitRoot)) {
    // 进入主仓本身 = 没有隔离，而调用方（子代理 / workflow）以为自己拿到了隔离
    throw new Error(`WorktreeCreate hook 输出的是主仓根目录，不是隔离工作区: ${p}`);
  }
  return p;
}

/** 是否配置了 WorktreeCreate hook */
export function hasWorktreeCreateHook(gitRoot?: string): boolean {
  return getWorktreeHook("WorktreeCreate", gitRoot) !== null;
}

/** 是否配置了 WorktreeRemove hook */
export function hasWorktreeRemoveHook(gitRoot?: string): boolean {
  return getWorktreeHook("WorktreeRemove", gitRoot) !== null;
}

/** 执行 hook 命令，stdin 传入 JSON，stdout 作为结果。带 timeout 保护。 */
function runHookCommand(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const proc = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: controller.signal,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`worktree hook 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`worktree hook 退出码 ${code}: ${stderr.trim() || stdout.trim() || "无输出"}`),
        );
      }
    });

    // hook 不读 stdin 且很快退出（如 `printf /path`）时，写入会以**异步** error 事件报 EPIPE，
    // 下面的 try/catch 接不住。不挂监听就会顶掉 close 分支里真正的结果（CI ubuntu 上实测：
    // 本该是「根目录」校验错误，拿到的却是 EPIPE）。stdin 是可选输入，失败一律忽略。
    proc.stdin?.on("error", () => {});
    try {
      proc.stdin?.write(JSON.stringify(payload));
      proc.stdin?.end();
    } catch {
      /* stdin 写入失败不阻断 */
    }
  });
}

/**
 * 执行 WorktreeCreate hook。
 * 传入 {name, cwd, projectRoot}，stdout 作为 worktreePath 返回。
 */
export async function executeWorktreeCreateHook(
  slug: string,
  gitRoot: string,
): Promise<{ worktreePath: string }> {
  const log = getLogger();
  const hook = getWorktreeHook("WorktreeCreate", gitRoot);
  if (!hook?.command) {
    throw new Error("未配置 WorktreeCreate hook");
  }
  const timeoutMs = (hook.timeout ? hook.timeout * 1000 : 0) || HOOK_TIMEOUT_MS;
  const out = await runHookCommand(
    hook.command,
    { name: slug, cwd: gitRoot, projectRoot: gitRoot },
    timeoutMs,
  );
  const lastLine = out.split("\n").pop()?.trim() ?? "";
  if (!lastLine) {
    throw new Error("WorktreeCreate hook 未输出 worktree 路径");
  }
  const worktreePath = validateHookWorktreePath(lastLine, gitRoot);
  log.info("WORKTREE", `Hook 创建 worktree: ${worktreePath}`);
  return { worktreePath };
}

/**
 * 执行 WorktreeRemove hook。
 * 传入 {worktree_path, cwd, projectRoot}。非 0 退出码抛异常。
 */
export async function executeWorktreeRemoveHook(
  worktreePath: string,
  gitRoot: string,
): Promise<void> {
  const log = getLogger();
  const hook = getWorktreeHook("WorktreeRemove", gitRoot);
  if (!hook?.command) {
    throw new Error("未配置 WorktreeRemove hook");
  }
  const timeoutMs = (hook.timeout ? hook.timeout * 1000 : 0) || HOOK_TIMEOUT_MS;
  await runHookCommand(
    hook.command,
    { worktree_path: worktreePath, cwd: gitRoot, projectRoot: gitRoot },
    timeoutMs,
  );
  log.info("WORKTREE", `Hook 移除 worktree: ${worktreePath}`);
}
