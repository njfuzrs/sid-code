/**
 * R4：P1 等待期拦截认不出两次事故会话的主力查询写法。
 *
 * 事故（`20261112-175603-ca8d7e5c`）：模型声明了等待之后，44 次前台查询一次都没被拦住，
 * 因为主力写法 `gh pr view 780 --json … | python3 -c "…"` 的**最后一段不是查询、
 * 也不是命令表里的任何东西**——`flattenCommand` 见到换行直接放弃，`python3` 不在纯过滤器
 * 白名单里，`gh api …/pulls/780` 不在命令表里。三者叠加，P1 判据在真实形态上完全不触发。
 *
 * 这个文件锁四件事：
 * 1. 44 条真实命令**原样**命中（fixture 从轨迹逐条抄下来，不按实现反推）；
 * 2. 六种新形态各自命中，且 subject 与既有 `gh pr view` / `gh pr checks` 同族；
 * 3. 扩匹配面**没有**放松安全边界（写文件 / 起子进程 / 发网络 / 改时钟一律 null）；
 * 4. 回放时确实拦得住（拦 27 条，≥ 方案要求的 20 条）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  matchStatusQuery,
  normalizeStatusOutput,
} from "@sid-code/core/task/status-query-commands.ts";
import {
  checkStatusQueryPoll,
  recordStatusQueryResult,
  type StatusPollContext,
} from "@sid-code/core/task/status-poll-guard.ts";

const T0 = 1_700_000_000_000;

/** 轨迹 fixture：`atMs` 是相对窗口起点的毫秒偏移，`command` / `output` 是原样记录 */
interface ReplayRow {
  atMs: number;
  command: string;
  output: string;
}

const rows = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "status-poll-replay-ca8d7e5c.json"), "utf8"),
) as ReplayRow[];

/** 只注入时钟与「有等待源」，listWaits 留空 = 没有 monitor 覆盖 → 走 120s 探测窗口 */
function makeCtx(clock: { now: number }): StatusPollContext {
  return {
    hasDeclaredExternalWait: () => true,
    listWaits: () => [],
    memo: { entries: new Map() },
    now: () => clock.now,
  };
}

describe("R4 §1.3 的 44 条真实命令（ca8d7e5c 窗口）", () => {
  test("44 条全部命中（改动前是 0 条）", () => {
    const missed = rows.filter((r) => !matchStatusQuery(r.command));
    expect(missed.map((r) => r.command.slice(0, 80))).toEqual([]);
    expect(rows.length).toBe(44);
  });

  test("同一种查询写法在窗口内共享同一签名（memo 才可能累加）", () => {
    // 44 条只有 9 种写法（唯一命令 = 9），其中 31 条完全相同。
    // 签名若随「第几次查询」漂移，sameRun 永远回到 1，拦截就形同虚设。
    const sigs = new Map<string, number>();
    for (const row of rows) {
      const m = matchStatusQuery(row.command);
      if (!m) continue;
      sigs.set(m.signature, (sigs.get(m.signature) ?? 0) + 1);
    }
    expect(sigs.size).toBe(9);
    expect(Math.max(...sigs.values())).toBe(31);
  });

  test("44 条的 subject 只有三个对象（gh:pr:780 / gh:run:43203650726 / run list）", () => {
    const subjects = new Set<string>();
    for (const row of rows) {
      const m = matchStatusQuery(row.command);
      if (m) subjects.add(m.subject);
    }
    expect([...subjects].sort()).toEqual([
      "gh:pr:780",
      "gh:run:43203650726",
      "gh:run:list:fix/tool-input-unknown-keys",
    ]);
  });
});

