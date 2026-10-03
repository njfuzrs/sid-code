/**
 * Settings 安全边界
 *
 * 对齐 Spec 15 §3.5：项目级配置可以影响行为，但不能影响安全控制。
 * 防止恶意仓库通过 .sid-code/settings.json 注入安全敏感字段
 * （如关闭权限确认、关闭环境变量清理、自我授权工具、关闭风险分类器）。
 *
 * ⚠️ 单一权威清单（P0-3 §5.2.5）：
 *   本文件的 SECURITY_SENSITIVE_FIELDS 是**唯一权威**的不可信项目级字段清单。
 *   src/permission/rule-loader.ts 不再各自维护 UNTRUSTED_PROJECT_SETTINGS，
 *   而是从这里复用，杜绝"两套清单内容不一致"的历史问题。
 *
 *   - 本文件 filterProjectSettings() 覆盖 Settings **全字段层面**
 *     （已接入 src/config/settings/settings.ts:getSettingsForSource 加载链）。
 *   - rule-loader 复用本清单覆盖**权限规则加载层面**
 *     （projectSettings 的 permissions.* 不可自我授权绕过安全限制）。
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import type { SettingsJson } from "./types.ts";

/**
 * 安全敏感字段——projectSettings 不能设置这些字段。
 * 只能从可信来源（user / local / flag / policy）设置。
 *
 * 本清单为历史上两套清单（security.ts SECURITY_SENSITIVE_FIELDS +
 * rule-loader.ts UNTRUSTED_PROJECT_SETTINGS）的**并集**，确保覆盖完整：
 *   原 security 独有：allowedTools、trustProjectExtensions
 *   原 rule-loader 独有：skipPermissions、yesMode
 *   两者共有：permissionMode、sanitizeEnv、allowedDirectories
 *   新增（P0-3 迭代 II）：enableLLMClassifier（安全开关，项目级不可关闭以削弱防线）
 *   新增（SEC-AUDIT-2026-07-19 P0）：webFetchIsolate（同理，项目级不可关掉网页隔离提炼）
 */
export const SECURITY_SENSITIVE_FIELDS = new Set<string>([
  "permissionMode", // 不允许项目配置跳过权限
  "skipPermissions", // 不允许项目配置直接关闭权限检查
  "yesMode", // 不允许项目配置自动 yes 一切确认
  "allowedTools", // 不允许项目配置自我授权工具
  "sanitizeEnv", // 不允许项目配置关闭环境变量清理
  "trustProjectExtensions", // 不允许项目配置自我信任
  "allowedDirectories", // 不允许项目配置扩大目录白名单
  "enableLLMClassifier", // 不允许项目配置关闭 LLM 风险分类器（削弱第二道防线）
  // 不允许项目配置关闭 WebFetch 隔离提炼。这条尤其关键：恶意项目若能在 .sid-code/settings.json
  // 里设 webFetchIsolate:false，就能让自己 README 里指向的 URL 原文直灌主上下文——
  // 正好是本条防线要拦的攻击链。
  "webFetchIsolate",
  // 不允许项目级 settings 把会话归属到别的 org / user。身份是审计 actor，
  // 被仓库 settings.json 改掉等于让恶意项目伪造成本归属。
  "identity",
  // P2：backend.url 决定设备凭据发往哪里（登录 / 市场 / 远程 MCP origin 校验）。
  // 仓库 settings.json 能改它，就能把员工凭据导到攻击者端点。
  "backend",
]);

/**
 * 过滤项目级配置中的安全敏感字段。
 * 返回新对象，不修改入参。
 */
export function filterProjectSettings(settings: SettingsJson): SettingsJson {
  const filtered: Record<string, unknown> = { ...settings };
  for (const field of SECURITY_SENSITIVE_FIELDS) {
    if (field in filtered) {
      delete filtered[field];
    }
  }
  return filtered as SettingsJson;
}

/**
 * `settings.local.json` 是否被 git 追踪（D1）。
 *
 * 「localSettings 是 gitignored 所以不会跟着仓库来」这个前提不成立：.gitignore 只挡
 * 「未追踪文件被 git add」，不挡「已追踪文件被 clone 下来」。攻击者 `git add -f` 一次，
 * 此后每个 clone 的人磁盘上都有它，且 `git check-ignore` 对已追踪文件返回 rc=1、
 * `git status` 也干净——受害者没有任何可见信号。
 *
 * 所以判据落在「这份文件会不会跟着仓库来」本身：被追踪 = 可能是别人写的 = 不可信。
 * 未追踪 / 不在 git 仓库里 = 只可能是本机写的 = 维持可信（不伤正当的本机 permissionMode 用法）。
 *
 * 实现细节：
 * - 剥掉 GIT_DIR / GIT_INDEX_FILE 等环境变量：在 git hook 里跑时它们指向**别的仓库**，
 *   不剥会拿那个仓库的 index 判定，结论静默错掉。
 * - git 不可用（ENOENT 等）时：向上找得到 `.git` 就按追踪处理（fail-closed，因为无法证伪）；
 *   找不到说明根本不在仓库里，文件不可能是 clone 来的。
 */
export function isGitTrackedFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", basename(filePath)], {
    cwd: dirname(filePath),
    env,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });
  if (r.error) return hasGitAncestor(dirname(filePath));
  // 0 = 追踪中；1 = 在仓库里但未追踪；128 = 不在 git 仓库里
  return r.status === 0;
}

function hasGitAncestor(dir: string): boolean {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * 某个 settings 来源的这份文件是否为不可信来源（D1）。
 *
 * projectSettings 恒不可信；localSettings 只在被 git 追踪时不可信。
 * settings 加载链（filterProjectSettings）、权限规则加载（rule-loader）、
 * 工作区信任扫描（trust.ts）三处共用这一个判据——三处各写一份 `source === "projectSettings"`
 * 正是 D1 的成因：过滤逻辑本身是对的，锚点挂错了 source 名。
 */
export function isUntrustedSettingsFile(
  source: string,
  filePath: string | null | undefined,
): boolean {
  if (source === "projectSettings") return true;
  if (source === "localSettings" && filePath) return isGitTrackedFile(filePath);
  return false;
}
