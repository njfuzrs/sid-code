/**
 * Dynamic Workflows M4/M6 — 真实 AgentRunner(接 SubAgent)
 *
 * runtime.ts 的 agent() 通过 AgentRunner 接口拿结果。本文件是生产实现:
 *  - 用 SubAgent.fromRegistry/execute 真正开子代理;
 *  - opts.model → SubAgentTask.model(M4 模型档位);
 *  - opts.schema → SubAgentTask.schema(M2 结构化输出,返回已校验对象而非文本);
 *  - opts.isolation === 'worktree' → 建临时 worktree,SubAgentTask.cwd 指向它,跑完按
 *    fail-closed 清理(无改动删,有改动留)(M4 真并行);
 *  - opts.agentType → SubAgentTask.type(自定义子代理类型);
 *  - 把 usage 回灌 budget(M6 成本归集)。
 *
 * 与 runtime 解耦:runtime 不 import 这里,这里 import runtime 的类型。M6 接线时由宿主
 * 构造 SubAgentRunner 注入 WorkflowRuntime。
 */

import { randomBytes } from "node:crypto";
import type { AgentRunner, AgentCallContext } from "../workflow/runtime.ts";
import type { AgentOpts } from "../workflow/types.ts";
import { SubAgent } from "../agent/sub-agent.ts";
import type { SubAgentResult } from "../agent/sub-agent.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { HookSystem } from "../hook/system.ts";
import { WorktreeManager, findGitRoot } from "../worktree/manager.ts";
import { getCwd } from "../bootstrap/state.ts";
import { getLogger } from "../debug/logger.ts";

/** SubAgentRunner 构造选项 */
export interface SubAgentRunnerOptions {
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  hookSystem?: HookSystem;
  /** workflow run id,用于 worktree slug(对齐 cc 的 wf_<runId>-<idx>) */
  runId: string;
  /** usage 回调:每个 agent 跑完把输出 token 回灌(驱动 budget.spent) */
  onUsage?: (outputTokens: number) => void;
  /** 完整 usage 归集:每个 agent 跑完把完整 SubAgentResult(含 inputTokens/model/provider)
   *  回传宿主,用于归集到主会话 SessionState(计入 /cost、costLimit 守卫)。
   *  与 onUsage 分工:onUsage 只喂 budget(输出 token),onResult 喂计费(完整用量)。 */
  onResult?: (result: SubAgentResult) => void;
  /** 默认子代理类型(opts.agentType 缺省时用) */
  defaultAgentType?: string;
}

/** 把 worktree slug 里不安全字符扁平化 */
function safeSlugPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
}

export class SubAgentRunner implements AgentRunner {
  private readonly opts: SubAgentRunnerOptions;
  /** worktree 序号(每次 isolation 调用自增,保证 slug 唯一) */
  private worktreeSeq = 0;

  constructor(opts: SubAgentRunnerOptions) {
    this.opts = opts;
  }

  async run(
    prompt: string,
    opts: AgentOpts | undefined,
    ctx: AgentCallContext,
  ): Promise<unknown> {
    const log = getLogger();
    const agentType = opts?.agentType ?? this.opts.defaultAgentType ?? "task";

    // 1) worktree 隔离(可选,贵)
    let cwd: string | undefined;
    let worktreeCleanup: (() => Promise<void>) | undefined;
    if (opts?.isolation === "worktree") {
      const gitRoot = findGitRoot(getCwd());
      if (gitRoot) {
        const idx = this.worktreeSeq++;
        const manager = new WorktreeManager(gitRoot);
        const slug = `wf_${safeSlugPart(this.opts.runId)}-${idx}-${randomBytes(2).toString("hex")}`;
        try {
          const session = await manager.create(slug);
          cwd = session.worktreePath;
          worktreeCleanup = async () => {
            // fail-closed:无改动则删,有改动保留(WorktreeManager.remove 内部判定)
            try {
              await manager.remove(session, false);
            } catch (err) {
              log.warn("WORKFLOW", `worktree 清理失败(保留): ${(err as Error).message}`);
            }
          };
        } catch (err) {
          log.warn(
            "WORKFLOW",
            `worktree 创建失败,降级为非隔离执行: ${(err as Error).message}`,
          );
        }
      } else {
        log.warn("WORKFLOW", "非 git 仓库,worktree 隔离降级为非隔离执行");
      }
    }

    // 2) 构造子代理任务
    const sub = SubAgent.fromRegistry(
      this.opts.providerRegistry,
      this.opts.toolRegistry,
      this.opts.hookSystem,
      opts?.model, // M4: modelOverride(第 4 参)
    );

    try {
      const result = await sub.execute(
        {
          type: agentType,
          description: ctx.label,
          prompt,
          model: opts?.model, // executeInner 内再次优先用它
          schema: opts?.schema, // M2: 结构化输出
          cwd, // M4: worktree 真并行
          effort: opts?.effort, // M4: 推理强度透传(low..max → provider high|max)
        },
        ctx.signal,
      );

      // 3) usage 回灌:budget(输出 token) + 完整归集(计费)
      if (result.usage) {
        this.opts.onUsage?.(result.usage.outputTokens ?? 0);
        this.opts.onResult?.(result);
      }

      if (!result.success) {
        // 失败:返回 null(runtime 的 parallel/pipeline 会据此落 null)
        log.warn("WORKFLOW", `[${ctx.label}] 子代理失败: ${result.output.slice(0, 120)}`);
        return null;
      }

      // 4) 带 schema → 解析为对象返回;否则返回文本
      if (opts?.schema) {
        try {
          return JSON.parse(result.output);
        } catch {
          // 理论上 StructuredOutput 工具已保证是合规 JSON;解析失败兜底返回原文
          log.warn("WORKFLOW", `[${ctx.label}] schema 输出非 JSON,返回原文`);
          return result.output;
        }
      }
      return result.output;
    } finally {
      await worktreeCleanup?.();
    }
  }
}
