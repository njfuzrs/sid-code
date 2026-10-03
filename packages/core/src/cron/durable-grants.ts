/**
 * durable 任务的本机授权登记（B43）
 *
 * `<project>/.sid-code/scheduled_tasks.json` 在项目目录里，**不受本机用户独占控制**：
 * 它可能随 git pull 进来（团队提交 / 恶意 PR 合入），也可能被项目里任何脚本改写。
 * 而无人值守执行会按文件里的 `prompt` / `allowedTools` / `workspaceDir` 跑 agent ——
 * 文件内容等于自己给自己授权。
 *
 * 所以「这个任务能不能被自动执行」不能由项目文件自己说了算。每次在本机经
 * Scheduler.addDurableTask 创建任务时，把它的内容指纹记进用户级
 * `~/.sid-code/state/durable-task-grants.json`；驱动者触发前比对指纹，
 * 对不上（不是本机建的，或建完之后被改过）一律不执行、只告警。
 *
 * 指纹不含 lastFiredAt：触发推进它是正常写回，不应让授权失效。
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { sidPaths } from "../config/paths.ts";
import { withFileMutex, writeAtomic } from "./durable-store.ts";
import type { CronTask } from "./types.ts";

interface GrantsFile {
  /** key = `${projectDir}::${taskId}` → 内容指纹 */
  grants: Record<string, string>;
}

function grantsPath(): string {
  return sidPaths.stateFile("durable-task-grants.json");
}

function keyOf(projectDir: string, taskId: string): string {
  return `${resolve(projectDir)}::${taskId}`;
}

/** 任务内容指纹：决定「跑什么、在哪跑、放行什么」的字段全部纳入 */
export function taskFingerprint(projectDir: string, t: CronTask): string {
  const payload = JSON.stringify({
    projectDir: resolve(projectDir),
    id: t.id,
    cron: t.cron,
    prompt: t.prompt,
    recurring: t.recurring,
    fireAt: t.fireAt ?? null,
    workspaceDir: t.workspaceDir ? resolve(t.workspaceDir) : null,
    allowedTools: [...(t.allowedTools ?? [])].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function read(): GrantsFile {
  const path = grantsPath();
  if (!existsSync(path)) return { grants: {} };
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed.grants !== "object") throw new Error(`${path} 格式不对`);
  return parsed as GrantsFile;
}

function mutate(fn: (g: GrantsFile) => boolean): void {
  const path = grantsPath();
  mkdirSync(dirname(path), { recursive: true });
  withFileMutex(path, () => {
    const g = read();
    if (fn(g)) writeAtomic(path, JSON.stringify(g, null, 2));
  });
}

/** 登记授权。失败抛错（调用方据此拒绝创建任务）。 */
export function grantDurableTask(projectDir: string, t: CronTask): void {
  const fp = taskFingerprint(projectDir, t);
  mutate((g) => {
    if (g.grants[keyOf(projectDir, t.id)] === fp) return false;
    g.grants[keyOf(projectDir, t.id)] = fp;
    return true;
  });
}

/** 撤销授权（任务删除 / 一次性任务执行后）。失败只影响登记表整洁，不影响安全，调用方可吞。 */
export function revokeDurableTask(projectDir: string, taskId: string): void {
  mutate((g) => {
    if (!(keyOf(projectDir, taskId) in g.grants)) return false;
    delete g.grants[keyOf(projectDir, taskId)];
    return true;
  });
}

/**
 * 该任务当前内容是否经本机授权。读登记表失败按「未授权」处理（fail-closed）。
 */
export function isDurableTaskGranted(projectDir: string, t: CronTask): boolean {
  try {
    return read().grants[keyOf(projectDir, t.id)] === taskFingerprint(projectDir, t);
  } catch {
    return false;
  }
}
