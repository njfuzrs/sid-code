/**
 * D5（T8，2026-11-15）：子代理里禁止后台 bash。
 *
 * 为什么禁：子代理没有查询/终止后台任务的权限（`task_output` / `task_stop` 在
 * `agent/tool-filter.ts` 的 ALL_AGENT_DISALLOWED_TOOLS 里硬禁）。它起的后台任务
 * 完成后通知投给一个早已收尾的回合——那次任务的输出没有任何消费者。
 *
 * 判据：子代理上下文（`getAgentRoot() !== undefined`）里传 `run_in_background=true`
 * 必须**在执行前**被拒，而不是先起任务再返回一个查不到的 task_id。
 * 主会话路径不受影响（那里的后台执行由既有 bash 后台测试覆盖，本文件不重复起任务）。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "../../src/tool/bash.ts";
import { withAgentCwd } from "../../src/bootstrap/cwd-context.ts";

describe("D5（T8）：子代理里禁止后台 bash", () => {
  test("子代理上下文：run_in_background=true 执行前被拒，带可行动的下一步", async () => {
    const root = mkdtempSync(join(tmpdir(), "sid-subagent-bg-"));
    const bash = new BashTool();
    const r = await withAgentCwd(root, () =>
      bash.execute({ command: "echo hi", run_in_background: true }),
    );
    expect(r.isError).toBe(true);
    expect(r.output).toContain("子代理里不支持后台执行");
    // 不是「权限拒绝」那种无信息文案：必须给出下一步怎么做
    expect(r.output).toContain("前台执行");
  });
});
