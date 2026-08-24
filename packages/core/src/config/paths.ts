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
 * 优先级：SID_CONFIG_DIR 环境变量 > SID_CODE_HOME 环境变量（兼容别名）> ~/.sid-code
 *
 * 每次调用都重新读取 env（不缓存）——使测试可在 beforeEach 中切换目录。
 *
 * ⚠ 为什么要读两个 env 名：轨迹子系统（`trace/digest.ts`、`scripts/trace-digest.ts`、
 * `/trace` 命令的报错文案）历史上自己写了一份 `process.env.SID_CODE_HOME ||
 * join(homedir(), ".sid-code")`，与本函数的 `SID_CONFIG_DIR` **互不认识** ——
 * 设了 `SID_CONFIG_DIR` 的人会发现轨迹还在老地方，设了 `SID_CODE_HOME` 的人会发现
 * 配置还在老地方。收敛方向是 `SID_CONFIG_DIR`（本模块的权威定义，且与
 * `getClaudeHome()` 的 `CLAUDE_CONFIG_DIR` 对称），但直接删掉 `SID_CODE_HOME`
 * 会静默打断既有用户脚本，所以在这里一并读、留作兼容别名。
 * **新代码一律用 `SID_CONFIG_DIR`。**
 */
export function getSidHome(): string {
  for (const override of [process.env.SID_CONFIG_DIR, process.env.SID_CODE_HOME]) {
    if (override && override.trim() !== "") {
      return override;
    }
  }
  return join(homedir(), ".sid-code");
}

/** 返回配置目录下的文件路径 */
export function sidHomePath(...segments: string[]): string {
  return join(getSidHome(), ...segments);
}

/**
 * 历史上散落在各处的配置根目录字面量前缀。
 *
 * `debugLogFile` / `auditLogFile` 的默认值曾是字面量 `"~/.sid-code/debug.log"`，
 * 而展开侧（`debug/logger.ts`）用 `homedir()` 展开 `~` —— 于是
 * **`SID_CONFIG_DIR` 管不到日志落点**：配置目录被重定向到 tmpdir，debug.log 仍写真实 HOME。
 */
const LEGACY_SID_HOME_PREFIXES = ["~/.sid-code/", "~\\.sid-code\\"] as const;

/**
 * 展开配置里的 `~` 路径，并把遗留的 `~/.sid-code/xxx` 字面量重定向到 `getSidHome()`。
 *
 * 两条语义，顺序不能反：
 * 1. `~/.sid-code/xxx` → `sidHomePath("xxx")` —— 尊重 `SID_CONFIG_DIR`。
 *    这一条**必须存在**而不能只改默认值：老用户的 `~/.sid-code/app.json` 里
 *    已经存着那个字面量（`createDefaultAppConfig()` 的默认值会被 `saveAppConfig`
 *    连带写进磁盘），磁盘值优先于新默认值 —— 只改默认值对他们完全无效。
 * 2. 其余 `~/xxx` → `homedir()/xxx` —— 用户手写 `"~/somewhere/x.log"` 的语义不变。
 *
 * ⚠ 展开逻辑集中在此一处。此前 `logger.ts` 自己写了一份（`join(homedir(), p.slice(1))`），
 * 那种写法对 `~foo` 这类非 `~/` 开头的串会拼出 `<home>foo`，是错的。
 */
