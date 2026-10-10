/**
 * 工作区信任门控（TrustDialog）
 * 启动时扫描项目目录下的危险配置，未信任时阻止危险操作
 * 信任持久化到 ~/.sid-code/trusted-projects.json
 * 家目录的信任是 session-only，不持久化
 */

import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import { isGitTrackedFile } from "../config/settings/security.ts";
import { getLegacyLocalSettingsPath, getSettingsFilePath } from "../config/settings/constants.ts";
import { getCheckoutRoot, getProjectIdentityRoot } from "../config/project-bases.ts";

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

/**
 * 本进程的工作区是否处于「有危险配置且未信任」状态（D3）。
 *
 * 由 cli.ts 的信任门控在配置生效前写入，Phase 2 全量 env 注入读它决定跑不跑。
 * 不能靠 pendingTrust 判断：非交互模式不登记快照，但同样是未信任。
 * 用户在 TrustDialog 里点「信任」后**不**清掉它：信任的语义是「下次启动完整加载」
 * （hooks / MCP 同样不热加载），本会话继续按降级配置跑，env 与它们保持一致。
 */
let workspaceUntrusted = false;

export function setWorkspaceUntrusted(value: boolean): void {
  workspaceUntrusted = value;
}

export function isWorkspaceUntrusted(): boolean {
  return workspaceUntrusted;
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

/** 路径 → 记录键（与历史口径一致：对原始字符串做 sha256，不做 realpath） */
function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex");
}

/** 信任记录持久化路径：~/.sid-code/state/trusted-projects.json */
function trustedProjectsPath(): string {
  return sidPaths.trustedProjects();
}

/**
 * 工作区信任管理器
 */
