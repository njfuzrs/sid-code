/**
 * B7-3 holdout-real-tasks 永封校验 hook 单测
 *
 * 锁死 4 个不变量：
 *   1. 永封完整（200 行 + sha256 匹配）→ exit 0
 *   2. 行数被改 → exit 1
 *   3. 内容被改（行数对但 sha256 变）→ exit 1
 *   4. 公开页面（CASES.md）含 holdout sid → exit 1
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SEALED = resolve(REPO_ROOT, "evals/holdout/real-tasks/holdout-sids.txt");
const CASES_MD = resolve(REPO_ROOT, "evals/CASES.md");
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

function withCasesMdBackup<T>(fn: () => T): T {
  const exists = existsSync(CASES_MD);
  const backup = exists ? readFileSync(CASES_MD) : null;
  try {
    return fn();
  } finally {
    if (backup) writeFileSync(CASES_MD, backup);
    else if (existsSync(CASES_MD)) unlinkSync(CASES_MD);
  }
}

describe("B7-3 holdout-real-tasks 永封校验", () => {
  // 防御性清理：若 CASES.md 被之前的测试异常中断残留 holdout sid，自动扫除
  // 避免"永封完整"测试因脏数据而误报 exit 1（withCasesMdBackup 的 finally 不会在 SIGKILL 时执行）
  beforeAll(() => {
    if (!existsSync(SEALED) || !existsSync(CASES_MD)) return;
    const holdoutSids = new Set(
      readFileSync(SEALED, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const lines = readFileSync(CASES_MD, "utf-8").split("\n");
    // ⚠ 必须用「包含」而非「整行相等」：下面的泄露测试写入的是
    // `${sid} leaked here`，整行 !== sid，所以 has(line.trim()) 永远匹配不上——
    // 这道防御网原本有个洞，一旦残留就再也清不掉，导致「永封完整 → exit 0」
    // 在后续每次运行里都失败，且脏数据留在**已被 git 追踪**的 evals/CASES.md 里。
    const cleanLines = lines.filter(
      (line) => !Array.from(holdoutSids).some((sid) => line.includes(sid)),
    );
    if (lines.length !== cleanLines.length) {
      // 归一化行尾：split("\n") 后原文件末尾的换行会产生一个空元素，
      // 直接 join 回去会比原文件多一个空行——脏 1 个字节同样会让 git diff 变红，
      // 而这是个**被追踪**的文件，不能留痕。
      while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === "") {
        cleanLines.pop();
      }
      writeFileSync(CASES_MD, cleanLines.join("\n") + "\n");
    }
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

  test("CASES.md 含 holdout sid → exit 1", () => {
    if (!existsSync(SEALED)) return;
    const firstSid = readFileSync(SEALED, "utf-8").split("\n")[0]?.trim();
    if (!firstSid) return;
    withCasesMdBackup(() => {
      const old = existsSync(CASES_MD) ? readFileSync(CASES_MD, "utf-8") : "";
      writeFileSync(CASES_MD, `${old}\n${firstSid} leaked here\n`);
      const r = runChecker();
      expect(r.rc).toBe(1);
      expect(r.out).toContain("含 holdout sid");
    });
  });
});
