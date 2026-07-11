/**
 * Memory 工具 - 让 LLM 主动保存记忆
 * 当前只有 /memory 斜杠命令能写记忆，此工具让 LLM 在对话中主动保存
 *
 * ADR-026: 写盘前过 SecretRedactHook.detect, 命中 secret 直接拒绝写入
 *          (纵深防御 — 不是 redact 后写入, 而是引导 LLM 不要写 secret)
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import type { MemoryStore } from "../memory/store.ts";
import { getLogger } from "../debug/logger.ts";
import { getSharedSecretRedactHook } from "../llm/hooks/secret-redact.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** Memory 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const memorySchema = lazySchema(() =>
  z.object({
    key: z.string().describe("记忆键名（简短描述性名称，如 'coding_style' 或 'test_framework'）"),
    value: z.string().describe("记忆内容（具体的偏好或约定）"),
    scope: z
      .enum(["global", "project", "team", "agent"])
      .optional()
      .describe(
        "记忆范围：global（全局，所有项目）/ project（当前项目，默认）/ team（团队共享，同步给所有协作者）/ agent（当前子代理类型的跨会话领域经验，仅在子代理内可用）",
      ),
  }),
);

export class MemoryTool implements Tool {
  private store: MemoryStore;
  /** 当前子代理类型（仅子代理隔离工具集里注入；主会话为 undefined，此时 agent scope 不可用） */
  private agentType?: string;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = memorySchema();

  constructor(store: MemoryStore, agentType?: string) {
    this.store = store;
    this.agentType = agentType;
  }

  /**
   * 派生一个绑定了 agentType 的副本（共享同一 MemoryStore）。
   * 供子代理隔离工具集使用——让 save_memory 的 agent scope 能定位到当前子代理类型目录。
   */
  withAgentType(agentType: string): MemoryTool {
    return new MemoryTool(this.store, agentType);
  }

  /** 低风险工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "save_memory";
  }

  description(): string {
    return "保存记忆到持久化存储。用于记录用户偏好、项目约定、重要决策等信息。";
  }

  usageGuide(): string {
    return `- 当用户明确说"记住..."、"以后都..."、"我偏好..."时，使用此工具保存
- 发现用户的编码风格偏好、项目约定、重要决策时，主动保存为记忆
- 记忆会持久化到磁盘，下次对话时自动加载
- 项目记忆优先于全局记忆
- team 范围：团队共享约定/规范，会同步给所有协作者（需启用 teamMemory）；含 secret 会被拒绝
- agent 范围：仅子代理内可用——沉淀「这一类子代理」跨会话复用的领域经验（常见坑、领域约定、有效方法），下次同类型子代理开工时自动注入
- 不要主动保存临时信息或已在 CLAUDE.md 中的内容
- 不适合保存：会话状态、敏感数据（API Key 等）`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(memorySchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      key: string;
      value: string;
      scope?: "global" | "project" | "team" | "agent";
    };

    if (!params.key || !params.value) {
      return { output: "错误: 缺少 key 或 value 参数", isError: true };
    }

    // 输入清洗
    const key = params.key.replace(/\n/g, " ").trim();
    const value = params.value.trim();
    const scope = params.scope || "project";

    if (key.length === 0) {
      return { output: "错误: key 不能为空", isError: true };
    }

    if (value.length === 0) {
      return { output: "错误: value 不能为空", isError: true };
    }

    // 长度限制
    if (value.length > 10000) {
      return { output: "错误: value 过长（最多 10000 字符）", isError: true };
    }

    // ADR-026 §4.2 第 3 项: save_memory 写盘前过 secret-redact 检测
    // 命中 secret 时拒绝写入 (RL-002 不泄露凭证 — 纵深防御)
    const redactHook = getSharedSecretRedactHook();
    const secretHits = redactHook.detect(value);
    if (secretHits.length > 0) {
      const categories = Array.from(new Set(secretHits.map((h) => h.category))).join(", ");
      log.warn("TOOL", `✗ 拒绝保存含 secret 的记忆 [${scope}] ${key} — 命中: ${categories}`);
      return {
        output:
          `错误: 检测到 value 中包含敏感信息 (${categories}), 拒绝写入持久化存储.\n` +
          `安全建议: 请勿把 API Key / token / 密码等凭证存到 memory. ` +
          `这类信息应该放在 .env 或环境变量, 通过 process.env 在运行时读取.\n` +
          `如需保存与凭证相关的元信息, 请仅描述类型 (例如 "用户使用 GitHub Personal Access Token 调 API"), ` +
          `不要把凭证明文写入 value 字段.`,
        isError: true,
      };
    }

    log.info("TOOL", `▶ 保存记忆 [${scope}] ${key}`);

    // team scope：写入团队共享记忆目录（落盘后由 watcher 同步到共享目录）
    if (scope === "team") {
      const { getTeamMemoryOptions } = await import("../memory/team/runtime.ts");
      const { isTeamMemoryEnabled } = await import("../memory/team/paths.ts");
      const teamOpts = getTeamMemoryOptions();
      if (!isTeamMemoryEnabled(teamOpts)) {
        return {
          output:
            "错误: 团队记忆未启用。请在配置中设置 teamMemory.enabled=true（并配置共享目录 teamMemory.dir）后再用 team 范围。\n" +
            "或改用 project / global 范围保存到本地记忆。",
          isError: true,
        };
      }
      try {
        const { saveTeamMemory } = await import("../memory/team/store.ts");
        const result = await saveTeamMemory(key, value);
        if (!result.success) {
          log.warn("TOOL", `✗ 团队记忆保存失败 ${key}: ${result.error}`);
          return { output: `错误: ${result.error}`, isError: true };
        }
        log.info("TOOL", `✓ 团队记忆已保存 ${key}`);
        return {
          output: `记忆已保存到团队共享范围（将同步给所有协作者）:\n键: ${key}\n值: ${value.slice(0, 100)}${value.length > 100 ? "..." : ""}`,
        };
      } catch (err: any) {
        return { output: `保存团队记忆失败: ${err.message}`, isError: true };
      }
    }

    // agent scope（G13）：写入当前子代理类型的跨会话领域记忆。
    // 只在子代理隔离工具集里注入了 agentType 时可用；主会话无 agentType → 引导改用 project。
    if (scope === "agent") {
      if (!this.agentType) {
        return {
          output:
            "错误: agent 范围仅在子代理内可用（用于沉淀该类型子代理的跨会话领域经验）。\n" +
            "主会话请改用 project / global 范围。",
          isError: true,
        };
      }
      try {
        const { saveAgentMemory } = await import("../memory/agent-store.ts");
        await saveAgentMemory(this.agentType, key, value);
        log.info("TOOL", `✓ agent 记忆已保存 [${this.agentType}] ${key}`);
        return {
          output: `记忆已保存到 agent 范围（${this.agentType} 类型跨会话领域经验）:\n键: ${key}\n值: ${value.slice(0, 100)}${value.length > 100 ? "..." : ""}`,
        };
      } catch (err: any) {
        return { output: `保存 agent 记忆失败: ${err.message}`, isError: true };
      }
    }

    try {
      await this.store.set(key, value, scope);

      log.info("TOOL", `✓ 记忆已保存 [${scope}] ${key}`);

      const scopeLabel = scope === "global" ? "全局" : "项目";
      return {
        output: `记忆已保存到${scopeLabel}范围:\n键: ${key}\n值: ${value.slice(0, 100)}${value.length > 100 ? "..." : ""}`,
      };
    } catch (err: any) {
      return { output: `保存记忆失败: ${err.message}`, isError: true };
    }
  }
}
