/**
 * durable-projects 注册表（缺口 C1 §4.5）
 *
 * 交互式 Scheduler 只读自己项目的 <project>/.sid-code/scheduled_tasks.json，
 * 但守护进程要管「所有项目」的 durable 任务，需要一个「已知项目清单」。
 *
 * 方案：当 cron_create(durable=true) 创建持久任务时，除写项目级 json 外，
 * 额外在 ~/.sid-code/state/durable-projects.json 登记该项目根路径。
 * 守护进程启动时读该清单，逐个项目加载其 scheduled_tasks.json 合并调度。
 * 项目被删 / json 不存在时从清单剔除（自愈）。
 *
 * 登记发生在 Scheduler.addDurableTask 写盘成功之后（B43：此前在 cron_create 里登记，
 * 且失败被吞；任何其他入口建的 durable 任务都不会被 daemon 发现）。
 * 注册表是多进程读改写的，一律包在文件互斥里并原子写，否则两个项目同时登记会互相覆盖。
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { withFileMutex, writeAtomic } from "../cron/durable-store.ts";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

/** 注册表文件路径（本机全局，放 state/） */
function registryPath(): string {
  return sidPaths.stateFile("durable-projects.json");
}

interface RegistryContent {
  /** 项目根目录绝对路径列表 */
  projects: string[];
  updatedAt: number;
}

function read(): RegistryContent {
  const path = registryPath();
  if (!existsSync(path)) return { projects: [], updatedAt: 0 };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RegistryContent;
    if (!Array.isArray(parsed.projects)) return { projects: [], updatedAt: 0 };
    return parsed;
  } catch (err: any) {
    getLogger().warn("DAEMON", `读取 durable-projects 注册表失败: ${err?.message ?? err}`);
    return { projects: [], updatedAt: 0 };
  }
}

/** 写失败抛错：登记失败意味着 daemon 永远发现不了这个项目，不能静默 */
function write(content: RegistryContent): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(content, null, 2));
}

/**
 * 登记一个项目根（cron_create durable=true 时调用）。
 * 幂等：已登记则不重复。
 */
export function registerDurableProject(projectDir: string): void {
  const dir = projectDir.trim() ? resolve(projectDir.trim()) : "";
  if (!dir) return;
  mkdirSync(dirname(registryPath()), { recursive: true });
  withFileMutex(registryPath(), () => {
    const content = read();
    if (content.projects.includes(dir)) return;
    content.projects.push(dir);
    content.updatedAt = Date.now();
    write(content);
  });
}

/**
 * 列出所有已登记且仍有持久任务的项目根。
 * 自愈：项目目录不存在、或其 scheduled_tasks.json 不存在 → 从清单剔除。
 * 返回清理后的有效项目列表。
 */
export function listDurableProjects(): string[] {
  const isValid = (dir: string) =>
    existsSync(dir) && existsSync(join(dir, ".sid-code", "scheduled_tasks.json"));
  const snapshot = read();
  if (snapshot.projects.every(isValid)) return snapshot.projects;

  // 有失效项才进互斥自愈：在锁内重读，避免把别的进程刚登记的项目一并抹掉
  try {
    mkdirSync(dirname(registryPath()), { recursive: true });
    return withFileMutex(registryPath(), () => {
      const content = read();
      const valid = content.projects.filter(isValid);
      if (valid.length !== content.projects.length) {
        write({ projects: valid, updatedAt: Date.now() });
      }
      return valid;
    });
  } catch (err: any) {
    getLogger().warn(
      "DAEMON",
      `durable-projects 自愈写回失败（本轮按有效项继续）: ${err?.message ?? err}`,
    );
    return snapshot.projects.filter(isValid);
  }
}

/** 显式移除一个项目根（运维/测试用） */
export function unregisterDurableProject(projectDir: string): void {
  const dir = resolve(projectDir.trim());
  mkdirSync(dirname(registryPath()), { recursive: true });
  withFileMutex(registryPath(), () => {
    const content = read();
    const idx = content.projects.indexOf(dir);
    if (idx === -1) return;
    content.projects.splice(idx, 1);
    content.updatedAt = Date.now();
    write(content);
  });
}
