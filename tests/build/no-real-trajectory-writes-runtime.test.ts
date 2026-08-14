/**
 * 运行时落盘门禁 —— 抓「间接写用户真实家目录」的测试。
 *
 * ## 为什么静态扫描抓不到，必须有这道运行时门禁
 *
 * 已有的 `packages/core/tests/telemetry/no-real-path-writes.test.ts` 是**静态扫描**：
 * 扫测试源码里有没有 import 落盘类导出（`recordCacheBreak` / `appendUsageLedger` …），
 * 有则要求文件里出现过 `process.env.SID_CONFIG_DIR` 之类的隔离标记。
 *
 * 这个手法对**直接**调落盘函数的测试有效，但对**间接**落盘结构性无效。实测案例：
 * `packages/core/tests/context/manager.test.ts` 只调 `mgr.addMessage(...)`，源码里没有
 * 任何 `.sid-code` 字样、也没 import 任何落盘导出 —— 但 `Manager.addMessage` 内部对
 * 超过 30000 字符的 tool_result 会调 `persistLargeOutput`（`context/manager.ts:615`
 * 附近），而后者同步写 `sidPaths.trajectories()` 下的目录。静态扫描必然漏。
 *
 * 真实后果不是假设：`~/.sid-code/trajectories/sessions/` 下曾长期躺着两个测试产物目录
 * （`default/` 与 `test-storage-session-001/`，建于 2026-08-10），而它们所在的
 * 「会话数」正是「会话终态覆盖率」这类指标的分母 —— 分母被灌水，健康指标看起来像故障。
 *
 * ## 判据为什么是「跑一遍看家目录有没有被写」而不是「跑一遍看测试是否全绿」
 *
 * `CLAUDE.md` 记着这条实测教训：**污染时测试同样全绿**。2026-08-03 那次往
 * cache-breaks.jsonl 灌了 6 万行假数据，一路 0 fail。本门禁受控复现过同一形态：
 * 一个 `delete process.env.SID_CONFIG_DIR` 后调 `persistLargeOutput` 的探针测试，
 * 报告 `1 pass 0 fail`，同时把文件写进了真实家目录。
 * 所以唯一有效的判据是**观察副作用**，不是观察断言结果。
 *
 * ## 手法：重定向 HOME 跑子进程，再看那个假家目录
 *
 * `os.homedir()` 读 `$HOME`（本机实测：`HOME=/tmp/x bun -e '...homedir()'` → `/tmp/x`），
 * 而 `getSidHome()` 在未设 `SID_CONFIG_DIR` 时回落 `join(homedir(), ".sid-code")`
 * （`config/paths.ts:27`）。于是把 `HOME` 指向临时目录跑子进程：
 *   - 隔离正常 → 落盘进 preload 给的 tmpdir，假家目录里**不出现** trajectories/
 *   - 隔离被绕过 → 文件出现在假家目录，被本门禁抓到
 *
 * 用假 HOME 而不是直接数真实家目录的前后差值，有两个决定性好处：
 *   1. **不碰用户真实数据**，门禁自身不会造成任何污染；
 *   2. **不受并行干扰** —— 数真实目录的话，另一个终端里正在跑的会话新建一个目录，
 *      就会让本门禁假红（这个仓库里多任务并行是常态）。
 *
 * ## 扫描范围为什么不是全量 bun test
 *
 * 全量跑一遍要 190s，翻倍进 CI 不划算。这里只跑**真的会写 trajectories/ 的两个目录**
 * （context/ 与 trace/，实测 584 个测试 2s）。范围收窄的代价是诚实写在下面的
 * SCOPE 常量注释里：新增别的目录下的间接落盘，本门禁抓不到。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * 受检目录。
 *
 * 只列**已知会写 `sidPaths.trajectories()`** 的测试目录：
 *  - `context/`：`persistLargeOutput` 的直接与间接（`Manager.addMessage`）调用方
 *  - `trace/`  ：`TrajectoryCollector` 全家
 *
 * ⚠ 这是刻意的范围限制，不是遗漏：全量 `bun test` 要 190s，进 CI 翻倍不划算。
 * 代价是**别的目录下新增的间接落盘本门禁抓不到** —— 真出现了就把目录加进这个数组，
 * 别把它改成扫全仓（那等于让每个 PR 多等 3 分钟）。
 */
const SCOPE = ["packages/core/tests/context/", "packages/core/tests/trace/"] as const;

