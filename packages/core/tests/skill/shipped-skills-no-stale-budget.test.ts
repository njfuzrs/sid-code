/**
 * 回归：随仓分发的 skill 不得再声明 / 宣称已失效的执行上限。
 *
 * PR-B（2026-10-17）起 fork 子代理无墙钟，`timeout-mins` 不再生效：
 *   - 内置 code-review 每次启动都会因自己声明的 `timeout-mins` 打一条「已不再生效」warn；
 *   - Skill Creator 模板会把这个死字段继续生成进用户的 skill；
 *   - /pr-workflow 的 prompt 告诉模型「最多 50 轮、30 分钟」，模型据此提前降级自审。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";
import { loadBundledSkills } from "@sid-code/core/skill/bundled/index.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..");

function skillFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === "SKILL.md") out.push(join(e.parentPath, e.name));
  }
  return out;
}

const SHIPPED = [
  ...skillFiles(join(REPO, "packages", "core", "src", "skill", "builtin")),
  ...skillFiles(join(REPO, "plugins")),
];

describe("随仓 skill 不声明已失效的 timeout-mins", () => {
  test("扫到了内置与插件 skill（防止路径漂移后空跑）", () => {
    expect(SHIPPED.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of SHIPPED) {
    test(file.slice(REPO.length + 1), () => {
      const m = readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---\n/);
      if (!m) throw new Error("no frontmatter");
      const fm = loadYaml(m[1]) as Record<string, unknown>;
      expect(fm["timeout-mins"]).toBeUndefined();
      expect(fm["timeoutMins"]).toBeUndefined();
    });
  }

  test("Skill Creator 生成模板不含 timeout-mins", () => {
    const src = readFileSync(
      join(REPO, "packages/core/src/skill/builtin/skill-creator/scripts/init_skill.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/^timeout-mins:/m);
  });
});

describe("/pr-workflow prompt 不宣称已删除的轮次 / 时间上限", () => {
  test("不出现「50 轮」「30 分钟」", async () => {
    const cmd = loadBundledSkills().find((s) => s.name === "pr-workflow");
    if (cmd?.type !== "prompt") throw new Error("pr-workflow 应为 prompt 命令");
    const prompt = await cmd.getPromptForCommand("", {} as never);
    const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    expect(text).not.toContain("50 轮");
    expect(text).not.toContain("30 分钟");
  });
});
