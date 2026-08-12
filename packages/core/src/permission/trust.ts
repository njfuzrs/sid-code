/**
 * 工作区信任门控（TrustDialog）
 * 启动时扫描项目目录下的危险配置，未信任时阻止危险操作
 * 信任持久化到 ~/.sid-code/trusted-projects.json
 * 家目录的信任是 session-only，不持久化
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";

/** 信任检查项 */
export interface TrustCheckItem {
  type: "hooks" | "mcp_servers" | "env_vars" | "bash_permissions";
  source: string; // 来源文件路径
  description: string; // 人类可读描述
  details?: string; // 具体内容（脱敏后）
}

/**
 * 待信任确认的快照（SEC-AUDIT-2026-07-19 P1）。
 *
 * 由 cli.ts 在**配置生效之前**填充（strip 掉危险配置时），由 app.ts 在 TUI 就绪后读取
 * 并弹 TrustDialog。用模块级单例传递而非穿参，是因为 cli→App 的构造参数链很长，
 * 且 App 构造器（hooks 初始化在里面）本身就在消费已 strip 过的 config。
 */
export interface PendingTrust {
  /** 被 strip 掉的危险配置项（供对话框展示） */
  items: TrustCheckItem[];
  /** 工作区路径 */
  workspacePath: string;
}

let pendingTrust: PendingTrust | null = null;

/** 登记待确认的信任快照（cli.ts strip 危险配置后调用） */
export function setPendingTrust(value: PendingTrust | null): void {
  pendingTrust = value;
}

/** 读取待确认的信任快照（app.ts 决定是否弹对话框） */
export function getPendingTrust(): PendingTrust | null {
  return pendingTrust;
}

/** 清空待确认快照（用户已做决定后调用） */
export function clearPendingTrust(): void {
  pendingTrust = null;
}

/** 信任状态 */
export interface TrustState {
  accepted: boolean;
  sessionOnly: boolean; // 家目录 = true
  checkedItems: TrustCheckItem[];
}

/** 持久化的信任记录 */
interface TrustedProject {
  /** 项目路径的 SHA-256 hash */
  pathHash: string;
  /** 信任时间 */
  trustedAt: string;
  /** 信任时的配置 hash（配置变更后需要重新信任） */
  configHash: string;
}

/** 持久化文件格式 */
interface TrustedProjectsFile {
  version: 1;
  projects: TrustedProject[];
}

/** 信任记录持久化路径：~/.sid-code/state/trusted-projects.json */
function trustedProjectsPath(): string {
  return sidPaths.trustedProjects();
}

/**
 * 工作区信任管理器
 */
export class TrustManager {
  private workspacePath: string;
  /** 当前会话的信任状态 */
  private sessionTrust = false;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * 扫描项目目录下的危险配置
   * 返回需要用户确认的检查项列表
   */
  async scanDangerousConfigs(): Promise<TrustCheckItem[]> {
    const items: TrustCheckItem[] = [];
    const settingsPath = join(this.workspacePath, ".sid-code", "settings.json");

    if (!existsSync(settingsPath)) {
      return items;
    }

    try {
      const content = await Bun.file(settingsPath).text();
      const settings = JSON.parse(content);

      // 检查 hooks 配置
      if (settings.hooks && Object.keys(settings.hooks).length > 0) {
        const hookCount = Object.values(settings.hooks).flat().length;
        items.push({
          type: "hooks",
          source: settingsPath,
          description: `${hookCount} 个 Hook 配置（可执行任意命令）`,
          details: Object.keys(settings.hooks).join(", "),
        });
      }

      // 检查 MCP 服务器配置
      if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
        const serverNames = Object.keys(settings.mcpServers);
        items.push({
          type: "mcp_servers",
          source: settingsPath,
          description: `${serverNames.length} 个 MCP 服务器（可执行外部进程）`,
          details: serverNames.join(", "),
        });
      }

      // 检查环境变量配置
      if (settings.env && Object.keys(settings.env).length > 0) {
        const envKeys = Object.keys(settings.env);
        items.push({
          type: "env_vars",
          source: settingsPath,
          description: `${envKeys.length} 个环境变量`,
          details: envKeys.join(", "),
        });
      }

      // 检查 Bash 权限规则
      const perms = settings.permissions;
      if (perms?.allow) {
        const bashRules = (perms.allow as string[]).filter((r) =>
          r.toLowerCase().startsWith("bash"),
        );
        if (bashRules.length > 0) {
          items.push({
            type: "bash_permissions",
            source: settingsPath,
            description: `${bashRules.length} 条 Bash 允许规则`,
            details: bashRules.join(", "),
          });
        }
      }
    } catch (err: any) {
      getLogger().warn("TRUST", `扫描 ${settingsPath} 失败: ${err.message}`);
    }