/** 在指定 HOME 下跑一批测试，返回那个假家目录里出现的 `.sid-code/` 子路径。 */
async function runWithFakeHome(
  targets: string[],
): Promise<{ leaked: string[]; exitCode: number; fakeHome: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "sid-runtime-gate-home-"));
  const proc = Bun.spawn(["bun", "test", ...targets], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: fakeHome,
      // 子进程不继承本进程的 env 改动，且这里刻意**不设** SID_CONFIG_DIR ——
      // 就是要让被测测试自己的隔离（或 preload 兜底）来决定落盘去哪。
      // 设了反而会把要检验的东西直接替被测方做掉。
      SID_CONFIG_DIR: undefined as unknown as string,
    },
  });
  const exitCode = await proc.exited;

  const sidDir = join(fakeHome, ".sid-code");
  const leaked: string[] = [];
  if (existsSync(sidDir)) {
    for (const entry of readdirSync(sidDir)) leaked.push(entry);
  }
  return { leaked, exitCode, fakeHome };
}

describe("运行时落盘门禁：受检测试不得写真实家目录的 trajectories/", () => {
  test("受检目录跑完，假家目录里不出现 trajectories/", async () => {
    const { leaked, exitCode, fakeHome } = await runWithFakeHome([...SCOPE]);
    try {
      // 先确认被测测试真的跑起来了。子进程若因为路径写错、bun 参数变化而一个测试都没跑，
      // 假家目录自然干干净净 —— 门禁会静默变成永远通过，正是它要防的那种假绿。
      expect(
        exitCode,
        `受检测试子进程退出码 ${exitCode}（非 0）。先修那边的失败，否则本门禁的结论不可信。`,
      ).toBe(0);

      expect(
        leaked.includes("trajectories"),
        `受检测试往真实家目录写了 trajectories/。\n` +
          `（本次用假 HOME=${fakeHome} 拦下了，真实运行时写的就是用户的 ~/.sid-code/）\n\n` +
          `假家目录 .sid-code/ 下实际出现：${leaked.join(", ") || "(空)"}\n\n` +
          `成因通常是**间接**落盘：测试只调 Manager.addMessage 之类的上层 API，\n` +
          `内部对超过 30000 字符的 tool_result 调 persistLargeOutput 写盘 ——\n` +
          `测试源码里没有任何 .sid-code 字样，所以静态扫描抓不到，只有本门禁能抓。\n\n` +
          `修法：在该测试 beforeAll/beforeEach 里把 process.env.SID_CONFIG_DIR 指向\n` +
          `mkdtempSync 的临时目录，并在 afterAll **存/恢复原值**（不要无条件 delete——\n` +
          `bun test 同批多文件同进程，delete 会连 preload 的兜底一起抹掉）。\n` +
          `参考 packages/core/tests/context/tool-result-storage.test.ts。`,
      ).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 120_000);

  test("门禁自证：故意不隔离的测试必须被抓到（不会红的门禁等于没有门禁）", async () => {
    // 造一个只调 persistLargeOutput、且抹掉隔离的探针测试，喂给同一套检测逻辑。
    // 若这条通不过，说明上面那条的"绿"毫无信息量。
    //
    // 探针必须落在**仓库内**（@sid-code/core 的模块解析依赖 workspace），
    // 且目录名不能以 `.` 开头 —— bun 的测试扫描会跳过点号目录（实测：
    // 放在 .pr7probe-xxx/ 下报 "filters did not match any test files"）。
    const probeDir = mkdtempSync(
      join(REPO_ROOT, "packages", "core", "tests", "runtime-gate-probe-"),
    );
    const probeFile = join(probeDir, "probe.test.ts");
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(
      probeFile,
      [
        `import { test, expect } from "bun:test";`,
        `import { persistLargeOutput } from "@sid-code/core/context/tool-result-storage.ts";`,
        `test("探针：抹掉隔离后落盘（本用例故意全绿而污染）", () => {`,
        `  delete process.env.SID_CONFIG_DIR;`,
        `  const r = persistLargeOutput("P".repeat(500), "probe1", "bash", "runtime-gate-probe", 100);`,
        `  expect(r.savedPath).not.toBe("");`,
        `});`,
      ].join("\n"),
    );

    try {
      const rel = probeFile.replace(REPO_ROOT + "/", "./");
      const { leaked, exitCode, fakeHome } = await runWithFakeHome([rel]);
      try {
        // 探针自己是**全绿**的（0 fail）—— 这正是要点：断言全过、数据照样进家目录。
        expect(exitCode, "探针本应通过（它的断言只检查落盘成功）").toBe(0);
        expect(
          leaked.includes("trajectories"),
          `门禁失效：探针明明抹掉了隔离并落盘，检测逻辑却没抓到。\n` +
            `假家目录 .sid-code/ 下：${leaked.join(", ") || "(空)"}\n` +
            `可能原因：HOME 重定向失效、或 getSidHome() 不再回落 homedir()。`,
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }, 120_000);
});
