/**
 * 门禁 · app.ts 两处 CommandContext 的 sessionId 必须是**逻辑会话 id**
 *
 * 缺陷形态与 `checkpoint-session-id-wiring.test.ts`（D5/D6）完全同源：上下游全对，
 * 断在中间那一行接线上。两处 cmdCtx 构造原先都写 `sessionId: ""`，于是
 *   - `/trace` `/perf` `/insights` 定位不到当前会话（回退 latest 或「未找到会话」）；
 *   - `/export` `/bug` `/status` `/fork` 直接把会话 id 丢了（`?? "-"` 挡不住空串）。
 *
 * ## 为什么是「逻辑 id」而不是「进程 id」（这条判据与一份文档相反，别改回去）
 *
 * 交付时核对过源码：轨迹目录名**不是**进程 id。证据链：
 *   1. `collector.ts` 的 SessionStart：`traceSessionId = isResume ? input.resumed_from!
 *      : input.session_id`；
 *   2. `writer.ts`：`sessionDir = join(baseDir, "sessions", sessionId)`；
 *   3. `listSessions()` 返回的 `id` 就是目录名，`/trace` `/perf` `/insights` 拿
 *      `ctx.sessionId` 去和它比对。
 *
 * 而 `getLogicalSessionId() = resumedSessionId ?? sessionState.sessionId`，与 (1)
 * 的取值域逐项相等：非 resume 时 = 进程 id，resume 时 = 被恢复会话 id。所以
 * **cmdCtx 传逻辑 id，四个按目录名定位的命令（trace/perf/insights/compact）不用动**；
 * 反过来若按「该用进程 id」的表把四处改成 `ctx.sessionState.sessionId`，`-c` 场景下
 * `/trace` 会拿进程新 id 去比对一个名为旧 id 的目录，永远匹配不上。
 *
 * 因此本文件同时锁两个方向：
 *   - 正向：两处 cmdCtx 用 `this.getLogicalSessionId()`；
 *   - 反向：两处 cmdCtx 不得写空串、不得写 `this.sessionState.sessionId`；
 *     四个命令不得改读 `ctx.sessionState.sessionId`。
 *
 * ⚠️ 用 readFileSync 而非 shell grep：app.ts 曾含 NUL 字节，grep 会判成 binary 并
 * **静默跳过**（见 checkpoint-session-id-wiring.test.ts 的同款注释）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliSrc = join(import.meta.dir, "..", "..", "src");
const appSrc = readFileSync(join(cliSrc, "app.ts"), "utf-8");

/** 切出 app.ts 里全部 cmdCtx 字面量块（两处：无头 resolveHeadlessSlash / TUI onSlashCommand）。 */
function cmdCtxBlocks(src: string): string[] {
  const re =
    /const cmdCtx: import\("\.\/command\/types\.ts"\)\.CommandContext = \{[\s\S]*?\n\s*\};/g;
  return [...src.matchAll(re)].map((m) => m[0]);
}

const blocks = cmdCtxBlocks(appSrc);

describe("门禁 · app.ts 扫描面", () => {
  test("扫描面非空（防止路径漂移让门禁退化成绿灯）", () => {
    expect(appSrc.length).toBeGreaterThan(100_000);
  });

  test("恰好两处 cmdCtx（无头 / TUI）；新增构造点必须一并纳入本门禁", () => {
    // 若将来多出第三处，这里会红并提醒作者确认它的口径——而不是让它静默绕过。
    expect(blocks).toHaveLength(2);
  });
});

describe("cmdCtx.sessionId 必须是逻辑会话 id", () => {
  test("两处都注入 this.getLogicalSessionId()", () => {
    for (const block of blocks) {
      expect(block).toContain("sessionId: this.getLogicalSessionId(),");
    }
  });

  test("两处都不再是空串（缺陷本体）", () => {
    for (const block of blocks) {
      expect(block).not.toContain('sessionId: ""');
    }
    // 全文件一起锁：空串形态只可能出现在 cmdCtx 构造里，别处不该有。
    expect(appSrc).not.toContain('sessionId: ""');
  });

  test("两处都不是进程 id（照「该用进程 id」的表改会引入 resume 选错会话）", () => {
    for (const block of blocks) {
      expect(block).not.toContain("sessionId: this.sessionState.sessionId");
    }
  });
});

describe("论证链 · 逻辑 id 与轨迹目录同口径", () => {
  test("getLogicalSessionId 仍是 resumedSessionId ?? sessionState.sessionId", () => {
    const at = appSrc.indexOf("private getLogicalSessionId(): string {");
    expect(at).toBeGreaterThan(-1);
    const body = appSrc.slice(at, at + 200);
    expect(body).toContain("this.resumedSessionId ?? this.sessionState.sessionId");
  });

  test("collector 的 traceSessionId 仍是 resumed_from ?? input.session_id（目录名口径的源头）", () => {
    // 跨包读源码断言在本仓有先例（见 packages/core/tests/llm/quota-effective-limit.test.ts）。
    // 锁的是「目录名 = 逻辑 id」这条论证链的上游：它一变，本门禁的正向断言就不再成立。
    const collector = readFileSync(
      join(cliSrc, "..", "..", "core", "src", "trace", "collector.ts"),
      "utf-8",
    );
    expect(collector).toContain(
      "const traceSessionId = isResume ? input.resumed_from! : input.session_id;",
    );
  });

  test("writer 仍用传入的 id 作 sessions/<id> 目录名", () => {
    const writer = readFileSync(
      join(cliSrc, "..", "..", "core", "src", "trace", "writer.ts"),
      "utf-8",
    );
    expect(writer).toContain('this.sessionDir = join(baseDir, "sessions", sessionId);');
  });
});

describe("反向门禁 · 四个按轨迹目录定位的命令仍读 ctx.sessionId", () => {
  // 若有人按那份「trace/perf/insights/compact 该用进程 id」的表去改命令，
  // 会把 app 层刚修好的接线重新拆掉——这条断言就是拦这个。
  const commands = ["trace/trace.ts", "perf/perf.ts", "insights/insights.ts", "compact/compact.ts"];

  for (const rel of commands) {
    test(`${rel} 读 ctx.sessionId，不读 ctx.sessionState.sessionId`, () => {
      const src = readFileSync(join(cliSrc, "command", "commands", rel), "utf-8");
      expect(src).toContain("ctx.sessionId");
      expect(src).not.toContain("ctx.sessionState.sessionId");
    });
  }
});
