/**
 * 构建期 NODE_ENV=production 防漂移哨兵
 *
 * 背景（2026-08-04 实证根因）：`bun build --compile` **不会**自动设置 NODE_ENV，
 * 编译产物运行时 `process.env.NODE_ENV` 恒为 Bun 的默认值 `"development"`。
 * 而 `react-reconciler/index.js` 是按**运行时** NODE_ENV 分支加载 build 的：
 *
 *   NODE_ENV === 'production' ? react-reconciler.production.js
 *                             : react-reconciler.development.js
 *
 * 于是发布出去的二进制一直跑的是 React **development build**，其中
 * `getRootForUpdatedFiber()` 有一句：
 *
 *   console.error("Maximum update depth exceeded. This can happen when a component
 *                  calls setState inside useEffect, but useEffect either doesn't
 *                  have a dependency array, or one of the dependencies changes
 *                  on every render.")
 *
 * 嵌套 passive update 超 NESTED_PASSIVE_UPDATE_LIMIT(=50) 就打一次。关键是它是
 * **console.error 而非 throw**，所以：React 错误边界抓不到、进程不崩、agent 主循环
 * 照常跑完、debug.log 里也没有任何记录——只有用户终端被反复刷屏。这正是同事机器上
 * 报的现象（低配慢机器一帧渲染耗时长，更容易把嵌套 update 堆到 50）。
 *
 * **该文案只存在于 development build**（production build 里 grep 命中 0 次），
 * 这是定性根因的决定性证据，也是本测试第 1 项断言的依据。
 *
 * 连带影响：`src/ink/reconciler.ts` 的 `NODE_ENV === 'development'` 分支会去
 * import react-devtools-core，其注释原文写着「DCE'd in production」——本就假设
 * 构建期会 define NODE_ENV，此前一直没接上。
 *
 * 为什么要立哨兵：修复只是在两个构建命令里各加一个 flag，**新增构建入口时极易漏带**，
 * 漏了就静默退回 development build（构建成功、单测全绿、只有用户终端刷屏）。
 * 这类"沉默的回归"必须靠门禁挡，不能靠人记。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** 期望出现在每个 --compile 构建命令里的 define(容忍引号/空格差异，按语义匹配)。 */
const DEFINE_PATTERN = /--define\s+process\.env\.NODE_ENV=['"]?["']production["']?/;

describe("构建期 NODE_ENV=production（React production build 门禁）", () => {
  test("react-reconciler 的报错文案只存在于 development build —— 根因判据本身仍成立", () => {
    const base = join(ROOT, "node_modules", "react-reconciler", "cjs");
    const devFile = join(base, "react-reconciler.development.js");
    const prodFile = join(base, "react-reconciler.production.js");

    // 依赖缺失时跳过而非误报（CI 精简安装等场景）
    if (!existsSync(devFile) || !existsSync(prodFile)) return;

    const needle = "Maximum update depth exceeded";
    expect(readFileSync(devFile, "utf8")).toContain(needle);
    // 核心断言：production build 里一次都不出现 → define 生效即彻底消除该刷屏
    expect(readFileSync(prodFile, "utf8")).not.toContain(needle);
  });

  test("react-reconciler 入口按运行时 NODE_ENV 分支（这是 define 能起作用的前提）", () => {
    const entry = join(ROOT, "node_modules", "react-reconciler", "index.js");
    if (!existsSync(entry)) return;
    const src = readFileSync(entry, "utf8");
    expect(src).toContain("process.env.NODE_ENV");
    expect(src).toContain("production");
  });

  test("Makefile 的 build 目标带 NODE_ENV=production define", () => {
    const mk = readFileSync(join(ROOT, "Makefile"), "utf8");

    // 取出所有非注释的 `bun build --compile` 行（含 $(BUILD_DEFINES) 变量引用形式）
    const compileLines = mk
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("build --compile"));

    expect(compileLines.length).toBeGreaterThan(0);

    // BUILD_DEFINES 变量本身必须定义为期望的 define
    const defineVar = mk.match(/^BUILD_DEFINES\s*=\s*(.+)$/m);
    expect(defineVar).not.toBeNull();
    expect(DEFINE_PATTERN.test(defineVar![1])).toBe(true);

    // 每条 --compile 行要么直接写 define，要么引用 $(BUILD_DEFINES)
    for (const line of compileLines) {
      const ok = DEFINE_PATTERN.test(line) || line.includes("$(BUILD_DEFINES)");
      expect(ok).toBe(true);
    }
  });

  test("release.sh 的 4 平台构建带 NODE_ENV=production define", () => {
    const sh = readFileSync(join(ROOT, "scripts", "release.sh"), "utf8");

    // release.sh 里构建命令跨多行(反斜杠续行)，按整体文本判定
    expect(sh).toContain("build --compile");
    expect(DEFINE_PATTERN.test(sh)).toBe(true);
  });

  test("被 define 改写的 NODE_ENV 消费点都已审计（新增消费点需在此登记）", () => {
    // --define 会把 src/ 下**所有** process.env.NODE_ENV 出现处按字面量改写，
    // 因此每个消费点的分支走向都会变。已审计结论：
    //   src/ink/reconciler.ts        === 'development'  true→false：不再 import devtools（注释本就说该 DCE）
    //   src/ink/reconciler.ts        === 'test'         不变（test 走 bun test，不经 --define）
    //   src/utils/process.ts         === 'test'         不变
    //   src/debug/logger.ts          !== 'test'         不变
    //   src/api/cache-strategy.ts    === 'production'   false→true：启用「生产打 error 不抛」容错分支（原本意图）
    // 新增消费点时本测试会失败，提示补审计而不是静默改变行为。
    const AUDITED = new Set([
      "src/ink/reconciler.ts",
      "src/utils/process.ts",
      "src/debug/logger.ts",
      "src/api/cache-strategy.ts",
    ]);

    const out = Bun.spawnSync({
      cmd: ["grep", "-rl", "process.env.NODE_ENV", "src/", "--include=*.ts", "--include=*.tsx"],
      cwd: ROOT,
    });
    const candidates = new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    // 只关心**真代码**里的消费点：--define 改写的是代码，注释里提到 NODE_ENV
    // （比如 console-guard.ts 的背景说明）不构成行为变化，不该逼人往审计表里
    // 塞一条假条目——那会把门禁稀释成噪音。这里逐行剔除注释后再判定。
    const isCommentLine = (line: string): boolean => {
      const t = line.trim();
      return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
    };
    const found = candidates.filter((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .some((line) => line.includes("process.env.NODE_ENV") && !isCommentLine(line)),
    );

    const unaudited = found.filter((f) => !AUDITED.has(f));
    expect(unaudited).toEqual([]);
  });
});
