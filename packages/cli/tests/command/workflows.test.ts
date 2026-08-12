/**
 * /workflows 命令测试（P1-3）
 *
 * 覆盖：空列表 / 列出 run / 详情命中 / 详情未命中 / taskId 兜底匹配。
 * 数据源为 task 注册表（getAllTasks + isWorkflowTask）。
 */
import { describe, test, expect, afterEach } from "bun:test";
import workflowsCmd from "@sid-code/cli/command/commands/workflows/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";
import { registerTask, clearAllTasks } from "@sid-code/core/task/registry.ts";
import type { LocalWorkflowTaskState } from "@sid-code/core/task/types.ts";

const loadCmd = () => (workflowsCmd as LocalCommand).load();
const EMPTY_CTX = {} as CommandContext;

/** 造一个 workflow task 注册进注册表。 */
function makeWfTask(over: Partial<LocalWorkflowTaskState> = {}): LocalWorkflowTaskState {
  const t: LocalWorkflowTaskState = {
    id: over.id ?? "local_workflow_t1",
    type: "local_workflow",
    status: over.status ?? "running",
    description: "test wf",
    startTime: Date.now() - 3000,
    outputFile: "/tmp/x",
    outputOffset: 0,
    notified: false,
    workflowName: over.workflowName ?? "demo-wf",
    runId: over.runId ?? "wf_test1",
    source: "inline",
    agentCount: over.agentCount ?? 2,
    currentPhase: over.currentPhase ?? "Find",
    isBackgrounded: true,
    progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] },
    ...over,
  };
  registerTask(t);
  return t;
}

describe("/workflows 命令", () => {
  afterEach(() => clearAllTasks());

  test("无 run 时给出空提示", async () => {
    const mod = await loadCmd();
    const r = await mod.call("", EMPTY_CTX);
    expect(r.type).toBe("text");
    expect((r as { value: string }).value).toContain("(无");
  });

  test("列出运行中的 run（含 name/phase/agent 计数）", async () => {
    makeWfTask({
      runId: "wf_aaa",
      workflowName: "review-changes",
      currentPhase: "Verify",
      agentCount: 5,
    });
    const mod = await loadCmd();
    const v = ((await mod.call("", EMPTY_CTX)) as { value: string }).value;
    expect(v).toContain("wf_aaa");
    expect(v).toContain("review-changes");
    expect(v).toContain("Verify");
    expect(v).toContain("5 agents");
  });

  test("详情命中 runId", async () => {
    makeWfTask({ runId: "wf_bbb", workflowName: "migrate", status: "completed" });
    const mod = await loadCmd();
    const v = ((await mod.call("wf_bbb", EMPTY_CTX)) as { value: string }).value;
    expect(v).toContain("migrate");
    expect(v).toContain("wf_bbb");
    expect(v).toContain("已完成");
  });

  test("详情兜底匹配 taskId", async () => {
    makeWfTask({ id: "local_workflow_xyz", runId: "wf_ccc" });
    const mod = await loadCmd();
    const v = ((await mod.call("local_workflow_xyz", EMPTY_CTX)) as { value: string }).value;
    expect(v).toContain("wf_ccc");
  });

  test("详情未命中给出提示", async () => {
    const mod = await loadCmd();
    const v = ((await mod.call("wf_notexist", EMPTY_CTX)) as { value: string }).value;
    expect(v).toContain("未找到");
  });
});
