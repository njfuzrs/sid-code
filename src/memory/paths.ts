/**
 * 记忆路径管理 + 安全验证（对齐 Claude Code memdir/paths.ts）
 *
 * 目录结构：
 *   ~/.sid-code/projects/<sanitized-project-root>/memory/
 *     ├── MEMORY.md          (索引)
 *     ├── user_*.md          (用户画像)
 *     ├── feedback_*.md      (行为反馈)
 *     ├── project_*.md       (项目上下文)
 *     └── reference_*.md     (外部引用)
 *
 * 安全设计：
 * - 使用 canonical git root（而非 cwd）作为路径键，确保同一仓库的所有
 *   工作树共享记忆。
 * - 拒绝相对路径、根路径、UNC 路径、null 字节。
 * - autoMemoryDirectory 覆盖配置不允许来自 projectSettings（防止恶意仓库
 *   把记忆目录指向 ~/.ssh）—— 此约束由调用方保证，本模块只提供校验函数。
 */

import { homedir } from "os";
import { join, isAbsolute, resolve, sep } from "path";
import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { getSidHome, isInsideSidHome } from "../config/paths.ts";

/** 记忆根目录：~/.sid-code/projects/ */
function projectsRoot(): string {
  return join(getSidHome(), "projects");
}

/** 按 agent 类型的记忆根目录：~/.sid-code/memory/agents/ */
function agentsMemRoot(): string {
  return join(getSidHome(), "memory", "agents");
}

/**
 * 纯 sanitize（有损）：去掉分隔符与不安全字符。**不要直接用它做目录键**，
 * 见 `sanitizeProjectKey` 的单射性说明。仅供内部与迁移期识别「旧键」使用。
 */
function sanitizeProjectKeyLossy(raw: string): string {
  // 去掉首尾分隔符，把路径分隔符与不安全字符替换为 -
  const cleaned = raw
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

/**
 * 该键的**有损**程度判定：sanitize 是否丢掉了区分两个不同路径所必需的信息。
 *
 * 判据：把路径按分隔符切段后，是否存在含「非 `[a-zA-Z0-9._-]` 字符」的段
 * （中文/日文/空格/括号…）。有这种段，就可能与另一个 ASCII 骨架相同的路径撞键。
 * 反过来，全段都是安全字符的路径经 sanitize 是单射的，无需加后缀。
 *
 * 不检查「连续分隔符被 `-+` 折叠」：`//` 与 `/` 指向磁盘上同一个目录，而入参恒经
 * `resolveProjectRoot`（git toplevel 或 `resolve()`）归一化，重复分隔符不会出现；
 * 即便出现，折叠成同一个键也是正确行为，不是碰撞。
 */
function isKeyLossy(raw: string): boolean {
  const trimmed = raw.replace(/^[\\/]+|[\\/]+$/g, "");
  return trimmed.split(/[\\/]+/).some((s) => /[^a-zA-Z0-9._-]/.test(s));
}

/**
 * 短哈希（6 位十六进制），用于给有损键补足单射性。
 *
 * 用 FNV-1a：无需引入 crypto、同步、稳定跨平台。这里只要求「不同输入极少碰撞」，
 * 不是密码学用途——键碰撞的后果是隔离失效，而 6 位 hex（约 1677 万）对
 * 「同一台机器上 ASCII 骨架相同的项目数」这个量级远够用。
 */
function shortHash(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * 把项目根路径转成文件系统安全的目录名。
 * 用 git canonical root 派生，去掉分隔符与特殊字符。
 *
 * 审计第 3 条：键派生必须是**单射**的。旧实现把「任意非 ASCII 字符」与「分隔符」
 * 都映射成 `-` 再折叠连续 `-`，是双重有损——`~/工作/app` 与 `~/文档/app` 派生出
 * **完全相同**的键，两个私有项目的记忆/会话/团队记忆目录重合，互相可读。
 * 中文用户的常见目录习惯极易命中，不是构造出来的边界场景。
 *
 * 修法：**仅当** sanitize 真的丢了信息时，追加原始路径的短哈希后缀（`-a3f9c1`）。
 * 纯 ASCII 路径（绝大多数用户）的键保持**逐字节不变**——这一点是刻意的：该键同时
 * 决定 `projects/<key>/memory`、`projects/<key>/team-memory`、`sessions/<key>/`、
 * `projects/<key>/mcp.local.json` 四处已落盘数据的位置，无条件改键会让所有存量
 * 用户的记忆与历史会话凭空「消失」。有损路径的用户本来就在共用一个错误目录，
 * 换键是必要代价（旧目录仍在磁盘上，未删除，见 `findLegacyProjectKey`）。
 */
export function sanitizeProjectKey(raw: string): string {
  const cleaned = sanitizeProjectKeyLossy(raw);
  if (!isKeyLossy(raw)) return cleaned;
  return `${cleaned}-${shortHash(raw)}`;
}

/**
 * 取该项目在**旧（有损）算法**下的键，用于读取存量数据做兼容回退。
 * 键本来就无损时返回 undefined（新旧键相同，无需回退）。
 */
export function findLegacyProjectKey(raw: string): string | undefined {
  if (!isKeyLossy(raw)) return undefined;
  return sanitizeProjectKeyLossy(raw);
}

/**
 * 解析项目的 canonical root。
 * 优先取 git 顶层目录（同仓库多 worktree 共享记忆），失败时回退传入路径。
 *
 * 防御（P0-2）：若解析结果落在配置根 ~/.sid-code 之内（典型场景：进程 cwd
 * 恰为 ~/.sid-code，git 顶层或 resolve(cwd) 都会指向配置目录），则拒绝该根，
 * 改回退到 homedir()，避免项目级 ".sid-code/" 叠加出 ~/.sid-code/.sid-code/ 自嵌套。
 */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  let root: string;
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .toString()
      .trim();
    root = top || resolve(cwd);
  } catch {
    // 非 git 仓库或 git 不可用，回退
    root = resolve(cwd);
  }

  // 防御：项目根不得落在配置目录内，否则叠加出自嵌套
  if (isInsideSidHome(root)) {
    return homedir();
  }
  return root;
}

