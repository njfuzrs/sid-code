/**
 * N6：只读集里「副作用在参数里」的程序（find / awk / sort / uniq / git --output）。
 *
 * 修前这些在 default + 无头 + 任意 allow 清单下经 Step 5.5 工具级只读放行，直接执行。
 * 原则是「看不懂就不算只读」：落到 ask，不是硬拒。对照组锁住最常见的只读用法不被误伤。
 */

import { describe, test, expect } from "bun:test";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

describe("N6：带副作用参数 → 非只读", () => {
  test.each([
    "find . -delete",
    "find . -name x -exec rm {} \;",
    "find . -execdir rm {} +",
    "find . -ok rm {} \;",
    "find . -fprint /tmp/x",
    `awk 'BEGIN{system("id")}'`,
    "cat f | awk '{system($0)}'",
    `awk '{print > "out"}' f`,
    `awk '{print | "sh"}' f`,
    `awk '{printf "%s", $0 >> "out"}' f`,
    `awk 'BEGIN{"id" | getline x}'`,
    "awk -f prog.awk f",
    `gawk 'BEGIN{system("id")}'`,
    "sort -o /tmp/x a",
    "sort -uo /tmp/x a",
    "sort --output=/tmp/x a",
    "uniq a /tmp/x",
    "git diff --output=/tmp/x",
    "git log --output /tmp/x",
  ])("%s", (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });
});

describe("N6 对照：常见只读用法仍是只读", () => {
  test.each([
    "find . -name x",
    "find . -name '*.ts' -print",
    "awk '{print $1}' f",
    "awk -F: '{print $1}' /etc/x",
    // 本地轨迹里 awk 脚本含 > / | 的 212 次中 210 次是这种比较 / 交替，不能误伤
    "awk 'NR>=10 && NR<=20' f",
    "awk 'NR>=58 && NR<=76 {printf \"%d|%s\\n\", NR, $0}' f",
    "awk '$1 > 5 || /a|b/ {print $1}' f",
    "sort a",
    "sort -k2 -n f",
    "uniq a",
    "uniq -c",
    "git diff",
    "git log --oneline -1",
    "git merge-base a b",
    "git merge-base --is-ancestor a HEAD",
  ])("%s", (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
});
