/**
 * 启动目录无关的测试隔离门禁。
 *
 * ## 治的是什么
 *
 * `bunfig.toml` 的 preload（`tests/preload-isolate-sid-home.ts`）只在 bun **当前工作目录**
 * 下有 bunfig 时生效。`test-isolation-preload-wiring.test.ts` 保证了每个包根都有一份，
 * 但管不到这些启动方式：
 *
 *   - `cd packages/cli/tests && bun test ./command/xxx.test.ts`
 *   - `cd packages/core/src && bun test ../../cli/tests/...`
 *   - 在仓库外用绝对路径 `bun test /abs/path/xxx.test.ts`（agent 常这么跑）
 *
 * 这几种情况下 preload 不生效，测试直接写进用户真实 `~/.sid-code`。2026-11-02 实测：
 * `~/.sid-code/compact-stats.json` 的 50 条记录全是测试 fixture（`tokensBefore` 160/120），
 * 并且被 `recommendParams` 当成真实样本，用来决定压缩参数。
 *
 * 修法在 `getSidHome()`：测试态下三个 override 都为空时，兜到进程级临时目录，
 * 不再依赖 bun 从哪个目录启动。本门禁锁住这一点。
 *
 * ## 判据
 *
 * 用假 `HOME`、仓库外的 cwd、不设 `SID_CONFIG_DIR`，以绝对路径跑已知会写
 * `compact-stats.json` 的测试，然后看假家目录有没有被写。看的是副作用，不是断言结果，
 * 因为污染发生时测试照样全绿。
 *
 * 场景 2 是变异自证：用 `SID_TEST_ALLOW_REAL_HOME=1` 关掉兜底，同一批测试必须写进假家目录。
 * 少了这一条，场景 1 的绿可能只是检测本身失效（HOME 没生效、文件名写错、测试没跑起来）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** 已知会经 recordCompactFeature 写 compact-stats.json 的测试（2026-11-02 实测各写 8 / 5 条）。 */
const TARGETS = [
  join(REPO_ROOT, "packages/cli/tests/command/compact-focus.test.ts"),
  join(REPO_ROOT, "packages/cli/tests/command/compact-analytics.test.ts"),
];
const SINK = "compact-stats.json";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function runOutsideRepo(opts: { allowRealHome: boolean }): Promise<{
  exitCode: number;
  wroteToFakeHome: boolean;
  output: string;
}> {
  const fakeHome = mkdtempSync(join(tmpdir(), "sid-cwd-gate-home-"));
  const outsideCwd = mkdtempSync(join(tmpdir(), "sid-cwd-gate-cwd-"));
  created.push(fakeHome, outsideCwd);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = fakeHome;
  // 本进程的 SID_CONFIG_DIR（preload 给的）绝不能漏给子进程，否则替被测方把隔离做掉了。
  delete env.SID_CONFIG_DIR;
  delete env.SID_CODE_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  if (opts.allowRealHome) env.SID_TEST_ALLOW_REAL_HOME = "1";
  else delete env.SID_TEST_ALLOW_REAL_HOME;

  const proc = Bun.spawn(["bun", "test", ...TARGETS], {
    cwd: outsideCwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const exitCode = await proc.exited;
  const output =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { exitCode, wroteToFakeHome: existsSync(join(fakeHome, ".sid-code", SINK)), output };
}

describe("测试隔离不依赖 bun 的启动目录", () => {
  test("场景 1：仓库外 cwd + 绝对路径 + 不设 SID_CONFIG_DIR → 假家目录零写入", async () => {
    for (const t of TARGETS) expect(existsSync(t), `受检测试不存在：${t}`).toBe(true);
    const r = await runOutsideRepo({ allowRealHome: false });
    // 先确认测试真的跑起来了，否则假家目录干净是因为什么都没跑。
    expect(r.exitCode, `受检测试子进程失败，本门禁结论不可信：\n${r.output}`).toBe(0);
    expect(r.output).toMatch(/Ran \d+ tests? across 2 files/);
    expect(
      r.wroteToFakeHome,
      `测试从仓库外启动时写进了真实家目录的 ${SINK}。getSidHome() 的测试态兜底失效了。`,
    ).toBe(false);
  }, 120_000);

  test("场景 2（变异自证）：关掉兜底 → 同一批测试写进假家目录，证明检测抓得到", async () => {
    const r = await runOutsideRepo({ allowRealHome: true });
    expect(r.exitCode, `受检测试子进程失败：\n${r.output}`).toBe(0);
    expect(
      r.wroteToFakeHome,
      `关掉兜底后预期写进 <HOME>/.sid-code/${SINK}，但没看到。可能原因：受检测试不再写这个文件` +
        `（换一个会写的测试）、HOME 重定向失效、或 preload 在仓库外也生效了（那样本门禁要换构造）。`,
    ).toBe(true);
  }, 120_000);
});
