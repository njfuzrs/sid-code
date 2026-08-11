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

/** 内置 bundled skill 的注册函数清单（顺序即注册顺序） */
const REGISTRARS = [
  registerSimplifySkill,
  registerVerifySkill,
  // Git/PR 工作流命令（补齐分析 P0-1）
  registerCommitSkill,
  registerCommitPushPrSkill,
  registerReviewSkill,
  registerPrCommentsSkill,
  registerPrWorkflowSkill,
  registerPrSkill,
] as const;

/**
 * 注册所有内置 Bundled Skill（幂等）。
 *
 * 幂等判据取自注册表实际内容，而不是一个独立的 `registered` 布尔标志。
 * 原因：标志与注册表会失同步——`clearBundledSkills()` 清空了注册表却不复位标志，
 * 之后所有 `registerBundledSkills()` 都成为空操作，`loadBundledSkills()` 静默返回空集
 *（内置 /commit /review /pr 等全部消失，且无任何报错）。以内容为准则天然自愈：
 * 注册表被清空后下次调用会重新注册。
 *
 * 单个注册函数本身是覆盖式的（registerBundledSkill 同名替换），重复调用无副作用。
 */
export function registerBundledSkills(): void {
  if (getRegisteredBundledSkills().length >= REGISTRARS.length) return;
  for (const register of REGISTRARS) register();
}

/** 注册并返回所有已启用的 Bundled Skill（命令加载器用） */
export function loadBundledSkills() {
  registerBundledSkills();
  return getRegisteredBundledSkills();
}
