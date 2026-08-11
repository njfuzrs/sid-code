/**
 * `agents` CLI 子命令（对齐 claude-code `claude agents`，缺口 A-2）
 *
 * 列出当前会话可用的所有子代理：内置（BUILTIN_AGENTS）+ 用户/项目自定义（.sid-code/agents）
 * + 插件提供。每条打印 名称 / 来源 / 模型 / 描述 / 工具白名单。
 *
 * 与 TUI 内 /agents 对话框不同，本命令是**无头 CLI 快速路径**：不启动完整 App，
 * 只做本地枚举 + 打印，供脚本/CI 快速查看代理清单。支持 --setting-sources 限定加载源。
 */

import { getBuiltInAgentDefinitions } from "@sid-code/core/agent/agent-definition.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

interface AgentRow {
  name: string;
  source: string;
  model: string;
  description: string;
  tools: string;
}

/** 解析 --setting-sources（复用与主流程一致的语义：逗号分隔 user/project/local）。 */
function parseSettingSourcesArg(args: string[]): ("user" | "project" | "local")[] | undefined {
  const idx = args.indexOf("--setting-sources");
  if (idx === -1 || !args[idx + 1]) return undefined;
  const parts = args[idx + 1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = new Set(["user", "project", "local"]);
  const bad = parts.filter((p) => !valid.has(p));
  if (bad.length > 0) {
    console.error(`错误: --setting-sources 含无效源 "${bad.join(", ")}"，可选: user / project / local`);
    process.exit(1);
  }
  return parts as ("user" | "project" | "local")[];
}

export async function handleAgentsCommand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const settingSources = parseSettingSourcesArg(args);

  // --setting-sources：极早期注入，限定后续磁盘设置加载范围（与 cli.ts 主流程同源）。
  if (settingSources) {
    try {
      const { setEnabledSettingSources } = await import("@sid-code/core/config/settings/settings.ts");
      setEnabledSettingSources(settingSources);
    } catch {
      /* 忽略：设置源过滤失败不应阻塞列举 */
    }
  }

  const rows: AgentRow[] = [];

  // 1) 内置代理
  for (const def of getBuiltInAgentDefinitions()) {
    rows.push({
      name: def.agentType,
      source: "built-in",
      model: def.model ?? "(主模型)",
      description: def.description,
      tools: def.tools && def.tools.length > 0 ? def.tools.join(", ") : "(全部)",
    });
  }

  // 2) 用户/项目自定义代理（.sid-code/agents）
  try {
    const { CustomAgentLoader } = await import("@sid-code/core/agent/custom.ts");
    const custom = await new CustomAgentLoader().loadAll();
    for (const def of custom) {
      rows.push({
        name: def.name,
        source: `custom(${def.source})`,
        model: "(主模型)",
        description: def.description,
        tools: def.tools && def.tools.length > 0 ? def.tools.join(", ") : "(全部)",
      });
    }
  } catch (err: any) {
    getLogger().warn("AGENTS", `加载自定义代理失败: ${err?.message ?? err}`);
  }

  // 3) 插件代理
  try {
    const { loadPluginAgents } = await import("../plugin/index.ts");
    const plugin = await loadPluginAgents();
    for (const def of plugin) {
      rows.push({
        name: def.name,
        source: "plugin",
        model: "(主模型)",
        description: def.description,
        tools: def.tools && def.tools.length > 0 ? def.tools.join(", ") : "(全部)",
      });
    }
  } catch (err: any) {
    getLogger().warn("AGENTS", `加载插件代理失败: ${err?.message ?? err}`);
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("未发现任何子代理。");
    return;
  }

  console.log(`可用子代理（共 ${rows.length} 个）:\n`);
  for (const r of rows) {
    console.log(`  ${r.name}  [${r.source}]  模型: ${r.model}`);
    console.log(`      ${r.description}`);
    console.log(`      工具: ${r.tools}`);
    console.log("");
  }
  console.log("提示: 用 --agent <name> 让整个会话以某个子代理的人格运行；--agents <json> 动态注入自定义子代理。");
}
