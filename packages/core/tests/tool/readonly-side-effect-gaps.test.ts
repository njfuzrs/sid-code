/**
 * N6：只读集单命令漏拦。
 *
 * 这些命令单条就有副作用（删文件、写文件、执行任意命令），旧实现把它们判只读，
 * 在 default + 无头下经 checker Step 5.5 工具级直接放行。sed 的 7 条在 02b 那份测试里。
 */

import { describe, test, expect } from "bun:test";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

describe("N6 只读集：有副作用的单命令判非只读", () => {
  test("find 的删除 / 执行 / 写文件动作", () => {
    for (const c of [
      "find . -delete",
      "find . -name x -exec rm {} \;",
      "find . -execdir rm {} +",
      "find . -ok rm {} \;",
      "find . -okdir rm {} \;",
      "find . -fprint /tmp/x",
      "find . -fprint0 /tmp/x",
      "find . -fprintf /tmp/x %p",
      "find . -fls /tmp/x",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  test("awk 脚本串里的 system / 管道 / 写文件 / getline / -f", () => {
    for (const c of [
      `awk 'BEGIN{system("id")}'`,
      `cat f | awk '{system($0)}'`,
      `awk '{print | "sh"}' f`,
      `awk '{print > "/tmp/x"}' f`,
      `awk '{print >> "/tmp/x"}' f`,
      `awk '{print |& "sh"}' f`,
      `awk 'NR>=1 {print | "sh"}' f`,
      `awk 'BEGIN{"id" | getline x; print x}'`,
      "awk -f prog.awk f",
      `awk -F: '{system($1)}' f`,
      `gawk 'BEGIN{system("id")}'`,
      `mawk 'BEGIN{system("id")}'`,
      `gawk -e 'BEGIN{system("id")}'`,
    ]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  test("sort -o / --output", () => {
    expect(isReadOnlyCommand("sort -o /tmp/x a")).toBe(false);
    expect(isReadOnlyCommand("sort -o/tmp/x a")).toBe(false);
    expect(isReadOnlyCommand("sort --output=/tmp/x a")).toBe(false);
    expect(isReadOnlyCommand("sort --output /tmp/x a")).toBe(false);
  });

  test("uniq 第二个位置参数是输出文件", () => {
    expect(isReadOnlyCommand("uniq a /tmp/x")).toBe(false);
  });

  test("git 只读子命令带 --output", () => {
    expect(isReadOnlyCommand("git diff --output=/tmp/x")).toBe(false);
    expect(isReadOnlyCommand("git log --output /tmp/x")).toBe(false);
    expect(isReadOnlyCommand("git show HEAD --output=/tmp/x")).toBe(false);
  });
});

describe("N6 只读对照组：常见只读用法仍判只读", () => {
  test("各程序的只读形态", () => {
    for (const c of [
      "find . -name x",
      "find . -name '*.ts' -type f -print",
      "awk '{print $1}' f",
      "awk -F: '{print $1}' /etc/passwd",
      "awk -v n=1 '{print $n}' f",
      "cat f | awk '{print $2}'",
      // 本地轨迹里的原样形态：>= 是比较、|| 是逻辑或，都不是副作用通道
      "awk 'NR>=12 && NR<=110' f",
      "awk 'NR>=358&&NR<=364 || NR>=719&&NR<=724 {print NR\": \"$0}' f",
      "sort a",
      "sort -n -r a",
      "uniq a",
      "sort a | uniq -c",
      "git diff",
      "git diff HEAD~1 -- src",
      "git merge-base a b",
      "git merge-base --is-ancestor a b",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(true);
    }
  });
});
