/**
 * 能力缓存落盘守卫门禁（issue #65）。
 *
 * ## 被守的不变量与被测的判据
 *
 * 不变量只有一条，和当年那次事故一字不差：**测试进程不得写用户真实的
 * `~/.sid-code/model-capabilities.json`**（一次 `bun test` 曾把开发机上已采集的
 * 2919 条能力数据抹成测试残留的 1 条）。
 *
 * 但守它的**手段**换了，本文件测的是新手段。旧手段是进程级布尔 `persistDisabled`，
 * 由 `__resetCapabilityCacheForTest()` 单向置位、无复位路径。它防住了事故，代价是
 * 反过来的：`bun test` 同批多文件同进程，任何文件调过一次 reset，`persist()` 在此后
 * 整个套件里永久 no-op —— **写盘路径从来没有被执行过**，D7 丢更新 bug 因此潜伏至今。
 * PR #63 加 `__enablePersistForTest()` 绕过，又引入「复位靠 afterEach 自觉」
 * （漏写即泄漏，正是当年事故的形态）和「同一开关两种相反语义」两个新问题。
 *
 * 新手段是无状态的**路径判据**（`isPersistBlocked()`）：
 *   测试态（NODE_ENV==="test"）**且** 落盘目标解析下来正好是用户真实 `~/.sid-code`
 *   → 拒写；其余情况照写。
 *
 * ## 为什么必须起子进程，不能在本进程里断言
 *
 * `homedir()` 在进程内**不随 `process.env.HOME` 改变** —— 实测：进程内改 HOME 后
 * `homedir()` 仍返回原值，只有以新 HOME **启动**的进程才会变
 * （`HOME=/tmp/x bun -e 'homedir()'` → `/tmp/x`）。所以「目标等于真实家目录」这一支
 * 在本进程内根本构造不出来，除非真去写用户的家目录 —— 那正是要防的事。
 * 手法与 `tests/build/no-real-trajectory-writes-runtime.test.ts` 同源：
 * 用假 HOME 起子进程，然后**看那个假家目录有没有被写**。
 *
 * ## 判据为什么是「看副作用」而不是「看测试是否全绿」
 *
 * `CLAUDE.md` 记着这条实测教训：**污染时测试同样全绿**。所以每个场景都直接检查
 * 假家目录里有没有出现 `model-capabilities.json`，而不是看探针的断言结果。
 *
 * ## 四个场景撑起「变异自证」
 *
 * 场景 1/2 是正向（该拦的拦住、该放的放行），3/4 各自去掉判据的一半，证明**两个条件
 * 都是承重的**：
 *   1. 测试态 + 未重定向        → 拒写（不变量本身）
 *   2. 测试态 + 已重定向 tmpdir → 照写（写盘路径可测，不需要任何后门）
 *   3. 测试态 + 显式把 SID_CONFIG_DIR 指向真实 `~/.sid-code` → 仍拒写
 *      （判据是**解析后相等**，不是"设了就允许"；这条正是 issue #65 里点名要防的误写法）
 *   4. **NODE_ENV=production** + 未重定向 → 照写
 *      同时证明两件事：① 生产路径不被守卫挡住（守卫在生产二进制里由
 *      `--define process.env.NODE_ENV='"production"'` 编译期折成 false）；
 *      ② 本门禁的检测逻辑真的能抓到"写进了假家目录"这个副作用 —— 场景 1 的绿
 *      因此不是恒真的。
 *
 * 场景 5 是回归面：拿**真实的那 10 个能力测试文件**在假 HOME 下跑一遍，
 * 断言假家目录里不出现缓存文件。它覆盖的是"未来某个用例忘了隔离"这种漂移，
 * 而不只是本文件手写的探针。
 */

import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CACHE_FILE = "model-capabilities.json";

/**
 * 在指定假 HOME 下跑一批测试文件，返回假家目录里是否出现了能力缓存文件。
 *
 * `sidConfigDir` 三态，对应三种要区分的情形：
 *   - `undefined`：不设 `SID_CONFIG_DIR`（探针自己还会 delete 一次，见下），
 *     于是 `getSidHome()` 回落 `<假 HOME>/.sid-code` —— 即"目标就是真实家目录"这一支。
 *   - 具体路径：重定向到别处（合法沙箱）。
 *   - `"REAL_HOME"`：显式指向 `<假 HOME>/.sid-code`，用来验证判据不是"设了就允许"。
 */
