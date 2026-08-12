/**
 * Shell 规则匹配测试（P0-1：对齐 CC matchWildcardPattern）
 * 覆盖方案文档给出的全部实测用例。
 */

import { describe, test, expect } from "bun:test";
import {
  matchWildcardPattern,
  matchShellRulePattern,
  hasWildcards,
  extractLegacyPrefix,
} from "@sid-code/core/permission/shell-rule-matching.ts";

describe("matchWildcardPattern - 方案文档实测用例（修复后应全部正确）", () => {
  test("Bash(*) 哨兵：* 匹配任意命令（含含路径命令）", () => {
    // 旧 minimatch 下这些全 false（* 不跨 /），这是 P0-1 的核心 bug
    expect(matchWildcardPattern("*", "ls /tmp")).toBe(true);
    expect(matchWildcardPattern("*", "cat src/foo.txt")).toBe(true);
    expect(matchWildcardPattern("*", "git push origin/main")).toBe(true);
  });

  test("cat * 匹配含路径参数", () => {
    expect(matchWildcardPattern("cat *", "cat src/foo.txt")).toBe(true);
  });

  test("git * 匹配含 / 的命令", () => {
    expect(matchWildcardPattern("git *", "git push origin/main")).toBe(true);
  });

  test("npm run * 匹配 npm run build", () => {
    expect(matchWildcardPattern("npm run *", "npm run build")).toBe(true);
  });

  test("ls * 匹配 ls -la（尾部空格+*特判）", () => {
    expect(matchWildcardPattern("ls *", "ls -la")).toBe(true);
  });

  test("ls * 不匹配 lsof（尾部 ( .*)? 要求空格边界）", () => {
    // "ls *" → "ls( .*)?"：匹配 "ls" 或 "ls <args>"，不匹配 "lsof"
    expect(matchWildcardPattern("ls *", "lsof")).toBe(false);
  });
});

describe("matchWildcardPattern - 尾部 ' *' 特判", () => {
  test("git * 同时匹配 git add 和裸 git", () => {
    expect(matchWildcardPattern("git *", "git add")).toBe(true);
    expect(matchWildcardPattern("git *", "git")).toBe(true);
  });

  test("多通配符 * run * 不做尾部优化，不误匹配 npm run", () => {
    expect(matchWildcardPattern("* run *", "npm run build")).toBe(true);
    expect(matchWildcardPattern("* run *", "npm run")).toBe(false);
  });
});

describe("matchWildcardPattern - 转义", () => {
  test("\\* 只匹配字面星号", () => {
    expect(matchWildcardPattern("echo \\*", "echo *")).toBe(true);
    expect(matchWildcardPattern("echo \\*", "echo foo")).toBe(false);
  });

  test("正则元字符被转义（. 不当通配符）", () => {
    expect(matchWildcardPattern("a.b", "a.b")).toBe(true);
    expect(matchWildcardPattern("a.b", "axb")).toBe(false);
  });
});

describe("matchWildcardPattern - dotAll（换行）", () => {
  test("* 匹配含内嵌换行的命令", () => {
    expect(matchWildcardPattern("cat *", "cat <<EOF\nline\nEOF")).toBe(true);
  });
});

describe("matchWildcardPattern - caseInsensitive", () => {
  test("大小写不敏感", () => {
    expect(matchWildcardPattern("LS *", "ls -la", true)).toBe(true);
    expect(matchWildcardPattern("LS *", "ls -la", false)).toBe(false);
  });
});

describe("hasWildcards", () => {
  test("含未转义 * → true", () => {
    expect(hasWildcards("git *")).toBe(true);
    expect(hasWildcards("*")).toBe(true);
  });
  test("末尾 :* legacy 前缀 → false", () => {
    expect(hasWildcards("npm:*")).toBe(false);
  });
  test("转义的 \\* → false", () => {
    expect(hasWildcards("echo \\*")).toBe(false);
  });
  test("无 * → false", () => {
    expect(hasWildcards("ls -la")).toBe(false);
  });
});

describe("extractLegacyPrefix", () => {
  test("npm:* → npm", () => {
    expect(extractLegacyPrefix("npm:*")).toBe("npm");
  });
  test("非 :* → null", () => {
    expect(extractLegacyPrefix("git *")).toBeNull();
  });
});

describe("matchShellRulePattern - 统一入口", () => {
  test("prefix: 前缀语法", () => {
    expect(matchShellRulePattern("prefix:git ", "git push")).toBe(true);
    expect(matchShellRulePattern("prefix:git ", "npm test")).toBe(false);
  });

  test("legacy :* 前缀（含裸命令）", () => {
    expect(matchShellRulePattern("git:*", "git push origin/main")).toBe(true);
    expect(matchShellRulePattern("git:*", "git")).toBe(true);
    expect(matchShellRulePattern("git:*", "github")).toBe(false);
  });

  test("通配符走 matchWildcardPattern", () => {
    expect(matchShellRulePattern("*", "ls /tmp")).toBe(true);
    expect(matchShellRulePattern("git *", "git commit -m x")).toBe(true);
  });

  test("无通配符退化为精确匹配", () => {
    expect(matchShellRulePattern("ls", "ls")).toBe(true);
    expect(matchShellRulePattern("ls", "ls -la")).toBe(false);
  });
});
