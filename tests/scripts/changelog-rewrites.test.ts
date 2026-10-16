/**
 * CHANGELOG 提交改写表的完整性（scripts/lib/changelog-rewrites.ts）。
 *
 * 改写表按完整 hash 匹配，失配是静默的：hash 写错、提交被 rebase 掉，
 * 生成器照样跑完，只是改写不生效，原标题原样回到 CHANGELOG.md。所以每条都要钉住：
 *   · hash 是本仓历史里真实存在的提交；
 *   · 改写后的标题仍是 Conventional Commits，type 和 PR 号与原标题一致（只改措辞，不改事实）。
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  COMMIT_REWRITES,
  applyDetailDrops,
  rewriteFor,
} from "../../scripts/lib/changelog-rewrites.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();

// 与 scripts/generate-changelog.ts 的 COMMIT_RE 同义
const COMMIT_RE =
  /^(feat|fix|refactor|perf|docs|style|test|build|ci|chore)(?:\(([^)]*)\))?\s*[:：]\s*(.*)$/;
const PR_RE = /\(#(\d+)\)\s*$/;

const entries = Object.entries(COMMIT_REWRITES);

describe("改写表条目", () => {
  test("至少有一条（空表说明这个文件可以删了）", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test.each(entries)("%s：hash 是完整 40 位且存在于本仓历史", (hash) => {
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(git(["cat-file", "-t", hash])).toBe("commit");
  });

  test.each(entries.filter(([, rw]) => rw.subject))(
    "%s：改写后的标题是 Conventional Commits，type 与 PR 号同原标题",
    (hash, rw) => {
      const original = git(["log", "-1", "--format=%s", hash]);
      const before = COMMIT_RE.exec(original);
      const after = COMMIT_RE.exec(rw.subject!);
      expect(after).not.toBeNull();
      expect(after![1]).toBe(before?.[1] ?? "");
      expect(PR_RE.exec(rw.subject!)?.[1]).toBe(PR_RE.exec(original)?.[1]);
    },
  );

  test.each(entries.filter(([, rw]) => rw.dropDetails?.length))(
    "%s：每个 dropDetails 子串都真的出现在提交正文里（否则这条是死规则）",
    (hash, rw) => {
      const body = git(["log", "-1", "--format=%b", hash]).replace(/\n(?=\S)/g, " ");
      for (const s of rw.dropDetails!) expect(body).toContain(s);
    },
  );
});

describe("rewriteFor / applyDetailDrops", () => {
  test("只认完整 hash，不认短 hash", () => {
    const [full] = entries[0]!;
    expect(rewriteFor(full)).toBeDefined();
    expect(rewriteFor(full.slice(0, 8))).toBeUndefined();
  });

  test("删掉含任一子串的行，其余原样保留并保序", () => {
    const rw = { dropDetails: ["foo", "bar"] };
    expect(applyDetailDrops(["a foo", "b", "bar c", "d"], rw)).toEqual(["b", "d"]);
  });

  test("没有改写或没有 dropDetails 时原样返回", () => {
    expect(applyDetailDrops(["x"], undefined)).toEqual(["x"]);
    expect(applyDetailDrops(["x"], { subject: "fix: y (#1)" })).toEqual(["x"]);
  });
});
