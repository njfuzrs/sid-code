/**
 * D9 守卫：唤醒撤销提示必须走「常驻历史区」，不许退回瞬态状态条。
 *
 * ## 守的是什么
 *
 * 事故形态（#674）：撤销发生后 `queryLoop` 只 yield 一条普通 `{kind:"system", level:"info"}`，
 * `app.ts` 的 info 分支把它放进 `system:transient` 状态条，同一轮 `done` 就
 * `removeStatusMessage` 清掉。用户回神时既看不到撤销、也不知道自己在等的唤醒已经没了——
 * 正是 #642 否决自动撤销时担心的「轮询静默中断、用户以为还在等」。
 * 修法是两半：`loop.ts` yield 时带 `persistent: true`，`app.ts` 的 `event.persistent`
 * 分支走 `appendPersistentHint`（写历史区、不进 ctxMgr、`done` 不清）。
 *
 * ## 为什么是源码文本断言
 *
 * `appendPersistentHint` 是 `runTUI` 内的闭包，`bridge` 也是局部变量——现有结构里
 * 没有能从 App 实例驱动「喂一个 system 事件」的入口。起一个真实 `runTUI` 需要 TTY 与
 * ink 渲染，成本远高于它守住的东西；而回归形态是「有人把 persistent 删了 / 把分支
 * 挪回 transient」，在源码里一眼可见。
 *
 * 行为侧（循环到底 yield 出什么）由 `packages/core/tests/query/wait-notice-persistent.test.ts`
 * 从真实 `queryLoop` 入口验证；TUI 渲染实证（截图核对历史区那一行）按方案 §L5 归 E2E-7。
 *
 * ⚠️ 跨域盲区：本文件读 `packages/cli/src` 与 `packages/core/src`，`affected-tests`
 * 按目录映射选不到它。动这两处的等待提示渲染时手动跑本文件。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_APP = join(import.meta.dir, "..", "..", "src", "app.ts");
const CORE_LOOP = join(import.meta.dir, "..", "..", "..", "core", "src", "query", "loop.ts");

/**
 * 去掉注释再断言：注释里写 `persistent` 是**合法**的（它解释的就是这段历史），
 * 只有代码里的写法算数。`[^:"]` 前缀避免把 `http://` 与字符串里的 `//` 当注释开头。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'])\/\/.*$/, "$1"))
    .join("\n");
}

/** 取某个锚点之后的一段代码（断言「分支里调了谁」，不依赖整段精确排版） */
function after(src: string, anchor: string, length: number): string {
  const i = src.indexOf(anchor);
  expect(i).toBeGreaterThanOrEqual(0);
  return src.slice(i, i + length);
}

describe("D9 守卫：撤销提示常驻", () => {
  test("loop.ts：撤销提示 yield 带 persistent: true，文案由 formatWaitInvalidationNotice 生成", () => {
    const code = stripComments(readFileSync(CORE_LOOP, "utf8"));
    // 从 drainWaitNotices 的调用点往后看：必须同时出现 persistent 与统一格式化函数，
    // 且不能是「逐条 yield」（D9 要求同一轮多条合成一行）
    const block = after(code, "drainWaitNotices()", 500);
    expect(block).toContain("persistent: true");
    expect(block).toContain("formatWaitInvalidationNotice(waitNotices)");
  });

  test("app.ts：event.persistent 分支写历史区，非 persistent 的 info 才进瞬态状态条", () => {
    const code = stripComments(readFileSync(CLI_APP, "utf8"));
    const persistentBranch = after(code, "event.persistent", 500);
    expect(persistentBranch).toContain("appendPersistentHint(event.text)");
    // 反向：瞬态状态条那支必须还在，且是「没有 persistent 时」的兜底——
    // 没这条断言，把整个 info 分支改成常驻也能绿，那就不是 D9 的修法了。
    expect(code).toContain('addStatusMessage("system:transient", event.text)');
  });
});
