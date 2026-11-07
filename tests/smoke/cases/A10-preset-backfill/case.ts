/**
 * A10 团队默认配置：已有配置的用户首次启动，补全模板缺的顶层键，**不覆盖**已有值。
 *
 * 期望来源：核心功能触发清单 A10 人工实测 ③（2026-11-05）：预置 3 键配置
 * （`model` / 1 条 `availableModels`，其 `apiKey: "${MY_KEY}"` / `quota: {}`），
 * 启动迁移在 stderr 打「已补全团队默认配置字段（未覆盖任何已有配置）: …」共 17 个键（与官网文档一致）；
 * `model`、`apiKey`（仍是 `${MY_KEY}`，未展开）、`quota: {}` 保持原值，`language` 补成模板的 `zh`。
 *
 * 17 个键补进来之后，6 个空占位键又被 v4/v5 清掉（同 A10-first-launch-chain），落盘 3 + 17 − 6 = 14 键。
 * 这条叠加同样只有走真实启动入口才看得到。
 *
 * 没覆盖「删掉已补入的键，重启后不再加回」：要两次启动，运行器目前只支持单次进程。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import template from "../../../../scripts/team-defaults.template.json" with { type: "json" };
import type { SmokeCase } from "../../lib/types.ts";

const PRESET_MODEL = {
  name: "smoke-replay",
  provider: "replay",
  apiKey: "${MY_KEY}",
  pricing: { input: 1, output: 1 },
};

const def: SmokeCase = {
  id: "A10-preset-backfill",
  ledger: "A10",
  feature: "团队默认配置",
  kind: "guard",
  repo: {},
  settings: () => ({ model: "smoke-replay", availableModels: [PRESET_MODEL], quota: {} }),
  argv: ["-p", "回复 ok"],
  expect: {
    output: ({ stderr, configDir }) => {
      const m = stderr.match(/已补全团队默认配置字段（未覆盖任何已有配置）: (.+)/);
      if (!m) return "stderr 里没有补全提示";
      const added = m[1].trim().split(/,\s*/).sort();
      const want = Object.keys(template)
        .filter((k) => !["model", "availableModels", "quota"].includes(k))
        .sort();
      if (added.length !== 17 || JSON.stringify(added) !== JSON.stringify(want)) {
        return `补全键期望 17 个 ${JSON.stringify(want)}，实际 ${added.length} 个 ${JSON.stringify(added)}`;
      }
      const after = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
      if (after.model !== "smoke-replay") return `model 被改成 ${after.model}`;
      if (JSON.stringify(after.availableModels) !== JSON.stringify([PRESET_MODEL])) {
        return `availableModels 被改：${JSON.stringify(after.availableModels)}`;
      }
      if (JSON.stringify(after.quota) !== "{}") return `quota 被改：${JSON.stringify(after.quota)}`;
      if (after.language !== "zh")
        return `language 期望补成 zh，实际 ${JSON.stringify(after.language)}`;
      if (Object.keys(after).length !== 14) {
        return `落盘键数期望 14，实际 ${Object.keys(after).length}：${JSON.stringify(Object.keys(after).sort())}`;
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/config/settings/settings.ts",
      find: "    if (!(key in raw)) {",
      replace: "    if (true) {",
      why: "补全不再跳过已有键，退化成整份覆盖：用户的 model / availableModels / quota 被模板值冲掉",
    },
    {
      file: "packages/core/src/migrations/runner.ts",
      find: '    version: 1,\n    name: "backfill-team-defaults",\n    migrate: backfillTeamDefaults,',
      replace: '    version: 1,\n    name: "backfill-team-defaults",\n    migrate: () => {},',
      why: "迁移注册表丢了 v1，老用户首次启动拿不到团队默认",
    },
  ],
};

export default def;
