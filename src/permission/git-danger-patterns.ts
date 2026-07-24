/**
 * Git 危险命令模式 —— 单一事实源（P0-2）
 *
 * 对标 CC `tools/BashTool/destructiveCommandWarning.ts` 的 DESTRUCTIVE_PATTERNS。
 * 这里集中定义所有「破坏性/难恢复」的 git 命令正则，供两处消费：
 *   1. `src/permission/checker.ts` 的 DANGEROUS_PATTERNS —— **运行时硬拦截**（触发确认/提级）。
 *   2. `src/ui/utils/danger-detect.ts` —— **UI 展示差异化**（确认框标红 + 安全默认）。
 *
 * 两处共享同一份正则，避免「拦截规则」与「展示规则」两份漂移。
 *
 * ⚠️ 正则设计约束：
 *   - 用 `[^;&|\n]*` 而非 `.*` 限定在**单条命令**内匹配，避免跨 `;`/`&&`/`|` 误吞后续命令。
 *   - checker 的 `hardcodedDangerCheck` 已会按复合命令拆分逐子命令查这些模式，
 *     因此单条内匹配即可，复合拆分能力自动继承。
 */

export type GitDangerSeverity = "critical" | "high" | "medium";

export interface GitDangerPattern {
  /** 危险描述（中文，用于确认框 / 审计） */
  name: string;
  /** 匹配正则 */
  pattern: RegExp;
  /** 严重程度：critical=拒绝不可确认 / high=可确认 / medium=需确认 */
  severity: GitDangerSeverity;
}

/**
 * Git 破坏性/难恢复命令模式表。
 *
 * severity 语义（对齐 checker.ts DANGEROUS_PATTERNS）：
 *   - high：拒绝但允许用户确认（对齐 CC「除非用户明确要求」）。
 *   - medium：需要用户确认（较轻，如 --amend 属协议层提醒）。
 *   - critical：直接拒绝不允许确认——git 场景**不用** critical
 *     （force push main/master 亦保留用户正当能力，用 high + UI 标红 + 安全默认，见「待决策项」拍板）。
 */
export const GIT_DANGER_PATTERNS: readonly GitDangerPattern[] = [
  // 硬重置：丢弃工作区/暂存区改动，难恢复
  { name: "git 硬重置", pattern: /\bgit\s+reset\s+(--\S+\s+)*--hard\b/, severity: "high" },
  // 强制推送：覆盖远程历史
  { name: "git 强制推送", pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, severity: "high" },
  // 强制推送 main/master：最危险的常见误操作（CC 专门警告）。保留 high 让用户能确认执行。
  { name: "git 强制推送 main/master", pattern: /\bgit\s+push\b[^;&|\n]*(--force|--force-with-lease|-f)\b[^;&|\n]*\b(main|master)\b/, severity: "high" },
  // 清理未跟踪文件（-f 强制，排除 -n/--dry-run 预演）
  { name: "git 清理未跟踪文件", pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/, severity: "high" },
  // 丢弃工作区改动：git checkout . / git restore .
  { name: "git 丢弃工作区改动", pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.[ \t]*($|[;&|\n])/, severity: "high" },
  // 删除/清空 stash
  { name: "git 删除 stash", pattern: /\bgit\s+stash\s+(drop|clear)\b/, severity: "high" },
  // 强制删分支（-D / --delete --force）
  { name: "git 强制删分支", pattern: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete)/, severity: "high" },
  // 跳过 hooks
  { name: "git 跳过 hooks", pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, severity: "high" },
  // 跳过签名
  { name: "git 跳过签名", pattern: /\bgit\s+[^;&|\n]*(--no-gpg-sign|-c\s+commit\.gpgsign=false)\b/, severity: "high" },
  // 劫持 git hooks 路径：改 core.hooksPath 指向攻击者目录 = 任意代码执行
  //（P0-1 额外加固：与 .git/hooks 目录写保护形成对称防护）
  { name: "劫持 git hooks 路径", pattern: /\bgit\s+config\b[^;&|\n]*core\.hooksPath\b/i, severity: "high" },
  // amend：改写上一个 commit（协议层，hook 失败时 --amend 会破坏历史工作），用 medium 兜底提醒
  { name: "git amend 改写上一个提交", pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, severity: "medium" },
];

/**
 * UI 展示用的破坏性 git 模式（子集 + 友好标签）。
 * danger-detect.ts 从这里派生展示标签，与拦截规则同源。
 * 只取「日常高频、值得在确认框标红」的项——amend（medium）不在展示强调之列。
 */
export interface GitDangerDisplay {
  pattern: RegExp;
  label: string;
}

export const GIT_DANGER_DISPLAY: readonly GitDangerDisplay[] = [
  { pattern: /\bgit\s+reset\s+(--\S+\s+)*--hard\b/i, label: "丢弃所有本地改动 (git reset --hard)" },
  { pattern: /\bgit\s+push\b[^;&|\n]*(--force|--force-with-lease|-f)\b/i, label: "强制推送 (git push --force)" },
  { pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/i, label: "删除未跟踪文件 (git clean -f)" },
  { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.[ \t]*($|[;&|\n])/i, label: "丢弃工作区改动 (git checkout/restore .)" },
  { pattern: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete)/i, label: "强制删除分支 (git branch -D)" },
  { pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/i, label: "跳过 hooks (--no-verify)" },
  { pattern: /\bgit\s+config\b[^;&|\n]*core\.hooksPath\b/i, label: "劫持 git hooks 路径 (core.hooksPath)" },
];

/**
 * 判断命令是否命中任一破坏性 git 模式（供 checkpoint 触发条件等复用，P2-1）。
 * @returns 命中的模式（severity 最高优先），未命中返回 null
 */
export function matchGitDanger(command: string): GitDangerPattern | null {
  if (!command) return null;
  const order: Record<GitDangerSeverity, number> = { critical: 3, high: 2, medium: 1 };
  let best: GitDangerPattern | null = null;
  for (const p of GIT_DANGER_PATTERNS) {
    if (p.pattern.test(command)) {
      if (!best || order[p.severity] > order[best.severity]) best = p;
    }
  }
  return best;
}
