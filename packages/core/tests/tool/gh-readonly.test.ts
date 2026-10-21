/**
 * B2（发现 6b）：gh 只读子命令白名单。
 *
 * 被评会话 ce7ea52e 里 `gh issue view 373 --json …` 被判非只读。白名单按
 * 「命令组 + 子命令」精确匹配；`gh api` 刻意不进（`-f/-F` 会隐式变成 POST）。
 */

import { describe, test, expect } from "bun:test";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

describe("B2 gh 只读白名单", () => {
  test("被评会话里的原样命令判只读", () => {
    expect(isReadOnlyCommand("gh issue view 373 --json title,body,comments")).toBe(true);
    expect(isReadOnlyCommand("gh issue view 373 --json title && gh pr list --state open")).toBe(
      true,
    );
  });

  test("白名单内的子命令判只读", () => {
    for (const c of [
      "gh issue list --label bug",
      "gh pr view 389 --json statusCheckRollup",
      "gh pr list --author @me",
      "gh pr diff 389",
      "gh pr checks 389",
      "gh repo view njfuzrs/sid-code",
      "gh pr view 389 -R njfuzrs/sid-code --json title -q .title",
      "gh --version",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(true);
    }
  });

  test("gh api 不进白名单（GET 形态也不放行）", () => {
    expect(isReadOnlyCommand("gh api repos/o/r")).toBe(false);
    expect(isReadOnlyCommand("gh api repos/o/r/issues -f title=x")).toBe(false);
    expect(isReadOnlyCommand("gh api -X DELETE repos/o/r")).toBe(false);
  });

  test("写操作与改本地状态的子命令判非只读", () => {
    for (const c of [
      "gh pr checkout 389",
      "gh pr merge 389 --auto --merge",
      "gh pr create --title x --body y",
      "gh pr close 389",
      "gh pr comment 389 -b hi",
      "gh issue create --title x",
      "gh issue close 1",
      "gh issue edit 1 --add-label bug",
      "gh repo clone o/r",
      "gh repo delete o/r --yes",
      "gh run rerun 1 --failed",
      "gh auth login",
      "gh",
      "gh pr",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  test("--web / -w 拉起浏览器，判非只读", () => {
    expect(isReadOnlyCommand("gh pr view 389 --web")).toBe(false);
    expect(isReadOnlyCommand("gh issue list -w")).toBe(false);
    expect(isReadOnlyCommand("gh repo view --web")).toBe(false);
  });

  test("只读子命令带写入重定向仍判非只读", () => {
    expect(isReadOnlyCommand("gh pr diff 389 > /tmp/x.diff")).toBe(false);
  });

  test("只读 gh 与写命令串联判非只读", () => {
    expect(isReadOnlyCommand("gh pr view 1 && gh pr merge 1")).toBe(false);
  });
});
