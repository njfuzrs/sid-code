/**
 * pr-merge-chain.sh 的行为测试。
 *
 * 用一个假 gh（GH_BIN 注入）代替真实 GitHub：每个 PR 的 `pr view` 按顺序吐出
 * 预设的状态行（吐完停在最后一行），其余子命令只记日志。这样能确定性地复现
 * 「BEHIND → BLOCKED → MERGED」「中途 CI 失败」这些只在真实合并时才出现的序列，
 * 不需要网络、不碰任何真实仓库。
 *
 * 重点钉住三条「出错也不会报红」的性质：
 *   ① 严格串行：前一个没合入，绝不碰下一个（否则 strict 下白跑 N-1 轮 CI）
 *   ② 失败即停：CI 红 / 冲突时后面的 PR 一个都不动（后面的可能依赖前面的）
 *   ③ 合并方式默认 merge，已挂 squash 的会被改掉（squash 会让 tag 指向游离提交）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "pr-merge-chain.sh");

// 假 gh：状态序列放在 $FAKE_DIR/<n>.seq，游标放在 $FAKE_DIR/<n>.pos，调用记录追加到 calls.log
const FAKE_GH = `#!/usr/bin/env bash
set -u
d="$FAKE_DIR"
# -q 的 jq 查询是多行的，压成一行再记，否则一次调用会被拆成多条「写操作」
printf '%s' "$*" | tr '\\n' ' ' >> "$d/calls.log"; echo >> "$d/calls.log"
case "$1 $2" in
  "pr view")
    n="$3"; pos=$(cat "$d/$n.pos" 2>/dev/null || echo 1)
    total=$(wc -l < "$d/$n.seq" | tr -d ' ')
    line=$(sed -n "\${pos}p" "$d/$n.seq")
    [ "$pos" -lt "$total" ] && echo $((pos + 1)) > "$d/$n.pos"
    printf '%s\\n' "$line" ;;
  "pr list") cat "$d/list" ;;
  "pr update-branch") echo "✓ PR branch updated" ;;
  "pr merge") : ;;
  *) echo "fake gh: 未知命令 $*" >&2; exit 9 ;;
esac
`;

let dir: string;

/** 一行状态：state isDraft mergeStateStatus autoMergeMethod 失败数 标题 */
const row = (state: string, mss: string, auto = "NONE", failed = 0, draft = false) =>
  [state, String(draft), mss, auto, String(failed), "fix: 标题"].join("\t");

function seq(n: number, rows: string[]) {
  writeFileSync(join(dir, `${n}.seq`), rows.join("\n") + "\n");
}

function run(args: string[]) {
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: {
      ...process.env,
      GH_BIN: join(dir, "gh"),
      FAKE_DIR: dir,
      PR_MERGE_CHAIN_INTERVAL: "0",
    },
  });
  const calls = existsSync(join(dir, "calls.log"))
    ? readFileSync(join(dir, "calls.log"), "utf-8").trim().split("\n")
    : [];
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    // 只看有副作用的调用，pr view 是轮询噪声
    writes: calls.filter((c) => !c.startsWith("pr view")),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-merge-chain-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pr-merge-chain.sh", () => {
  test("串行：BEHIND 先 update，合入后才处理下一个", () => {
    seq(1, [
      row("OPEN", "BEHIND"),
      row("OPEN", "BEHIND", "MERGE"),
      row("OPEN", "BLOCKED", "MERGE"),
      row("MERGED", "UNKNOWN", "MERGE"),
    ]);
    seq(2, [
      row("OPEN", "BEHIND"),
      row("OPEN", "CLEAN", "MERGE"),
      row("MERGED", "UNKNOWN", "MERGE"),
    ]);
    const r = run(["1", "2"]);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([
      "pr merge 1 --auto --merge",
      "pr update-branch 1",
      "pr merge 2 --auto --merge",
    ]);
    expect(r.out).toContain("共合入 2 个");
  });

  test("已挂 squash 的 auto-merge 会改成 merge", () => {
    seq(7, [row("OPEN", "BLOCKED", "SQUASH"), row("MERGED", "UNKNOWN", "MERGE")]);
    const r = run(["7"]);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual(["pr merge 7 --disable-auto", "pr merge 7 --auto --merge"]);
  });

  test("CI 失败即停，后面的 PR 完全不动", () => {
    seq(1, [row("OPEN", "BLOCKED"), row("OPEN", "BLOCKED", "MERGE", 1)]);
    seq(2, [row("OPEN", "BEHIND")]);
    const r = run(["1", "2"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("检查失败");
    expect(r.writes.some((c) => c.includes(" 2"))).toBe(false);
  });

  test("冲突即停", () => {
    seq(1, [row("OPEN", "DIRTY"), row("OPEN", "DIRTY", "MERGE")]);
    const r = run(["1"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("冲突");
  });

  test("已合入的跳过，draft 停止", () => {
    seq(1, [row("MERGED", "UNKNOWN")]);
    seq(2, [row("OPEN", "CLEAN", "NONE", 0, true)]);
    const r = run(["1", "2"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("#1");
    expect(r.out).toContain("draft");
    expect(r.writes).toEqual([]);
  });

  test("超时即停", () => {
    seq(1, [row("OPEN", "BLOCKED", "MERGE")]);
    const r = run(["--timeout", "1", "1"]);
    expect(r.code).toBe(4);
    expect(r.out).toContain("超过 1 分钟");
  });

  test("--dry-run 不产生任何写操作", () => {
    seq(1, [row("OPEN", "BEHIND", "SQUASH")]);
    seq(2, [row("OPEN", "DIRTY")]);
    const r = run(["--dry-run", "1", "2"]);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out).toContain("有冲突");
  });

  test("--all 从 pr list 取编号", () => {
    writeFileSync(join(dir, "list"), "3\n5\n");
    seq(3, [row("MERGED", "UNKNOWN")]);
    seq(5, [row("MERGED", "UNKNOWN")]);
    const r = run(["--all"]);
    expect(r.code).toBe(0);
    expect(r.writes[0]).toStartWith("pr list --base main");
    expect(r.out).toContain("共合入 2 个");
  });

  test("不给 PR 号时等同 --all", () => {
    writeFileSync(join(dir, "list"), "4\n");
    seq(4, [row("MERGED", "UNKNOWN")]);
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.writes[0]).toStartWith("pr list --base main");
    expect(r.out).toContain("共合入 1 个");
  });

  test("只给 --dry-run 也走全部 PR，且零写操作（除 pr list）", () => {
    writeFileSync(join(dir, "list"), "6\n");
    seq(6, [row("OPEN", "BEHIND")]);
    const r = run(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.writes.filter((c) => !c.startsWith("pr list"))).toEqual([]);
  });

  test("--all 与显式 PR 号互斥", () => {
    expect(run(["--all", "1"]).code).toBe(1);
  });

  test("参数校验：非数字 PR 号、非法 method", () => {
    expect(run(["abc"]).code).toBe(1);
    expect(run(["--method", "fast", "1"]).code).toBe(1);
  });
});