async function runProbe(opts: {
  probeSource: string;
  nodeEnv?: string;
  sidConfigDir?: string | "REAL_HOME";
}): Promise<{ wroteToFakeHome: boolean; exitCode: number; stderr: string; fakeHome: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "sid-persist-guard-home-"));
  // 探针必须落在**仓库内**：`@sid-code/core/...` 的模块解析依赖 workspace。
  // 目录名不能以 `.` 开头 —— bun 的测试扫描会跳过点号目录（实测报
  // "filters did not match any test files"，于是门禁静默变成永远通过）。
  const probeDir = mkdtempSync(
    join(REPO_ROOT, "packages", "core", "tests", "persist-guard-probe-"),
  );
  const probeFile = join(probeDir, "probe.test.ts");
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(probeFile, opts.probeSource);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = fakeHome;
  // 本进程自己的 SID_CONFIG_DIR（preload 兜底给的 tmpdir）绝不能漏给子进程 ——
  // 漏了就等于替被测方把隔离做掉了，场景 1 会变成永远通过。
  delete env.SID_CONFIG_DIR;
  if (opts.sidConfigDir === "REAL_HOME") env.SID_CONFIG_DIR = join(fakeHome, ".sid-code");
  else if (opts.sidConfigDir !== undefined) env.SID_CONFIG_DIR = opts.sidConfigDir;
  // `bun test` 默认把 NODE_ENV 设成 "test"，但**尊重外部预设**（实测 NODE_ENV=production
  // 传进去就是 production）—— 场景 4 靠的正是这一点。
  if (opts.nodeEnv !== undefined) env.NODE_ENV = opts.nodeEnv;

  try {
    const proc = Bun.spawn(["bun", "test", probeFile.replace(REPO_ROOT + "/", "./")], {
      cwd: REPO_ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return {
      wroteToFakeHome: existsSync(join(fakeHome, ".sid-code", CACHE_FILE)),
      exitCode,
      stderr,
      fakeHome,
    };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

/**
 * 探针源码：清掉隔离（模拟"忘了重定向"的测试）→ 塞一条内存态 → 触发一次落盘。
 *
 * `deleteIsolation` 为 false 时保留传进来的 `SID_CONFIG_DIR`（场景 2/3 要用它）。
 * 探针自己**不断言落盘位置**：位置由外层看假家目录判定，这样"探针全绿而污染"这种
 * 形态才能被抓到，而不是被探针自己的断言掩盖。
 */
function probeSource(deleteIsolation: boolean): string {
  return [
    `import { test, expect } from "bun:test";`,
    `import {`,
    `  __resetCapabilityCacheForTest,`,
    `  __persistForTest,`,
    `  __isPersistBlockedForTest,`,
    `} from "@sid-code/core/llm/model-capabilities.ts";`,
    `test("探针：触发一次 persist()", () => {`,
    deleteIsolation ? `  delete process.env.SID_CONFIG_DIR;` : ``,
    `  __resetCapabilityCacheForTest({ "guard-probe-model": { contextWindow: 12_345 } });`,
    `  __persistForTest();`,
    `  // 只打印判据，不据此断言 —— 落盘位置由外层观察副作用来判。`,
    `  console.error("BLOCKED=" + __isPersistBlockedForTest());`,
    `  expect(true).toBe(true);`,
    `});`,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("落盘守卫：测试态 + 目标是用户真实 ~/.sid-code → 拒写", () => {
  test("场景 1：测试态且未重定向 → 一个字节都不写进真实家目录", async () => {
    const r = await runProbe({ probeSource: probeSource(true) });
    expect(r.exitCode, `探针本应通过（它只断言 true）。stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("BLOCKED=true");
    expect(
      r.wroteToFakeHome,
      `守卫失效：探针抹掉隔离后 persist() 写进了真实家目录路径。\n` +
        `（本次用假 HOME=${r.fakeHome} 拦下了，真实运行时写的就是用户的 ~/.sid-code/${CACHE_FILE}）`,
    ).toBe(false);
  }, 120_000);

  test("场景 2：测试态但已重定向到 tmpdir → 照常落盘（写盘路径不再需要后门）", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "sid-persist-guard-sandbox-"));
    try {
      const r = await runProbe({ probeSource: probeSource(false), sidConfigDir: sandbox });
      expect(r.exitCode, `探针本应通过。stderr:\n${r.stderr}`).toBe(0);
      // 判据没把合法写盘也拦掉 —— 这正是本次改动的目的（原先它被永久拦着）。
      expect(r.stderr).toContain("BLOCKED=false");
      expect(existsSync(join(sandbox, CACHE_FILE)), "重定向后应正常落盘").toBe(true);
      expect(r.wroteToFakeHome, "落盘应进沙箱，不该同时碰真实家目录").toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 120_000);

  test("场景 3：SID_CONFIG_DIR 显式指向真实 ~/.sid-code → 仍拒写（判据是相等，不是'设了就允许'）", async () => {
    // issue #65 里点名的误写法就是"设了 SID_CONFIG_DIR 就允许写"。那样写的话，
    // 一个 `SID_CONFIG_DIR=$HOME/.sid-code` 的测试会被判成"已隔离"，照样抹掉用户数据。
    const r = await runProbe({ probeSource: probeSource(false), sidConfigDir: "REAL_HOME" });
    expect(r.exitCode, `探针本应通过。stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("BLOCKED=true");
    expect(
      r.wroteToFakeHome,
      `守卫被"设了 SID_CONFIG_DIR 就允许"这种写法绕过了：指向真实家目录时必须仍然拒写。`,
    ).toBe(false);
  }, 120_000);

  test("场景 4（变异自证）：NODE_ENV=production + 未重定向 → 照写，且本门禁抓得到", async () => {
    // 这一条同时是**门禁自证**：它证明"检测假家目录里有没有 model-capabilities.json"
    // 这套逻辑真的能观察到污染。少了它，场景 1 的绿可能只是因为检测本身失效
    // （HOME 重定向没生效、getSidHome() 不再回落 homedir()、文件名写错…）。
    const r = await runProbe({ probeSource: probeSource(true), nodeEnv: "production" });
    expect(r.exitCode, `探针本应通过。stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("BLOCKED=false");
    expect(
      r.wroteToFakeHome,
      `门禁失效：NODE_ENV=production 时守卫不该拦，落盘应当发生在 <HOME>/.sid-code/${CACHE_FILE}，\n` +
        `但检测逻辑没看到它。可能原因：HOME 重定向失效、getSidHome() 不再回落 homedir()、\n` +
        `或 bun test 开始无条件覆盖 NODE_ENV（那样场景 4 就失去意义，需换一种构造方式）。`,
    ).toBe(true);
  }, 120_000);
});

describe("回归面：真实的能力测试文件在假 HOME 下跑完，不碰真实缓存文件", () => {
  /**
   * 受检文件**动态发现**：`packages/core/tests/` 下所有 import 了 `model-capabilities.ts`
   * 的测试文件（本文件自己排除 —— 它会起子进程，列进去就是无限递归）。
   *
   * 刻意不写死清单：写死的话，新增一个能力测试文件而忘了登记，本门禁就不覆盖它，
   * 而且**没有任何东西会红**（这正是 `no-real-path-writes.test.ts` 里那条
   * 「白名单是穷举式防线，每漏一个就多一个缺口」的教训）。动态发现让"新增即覆盖"成为默认。
   *
   * 范围仍是收窄的、且这个收窄是刻意的：不扫整个 `llm/`（实测 37s，翻进门禁不划算），
   * 只扫真的碰这个模块的文件（实测 11 个文件 0.4s）。
   */
  function discoverCapabilityTests(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".test.ts")) continue;
        if (full === import.meta.path) continue; // 排除自己，否则无限递归
        if (readFileSync(full, "utf8").includes("llm/model-capabilities.ts")) {
          found.push("./" + full.replace(REPO_ROOT + "/", ""));
        }
      }
    };
    walk(join(REPO_ROOT, "packages", "core", "tests"));
    return found.sort();
  }

  test("受检能力测试跑完，假家目录里不出现 model-capabilities.json", async () => {
    const CAPABILITY_TESTS = discoverCapabilityTests();
    // 发现面非空自证：正则/目录结构漂移导致一个都没匹配上时，子进程什么都不跑、
    // 假家目录干干净净，门禁会静默变成永远通过。下限**刻意低于实测值**（实测 10）：
    // 写成精确相等会让"新增一个已正确隔离的测试"也把门禁弄红，逼人来改数字，
    // 最后被人干脆删掉这条断言。
    expect(CAPABILITY_TESTS.length).toBeGreaterThanOrEqual(6);

    const fakeHome = mkdtempSync(join(tmpdir(), "sid-persist-guard-suite-"));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      env.HOME = fakeHome;
      // 刻意**不设** SID_CONFIG_DIR：就是要让被测测试自己的隔离（或 preload 兜底）
      // 来决定落盘去哪。设了反而会替被测方把要检验的事做掉。
      delete env.SID_CONFIG_DIR;

      const proc = Bun.spawn(["bun", "test", ...CAPABILITY_TESTS], {
        cwd: REPO_ROOT,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      // 先确认被测测试真的跑起来了。子进程若一个测试都没跑（路径写错、bun 参数变化），
      // 假家目录自然干干净净 —— 门禁会静默变成永远通过，正是它要防的假绿。
      expect(
        exitCode,
        `受检能力测试子进程退出码 ${exitCode}（非 0）。先修那边的失败，否则本门禁的结论不可信。\n${stderr.slice(-2000)}`,
      ).toBe(0);
      expect(stderr).toMatch(/\d+ pass/);

      expect(
        existsSync(join(fakeHome, ".sid-code", CACHE_FILE)),
        `受检能力测试往真实家目录写了 ${CACHE_FILE}。\n` +
          `（本次用假 HOME=${fakeHome} 拦下了，真实运行时写的就是用户已采集的能力数据 ——\n` +
          `当年这条路径把 2919 条抹成了 1 条。）\n\n` +
          `修法：在该测试 beforeEach 里把 process.env.SID_CONFIG_DIR 指向 mkdtempSync 的\n` +
          `临时目录，afterEach **存/恢复原值**（不要无条件 delete —— bun test 同进程跑多文件，\n` +
          `delete 会连 preload 的兜底一起抹掉）。\n` +
          `参考 packages/core/tests/llm/model-capabilities-concurrent-write.test.ts。`,
      ).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 120_000);
});
