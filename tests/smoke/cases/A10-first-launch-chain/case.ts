/**
 * A10 团队默认配置：首装写入模板后的**首次启动**，整条迁移链按真实顺序跑完的叠加结果。
 *
 * 期望来源：核心功能触发清单 A10 的人工实测（2026-11-05，HEAD 0b6b2d0e）「讲的时候留余地 (a)」：
 * 模板 20 个顶层键里有 6 个空占位键（allowedTools / disallowedTools / hooks / allowedDirectories /
 * blockedDirectories / permissionMode），首次启动时被 v4/v5 迁移按「值等于代码默认」清掉，20 → 14；
 * `state/migrations.json` 记 `migrationVersion=7` + `teamDefaults.{hash,keys}`（20 键）。
 *
 * 放 G2 而不是 G1 的理由（台账 A10）：单个迁移的单测都在，但「20 → 14」是 v1 补全、v4/v5 清理
 * 按 runner 顺序串起来的结果，只有走真实启动入口才看得到。
 *
 * 和人工实测的差别：`model` / `availableModels` 换成 replay 模型，否则模板的占位 key 会让启动报错退出。
 * 这两个键不在清理清单里，不影响键数。首装那一步（install-template.sh 写文件）不在本用例范围内，
 * 运行器直接把「首装后的文件」写进隔离配置目录。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import template from "../../../../scripts/team-defaults.template.json" with { type: "json" };
import type { SmokeCase } from "../../lib/types.ts";

const DUMPED = [
  "allowedDirectories",
  "allowedTools",
  "blockedDirectories",
  "disallowedTools",
  "hooks",
  "permissionMode",
];

const def: SmokeCase = {
  id: "A10-first-launch-chain",
  ledger: "A10",
  feature: "团队默认配置",
  kind: "guard",
  repo: {},
  settings: ({ defaults }) => ({ ...template, ...defaults }),
  argv: ["-p", "回复 ok"],
  expect: {
    output: ({ configDir }) => {
      const after = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
      const tplKeys = Object.keys(template).sort();
      if (tplKeys.length !== 20)
        return `模板顶层键期望 20 个，实际 ${tplKeys.length}（模板变了，回触发清单核对）`;
      const want = tplKeys.filter((k) => !DUMPED.includes(k));
      const got = Object.keys(after).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        return `首次启动后键集合期望 ${want.length} 个 ${JSON.stringify(want)}，实际 ${got.length} 个 ${JSON.stringify(got)}`;
      }
      const state = JSON.parse(readFileSync(join(configDir, "state/migrations.json"), "utf8"));
      if (state.migrationVersion !== 7)
        return `migrationVersion 期望 7，实际 ${state.migrationVersion}`;
      const marked = state.teamDefaults?.keys;
      if (!Array.isArray(marked) || marked.length !== 20) {
        return `teamDefaults.keys 期望 20 个，实际 ${JSON.stringify(marked)}`;
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/migrations/move-stray-app-config-keys.ts",
      find: "      delete settings[key];",
      replace: "      void key;",
      why: "v4/v5 不再清理值等于默认的灌入键，首次启动后仍是 20 键",
    },
  ],
};

export default def;
