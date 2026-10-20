/**
 * 门禁 · goal_state 清除哨兵只读兼容（与 clear-rotates-session-wiring.test.ts 同一种静态门禁）
 *
 * 背景：1121f4a6（v0.1.609）把 /clear 改成「结束旧会话 + 开新会话」，删掉了写哨兵的调用，
 * 但常量、写分支、读侧比较和两处「/clear 会落哨兵」的注释都留了下来，形成死代码，
 * 官网文档也跟着写了一个不存在的保证。
 *
 * 这里锁三件事：
 *   1. 写侧不复活：App 里不再有任何地方把哨兵写进 goal_state；
 *      persistGoalState 不再带 clearMarker 参数。
 *   2. 读侧兼容不丢：restoreSession 仍会跳过旧版文件里的哨兵值，
 *      不把它当成 JSON 解析（解析失败会打一条误导性的「恢复失败」warn）。
 *   3. /clear 不调 persistGoalState：clearConversation 先 finalizeSessionStore() 关掉旧文件，
 *      之后写入什么也落不进去；真要接线，必须放到 finalize 之前（见 app.ts 注释）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "app.ts"), "utf-8");

function body(marker: string, len: number): string {
  const i = appSrc.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  return appSrc.slice(i, i + len);
}

describe("goal_state 清除哨兵：只读兼容", () => {
  test("写侧：没有任何 appendMetadata 写入哨兵，persistGoalState 无参", () => {
    expect(appSrc).not.toMatch(
      /appendMetadata\(\s*"goal_state"\s*,\s*LEGACY_GOAL_STATE_CLEARED_MARKER/,
    );
    expect(appSrc).not.toMatch(/appendMetadata\(\s*"goal_state"\s*,\s*"__CLEARED__"/);
    expect(appSrc).toContain("private persistGoalState(): void {");
    expect(appSrc).not.toMatch(/persistGoalState\(\s*(true|false)\s*\)/);
    // 字面量只允许出现在唯一的常量定义处
    expect(appSrc.split('"__CLEARED__"').length - 1).toBe(1);
    expect(appSrc).toContain('const LEGACY_GOAL_STATE_CLEARED_MARKER = "__CLEARED__";');
  });

  test("读侧：restoreSession 在反序列化之前跳过旧版哨兵", () => {
    const b = body("// /goal：从 JSONL metadata 恢复目标状态", 1_200);
    const guard = b.indexOf(
      'sessionData.metadata["goal_state"] !== LEGACY_GOAL_STATE_CLEARED_MARKER',
    );
    const parse = b.indexOf("deserializeGoalState(");
    expect(guard).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(guard);
  });

  test("/clear 不调 persistGoalState（旧文件已在 finalizeSessionStore 时关闭）", () => {
    const start = appSrc.indexOf("private async clearConversation(");
    expect(start).toBeGreaterThan(-1);
    // 截到下一个方法定义为止
    const rest = appSrc.slice(start + 1);
    const next = rest.search(/\n  (private|public|protected|async) /);
    const clearBody = rest.slice(0, next > 0 ? next : 12_000);
    expect(clearBody).toContain("this.goalState = null;");
    expect(clearBody).not.toContain("persistGoalState(");
  });
});
