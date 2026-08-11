/**
 * 迁移 v1：团队默认配置补全
 *
 * 背景：`sid-code update` 只替换二进制、不碰用户 ~/.sid-code/settings.json（install.sh 是
 * 纯 bash，只有「文件不存在才整份 cp」的语义，无法做 JSON 顶层合并）。早期安装的用户因此
 * 永远拿不到后来新增的团队默认字段（subAgentModels / search / trace / quota 等）。
 *
 * 本迁移在「更新后首次启动」时，把团队完整默认配置里【用户尚未拥有的顶层键】补进
 * settings.json，绝不覆盖用户已有的任何字段。
 *
 * 单一事实源：直接 import 团队默认模板 scripts/team-defaults.template.json（Bun --compile
 * 会把它内联进二进制，与 install.sh 首装拷贝的服务器版同源，避免两份 drift）。模板里的
 * apiKey 是占位符 __YOUR_API_KEY__——但补全只对「用户缺失的顶层键」生效：已有 availableModels
 * 的用户不会被塞占位符 Key（availableModels 整块视为「已表态」，不做模型级 diff）。
 *
 * 幂等：靠迁移 runner 的版本水位线（migrations.json 的 migrationVersion）保证每台机器只补
 * 一次。因此用户补全后再主动删掉某个键，下次启动不会被加回来——这正是期望行为。
 */

// 指向**仓库根**的 scripts/（不是包内）。P2-2 分包后本文件深了两层，故 ../../../../。
import teamDefaults from "../../../../scripts/team-defaults.template.json" with { type: "json" };
import { mergeMissingTopLevelKeys } from "../config/settings/settings.ts";

export function migrate(): void {
  const added = mergeMissingTopLevelKeys(
    "userSettings",
    teamDefaults as Record<string, unknown>,
  );
  if (added.length > 0) {
    console.log(`已补全团队默认配置字段（未覆盖任何已有配置）: ${added.join(", ")}`);
  }
}
