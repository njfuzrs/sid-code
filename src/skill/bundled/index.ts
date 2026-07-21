/**
 * Bundled Skills 统一入口（Task 6）
 *
 * registerBundledSkills() 在启动时调用一次，注册所有编译时内置 Skill。
 * getBundledSkills() 返回它们的 UnifiedCommand 形式，由命令加载器合并进统一注册表。
 */

import { registerSimplifySkill } from "./simplify.ts";
import { registerVerifySkill } from "./verify.ts";
import { registerCommitSkill } from "./commit.ts";
import { registerCommitPushPrSkill } from "./commit-push-pr.ts";
import { registerReviewSkill } from "./review.ts";
import { registerPrCommentsSkill } from "./pr-comments.ts";
import { registerPrWorkflowSkill } from "./pr-workflow.ts";
import { registerPrSkill } from "./pr.ts";
import { getBundledSkills as getRegisteredBundledSkills } from "./registry.ts";

export {
  registerBundledSkill,
  getBundledSkills,
  clearBundledSkills,
  hasBundledSkill,
  type BundledSkillDefinition,
} from "./registry.ts";

let registered = false;

/** 注册所有内置 Bundled Skill（幂等） */
export function registerBundledSkills(): void {
  if (registered) return;
  registerSimplifySkill();
  registerVerifySkill();
  // Git/PR 工作流命令（补齐分析 P0-1）
  registerCommitSkill();
  registerCommitPushPrSkill();
  registerReviewSkill();
  registerPrCommentsSkill();
  registerPrWorkflowSkill();
  registerPrSkill();
  registered = true;
}

/** 注册并返回所有已启用的 Bundled Skill（命令加载器用） */
export function loadBundledSkills() {
  registerBundledSkills();
  return getRegisteredBundledSkills();
}
