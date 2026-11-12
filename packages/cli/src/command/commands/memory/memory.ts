import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
// CG-1：cwd 的两种语义分开取。`getCwd()` = 模型此刻在哪（跟随 bash cd）；
// `getProjectRoot()` = 工作区根（项目身份，不随 cd / worktree 切换漂移）。
import { getCwd, getProjectRoot } from "@sid-code/core/bootstrap/state.ts";

/** /memory 命令 */
export class MemoryCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数 → 打开交互式记忆面板（auto-memory 条目管理 + f 键切回 CLAUDE.md 浏览）
    if (!args.trim()) {
      return { type: "dialog", dialog: "memory" };
    }

    const { MemoryStore, formatEvictionNotice } = await import("@sid-code/core/memory/store.ts");
    // CG-1 / R1：记忆按「工作区根」归属。用 process.cwd() 时 bash `cd` 不漂、但进 worktree 会漂，
    // 同一个项目的记忆被拆成两处；getProjectRoot() 在两种场景下都稳定指向项目身份。
    const store = new MemoryStore(getProjectRoot());
    await store.load();

    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0] || "list";

    switch (subCmd) {
      case "auto": {
        // M2：auto-memory 后台提取开关。/memory auto on|off|status [-p]
        const action = (parts[1] || "status").toLowerCase();
        const persist = args.includes("-p") || args.includes("--persist");

        if (action === "status" || action === "") {
          if (!ctx.getAutoMemoryState) {
            return { type: "text", value: "auto-memory 状态不可用（运行环境未接线）" };
          }
          const st = ctx.getAutoMemoryState();
          const sourceLabel = {
            env: "环境变量 SID_CODE_AUTO_MEMORY",
            settings: "settings.json",
            default: "默认",
          }[st.source];
          const stateLabel = st.enabled ? "已启用（extraction on）" : "已禁用（extraction off）";
          return {
            type: "text",
            value: [
              `auto-memory: ${stateLabel}`,
              `  来源: ${sourceLabel}`,
              "",
              "用法: /memory auto on|off [-p]（-p 持久化到 settings.json）",
            ].join("\n"),
          };
        }

        if (action !== "on" && action !== "off" && action !== "enable" && action !== "disable") {
          return errorText("用法: /memory auto on|off|status [-p]");
        }

        const enable = action === "on" || action === "enable";
        if (!ctx.setAutoMemory) {
          return { type: "text", value: "auto-memory 开关不可用（运行环境未接线）" };
        }
        // env 覆盖优先级更高：若 env 显式设值，运行时切换仍生效但重启后被 env 覆盖，提示用户。
        const envSet =
          process.env.SID_CODE_AUTO_MEMORY !== undefined && process.env.SID_CODE_AUTO_MEMORY !== "";
        await ctx.setAutoMemory(enable, persist);
        const lines = [
          `auto-memory 后台提取已${enable ? "启用" : "禁用"}${persist ? "（已持久化到 settings.json）" : "（仅本会话）"}`,
        ];
        if (envSet) {
          lines.push("⚠️ 检测到环境变量 SID_CODE_AUTO_MEMORY 已设置，重启后将以环境变量为准。");
        }
        return { type: "text", value: lines.join("\n") };
      }

      case "external": {
        // M4-5：CLAUDE.md 外部 @import 审批开关。/memory external allow|deny|status
        // 让用户在启动对话框拒绝后仍有命令入口改主意（对齐 CC Config.tsx toggle）。
        const action = (parts[1] || "status").toLowerCase();

        if (action === "status" || action === "") {
          if (!ctx.getExternalImportsState) {
            return { type: "text", value: "外部导入审批状态不可用（运行环境未接线）" };
          }
          const { approved } = ctx.getExternalImportsState();
          const stateLabel =
            approved === undefined
              ? "尚未询问（首次遇到外部导入时会弹审批对话框）"
              : approved
                ? "已允许（项目外的 @import 会被展开加载）"
                : "已禁用（项目外的 @import 会被跳过）";
          return {
            type: "text",
            value: [
              `CLAUDE.md 外部导入: ${stateLabel}`,
              "",
              "用法: /memory external allow|deny|status",
              "  allow — 允许加载项目根之外（含 ~/）的 @import",
              "  deny  — 跳过所有项目外的 @import",
            ].join("\n"),
          };
        }

        if (action !== "allow" && action !== "deny" && action !== "on" && action !== "off") {
          return errorText("用法: /memory external allow|deny|status");
        }

        if (!ctx.setExternalImportsApproved) {
          return { type: "text", value: "外部导入审批开关不可用（运行环境未接线）" };
        }
        const approved = action === "allow" || action === "on";
        await ctx.setExternalImportsApproved(approved);
        return {
          type: "text",
          value: approved
            ? "已允许 CLAUDE.md 外部导入，规则已重载（项目外的 @import 现在会被展开）。"
            : "已禁用 CLAUDE.md 外部导入，项目外的 @import 将被跳过。",
        };
      }

      case "set": {
        const key = parts[1];
        // 修复 --global 解析：先在 token 级剥离 flag 再 join，避免 value 正文里的
        // "--global" 子串被 String.replace 误删（详见 docs/bugfixes 20261017 排查）。
        // scope 判定与 value 清理必须用同一数据源（rest），否则 key/value 含子串时两边结论不一致。
        const rest = parts.slice(2);
        const scope = rest.includes("--global") ? ("global" as const) : ("project" as const);
        const value = rest
          .filter((p) => p !== "--global")
          .join(" ")
          .trim();
        // 空值检查放在剥离之后：/memory set key --global 不再静默存入空 value
        if (!key || !value) {
          return errorText("用法: /memory set <key> <value> [--global]");
        }
        // PR-A（A2）：满额淘汰的代价必须在命令输出里可见 —— 与 save_memory 工具同文案。
        const result = await store.set(key, value, scope);
        return {
          type: "text",
          value: `记忆已保存: [${scope}] ${key} = ${value}` + formatEvictionNotice(result.evicted),
        };
      }

      case "get": {
        const key = parts[1];
        if (!key) {
          return errorText("用法: /memory get <key>");
        }
        const entry = await store.get(key);
        if (entry) {
          const date = new Date(entry.updatedAt).toLocaleString();
          return {
            type: "text",
            value: `[${entry.scope}] ${entry.key} = ${entry.value}\n  更新时间: ${date}`,
          };
        }
        return { type: "text", value: `未找到记忆: ${key}` };
      }

      case "delete":
      case "del":
      case "rm": {
        const key = parts[1];
        if (!key) {
          return errorText("用法: /memory delete <key>");
        }
        const deleted = await store.delete(key);
        return { type: "text", value: deleted ? `已删除记忆: ${key}` : `未找到记忆: ${key}` };
      }

      case "search": {
        const keyword = parts.slice(1).join(" ");
        if (!keyword) {
          return errorText("用法: /memory search <keyword>");
        }
        const results = await store.search(keyword);
        if (results.length === 0) {
          return { type: "text", value: `未找到匹配 "${keyword}" 的记忆` };
        }
        const lines = [`找到 ${results.length} 条匹配:`];
        for (const entry of results) {
          lines.push(`  [${entry.scope}] ${entry.key}: ${entry.value}`);
        }
        return { type: "text", value: lines.join("\n") };
      }

      case "show": {
        // 显示当前注入系统提示词的记忆内容
        const summary = await store.generateSummary();
        if (!summary) {
          return { type: "text", value: "当前没有记忆被注入系统提示词" };
        }
        const stats = await store.getStats();
        const lines = [
          `当前注入系统提示词的记忆 (全局 ${stats.globalCount} 条, 项目 ${stats.projectCount} 条):`,
          "",
          summary,
        ];
        return { type: "text", value: lines.join("\n") };
      }

      case "reload": {
        // M11：重新加载记忆并刷新系统提示词。
        // 走 memorySystemPrompt 索引指针路径（与启动 init-helpers 一致），
        // 不再用 memorySummary 全文摘要（已下线双轨注入）。
        const freshStore = new MemoryStore(getProjectRoot());
        await freshStore.load();
        const { buildMemorySystemPrompt } = await import("@sid-code/core/memory/prompt.ts");
        const indexContent = await freshStore.getIndexContent();

        // 团队记忆索引一并注入（若启用）
        let teamIndexContent: string | null = null;
        try {
          const { isTeamMemoryEnabled } = await import("@sid-code/core/memory/team/paths.ts");
          if (isTeamMemoryEnabled(ctx.config.teamMemory)) {
            const { getTeamIndexContent } = await import("@sid-code/core/memory/team/store.ts");
            teamIndexContent = await getTeamIndexContent(getProjectRoot());
          }
        } catch {
          /* 团队记忆索引注入失败不阻断 reload */
        }

        const memorySystemPrompt = buildMemorySystemPrompt(indexContent, teamIndexContent);
        if (!memorySystemPrompt) {
          return { type: "text", value: "记忆为空，无需刷新" };
        }

        // 重建系统提示词（索引指针进 core 区）
        const { buildSystemPrompt } = await import("@sid-code/core/config/system-prompt.ts");
        const { loadAllCLAUDEmd } = await import("@sid-code/core/config/rules.ts");
        const projectRules = await loadAllCLAUDEmd(getProjectRoot());

        // 缺口 D / M4（CG-3）：deny 规则约束摘要必须跟着重建一起传。
        // 启动路径（app.ts:4469、init-helpers.ts:596）都传，只有这条 reload 重建路径此前漏了，
        // 结果是「刷新记忆」顺手把「哪些操作必被拒绝」的约束块抹掉，模型重新开始撞 deny 规则。
        // 这里按**当前** checker 重取而不是复用启动时的值：reload 会重读 CLAUDE.md，
        // 而 CLAUDE.md 可以改写 deny 规则（见 app.ts:4726 同一理由）。
        let denyRulesSummary: string | undefined;
        if (
          ctx.permissionChecker &&
          typeof (ctx.permissionChecker as any).describeDenyRules === "function"
        ) {
          denyRulesSummary = (ctx.permissionChecker as any).describeDenyRules() || undefined;
        }

        const newPrompt = buildSystemPrompt({
          tools: ctx.toolRegistry.all(),
          projectRules: projectRules?.rawContent || undefined,
          projectRulesPath: projectRules?.sourcePath,
          projectRulesPaths: projectRules?.loadedPaths,
          appendPrompt: ctx.config.appendSystemPrompt || undefined,
          // CG-1 / R2：这里重建系统提示词，`<working-directory>` 取的是「模型此刻在哪」。
          workingDir: getCwd(),
          permissionMode: ctx.config.permissionMode,
          gitStatus: true,
          memorySystemPrompt,
          denyRulesSummary,
          preferredLanguage: ctx.config.language,
          model: ctx.config.model,
          availableModels: ctx.config.availableModels,
          // 延迟工具呈现（见 core/config/deferred-tool-view.ts）：/memory reload 也走
          // 完整重建，漏传会让分区标注在刷新记忆后消失
          toolSearchKeepLoaded: ctx.config.toolSearchKeepLoaded,
          toolSearchDisabled: ctx.config.toolSearch === false,
          // 不再写死 maxTokens：交由 buildSystemPrompt 按模型 contextWindow 的 90% 动态推导
        });
        // 归因：/memory reload 换掉的是 core 区的记忆索引，静态前缀必然作废。
        // 不记账的话这类断裂在轨迹里只能标 none_local（与 rebuildSystemPrompt 同口径）。
        ctx.ctxMgr.recordSendMutationCause("system_rebuild:memory_reload");
        ctx.ctxMgr.setSystemPrompt(newPrompt);
        clearPromptCache();

        return {
          type: "text",
          value: `记忆已重新加载，系统提示词已刷新 (${newPrompt.length} 字符)`,
        };
      }

      case "list":
      case "ls":
      default: {
        const entries = await store.list();
        if (entries.length === 0) {
          return { type: "text", value: "暂无记忆\n使用 /memory set <key> <value> 添加记忆" };
        }
        const stats = await store.getStats();
        const lines = [`记忆列表 (全局 ${stats.globalCount} 条, 项目 ${stats.projectCount} 条):`];
        for (const entry of entries) {
          const date = new Date(entry.updatedAt).toLocaleDateString();
          lines.push(`  [${entry.scope}] ${entry.key}: ${entry.value} (${date})`);
        }
        return { type: "text", value: lines.join("\n") };
      }
    }
  }
}