/**
 * 获取记忆目录路径（不自动创建）。
 * @param cwd 工作目录（默认 process.cwd()）
 * @param override 显式覆盖目录（来自非 projectSettings 的可信配置）
 */
export function getAutoMemPath(cwd: string = process.cwd(), override?: string): string {
  if (override) {
    const validated = validateMemoryPath(override);
    if (validated) return validated;
  }
  const root = resolveProjectRoot(cwd);
  const key = sanitizeProjectKey(root);
  return join(projectsRoot(), key, "memory");
}

/** 获取记忆目录路径并确保存在 */
export function ensureAutoMemPath(cwd: string = process.cwd(), override?: string): string {
  const dir = getAutoMemPath(cwd, override);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** MEMORY.md 索引文件路径 */
export function getMemoryIndexPath(cwd: string = process.cwd(), override?: string): string {
  return join(getAutoMemPath(cwd, override), "MEMORY.md");
}

/** Session Memory 文件路径：~/.sid-code/projects/<hash>/.session_memory.md */
export function getSessionMemoryPath(cwd: string = process.cwd()): string {
  const root = resolveProjectRoot(cwd);
  const key = sanitizeProjectKey(root);
  return join(projectsRoot(), key, ".session_memory.md");
}

/**
 * 把 agent 类型名转成文件系统安全的目录 slug，防路径穿越。
 * 只保留 [a-z0-9._-]，其余（含 / \ .. 空格 中文等）替换为 -，截断到 64 字符。
 * 空 / 全非法字符时回退 "unknown"。
 */
export function sanitizeAgentType(raw: string): string {
  const slug = String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return slug || "unknown";
}

/**
 * 获取按 agent 类型的记忆目录路径（不自动创建）。
 * 布局：~/.sid-code/memory/agents/<sanitized-agentType>/
 *   ├── MEMORY.md   (该类型累积记忆索引)
 *   └── *.md        (记忆条目)
 * 与 getAutoMemPath 风格一致；agentType 做 slug 安全化，防路径穿越。
 */
export function getAgentMemPath(agentType: string): string {
  const slug = sanitizeAgentType(agentType);
  return join(agentsMemRoot(), slug);
}

/** 获取 agent 类型记忆目录并确保存在 */
export function ensureAgentMemPath(agentType: string): string {
  const dir = getAgentMemPath(agentType);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 某 agent 类型的 MEMORY.md 索引文件路径 */
export function getAgentMemoryIndexPath(agentType: string): string {
  return join(getAgentMemPath(agentType), "MEMORY.md");
}

/**
 * 判断绝对路径是否位于某个记忆目录内（用于提取代理工具权限校验）。
 * 同时规范化两端，防止 ../ 逃逸。
 */
export function isAutoMemPath(absolutePath: string, memoryDir: string): boolean {
  const normalizedTarget = resolve(absolutePath);
  const normalizedDir = resolve(memoryDir);
  return (
    normalizedTarget === normalizedDir ||
    normalizedTarget.startsWith(normalizedDir + sep)
  );
}

/**
 * 校验显式记忆目录覆盖路径的合法性。
 * 拒绝：相对路径、根路径、null 字节、UNC 路径。
 * 合法时返回规范化绝对路径，非法时返回 undefined。
 */
export function validateMemoryPath(raw: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  // null 字节
  if (raw.includes("\0")) return undefined;
  // UNC 路径（\\server\share）
  if (raw.startsWith("\\\\")) return undefined;
  // 必须是绝对路径
  if (!isAbsolute(raw)) return undefined;
  const normalized = resolve(raw);
  // 拒绝根路径
  if (normalized === sep || /^[a-zA-Z]:\\?$/.test(normalized)) return undefined;
  return normalized;
}

/**
 * M2：判定 auto-memory 后台自动提取是否启用。
 * 优先级：env SID_CODE_AUTO_MEMORY > settings autoMemory > 默认 true。
 * - env 显式设 "0" / "false" → 关闭；设 "1" / "true" → 启用（覆盖 settings）。
 * - settings.autoMemory === false → 关闭；否则默认启用（保持既有行为）。
 *
 * 对齐 [feedback-no-hardcoded-model-tier-rules] 的「全局默认 + env 兜底」范式，
 * 且与 recall.ts 的 env gate 风格一致（但 recall 默认关，本项默认开）。
 */
export function isAutoMemoryEnabled(settingValue?: boolean): boolean {
  const env = process.env.SID_CODE_AUTO_MEMORY;
  if (env !== undefined && env !== "") {
    const v = env.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  }
  // env 未设或无法解析 → 看 settings，仅显式 false 才关闭
  return settingValue !== false;
}

/**
 * 记忆类型前缀（与 MemoryType 封闭分类法一致）。
 * 用于剥离 key 里已经带上的类型前缀，避免二次拼接。
 */
const MEMORY_TYPE_PREFIX_RE = /^(user|feedback|project|reference)[_-]+/;

/**
 * 剥掉 key 开头冗余的类型前缀：`project_xxx` → `xxx`。
 *
 * 三个调用方共用同一条规则（文件名生成、私有记忆 key 归一化、agent 记忆 key 归一化），
 * 各自抄一份正则必然漂移，所以收敛到这里。
 *
 * 语义边界：
 * - 只剥一层，且要求类型词后**紧跟分隔符**——`projection-matrix`、`userland-tooling`
 *   这类以类型词开头的正常语义名不会被误伤。
 * - **剥完为空则返回原值**（`project` 这种 key 整体就是类型词，清空会丢掉标识）。
 * - 幂等：对已归一化的 key 再调用结果不变。
 */
export function stripMemoryTypePrefix(name: string): string {
  const stripped = name.replace(MEMORY_TYPE_PREFIX_RE, "");
  return stripped || name;
}

/**
 * 生成记忆文件名：<type>_<slug>.md
 * slug 由 name 派生为 kebab-case，截断到 60 字符。
 *
 * ─── 2026-07-30 修复：双类型前缀 ───
 *
 * 模型保存记忆时经常把类型写进 name（`name: project_xxx`），而本函数无条件在
 * 前面再拼一次 `${type}_`，产出 `project_project-xxx.md`。后果不是文件名难看
 * 而已——注入 system prompt 的索引行是 `- [key](文件名)`，key 与文件名从此
 * **对不上**（实测某项目 47 条索引 47 条全部不一致），模型照着 key 拼路径
 * 必然 Read 失败，照着链接读又要先看懂前缀是冗余的。
 *
 * 因此在派生 slug 前先剥掉 key 已有的类型前缀。只剥一层且只认封闭分类法里的
 * 4 个词：`project_xxx` → `xxx`，但 `user-profile` 这种以类型词开头的**正常
 * 语义名**不会被误伤（要求前缀后紧跟分隔符才算前缀）。
 *
 * 幂等：`memoryFilename("project", memoryFilename(...))` 不会继续脱层，
 * 因为剥离只作用于 name，不作用于最终拼出的文件名。
 */
export function memoryFilename(type: string, name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(MEMORY_TYPE_PREFIX_RE, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
  return `${type}_${slug}.md`;
}
