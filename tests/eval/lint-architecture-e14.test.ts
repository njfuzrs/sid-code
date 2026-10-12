/**
 * E-14 扫描面反漂移（内置 skill 下沉方案 P1）。
 *
 * E-14 原先只扫 `packages/core/src/skill/builtin/`。skill 迁到 `plugins/<插件>/skills/` 之后，
 * 规则照样 0 finding 通过 —— 不是因为合规，而是因为根本没扫到。这里断言扫描面确实覆盖插件 skill。
 *
 * 变异自证：把 listE14SkillDirs 里遍历 plugins/ 的那段删掉，下面两条红。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listE14SkillDirs } from "../../scripts/eval/lint-architecture.ts";

describe("E-14 扫描面含仓内插件 skill", () => {
  test("真实仓库：5 个迁出的插件 skill 都在扫描面里", () => {
    const dirs = listE14SkillDirs();
    for (const d of [
      "plugins/ops/skills/ci-heal",
      "plugins/ops/skills/incident-rca",
      "plugins/compliance/skills/security-audit",
      "plugins/compliance/skills/governance",
      "plugins/github-pr/skills/comments",
    ]) {
      expect(dirs).toContain(d);
    }
    // 内置 skill 仍在扫描面里（P4 之前两份并存）
    expect(dirs).toContain("packages/core/src/skill/builtin/code-review");
  });

  test("临时仓库：新增插件 skill 自动进入扫描面（不靠写死清单）", () => {
    const root = mkdtempSync(join(tmpdir(), "e14-"));
    try {
      mkdirSync(join(root, "plugins", "demo", "skills", "hello"), { recursive: true });
      writeFileSync(join(root, "plugins", "demo", "skills", "hello", "SKILL.md"), "x");
      expect(listE14SkillDirs(root)).toEqual(["plugins/demo/skills/hello"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
