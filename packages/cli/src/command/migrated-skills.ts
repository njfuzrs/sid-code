/**
 * 已下沉 / 已删除的内置 skill 的迁移提示（内置 Skill 下沉方案 P4 §7）
 *
 * 5 个迁移项搬到了官方 / 企业插件市场，2 个删除项不再提供。用户升级后照旧敲 `/security-audit`，
 * 得到的应该是「去哪装、装完叫什么」，而不是一句「未知命令」——后者会被读成「功能没了」。
 *
 * 文案分两种，判据是**官方市场在当前企业策略下能不能装**（与 /plugin install 同一个判定函数）：
 * - 能装 → `/plugin install <插件>@sid-code`；
 * - 锁定且官方被拒（或被 officialMarketplace:false 关掉）→ 请管理员在企业市场上架。
 *   锁定企业恰恰是合规类 skill 的主要用户（方案 §6.3），给他们一条装不上的命令等于没提示。
 *
 * 这张表保留 180 天后删除：sid-code 还在 0.1.x，没有「大版本」可数。
 * REMOVE_AFTER: 2027-04-12
 * （P4 发布日 + 180 天。到期由 migrated-skills.test.ts 读上面这一行提醒，运行时不自己失效；
 *  刻意不做成导出常量——只给测试读的导出会被 command-system-gate 判成死导出。）
 */

import { evaluatePluginOrigin } from "@sid-code/core/config/plugin-only-policy.ts";
import { defaultMarketIndexUrl, findMarket, OFFICIAL_MARKET_NAME } from "../plugin/market.ts";

type MigrationEntry =
  | { kind: "moved"; plugin: string; skill: string }
  | { kind: "removed"; instead: string };

/** 旧命令名（含历史别名）→ 去向 */
const MIGRATED_SKILLS: Record<string, MigrationEntry> = {
  "security-audit": { kind: "moved", plugin: "compliance", skill: "security-audit" },
  "code-governance": { kind: "moved", plugin: "compliance", skill: "governance" },
  "ci-self-heal": { kind: "moved", plugin: "ops", skill: "ci-heal" },
  "incident-rca": { kind: "moved", plugin: "ops", skill: "incident-rca" },
  "pr-comments": { kind: "moved", plugin: "github-pr", skill: "comments" },
  // 原 pr-comments 的下划线别名（兼容 claude-code 命名）
  pr_comments: { kind: "moved", plugin: "github-pr", skill: "comments" },
  "commit-push-pr": {
    kind: "removed",
    instead: "用 /commit 提交、git push 推送，再用 /pr 生成描述；或用 /pr-workflow 一次走完",
  },
  "bug-fix": {
    kind: "removed",
    instead: "直接描述 bug 即可，复现 → 根因 → 修复 → 验证是默认工作方式",
  },
};

/** 官方市场在当前配置与企业策略下能否安装（与 /plugin install 同一判定函数）。 */
function isOfficialMarketInstallable(): boolean {
  const official = findMarket(OFFICIAL_MARKET_NAME);
  if (!official) return false; // officialMarketplace:false
  return evaluatePluginOrigin(
    { kind: "market", indexUrl: official.indexUrl },
    defaultMarketIndexUrl() ?? undefined,
  ).allowed;
}

/**
 * 整条输入是不是一个迁移表里的旧命令（`/commit-push-pr`，前后空白不计）。
 *
 * 给 TUI 补全的「回车直接执行补全项」路径用：旧名已不在命令表，模糊补全会把
 * `/commit-push-pr` 匹配成 `/commit` 并**直接执行一次提交**，用户看不到迁移提示。
 * 命中时应提交原文，让 executor 给出迁移提示（2026-10-14 用真实二进制复现）。
 */
export function isMigratedSkillInput(text: string): boolean {
  const m = /^\/([A-Za-z0-9_-]+)$/.exec(text.trim());
  return m ? Object.hasOwn(MIGRATED_SKILLS, m[1]!) : false;
}

/**
 * 旧命令名命中迁移表时返回提示文本，否则返回 null（调用方照常报「未知命令」）。
 * 只在命令表里**查不到**这个名字时才会被调用，所以用户 / 项目自己定义了同名 skill 时不受影响。
 */
export function getMigratedSkillHint(name: string): string | null {
  if (!Object.hasOwn(MIGRATED_SKILLS, name)) return null; // 防 /constructor 之类原型链键
  const entry = MIGRATED_SKILLS[name]!;
  if (entry.kind === "removed") {
    return `/${name} 已移除。${entry.instead}。`;
  }
  const newName = `/${entry.plugin}:${entry.skill}`;
  if (isOfficialMarketInstallable()) {
    return (
      `/${name} 已移到插件 ${entry.plugin}：` +
      `/plugin install ${entry.plugin}@${OFFICIAL_MARKET_NAME}，之后用 ${newName}`
    );
  }
  return (
    `/${name} 已移到插件 ${entry.plugin}，当前企业策略不允许从官方市场安装。` +
    `请联系管理员在企业市场上架 ${entry.plugin}，装好后用 ${newName}`
  );
}
