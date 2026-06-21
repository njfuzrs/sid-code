/**
 * Dynamic Workflows M6 — Workflow 工具(注册给模型)
 *
 * 模型调用此工具来跑一段确定性多 agent 编排脚本。职责:
 *  1. 接收 inline script / scriptPath / 已存 workflow name + args + resumeFromRunId;
 *  2. 解析校验 meta(sandbox.parseAndValidateMeta);
 *  3. 注册 local_workflow 后台 task(TUI 可见);
 *  4. 组装 WorkflowRuntime + SubAgentRunner + Journal,跑 sandbox;
 *  5. 把脚本持久化到 ~/.sid-code/workflows/scripts/(支持 resume 与分享);
 *  6. 完成/失败标记 task,结果经 notification 回注主循环。
 *
 * 设计选择:
 *  - 延迟工具(shouldDefer=true):与 team_create 一致,默认不进首轮上下文,由 tool_search 在
 *    用户提到 workflow/多 agent 编排时按需调出——这就是 sid-code 风格的 opt-in 门控,token 成本
 *    门禁通过 budget + 1000 上限 + 4096/call 三道闸守住。
 *  - 同步执行(await 到完成):对齐 team_create。task 注册让长跑期间 TUI 可见进度;runId 落盘
 *    支持后续 resume。
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sidHomePath } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "./registry.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SubAgentUsageSink } from "../agent/tool.ts";
import { runInSandbox, parseAndValidateMeta } from "../workflow/sandbox.ts";
import { WorkflowRuntime } from "../workflow/runtime.ts";
import { SubAgentRunner } from "../workflow/sub-agent-runner.ts";
import { Journal } from "../workflow/journal.ts";
import {
  createWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  appendWorkflowOutput,
  updateWorkflowProgress,
} from "../task/index.ts";

const workflowSchema = lazySchema(() =>
  z
    .object({
      script: z
        .string()
        .optional()
        .describe(
          "自包含的 workflow JS 脚本。必须以 `export const meta = { name, description, phases }` 开头(纯字面量),随后用 agent()/parallel()/pipeline()/phase()/log()/args/budget 编写。纯 JavaScript,不能含 TypeScript 类型标注。",
        ),
      scriptPath: z
        .string()
        .optional()
        .describe("磁盘上的 workflow 脚本路径。优先于 script。用于迭代:编辑该文件后用同一 scriptPath 重跑。"),
      name: z
        .string()
        .optional()
        .describe("已保存 workflow 的名字(从 ~/.sid-code/workflows/scripts/ 加载)。script/scriptPath 都没给时用它。"),
      args: z
        .unknown()
        .optional()
        .describe("传给脚本的 args(脚本里以全局 `args` 逐字可见)。传数组/对象用真正的 JSON 值,不要传 JSON 字符串。"),
      resumeFromRunId: z
        .string()
        .optional()
        .describe("从先前某次 run 的 journal 恢复:未改动的 agent() 调用直接返回缓存,只重跑改动及其之后的。"),
      budgetTotal: z
        .number()
        .optional()
        .describe("本次 run 的 token 目标(硬上限)。达上限后 agent() 抛错。省略=不限。"),
    })
    .describe("跑一段确定性多 agent 编排脚本(Dynamic Workflow)"),
);

/** workflow 脚本持久化目录 */
function workflowScriptsDir(): string {
  return sidHomePath("workflows", "scripts");
}

/** 生成 run id(wf_ + 12 位 hex) */
function newRunId(): string {
  return `wf_${randomBytes(6).toString("hex")}`;
}

/** journal 路径(按 runId) */
function journalPath(runId: string): string {
  return sidHomePath("workflows", "journals", `${runId}.jsonl`);
}

export class WorkflowTool implements Tool {
  readonly zodSchema = workflowSchema();
  /** 延迟工具:默认不进首轮上下文,由 tool_search 按需调出(opt-in 门控) */
  readonly shouldDefer = true;
  readonly searchHint =
    "workflow orchestrate multi-agent fan-out parallel pipeline 编排 工作流 多代理 并行 扇出 审计 迁移";

