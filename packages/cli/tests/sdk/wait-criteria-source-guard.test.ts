/**
 * D11 守卫：无头等待判据不得退回「只看后台线程状态」的旧口径。
 *
 * ## 守的是什么
 *
 * 事故形态（#674）：stream-json 无头会话里模型起了一个 `wait_until` 后台 shell 等 CI，
 * 命令静默超过 60 秒（等 CI 时是常态）。`cli/src/app.ts` 当时注入的是
 * `hasAwaitedBackgroundTasks()`——它对 shell 要求 `shellSilentForMs < SHELL_QUIESCENT_MS`，
 * 于是 stdin 关闭后进程判「没有值得等的后台任务」，直接收尾退出，后台 shell 随进程被带走。
 * 修法是把注入点换成 `hasPromisedWait()`：它是旧判据的**超集**（派生分支逐字复用
 * `isAwaitedBackgroundTask`），额外认出显式声明了 deadline 承诺的等待源
 * （`wait_until` / `monitor` / 已排的 `schedule_wakeup`）。
 *
 * ## 为什么是源码文本断言而不是行为断言
 *
 * 判据注入点埋在 `App.buildSDKDriver` 里，起一个真实 App 的成本远高于它守住的东西；
 * 而回归方式是「有人又把那一行换回去」，这种回归在源码里一眼可见。
 * 行为侧（循环到底退不退）由 `packages/core/tests/sdk/stream-json-wait-promise.test.ts`
 * 从真实入口验证，两条各守一半。
 *
 * ## 白名单
 *
 * `packages/core/src/query/loop.ts` 的 `runningBg = hasAwaitedBackgroundTasks()` 是
 * **事实字段**（`EndTurnShape.runningBackgroundTasks`，与 `promised_waits` 并列落轨迹），
 * 不是等待判据——保留它才能让「为什么没拦」可复算。本文件反过来断言它仍在。
 *
 * ⚠️ 跨域盲区：本文件读 `packages/cli/src` 与 `packages/core/src/sdk`，`affected-tests`
 * 按目录映射选不到它（改 `cli/src/app.ts` 时整包跑 cli 能选中；改 `core/src/sdk` 选不到）。
 * 动这两处时手动跑本文件。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CLI_SRC = join(import.meta.dir, "..", "..", "src");
const CORE_SRC = join(import.meta.dir, "..", "..", "..", "core", "src");
const CORE_SDK = join(CORE_SRC, "sdk");

/** 旧判据的标识符（本文件自身不算调用点，故不参与扫描） */
const LEGACY = "hasAwaitedBackgroundTasks";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * 去掉注释再断言：注释里提到旧函数名是**合法**的——它记录的正是这段历史。
 * `[^:"]` 前缀避免把 `http://` 与字符串里的 `//` 当成注释开头。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'])\/\/.*$/, "$1"))
    .join("\n");
}

describe("D11 守卫：旧等待判据不得回到无头路径", () => {
  test("packages/cli/src 与 packages/core/src/sdk 下没有旧判据的调用", () => {
    const offenders: string[] = [];
    for (const file of [...listTsFiles(CLI_SRC), ...listTsFiles(CORE_SDK)]) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (code.includes(LEGACY)) offenders.push(relative(process.cwd(), file));
    }
    // 有人把 app.ts 的注入点换回旧判据、或在 sdk 下新读写旧判据时，这里直接列出文件
    expect(offenders).toEqual([]);
  });

  test("app.ts 的无头驱动注入的是 hasPromisedWait", () => {
    const appCode = stripComments(readFileSync(join(CLI_SRC, "app.ts"), "utf8"));
    expect(appCode).toContain("hasRunningBackgroundTasks: () => hasPromisedWait()");
  });

  test("白名单条目仍真实存在：loop.ts 的 EndTurnShape 事实字段", () => {
    // 这条不是「允许例外」而是「例外仍是事实字段」：若有人连事实字段一起删了，
    // 轨迹就再也答不出「当时有没有后台任务」，本守卫要把它拦下来。
    const loopCode = stripComments(readFileSync(join(CORE_SRC, "query", "loop.ts"), "utf8"));
    expect(loopCode).toContain("runningBg = hasAwaitedBackgroundTasks()");
  });
});
