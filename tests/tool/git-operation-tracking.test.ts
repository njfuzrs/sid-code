/**
 * P2-3：git 操作使用度量
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  classifyGitOperation,
  recordGitOperation,
  getGitOperationStats,
  resetGitOperationStats,
  setGitOperationObserver,
  type GitOperationEvent,
} from "@sid-code/core/tool/git-operation-tracking.ts";

describe("P2-3 classifyGitOperation", () => {
  test("commit", () => {
    expect(classifyGitOperation("git commit -m 'x'")).toBe("commit");
    expect(classifyGitOperation("git commit -F -")).toBe("commit");
  });
  test("commit --dry-run 不计为 commit", () => {
    expect(classifyGitOperation("git commit --dry-run")).toBeNull();
  });
  test("push", () => {
    expect(classifyGitOperation("git push origin main")).toBe("push");
    expect(classifyGitOperation("git push --force")).toBe("push");
  });
  test("PR 创建（gh/glab/cr）", () => {
    expect(classifyGitOperation("gh pr create --fill")).toBe("pr_created");
    expect(classifyGitOperation("glab mr create")).toBe("pr_created");
    expect(classifyGitOperation("cr create")).toBe("pr_created");
  });
  test("merge / rebase / checkout / reset", () => {
    expect(classifyGitOperation("git merge feature")).toBe("merge");
    expect(classifyGitOperation("git rebase main")).toBe("rebase");
    expect(classifyGitOperation("git checkout -b x")).toBe("checkout");
    expect(classifyGitOperation("git switch main")).toBe("checkout");
    expect(classifyGitOperation("git reset --hard")).toBe("reset");
  });
  test("只读 git 与非 git 返回 null", () => {
    expect(classifyGitOperation("git status")).toBeNull();
    expect(classifyGitOperation("git log")).toBeNull();
    expect(classifyGitOperation("ls -la")).toBeNull();
    expect(classifyGitOperation("npm test")).toBeNull();
  });
});

describe("P2-3 计数与观察者", () => {
  beforeEach(() => {
    resetGitOperationStats();
    setGitOperationObserver(() => {});
  });

  test("记录累加 byKind 与 total", () => {
    recordGitOperation("git commit -m a", 1000);
    recordGitOperation("git commit -m b", 1001);
    recordGitOperation("git push origin main", 1002);
    recordGitOperation("gh pr create", 1003);
    recordGitOperation("ls", 1004); // 非 git → 忽略

    const stats = getGitOperationStats();
    expect(stats.total).toBe(4);
    expect(stats.byKind.commit).toBe(2);
    expect(stats.byKind.push).toBe(1);
    expect(stats.byKind.pr_created).toBe(1);
    expect(stats.events).toHaveLength(4);
  });

  test("观察者被调用且命令截断", () => {
    const seen: GitOperationEvent[] = [];
    setGitOperationObserver((e) => seen.push(e));
    const long = "git commit -m '" + "x".repeat(500) + "'";
    recordGitOperation(long, 2000);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("commit");
    expect(seen[0].command.length).toBeLessThanOrEqual(200);
  });

  test("非 git 操作不触发观察者", () => {
    let called = 0;
    setGitOperationObserver(() => { called++; });
    recordGitOperation("echo hi", 3000);
    expect(called).toBe(0);
  });

  test("观察者抛异常不影响计数", () => {
    setGitOperationObserver(() => { throw new Error("boom"); });
    expect(() => recordGitOperation("git push", 4000)).not.toThrow();
    expect(getGitOperationStats().byKind.push).toBe(1);
  });
});

/**
 * git 全局选项容错：`git -c commit.gpgsign=false commit` 是签名环境下的常见写法，
 * 不归一化则子命令与 `git` 被撑开 → 所有分类正则失配 → 这些操作漏计数（度量失真）。
 */
describe("git 全局选项不影响分类", () => {
  beforeEach(() => {
    resetGitOperationStats();
    setGitOperationObserver(null);
  });

  test("-c / -C / 组合选项前缀仍能正确分类", () => {
    expect(classifyGitOperation("git -c commit.gpgsign=false commit -m x")).toBe("commit");
    expect(classifyGitOperation("git -C /tmp push")).toBe("push");
    expect(classifyGitOperation("git -c a=b -C /d merge feature")).toBe("merge");
    expect(classifyGitOperation("git --git-dir=/x/.git rebase main")).toBe("rebase");
  });

  test("归一化后仍不误计只读操作", () => {
    expect(classifyGitOperation("git --no-pager log")).toBeNull();
    expect(classifyGitOperation("git -C /tmp status")).toBeNull();
    expect(classifyGitOperation("git -c core.pager=cat diff")).toBeNull();
  });

  test("带全局选项的操作真正进入计数", () => {
    recordGitOperation("git -c commit.gpgsign=false commit -m x", 1000);
    recordGitOperation("git -C /tmp push", 1001);
    const stats = getGitOperationStats();
    expect(stats.total).toBe(2);
    expect(stats.byKind.commit).toBe(1);
    expect(stats.byKind.push).toBe(1);
  });

  test("resetGitOperationStats 清零（同进程新会话不串味）", () => {
    recordGitOperation("git commit -m x", 1000);
    expect(getGitOperationStats().total).toBe(1);
    resetGitOperationStats();
    const stats = getGitOperationStats();
    expect(stats.total).toBe(0);
    expect(stats.events).toHaveLength(0);
    expect(stats.byKind.commit).toBe(0);
  });
});
