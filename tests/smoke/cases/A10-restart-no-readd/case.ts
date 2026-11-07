/**
 * A10 团队默认配置：删除是表态。首次启动补全后，手动删掉一个已补入的键，重启**不再加回**；
 * 重启也不再打印补全提示。
 *
 * 期望来源：核心功能触发清单 A10 人工实测 ④（2026-11-05）：「再启动一次不再打印补全提示……
 * 手动删掉已补入的 `effortLevel` 后重启，**未被加回**（删除是表态）」。
 *
 * 机制（回源码核实）：v1 全量补全只跑一次（`migrationVersion` 水位）；之后每次启动走
 * `backfillNewTemplateKeys`，只补模板相对 `state/migrations.json` 里 `teamDefaults.keys` **新增**的键。
 * `effortLevel` 已在记录里，所以删了不会回来。
 *
 * 预置配置与 A10-preset-backfill 相同，第一次运行的补全由那条用例守，这里只看第二次。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A10-restart-no-readd",
  ledger: "A10",
  feature: "团队默认配置",
  kind: "guard",
  repo: {},
  settings: () => ({
    model: "smoke-replay",
    availableModels: [
      {
        name: "smoke-replay",
        provider: "replay",
        apiKey: "${MY_KEY}",
        pricing: { input: 1, output: 1 },
      },
    ],
    quota: {},
  }),
  argv: ["-p", "回复 ok"],
  after: [
    {
      kind: "print",
      replay: "restart.jsonl",
      argv: ["-p", "回复 ok"],
      prepare: ({ configDir }) => {
        const p = join(configDir, "settings.json");
        const s = JSON.parse(readFileSync(p, "utf8"));
        if (!("effortLevel" in s)) throw new Error("前置不成立：首次启动没有补入 effortLevel");
        delete s.effortLevel;
        writeFileSync(p, JSON.stringify(s, null, 2));
      },
    },
  ],
  expect: {
    output: ({ stderr, steps, configDir }) => {
      if (!stderr.includes("已补全团队默认配置字段")) return "前置不成立：首次启动没有打印补全提示";
      const restart = steps[0];
      if (!restart || restart.kind !== "print") return "缺少重启步骤的结果";
      if (restart.stderr.includes("已补全团队默认配置字段")) {
        return `重启后又打印了补全提示：${restart.stderr.match(/已补全团队默认配置字段.*/)?.[0]}`;
      }
      const after = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
      if ("effortLevel" in after)
        return `删掉的 effortLevel 重启后被加回：${JSON.stringify(after.effortLevel)}`;
      return null;
    },
  },
  // 不用「去掉 known 过滤」这类单点变异：backfillNewTemplateKeys 有两道串联保护
  // （模板哈希未变直接返回 + 只补新增键），只拆一道另一道照样挡住，2026-11-07 实测 survived。
  // 这里模拟的是更真实的退化：有人把每次启动的增量补全换成了全量补全。
  mutations: [
    {
      file: "packages/core/src/migrations/runner.ts",
      find: "    backfillNewTemplateKeys();",
      replace: "    backfillTeamDefaults();",
      why: "每次启动走全量补全而不是增量补全，用户删掉的键重启后被加回（删除不再是表态）",
    },
  ],
};

export default def;
