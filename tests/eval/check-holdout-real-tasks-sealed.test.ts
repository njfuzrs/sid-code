/**
 * B7-3 holdout-real-tasks 永封校验 hook 单测
 *
 * 锁死 4 个不变量：
 *   1. 永封完整（200 行 + sha256 匹配）→ exit 0
 *   2. 行数被改 → exit 1
 *   3. 内容被改（行数对但 sha256 变）→ exit 1
 *   4. 公开页面含 holdout sid → exit 1
 *      （探针写 website/_holdout-sid-probe.md：checker 扫 website 下全部 .md。
 *       旧公开面那份自动生成页已于 2026-09-18 删除；题面泄露检测链同批下线，
 *       永封校验这条链仍扫公开页 sid。本探针现场创建、测完删掉。）
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SEALED = resolve(REPO_ROOT, "evals/holdout/real-tasks/holdout-sids.txt");
const PROBE_MD = resolve(REPO_ROOT, "website/_holdout-sid-probe.md");
const CHECKER = "scripts/eval/check-holdout-real-tasks-sealed.sh";

function runChecker(): { rc: number; out: string } {
  const r = spawnSync("sh", [CHECKER], { cwd: REPO_ROOT, encoding: "utf-8" });
  return { rc: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function withSealedBackup<T>(fn: () => T): T {
  const backup = readFileSync(SEALED);
  try {
    return fn();
  } finally {
    writeFileSync(SEALED, backup);
  }
}

function withProbeMd<T>(fn: () => T): T {
  const exists = existsSync(PROBE_MD);
  const backup = exists ? readFileSync(PROBE_MD) : null;
  try {
    return fn();
  } finally {
    if (backup) writeFileSync(PROBE_MD, backup);
    else if (existsSync(PROBE_MD)) unlinkSync(PROBE_MD);
  }
}

describe("B7-3 holdout-real-tasks 永封校验", () => {
  // 防御性清理：探针是未追踪文件，SIGKILL 时 finally 不跑。
  beforeAll(() => {
    // 探针是未追踪的临时文件。上次测试若被 SIGKILL，finally 不会跑，
    // 残留会让「永封完整 → exit 0」在后续每次运行里都失败。
    if (existsSync(PROBE_MD)) unlinkSync(PROBE_MD);
  });

  test("永封完整 → exit 0", () => {
    if (!existsSync(SEALED)) {
      // 跳过（M4 之前可能未落地，但当前 commit 已落）
      return;
    }
    expect(runChecker().rc).toBe(0);
  });

  test("行数被改（追加一行）→ exit 1", () => {
    if (!existsSync(SEALED)) return;
    withSealedBackup(() => {
      writeFileSync(SEALED, readFileSync(SEALED, "utf-8") + "tampered-extra-line\n");
      const r = runChecker();
      expect(r.rc).toBe(1);
      expect(r.out).toContain("行数");
    });
  });

  test("内容被改（行数对但 sha256 变）→ exit 1", () => {
    if (!existsSync(SEALED)) return;
    withSealedBackup(() => {
      const lines = readFileSync(SEALED, "utf-8").trimEnd().split("\n");
      // 改最后一行内容（保持 200 行）
      lines[lines.length - 1] = "ffffffff-fff";
      writeFileSync(SEALED, lines.join("\n") + "\n");
      const r = runChecker();
      expect(r.rc).toBe(1);
      expect(r.out).toContain("sha256");
    });
  });

  test("公开页含 holdout sid → exit 1", () => {
    if (!existsSync(SEALED)) return;
    const firstSid = readFileSync(SEALED, "utf-8").split("\n")[0]?.trim();
    if (!firstSid) return;
    withProbeMd(() => {
      writeFileSync(PROBE_MD, `${firstSid} leaked here\n`);
      const r = runChecker();
      expect(r.rc).toBe(1);
      expect(r.out).toContain("含 holdout sid");
    });
  });
});
