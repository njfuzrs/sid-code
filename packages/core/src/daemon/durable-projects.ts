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
 * 这是 C1 唯一需要触碰会话内层的地方（cron_create 加一行登记）。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
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

function write(content: RegistryContent): void {
  const path = registryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(content, null, 2));
  } catch (err: any) {
    getLogger().warn("DAEMON", `写入 durable-projects 注册表失败: ${err?.message ?? err}`);
  }
}

/**
 * 登记一个项目根（cron_create durable=true 时调用）。
 * 幂等：已登记则不重复。
 */
export function registerDurableProject(projectDir: string): void {
  const dir = projectDir.trim();
  if (!dir) return;
  const content = read();
  if (content.projects.includes(dir)) return;
  content.projects.push(dir);
  content.updatedAt = Date.now();
  write(content);
}

/**
 * 列出所有已登记且仍有持久任务的项目根。
 * 自愈：项目目录不存在、或其 scheduled_tasks.json 不存在 → 从清单剔除。
 * 返回清理后的有效项目列表。
 */
export function listDurableProjects(): string[] {
  const content = read();
  const valid: string[] = [];
  let changed = false;

  for (const dir of content.projects) {
    const jsonPath = join(dir, ".sid-code", "scheduled_tasks.json");
    if (existsSync(dir) && existsSync(jsonPath)) {
      valid.push(dir);
    } else {
      changed = true; // 剔除失效项
    }
  }

  if (changed) {
    write({ projects: valid, updatedAt: Date.now() });
  }
  return valid;
}

/** 显式移除一个项目根（运维/测试用） */
export function unregisterDurableProject(projectDir: string): void {
  const content = read();
  const idx = content.projects.indexOf(projectDir.trim());
  if (idx === -1) return;
  content.projects.splice(idx, 1);
  content.updatedAt = Date.now();
  write(content);
}