export function expandSidHomePath(p: string): string {
  for (const prefix of LEGACY_SID_HOME_PREFIXES) {
    if (p.startsWith(prefix)) {
      return sidHomePath(p.slice(prefix.length));
    }
  }
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * 当前解析出的配置根目录**就是用户真实的 `~/.sid-code`** 吗？
 *
 * 用途：给「测试进程绝不允许改用户真实数据」这类守卫提供**路径判据**，
 * 取代进程级布尔开关。布尔开关的病灶是它与"写到哪里"这件事无关：
 * 置位了就连重定向到 tmpdir 的合法写盘也一起禁掉（于是写盘路径长期不可测），
 * 复位了又要靠调用方自觉关回去（漏写就泄漏到同批后续测试文件）。
 * 路径判据没有状态，不需要复位，也不会泄漏。
 *
 * ⚠ 判据是**相等**而不是"落在其下"：`SID_CONFIG_DIR=~/.sid-code/some-sandbox` 写的是
 * 另一个目录里的另一份文件，不会覆盖用户那份，没有理由拦它。用前缀判会把这种合法的
 * 沙箱用法也一并拒掉。要判"落在其下"用 `isInsideSidHome()`（那是另一个问题：自嵌套）。
 *
 * ⚠ `homedir()` 在进程内**不随 `process.env.HOME` 改变**（实测：进程内改 HOME 后
 * `homedir()` 仍返回原值；只有以新 HOME **启动**的进程才会变）。所以想在测试里让本函数
 * 返回 true，只能起一个 `HOME=<临时目录>` 的子进程 —— 见
 * `packages/core/tests/llm/model-capabilities-persist-guard.test.ts` 的三个场景。
 */
export function isRealUserSidHome(): boolean {
  return resolve(getSidHome()) === resolve(join(homedir(), ".sid-code"));
}

/**
 * 返回 CC 兼容配置根目录（~/.claude），用于读取从 Claude Code 迁移的扩展。
 * 优先级：CLAUDE_CONFIG_DIR 环境变量 > ~/.claude
 *
 * 对标 CC 的 CLAUDE_CONFIG_DIR。仅用于**兼容读取**（如 ~/.claude/commands、
 * ~/.claude/skills），sid-code 自身产物一律写 getSidHome()。
 * 每次调用重新读 env，便于测试隔离。
 */
export function getClaudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim() !== "") {
    return override;
  }
  return join(homedir(), ".claude");
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
  /**
   * 企业策略文件候选路径（P2-1，first-exists-wins，优先级从高到低）：
   * 1. /etc/sid-code/managed-settings.json —— 系统级企业管控（对齐 CC 系统 managed 路径，最高）
   * 2. ~/.sid-code/managed-settings.json    —— 用户级 MDM/回退（原 ManagedFileLoader 路径，兼容既有）
   * 统一后废弃历史上冲突的 /etc/sid-code/policy.json 与 /etc/sid-code/policy.yaml 两个路径。
   */
  managedPolicyCandidates: (): string[] => [
    "/etc/sid-code/managed-settings.json",
    sidHomePath("managed-settings.json"),
  ],
  globalClaudeMd: () => sidHomePath("CLAUDE.md"),
  gitignore: () => sidHomePath(".gitignore"),
  lspConfig: () => sidHomePath("lsp.json"),
  /** 网关定价采集缓存（全局共享，不随会话；带 pricing_version + fetched_at） */
  gatewayPricing: () => sidHomePath("gateway-pricing.json"),
  /**
   * 模型**能力**缓存（contextWindow / maxOutputTokens / effort 档位）。
   * 与 gatewayPricing 的关键差异：能力是模型固有属性 → 按模型名单键、**不按端点分桶**；
   * 价格随渠道变 → 按「模型名 + 端点」复合键。见 model-capabilities.ts 头部注释。
   */
  modelCapabilities: () => sidHomePath("model-capabilities.json"),

  // ── 日志归拢：logs/ ──
  logs: () => sidHomePath("logs"),
  log: (name: string) => sidHomePath("logs", name),
  /**
   * `--debug` 的日志落点（配置项 `debugLogFile` 的默认值）。
   *
   * ⚠ 刻意**不放进 `logs/`**：`~/.sid-code/debug.log` 这个路径写进了 `--help`、
   * `website/ref/cli.md`、`website/use/troubleshooting.md` 与大量注释，本次是修
   * 「不尊重 SID_CONFIG_DIR」这一个缺陷，顺手挪目录会让所有文档同时失准。
   */
  debugLog: () => sidHomePath("debug.log"),
  /** 零配置审计日志落点（配置项 `auditLogFile` 的默认值）。同上，不挪目录。 */
  auditLog: () => sidHomePath("audit.log"),

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

  // ── 并发冲突检测 ──
  fileIntents: () => sidHomePath("file-intents"),

  // ── 记忆/项目 ──
  projects: () => sidHomePath("projects"),

  // ── 轨迹/遥测 ──
  trajectories: () => sidHomePath("trajectories"),
  uploadQueue: () => sidHomePath("trajectories", ".upload_queue.jsonl"),
  telemetry: () => sidHomePath("telemetry"),
  /** 用量账本（缓存命中长期统计底座，append-only，默认开、不轮转） */
  usageLedger: () => sidHomePath("usage-ledger.jsonl"),
  /**
   * P0-2：会话指标索引（每会话一行摘要，**不受 trajectories LRU 影响**）。
   *
   * ⚠ 路径刻意与 `trajectories/` **同级而非在其下**：轨迹目录受 LRU=100 管辖，
   * `pruneOldSessions()` 会 `rmSync` 整个会话目录。把索引放进去，等于让它被将来
   * 任何对 `trajectories/` 的清理连带删掉 —— 而它存在的唯一理由就是"删了还在"。
   *
   * 与 `usageLedger` 同一套语义（每会话一行 upsert、不自动清理、人类可读）：
   * 19 字段 ≈ 500B，377 会话 ≈ 190KB，跑到 10 万会话也只有 50MB。
   */
  sessionIndex: () => sidHomePath("session-index.jsonl"),
  /** 缓存中断遥测（G13，append-only，跨会话缓存健康度历史） */
  cacheBreaks: () => sidHomePath("cache-breaks.jsonl"),

  // ── 计划 ──
  plans: () => sidHomePath("plans"),
  plansForProject: (project: string) => sidHomePath("plans", project),
  plan: (project: string, fileName: string) => sidHomePath("plans", project, `${fileName}.md`),

  // ── 任务输出 ──
  tasks: () => sidHomePath("tasks"),

  // ── 扩展/插件/skill ──
  plugins: () => sidHomePath("plugins"),
  builtinSkills: () => sidHomePath("builtin-skills"),
  skills: () => sidHomePath("skills"),
  extensionDir: (type: string) => sidHomePath(type),
  /**
   * P2-1：企业 managed 扩展目录候选（first-exists 全扫，优先级最高）。
   * 与 managedPolicyCandidates 同源约定：系统级 /etc/sid-code/{type} + 用户级回退 ~/.sid-code/managed/{type}。
   * managed 层扩展覆盖同名 user/project。SID_CODE_DISABLE_POLICY_SKILLS=1 可整体关闭。
   */
  managedExtensionDirs: (type: string): string[] => [
    `/etc/sid-code/${type}`,
    sidHomePath("managed", type),
  ],

  // ── 自带二进制（编译期嵌入、运行时释放的工具，如 ripgrep）──
  binDir: () => sidHomePath("bin"),
  rgBinary: () => sidHomePath("bin", process.platform === "win32" ? "rg.exe" : "rg"),

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
