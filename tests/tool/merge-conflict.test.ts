/**
 * P1-3：合并冲突运行时检测
 */

import { describe, test, expect } from "bun:test";
import { detectMergeConflictHint } from "@sid-code/core/tool/bash/merge-conflict.ts";

describe("P1-3 合并冲突检测", () => {
  test("git merge 冲突命中", () => {
    const out = "Auto-merging foo.ts\nCONFLICT (content): Merge conflict in foo.ts\nAutomatic merge failed; fix conflicts and then commit the result.";
    const hint = detectMergeConflictHint("git merge feature", out);
    expect(hint).not.toBeNull();
    expect(hint).toContain("合并冲突处理协议");
    expect(hint).toContain("ask_user_question");
  });

  test("git rebase 冲突命中", () => {
    const out = "CONFLICT (content): Merge conflict in a.ts";
    expect(detectMergeConflictHint("git rebase main", out)).not.toBeNull();
  });

  test("git pull 冲突命中", () => {
    const out = "Unmerged paths:\n  both modified: b.ts";
    expect(detectMergeConflictHint("git pull origin main", out)).not.toBeNull();
  });

  test("成功 merge 不命中", () => {
    expect(detectMergeConflictHint("git merge feature", "Fast-forward\n 1 file changed")).toBeNull();
  });

  test("非 merge 类命令即使输出含 CONFLICT 也不命中", () => {
    // 例如 grep 到源码里的字符串 CONFLICT
    expect(detectMergeConflictHint("git status", "nothing about CONFLICT here")).toBeNull();
    expect(detectMergeConflictHint("echo CONFLICT", "CONFLICT")).toBeNull();
  });
});