    return items;
  }

  /**
   * 检查当前工作区是否已被信任
   */
  async isTrusted(): Promise<boolean> {
    // session-only 信任
    if (this.sessionTrust) return true;

    // 家目录不持久化信任
    if (this.isHomeDirectory()) return false;

    // 检查持久化信任
    const pathHash = this.getPathHash();
    const configHash = await this.getConfigHash();
    const trusted = await this.loadTrustedProjects();

    const record = trusted.projects.find((p) => p.pathHash === pathHash);
    if (!record) return false;

    // 配置变更后需要重新信任
    if (record.configHash !== configHash) {
      getLogger().info("TRUST", "项目配置已变更，需要重新信任");
      return false;
    }

    return true;
  }

  /**
   * 标记当前工作区为已信任
   */
  async trust(): Promise<void> {
    const log = getLogger();

    // 家目录只做 session-only 信任
    if (this.isHomeDirectory()) {
      this.sessionTrust = true;
      log.info("TRUST", "家目录信任（session-only）");
      return;
    }

    // 持久化信任
    const pathHash = this.getPathHash();
    const configHash = await this.getConfigHash();
    const trusted = await this.loadTrustedProjects();

    // 更新或添加记录
    const existing = trusted.projects.findIndex((p) => p.pathHash === pathHash);
    const record: TrustedProject = {
      pathHash,
      trustedAt: new Date().toISOString(),
      configHash,
    };

    if (existing >= 0) {
      trusted.projects[existing] = record;
    } else {
      trusted.projects.push(record);
    }

    await this.saveTrustedProjects(trusted);
    this.sessionTrust = true;
    log.info("TRUST", `工作区已信任: ${this.workspacePath}`);
  }

  /**
   * 撤销信任
   */
  async revokeTrust(): Promise<void> {
    this.sessionTrust = false;
    const pathHash = this.getPathHash();
    const trusted = await this.loadTrustedProjects();
    trusted.projects = trusted.projects.filter((p) => p.pathHash !== pathHash);
    await this.saveTrustedProjects(trusted);
  }

  /** 是否为家目录 */
  private isHomeDirectory(): boolean {
    const home = homedir();
    return this.workspacePath === home || this.workspacePath === home + "/";
  }

  /** 获取路径 hash */
  private getPathHash(): string {
    return createHash("sha256").update(this.workspacePath).digest("hex");
  }

  /** 获取配置内容 hash（用于检测配置变更） */
  private async getConfigHash(): Promise<string> {
    const settingsPath = join(this.workspacePath, ".sid-code", "settings.json");
    try {
      if (!existsSync(settingsPath)) return "empty";
      const content = await Bun.file(settingsPath).text();
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return "error";
    }
  }

  /** 加载持久化的信任记录 */
  private async loadTrustedProjects(): Promise<TrustedProjectsFile> {
    try {
      if (!existsSync(trustedProjectsPath())) {
        return { version: 1, projects: [] };
      }
      const content = await Bun.file(trustedProjectsPath()).text();
      return JSON.parse(content);
    } catch {
      return { version: 1, projects: [] };
    }
  }

  /** 保存持久化的信任记录 */
  private async saveTrustedProjects(data: TrustedProjectsFile): Promise<void> {
    const dir = sidPaths.state();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(trustedProjectsPath(), JSON.stringify(data, null, 2) + "\n");
  }
}
