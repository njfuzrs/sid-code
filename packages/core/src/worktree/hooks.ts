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
 */

import { spawn } from "child_process";
import { getSettings } from "../config/settings/settings.ts";
import { getLogger } from "../debug/logger.ts";

/** hook 执行超时（ms） */
const HOOK_TIMEOUT_MS = 30_000;

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

/** 读取指定 worktree hook 的第一个 command 配置 */
function getWorktreeHook(
  event: "WorktreeCreate" | "WorktreeRemove",
  gitRoot?: string,
): HookEntry | null {
  try {
    const { settings } = getSettings(gitRoot);
    const hooks = settings?.hooks as Record<string, HookEntry[]> | undefined;
    const entries = hooks?.[event];
    if (!Array.isArray(entries)) return null;
    const cmd = entries.find((e) => e?.command && (e.type ?? "command") === "command");
    return cmd ?? null;
  } catch {
    return null;
  }
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
  const worktreePath = out.split("\n").pop()?.trim() ?? "";
  if (!worktreePath) {
    throw new Error("WorktreeCreate hook 未输出 worktree 路径");
  }
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