describe("R4 六种形态各自命中", () => {
  test("F1 多行 python 过滤器（引号内换行不是命令分隔符）", () => {
    const cmd = [
      'cd /repo/wt && gh pr view 780 --json state,mergeStateStatus,mergedAt,statusCheckRollup 2>&1 | python3 -c "',
      "import json,sys",
      "d=json.load(sys.stdin)",
      "print('state:', d.get('state'))",
      '"',
    ].join("\n");
    const m = matchStatusQuery(cmd);
    expect(m?.subject).toBe("gh:pr:780");
    expect(m?.family).toBe("gh_pr_view");
  });

  test("F2 单行 python -c 过滤器同样认", () => {
    expect(matchStatusQuery(`gh pr view 780 --json state | python3 -c "print(1)"`)?.subject).toBe(
      "gh:pr:780",
    );
  });

  test("F1' heredoc 形态的脚本正文参与只读判定", () => {
    const ok = [
      "gh pr view 780 --json state 2>&1 | python3 <<'EOF'",
      "import json,sys",
      "print(json.load(sys.stdin)['state'])",
      "EOF",
    ].join("\n");
    expect(matchStatusQuery(ok)?.subject).toBe("gh:pr:780");

    const write = [
      "gh pr view 780 --json state 2>&1 | python3 <<'EOF'",
      "import shutil",
      "shutil.rmtree('/tmp/x')",
      "EOF",
    ].join("\n");
    expect(matchStatusQuery(write)).toBeNull();
  });

  test("F2' node -e / ruby -e 也按正文语义判", () => {
    expect(
      matchStatusQuery(`gh pr view 780 --json state | node -e "process.stdin.pipe(process.stdout)"`)
        ?.subject,
    ).toBe("gh:pr:780");
    expect(
      matchStatusQuery(`gh pr view 780 --json state | ruby -e "puts STDIN.read"`)?.subject,
    ).toBe("gh:pr:780");
  });

  test("F3 gh api …/pulls/<n> 与 gh pr view 共用 gh:pr subject", () => {
    expect(matchStatusQuery("gh api repos/o/r/pulls/780 -q .state")?.subject).toBe("gh:pr:780");
  });

  test("F4 赋值段展开 + 派生对象归并（head=$(…) → gh:pr）", () => {
    const cmd =
      "head=$(gh api repos/o/r/pulls/779 -q '.head.sha'); gh api repos/o/r/commits/$head/check-runs -q '.check_runs[]|{name,status,conclusion}'";
    const m = matchStatusQuery(cmd);
    // 第二段查的是「那个 PR 的 CI」，subject 必须归并回 PR 本身
    expect(m?.subject).toBe("gh:pr:779");
    expect(m?.family).toBe("gh_api_checks");
  });

  test("F5 末尾无害段（date / echo）不再是放弃理由", () => {
    expect(matchStatusQuery("gh pr view 780 --json state; date -u +%H:%M:%S")?.subject).toBe(
      "gh:pr:780",
    );
    expect(matchStatusQuery("gh pr checks 662; echo done")?.subject).toBe("gh:pr:662");
    expect(matchStatusQuery("gh pr checks 662 | head -5; echo done")?.subject).toBe("gh:pr:662");
  });

  test("F6 `| jq -r` 这类既有形态没有回归", () => {
    expect(matchStatusQuery("gh pr view 780 --json state | jq -r .state")?.subject).toBe(
      "gh:pr:780",
    );
  });
});

