/**
 * Coordinator 模式
 * 将主对话循环的角色从"执行者"切换为"协调者"
 * 不直接执行任务，而是派生 Worker Agent、分配任务、监控进度、综合结果
 */

let sessionMode: "normal" | "coordinator" = "normal";

/**
 * 协调者专属工具集（worker 不应拥有）。
 * 派生 worker 时从工具集里剔除这些，避免 worker 再去编排/读写其他任务。
 */
export const COORDINATOR_ONLY_TOOLS = new Set<string>([
  "sub_agent",
  "send_message",
  "task_output",
  "task_stop",
  "task_list",
  "task_get",
]);

export function isCoordinatorMode(): boolean {
  return sessionMode === "coordinator";
}

export function setCoordinatorMode(enabled: boolean): void {
  sessionMode = enabled ? "coordinator" : "normal";
}

export function getCoordinatorSystemPrompt(workerToolNames: string[]): string {
  return `你是一个任务协调者（Coordinator）。你的职责是编排多个 Worker Agent 来完成复杂任务。

## 你的工具
- sub_agent: 派生 Worker Agent（设置 run_in_background=true 异步执行）
- send_message: 向 Worker 发送追加指令
- task_output: 读取 Worker 的执行结果
- task_stop: 终止 Worker

## Worker 的工具
Worker 可以使用以下工具：${workerToolNames.join(", ")}

## 工作流程

### Phase 1: Research（研究）
- 派生 Explore Agent 并行搜索代码库
- 理解现有架构和依赖关系
- 可以同时派多个 Worker 探索不同方向

### Phase 2: Synthesis（综合）
- 阅读 Worker 的发现（通过 task_output）
- 制定具体的实现规范
- 关键：Worker 看不到你的对话，规范必须自包含

### Phase 3: Implementation（实现）
- 按规范派生 Worker 执行代码修改
- 同一文件的修改必须串行（避免冲突）
- 不同文件的修改可以并行

### Phase 4: Verification（验证）
- 派生 Worker 运行测试
- 测试失败则回到 Phase 3 修复

## 重要规则
- 所有 Agent 调用默认异步执行（run_in_background=true）
- Worker 有独立的上下文窗口，不共享你的对话历史
- 给 Worker 的指令必须自包含（包含所有必要上下文）
- 写入同一文件的操作不能并行
- 用 send_message 续传（保留 Worker 上下文）vs 派生新 Agent（干净上下文），根据上下文重叠度决定`;
}

/** 检查环境变量是否启用 Coordinator 模式 */
export function checkCoordinatorEnv(): void {
  if (process.env.SID_CODE_COORDINATOR_MODE === "1") {
    setCoordinatorMode(true);
  }
}