export class TrustManager {
  /** 启动目录（B1）：危险配置从这里扫，与共享 settings.json 的加载口径一致 */
  private workspacePath: string;
  /**
   * P10：信任记录的键 = 项目身份根（B2，git root；非仓库退回 cwd）。此前 cli.ts / app.ts
   * 用 cwd、worktree/hooks.ts 用 gitRoot，同一个仓库在根目录信任过、到子目录又判未信任，
   * 而 worktree hook 判定读的又是另一把键。
   */
  private identityRoot: string;
  /** 当前会话的信任状态 */
  private sessionTrust = false;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.identityRoot = getProjectIdentityRoot(workspacePath);
  }

  /**
   * 扫描项目目录下的危险配置
   * 返回需要用户确认的检查项列表
   */
  async scanDangerousConfigs(): Promise<TrustCheckItem[]> {
    const items: TrustCheckItem[] = [];
    for (const settingsPath of this.untrustedSettingsFiles()) {
      await this.scanSettingsFile(settingsPath, items);
    }
    return items;
  }

  /**
   * 需要过信任门的项目配置文件：settings.json 恒在列；settings.local.json 只在被 git 追踪时
   * 在列（D1/D3：被追踪 = 会随 clone 分发 = 可能是别人写的）。未追踪的 local 文件是本机
   * 私有配置，把它也拉进来只会让每个用本机 hooks 的人每次改配置都被问一遍。
   */
  private untrustedSettingsFiles(): string[] {
    const files = [join(this.workspacePath, ".sid-code", "settings.json")];
    // P1b：local 文件可能有两份（git root 新位置 + 启动目录旧位置），被追踪的都要过信任门
    const locals = [
      getLegacyLocalSettingsPath(this.workspacePath),
      getSettingsFilePath("localSettings", this.workspacePath),
    ];
    for (const local of locals) {
      if (local && isGitTrackedFile(local)) files.push(local);
    }
    return files;
  }

  private async scanSettingsFile(settingsPath: string, items: TrustCheckItem[]): Promise<void> {
    if (!existsSync(settingsPath)) return;

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
    const configHash = await this.getConfigHash();
    const trusted = await this.loadTrustedProjects();

    const found = this.findRecord(trusted.projects);
    if (!found) return false;
    // 祖先目录的信任是锁存值（对齐 CC），不比 configHash —— 见 findRecord
    if (found.inherited) return true;
    const record = found.record;

    // 配置变更后需要重新信任（只对本项目自己的记录）
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
    log.info("TRUST", `工作区已信任: ${this.identityRoot}（启动目录 ${this.workspacePath}）`);
  }

  /**
   * 撤销信任
   */
  async revokeTrust(): Promise<void> {
    this.sessionTrust = false;
    const pathHash = this.getPathHash();
    const trusted = await this.loadTrustedProjects();
    const legacy = new Set([
      hashPath(this.workspacePath),
      hashPath(getCheckoutRoot(this.workspacePath)),
    ]);
    trusted.projects = trusted.projects.filter(
      (p) => p.pathHash !== pathHash && !legacy.has(p.pathHash),
    );
    await this.saveTrustedProjects(trusted);
  }

  /**
   * isTrusted 的同步版本，只读持久化记录（不含 session-only 信任）。
   *
   * 给**同步**调用链用的：worktree hook 的读取点（`hasWorktreeCreateHook`）是同步函数，
   * 且被 cli.ts 的工具注册条件同步调用，改成 async 会把整条链拖成 async。
   * 判据与 isTrusted 完全一致（路径 hash + 配置 hash），差别只在不认 sessionTrust ——
   * 那个状态只存在于某一个 TrustManager 实例里，别的调用方本来就拿不到。
   * 同会话内用户点了「信任」会走 trust() 落盘，这里随后就能读到。
   */
  isTrustedSync(): boolean {
    if (this.isHomeDirectory()) return false;
    try {
      const file = trustedProjectsPath();
      if (!existsSync(file)) return false;
      const data = JSON.parse(readFileSync(file, "utf-8")) as TrustedProjectsFile;
      const found = this.findRecord(data.projects ?? []);
      if (!found) return false;
      if (found.inherited) return true;
      return found.record.configHash === this.getConfigHashSync();
    } catch {
      return false; // 读不出来一律当未信任（fail-closed）
    }
  }

  /** getConfigHash 的同步版本（口径必须与之一字不差，否则同步/异步两条路判出不同结论） */
  private getConfigHashSync(): string {
    try {
      return this.hashConfigContents(
        this.untrustedSettingsFiles().map((p) => (existsSync(p) ? readFileSync(p, "utf-8") : null)),
      );
    } catch {
      return "error";
    }
  }

  /**
   * 配置内容 hash。只有 settings.json 时口径与历史完全一致（既有信任记录不失效）；
   * 被追踪的 settings.local.json 存在时把它拼进来——否则信任之后攻击者改 local 文件
   * 不会触发重新确认。
   */
  private hashConfigContents(contents: (string | null)[]): string {
    const [main, ...rest] = contents;
    if (rest.length === 0) {
      if (main === null || main === undefined) return "empty";
      return createHash("sha256").update(main).digest("hex").slice(0, 16);
    }
    const h = createHash("sha256");
    for (const c of contents) h.update(c === null ? "\0<absent>\0" : `\0${c.length}\0${c}`);
    return h.digest("hex").slice(0, 16);
  }

  /**
   * P10：按「身份根 → 其祖先」的顺序找信任记录，最近的一条胜出（对齐 CC：任一祖先已信任即继承）。
   * 末尾再认一次旧口径（启动目录 cwd 本身的键），迁移前写下的记录不失效。
   *
   * `inherited` 区分两种命中，判据不同：
   * - **本项目自己的记录**（身份根 / 旧 cwd 键）：仍比 configHash，配置内容变了要重新确认；
   * - **祖先目录的记录**：锁存布尔值，**不比 configHash**（对齐 CC 的信任语义）。
   *   祖先记录里的 hash 是祖先自己当时的配置，拿它和本仓库的配置比必然不等 ——
   *   #220 照比，结果「向上继承」只在两边都没有危险配置时成立，而那时信任框根本不弹，
   *   继承成了死代码（门禁测试用空配置，测不出来）。
   *   代价要点破：在 ~/Code 这类父目录信任一次，其下新 clone 的仓库危险配置会直接生效。
   *   家目录不参与继承，这是唯一的上界。
   */
  private findRecord(
    projects: TrustedProject[],
  ): { record: TrustedProject; inherited: boolean } | undefined {
    const byHash = new Map(projects.map((p) => [p.pathHash, p]));
    const home = resolve(homedir());
    const self = resolve(this.identityRoot);
    let dir = self;
    while (true) {
      // 家目录及其上层不参与继承：在家目录点过「信任」只是 session-only，不该被子目录继承
      if (dir === home) break;
      const hit = byHash.get(hashPath(dir));
      if (hit) return { record: hit, inherited: dir !== self };
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // 旧口径：启动 cwd（#220 之前）、当前工作树根（#220，worktree 下不归主仓）
    for (const p of [getCheckoutRoot(this.workspacePath), this.workspacePath]) {
      const legacy = byHash.get(hashPath(p));
      if (legacy) return { record: legacy, inherited: false };
    }
    return undefined;
  }

  /** 是否为家目录（按身份根判：非仓库的家目录启动、仓库根恰是家目录都算） */
  private isHomeDirectory(): boolean {
    return resolve(this.identityRoot) === resolve(homedir());
  }

  /** 获取路径 hash（写入一律用身份根） */
  private getPathHash(): string {
    return hashPath(this.identityRoot);
  }

  /** 获取配置内容 hash（用于检测配置变更） */
  private async getConfigHash(): Promise<string> {
    try {
      const contents: (string | null)[] = [];
      for (const p of this.untrustedSettingsFiles()) {
        contents.push(existsSync(p) ? await Bun.file(p).text() : null);
      }
      return this.hashConfigContents(contents);
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