describe("R4 扩匹配面没有放松安全边界", () => {
  test("脚本正文里有写文件 / 子进程 / 网络 → null", () => {
    for (const cmd of [
      `gh pr view 1 --json state | python3 -c "import shutil; shutil.rmtree('/tmp/x')"`,
      `gh pr view 1 --json state | python3 -c "open('/tmp/x','w').write('hi')"`,
      `gh pr view 1 --json state | python3 -c "import subprocess; subprocess.run(['git','push'])"`,
      `gh pr view 1 --json state | python3 -c "import requests; requests.get('http://x')"`,
      `gh pr view 1 --json state | python3 -c "import os; os.system('git push')"`,
      `gh pr view 1 --json state | python3 -c "import socket"`,
      `gh pr view 1 --json state | node -e "require('child_process').execSync('git push')"`,
      `gh pr view 1 --json state | node -e "require('fs').writeFileSync('/tmp/x','y')"`,
      `gh pr view 1 --json state | ruby -e "File.write('/tmp/x','y')"`,
    ]) {
      expect(matchStatusQuery(cmd)).toBeNull();
    }
  });

  test("脚本正文取不到（从 stdin / 文件读）→ 不当纯过滤", () => {
    // `python3 script.py` 的正文在文件里，判不出会不会写 → 宁漏不误
    expect(matchStatusQuery("gh pr view 1 --json state | python3 scripts/x.py")).toBeNull();
  });

  test("date -s 会改系统时钟，不算无害段", () => {
    expect(matchStatusQuery("gh pr view 1 --json state; date -s 2020-01-01")).toBeNull();
    expect(matchStatusQuery("gh pr view 1 --json state; date --set=2020-01-01")).toBeNull();
  });

  test("赋值段内部是写操作 → null（展开不会把写命令变成查询）", () => {
    expect(matchStatusQuery("x=$(git push); gh pr view 1 --json state")).toBeNull();
    expect(matchStatusQuery("x=$(curl -X POST http://x); gh pr view 1 --json state")).toBeNull();
  });

  test("gh api 写标志 + pulls 路径仍然拒绝", () => {
    expect(matchStatusQuery("gh api -X PATCH repos/o/r/pulls/1 -f state=closed")).toBeNull();
    expect(matchStatusQuery("gh api repos/o/r/pulls/1 -X POST")).toBeNull();
  });

  test("末尾未知段仍然放行（无害段只放行无害的那几个）", () => {
    expect(matchStatusQuery("gh pr view 1 --json state; git status")).toBeNull();
    expect(matchStatusQuery("gh pr view 1 --json state; rm -rf /tmp/x")).toBeNull();
  });
});

describe("R4 输出归一化：组合时长不再让签名漂移", () => {
  test("13m43s 与 5m2s 归一化后相同（gh run list 的 ELAPSED 列）", () => {
    const a = normalizeStatusOutput(
      "gh_run",
      "43203650726  test  pass  13m43s  2020-01-01T00:00:00Z",
    );
    const b = normalizeStatusOutput(
      "gh_run",
      "43203650726  test  pass  5m2s   2020-01-01T00:00:00Z",
    );
    expect(a).toBe(b);
  });

  test("真实状态变化仍产生不同签名（归一化没抹过头）", () => {
    const a = normalizeStatusOutput("gh_run", "43203650726  test  pass  13m43s");
    const b = normalizeStatusOutput("gh_run", "43203650726  test  fail  13m43s");
    expect(a).not.toBe(b);
  });
});

describe("R4 真实轨迹回放：确实拦得住", () => {
  /**
   * 44 条命令 + 原输出按时间顺序喂给 P1 判据。
   *
   * 拦截数 **27** 是用轨迹时间戳独立重算出来的（不是「跑一遍实现看结果」）：
   * 9 种签名里最大的那一组 31 条，前 2 条放行（第 2 条给「结果没变」提示）、
   * 之后持续拦截；中途跨越 120s 探测窗口时放行 2 次 → 31 - 2 - 2 = 27。
   * 方案 §R4 的要求是 ≥ 20（改动前是 0）。
   */
  test("matched = 44，intercepted ≥ 20，且拦下时回执带上次摘要", () => {
    const clock = { now: T0 };
    const ctx = makeCtx(clock);
    let matched = 0;
    let blocked = 0;
    let blockedWithoutSummary = 0;
    for (const row of rows) {
      clock.now = T0 + row.atMs;
      if (!matchStatusQuery(row.command)) continue;
      matched++;
      const r = checkStatusQueryPoll("bash", { command: row.command }, ctx);
      if (r.intercept) {
        blocked++;
        // 被拦时模型必须拿得到上次的结论，否则压缩后再问就彻底失忆
        if (!r.output.includes("本次未执行") || !r.output.includes("上次查询于")) {
          blockedWithoutSummary++;
        }
        continue; // 被拦 = 不执行 = 不更新 memo
      }
      recordStatusQueryResult(row.command, row.output, ctx);
    }
    expect(matched).toBe(44);
    expect(blocked).toBeGreaterThanOrEqual(20);
    expect(blocked).toBe(27);
    expect(blockedWithoutSummary).toBe(0);
  });
});
