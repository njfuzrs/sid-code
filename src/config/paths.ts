/**
 * sid-code 配置目录解析
 *
 * 统一解析配置根目录，支持 SID_CONFIG_DIR 环境变量覆盖
 * （对标 Claude Code 的 CLAUDE_CONFIG_DIR）。
 *
 * 用途：
 * 1. 测试隔离——测试可将配置目录指向临时目录，不污染真实 ~/.sid-code
 * 2. 多实例/沙箱——同一机器跑多个隔离的 sid-code 实例
 * 3. 容器/CI——显式指定配置位置
 *
 * 中心化路径布局（sidPaths）：
 *   所有子路径在此集中定义，杜绝各模块自行 join(homedir(), ".sid-code", ...)。
 *   对标 claude-code 的 envUtils.ts 统一入口模式。新增模块一律走 sidPaths.*
 *   或 sidHomePath()，禁止再硬编码 homedir()。
 */

import { homedir } from "os";
import { join, resolve, sep } from "path";

/**
 * 返回 sid-code 配置根目录。
 * 优先级：SID_CONFIG_DIR 环境变量 > ~/.sid-code
 *
 * 每次调用都重新读取 env（不缓存）——使测试可在 beforeEach 中切换目录。
 */
export function getSidHome(): string {
  const override = process.env.SID_CONFIG_DIR;
  if (override && override.trim() !== "") {
    return override;
  }
  return join(homedir(), ".sid-code");
}

/** 返回配置目录下的文件路径 */
export function sidHomePath(...segments: string[]): string {
  return join(getSidHome(), ...segments);
}

/**
 * 判断某个绝对路径是否落在配置根目录（getSidHome()）之内。
 *
 * 用于「项目级路径派生」的防御：当进程 cwd 恰为 ~/.sid-code 时，
 * 任何 process.cwd() + ".sid-code"/".claude" 的项目级拼接会叠加出
 * ~/.sid-code/.sid-code/ 或 ~/.sid-code/.claude/ 自嵌套。派生项目根前
 * 先用本函数判定，若落在配置根内则拒绝派生（见各项目级路径模块）。
 *
 * 规范化两端并按路径分隔符比较，避免 ~/.sid-code-foo 这类前缀误判。
 */
export function isInsideSidHome(absolutePath: string): boolean {
  const target = resolve(absolutePath);
  const home = resolve(getSidHome());
  return target === home || target.startsWith(home + sep);
}

/**
 * 中心化路径布局。所有 ~/.sid-code 下的子路径在此定义，
 * 各模块统一调用，杜绝散落的 join(homedir(), ".sid-code", ...) 硬编码。
 *
 * 归拢策略（对标 claude-code）：
 * - logs/   ：所有运行时日志（audit / permissions-audit / debug 等）
 * - state/  ：散落的运行时状态（app.json / command-usage / trusted-extensions 等）
 * - 其余按职责分目录（checkpoints / sessions / projects / trajectories / ...）
 */
export const sidPaths = {
  // ── 配置文件 ──
  settings: () => sidHomePath("settings.json"),
  appConfig: () => sidHomePath("app.json"),
  managedSettings: () => sidHomePath("managed-settings.json"),
  globalClaudeMd: () => sidHomePath("CLAUDE.md"),
  gitignore: () => sidHomePath(".gitignore"),
  lspConfig: () => sidHomePath("lsp.json"),

  // ── 日志归拢：logs/ ──
  logs: () => sidHomePath("logs"),
  log: (name: string) => sidHomePath("logs", name),

  // ── 状态归拢：state/ ──
  state: () => sidHomePath("state"),
  stateFile: (name: string) => sidHomePath("state", name),
  migrationState: () => sidHomePath("state", "migrations.json"),
  commandUsage: () => sidHomePath("state", "command-usage.json"),
  trustedExtensions: () => sidHomePath("state", "trusted-extensions.json"),
  trustedProjects: () => sidHomePath("state", "trusted-projects.json"),

  // ── 检查点 ──
  checkpointsRoot: () => sidHomePath("checkpoints"),
  checkpoints: (sessionId: string) => sidHomePath("checkpoints", sessionId),

  // ── 会话 ──
  sessions: () => sidHomePath("sessions"),
  activeSessions: () => sidHomePath("active-sessions"),

  // ── 记忆/项目 ──
  projects: () => sidHomePath("projects"),

  // ── 轨迹/遥测 ──
  trajectories: () => sidHomePath("trajectories"),
  uploadQueue: () => sidHomePath("trajectories", ".upload_queue.jsonl"),
  telemetry: () => sidHomePath("telemetry"),
  /** 用量账本（缓存命中长期统计底座，append-only，默认开、不轮转） */
  usageLedger: () => sidHomePath("usage-ledger.jsonl"),

  // ── 计划 ──
  plans: () => sidHomePath("plans"),
  plan: (slug: string) => sidHomePath("plans", `${slug}.md`),

  // ── 任务输出 ──
  tasks: () => sidHomePath("tasks"),

  // ── 扩展/插件/skill ──
  plugins: () => sidHomePath("plugins"),
  builtinSkills: () => sidHomePath("builtin-skills"),
  skills: () => sidHomePath("skills"),
  extensionDir: (type: string) => sidHomePath(type),

  // ── IDE ──
  ideLockDir: () => sidHomePath("ide"),

  // ── MCP OAuth 凭据存储（access/refresh token、动态注册 client、discovery 缓存） ──
  mcpOAuth: () => sidHomePath("mcp-oauth.json"),
  /** MCP token 刷新跨进程互斥锁目录 */
  mcpOAuthLocks: () => sidHomePath("state", "mcp-oauth-locks"),

  // ── 持久 Shell 会话：shell 环境快照 ──
  shellSnapshots: () => sidHomePath("shell-snapshots"),

  // ── 清理水位线 ──
  lastCleanup: () => sidHomePath(".last-cleanup"),
} as const;