  constructor(
    private providerRegistry: ProviderRegistry,
    private toolRegistry: ToolRegistry,
    private hookSystem?: HookSystem,
  ) {}

  /** 子代理 usage 归集 sink(由主会话注入,与 SubAgentTool 同一接口)。
   *  workflow 内每个子 agent 跑完把完整 usage 按其实际 model/provider 回写主会话 SessionState,
   *  否则 workflow 烧的 token/费用完全不计入 /cost、costLimit 守卫对 workflow 失效。 */
  private usageSink?: SubAgentUsageSink;

  /** 注入 usage 归集 sink(app.wireSubAgentUsageSink 自动调用)。 */
  setUsageSink(sink: SubAgentUsageSink): void {
    this.usageSink = sink;
  }

  /**
   * 注入 hook 系统(根因修复)。WorkflowTool 在 cli.ts 注册时 HookSystem 尚未创建,
   * App 构造 HookSystem 后经此 setter 回填,workflow 内子代理才能触发 Subagent/工具级 hook 与 span。
   */
  setHookSystem(hookSystem: HookSystem): void {
    this.hookSystem = hookSystem;
  }

  readOnly(): boolean {
    return false;
  }

  async checkPermissions(
    _input: unknown,
    _context: ToolUseContext,
  ): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "workflow";
  }

  description(): string {
    return "执行一段确定性多 agent 编排脚本(Dynamic Workflow):跨多个 subagent 组织工作,用于穷尽分解(fan-out)、对抗校验(verify)、或承接单上下文装不下的规模(迁移/审计/扫荡)。脚本负责流程控制(parallel/pipeline/loop),模型负责填每个 agent() 格子。";
  }

  usageGuide(): string {
    // 动态列出可选 agentType(含 verify),让模型知道 agent({agentType:'...'}) 可选哪些类型。
    // 从 BUILTIN_AGENTS 派生,避免写死漂移(新增内置类型自动出现在指南里)。
    let agentTypesLine = "";
    try {
      const { getBuiltInAgentDefinitions } = require("../agent/agent-definition.ts");
      const defs = getBuiltInAgentDefinitions() as Array<{ agentType: string; description: string }>;
      const list = defs.map((d) => `${d.agentType}(${d.description})`).join("、");
      agentTypesLine = `\n- agent({agentType}) 可选内置类型:${list}。对抗校验场景用 agent({agentType:'verify'}) 开对抗式验证子代理(默认怀疑、主动证伪、读码举证)。`;
    } catch { /* 注册表读取失败不影响指南主体 */ }

    return `- 仅当任务需要多 agent 编排(穷尽/对抗/大规模)时用;单点查找用普通工具或单个子代理。
- 脚本必须以 \`export const meta = { name, description }\` 纯字面量开头。
- 原语:agent(prompt, opts?) 开子代理;parallel(thunks) 并发屏障;pipeline(items, ...stages) 无屏障逐项;phase(title) 进度组;log(msg) 叙述;args 入参;budget 预算。
- agent({schema}) 强制结构化输出,返回校验后的对象;agent({model}) 选模型;agent({isolation:'worktree'}) 并行改文件隔离。${agentTypesLine}
- 默认 pipeline 而非 parallel:无屏障逐项推进墙钟更短。仅当 stage N 需要全部 stage N-1 结果时才用 parallel 屏障。
- 迭代:返回的 scriptPath 可编辑后用 {scriptPath, resumeFromRunId} 重跑,已完成的 agent 走缓存。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(workflowSchema()) as Record<string, unknown>;
  }

  /** 解析脚本来源:script > scriptPath > name */
  private resolveScript(params: {
    script?: string;
    scriptPath?: string;
    name?: string;
  }): { src: string; source: string } | { error: string } {
    if (params.scriptPath) {
      if (!existsSync(params.scriptPath)) {
        return { error: `scriptPath 不存在: ${params.scriptPath}` };
      }
      try {
        return { src: readFileSync(params.scriptPath, "utf-8"), source: `scriptPath:${params.scriptPath}` };
      } catch (err) {
        return { error: `读取 scriptPath 失败: ${(err as Error).message}` };
      }
    }
    if (params.script) {
      return { src: params.script, source: "inline" };
    }
    if (params.name) {
      const p = join(workflowScriptsDir(), `${params.name}.js`);
      if (!existsSync(p)) {
        return { error: `找不到已保存的 workflow: ${params.name}(期望 ${p})` };
      }
      try {
        return { src: readFileSync(p, "utf-8"), source: `name:${params.name}` };
      } catch (err) {
        return { error: `读取 workflow ${params.name} 失败: ${(err as Error).message}` };
      }
    }
    return { error: "必须提供 script / scriptPath / name 之一" };
  }

  /** 持久化脚本到 ~/.sid-code/workflows/scripts/<name>-<runId>.js,返回落盘路径 */
  private persistScript(name: string, runId: string, src: string): string | undefined {
    try {
      const dir = workflowScriptsDir();
      mkdirSync(dir, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
      const path = join(dir, `${safeName}-${runId}.js`);
      writeFileSync(path, src, "utf-8");
      return path;
    } catch (err) {
      getLogger().warn("WORKFLOW", `脚本持久化失败: ${(err as Error).message}`);
      return undefined;
    }
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      script?: string;
      scriptPath?: string;
      name?: string;
      args?: unknown;
      resumeFromRunId?: string;
      budgetTotal?: number;
    };

    // 1) 解析脚本来源
    const resolved = this.resolveScript(params);
    if ("error" in resolved) {
      return { output: `[workflow] ${resolved.error}`, isError: true };
    }
    const { src, source } = resolved;

    // 2) 解析校验 meta(执行前拿到 name/description)
    const metaResult = parseAndValidateMeta(src);
    if (!metaResult.ok) {
      return { output: `[workflow] ${metaResult.error}`, isError: true };
    }
    const meta = metaResult.meta;

    // 3) runId:resume 复用旧 id,否则新建
    const runId = params.resumeFromRunId ?? newRunId();

    // 4) 注册后台 task(TUI 可见)。abortController 由 killWorkflowTask 触发,
    //    下面 §合并 signal 时接进 runtime,确保 task_stop 能真正中止运行中的子代理。
    const { taskState, abortController } = createWorkflowTask({
      workflowName: meta.name,
      runId,
      source,
      description: `${meta.name}: ${meta.description}`,
    });
    const taskId = taskState.id;

    // 5) 组装 journal(resume 时回放)
    const journal = new Journal(journalPath(runId));
    if (params.resumeFromRunId) journal.load();

    // 6) 持久化脚本(支持迭代/分享)
    const savedPath = this.persistScript(meta.name, runId, src);

    // 7) 组装 runtime + runner
    //    outputTokens 驱动 budget;inputTokens/outputTokens 累计供 task 结果展示真实用量;
    //    每个子 agent 的完整 usage 经 usageSink 按其实际 model 回写主会话(计入 /cost)。
    let outputTokens = 0;
    let inputTokens = 0;
    const runner = new SubAgentRunner({
      providerRegistry: this.providerRegistry,
      toolRegistry: this.toolRegistry,
      hookSystem: this.hookSystem,
      runId,
      onUsage: (t) => {
        outputTokens += t;
      },
      onResult: (result) => {
        // 累计真实用量(修复此前 inputTokens 恒为 0)
        inputTokens += result.usage?.inputTokens ?? 0;
        // 归集到主会话 SessionState(按子代理实际 model/provider 计费)
        if (this.usageSink) {
          try {
            this.usageSink(result);
          } catch (err) {
            log.warn("WORKFLOW", `usage 归集失败(不影响 workflow): ${(err as Error).message}`);
          }
        }
      },
    });

    // 合并外部 signal(工具调用自身)与 task abortController(killWorkflowTask 触发)。
    // 任一触发都中断 workflow——这是 task_stop 能真正掐断运行中子代理的关键。
    // 修复缺口:此前 `mergedSignal = signal` 只接了外部 signal,task 的 abortController
    // 从未接进 runtime,导致 kill 只改状态、发通知,正在跑的子代理仍后台烧 token。
    const mergedSignal = signal
      ? AbortSignal.any([signal, abortController.signal])
      : abortController.signal;

    let agentCount = 0;
    const runtime = new WorkflowRuntime({
      runner,
      args: params.args,
      budgetTotal: params.budgetTotal ?? null,
      spentReader: () => outputTokens,
      journal,
      signal: mergedSignal,
      progress: {
        onLog: (m) => appendWorkflowOutput(taskId, `[log] ${m}\n`),
        onPhase: (title) => {
          appendWorkflowOutput(taskId, `[phase] ${title}\n`);
          updateWorkflowProgress(taskId, { currentPhase: title });
        },
        onAgentStart: (ctx) => {
          agentCount = Math.max(agentCount, ctx.callIndex + 1);
          updateWorkflowProgress(taskId, { agentCount });
        },
      },
    });

    // 8) 跑沙箱
    try {
      log.info("WORKFLOW", `▶ 启动 workflow "${meta.name}" (runId=${runId}, source=${source})`);

      // 内联子 workflow 原语(嵌套仅一层):共享同一 runtime 的调度器/计数器/budget/journal,
      // 但用子脚本自己的 args,且子脚本里再调 workflow() 抛错(强制单层)。
      const childWorkflow = async (
        nameOrRef: string | { scriptPath: string },
        childArgs?: unknown,
      ): Promise<unknown> => {
        // 解析子脚本来源
        let childSrc: string;
        if (typeof nameOrRef === "string") {
          const p = join(workflowScriptsDir(), `${nameOrRef}.js`);
          if (!existsSync(p)) {
            throw new Error(`[workflow] 内联子 workflow 未找到: ${nameOrRef}(期望 ${p})`);
          }
          childSrc = readFileSync(p, "utf-8");
        } else if (nameOrRef && typeof nameOrRef === "object" && nameOrRef.scriptPath) {
          if (!existsSync(nameOrRef.scriptPath)) {
            throw new Error(`[workflow] 内联子 workflow scriptPath 不存在: ${nameOrRef.scriptPath}`);
          }
          childSrc = readFileSync(nameOrRef.scriptPath, "utf-8");
        } else {
          throw new Error("[workflow] workflow(nameOrRef) 需要 string 名字或 {scriptPath}");
        }
        // 子脚本里再调 workflow() → 抛错(嵌套仅一层)
        const nestedThrow = () => {
          throw new Error("[workflow] 嵌套仅一层:子 workflow 内不能再调 workflow()");
        };
        const childApi = runtime.buildApi(nestedThrow, { args: childArgs });
        const { value } = await runInSandbox(childSrc, childApi);
        return value;
      };

      const { value } = await runInSandbox(src, runtime.buildApi(childWorkflow));

      const outputObj = {
        workflow: meta.name,
        runId,
        scriptPath: savedPath,
        agentCount: runtime.agentCallCount,
        result: value,
      };
      const outputText = JSON.stringify(outputObj, null, 2);

      await completeWorkflowTask(taskId, {
        output: outputText,
        totalToolUseCount: runtime.agentCallCount,
        totalTokens: inputTokens + outputTokens,
        usage: { inputTokens, outputTokens },
      });

      log.info("WORKFLOW", `✓ workflow "${meta.name}" 完成,共 ${runtime.agentCallCount} 个 agent 调用`);

      const resumeHint = savedPath
        ? `\n\n可迭代:编辑 ${savedPath} 后用 {scriptPath:"${savedPath}", resumeFromRunId:"${runId}"} 重跑(已完成的 agent 走缓存)。`
        : "";
      return { output: outputText + resumeHint, isError: false };
    } catch (err) {
      const msg = (err as Error).message;
      await failWorkflowTask(taskId, msg);
      log.error("WORKFLOW", `✗ workflow "${meta.name}" 失败: ${msg}`);
      return { output: `[workflow] "${meta.name}" 执行失败: ${msg}`, isError: true };
    }
  }
}
