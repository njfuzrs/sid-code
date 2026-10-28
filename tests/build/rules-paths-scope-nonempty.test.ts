/**
 * 防漂移哨兵：仓库里每一份带 frontmatter `paths:` 的规则文件，作用域都不能是空集。
 *
 * 拦的是 `afab5725` 那一类事故：分包 `git mv` 把 `src/ui/CLAUDE.md` 搬到
 * `packages/cli/src/ui/`，frontmatter 的 `paths: ["src/ui/**"]` 没跟着改，从此
 * 静默失效两个半月（本地 668 次 ui 访问 0 次注入），没有任何测试变红。
 *
 * 判据：按运行时同一个函数（`rulesPathsMatchFromOwner`）判定，规则归属目录下
 * 至少有一个 git 跟踪的文件命中。红了 = 规则搬家后作用域变空，改 frontmatter 或改回位置，
 * 不要删这条断言。
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  parseRulesFrontmatter,
  ruleOwnerDir,
  rulesPathsMatchFromOwner,
} from "@sid-code/core/config/rules.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const RULE_FILE = /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|\.(claude|sid-code)\/rules\/.+\.md)$/;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO })
  .toString()
  .split("\0")
  .filter(Boolean);

const scopedRules = tracked
  .filter((f) => RULE_FILE.test(f))
  .map((f) => ({
    file: f,
    paths: parseRulesFrontmatter(readFileSync(join(REPO, f), "utf8")).paths,
  }))
  .filter((r): r is { file: string; paths: string[] } => !!r.paths && r.paths.length > 0);

describe("带 paths: 的规则文件作用域非空", () => {
  test("至少找到一份带 paths 的规则（防枚举逻辑坏了导致恒绿）", () => {
    expect(scopedRules.length).toBeGreaterThan(0);
  });

  for (const { file, paths } of scopedRules) {
    test(`${file} 的 paths ${JSON.stringify(paths)} 命中归属目录下至少一个跟踪文件`, () => {
      const ownerAbs = ruleOwnerDir(join(REPO, file));
      const ownerRel = ownerAbs === REPO ? "" : ownerAbs.slice(REPO.length + 1) + "/";
      const candidates = tracked.filter((f) => f.startsWith(ownerRel) && f !== file);
      const hit = candidates.find((f) => rulesPathsMatchFromOwner(paths, [f], ownerAbs, REPO));
      expect({ file, hit: hit ?? null }).not.toEqual({ file, hit: null });
    });
  }
});
