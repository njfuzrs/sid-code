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
} from "../../src/tool/git-operation-tracking.ts";

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
