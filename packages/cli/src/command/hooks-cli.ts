/**
 * `hooks list` CLI 子命令（§三.9：无头自检「到底哪些 hook 生效」）
 *
 *   sid-code hooks list [--json] [--trust-workspace]
 *
 * 输出**实际注册表**（事件 / 来源 / matcher / if / handler），以及被跳过的条目和原因：
 * 未信任工作区摘掉的项目级层、归一化诊断（形状不认识、未知事件、mcp_tool 等）。
 * e2e 与用户自查都靠它，不用再翻 debug 日志猜。
 *
 * 不启动 App：与主流程同样的取数（collectHookLayers + 同一个归一化层 + 同一个信任判据），
 * 所以这里显示的就是下一次会话会注册的东西。插件 hook 也列出（读插件缓存，不联网）。
 */

import { HookSystem } from "@sid-code/core/hook/system.ts";
import { ConfigSource } from "@sid-code/core/hook/types.ts";
import type { HookDiagnostic } from "@sid-code/core/hook/config-normalize.ts";
import type { HookRegistryEntry } from "@sid-code/core/hook/registry.ts";

const SOURCE_OF: Record<string, ConfigSource> = {
  managed: ConfigSource.Managed,
  user: ConfigSource.User,
  project: ConfigSource.Project,
  local: ConfigSource.Local,
};

interface HookRow {
  event: string;
  source: string;
  matcher?: string;
  if?: string;
  type: string;
  handler: string;
  sequential?: boolean;
  async?: boolean;
}

function handlerOf(e: HookRegistryEntry): string {
  const c = e.config;
  if (c.type === "command") return c.args ? [c.command, ...c.args].join(" ") : c.command;
  if (c.type === "url") return c.url;
  if (c.type === "prompt" || c.type === "agent") return c.prompt.slice(0, 80);
  return c.name;
}

export async function handleHooksCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "list") {
    console.error("用法: sid-code hooks list [--json] [--trust-workspace]");
    process.exit(sub ? 1 : 0);
  }
  const asJson = args.includes("--json");
  const trustFlag = args.includes("--trust-workspace");

  const { collectHookLayers } = await import("@sid-code/core/config/hook-layers.ts");
  const layers = collectHookLayers();

  // 与 cli.ts 信任门同一判据：有不可信层且工作区未信任 → 该层跳过
  let trusted = trustFlag;
  if (!trusted && layers.some((l) => l.untrusted)) {
    try {
      const { TrustManager } = await import("@sid-code/core/permission/trust.ts");
      trusted = await new TrustManager(process.cwd()).isTrusted();
    } catch {
      trusted = false;
    }
  }
  const skipped: Array<{ file: string; source: string; reason: string; count: number }> = [];
  for (const l of layers) {
    if (l.untrusted && !trusted) {
      l.skippedByTrust = true;
      skipped.push({
        file: l.file,
        source: l.source,
        reason: "未信任工作区，已跳过（交互模式确认信任，或加 --trust-workspace）",
        count: Object.values(l.hooks).flat().length,
      });
    }
  }

  const sys = new HookSystem();
  const diagnostics: HookDiagnostic[] = [];
  diagnostics.push(
    ...sys.initializeFromSources(
      layers
        .filter((l) => !l.skippedByTrust)
        .map((l) => ({
          hooks: l.hooks,
          source: SOURCE_OF[l.source]!,
          ctx: { pathPrefix: `${l.file}#hooks` },
        })),
    ),
  );

  try {
    const { loadAllPluginsCacheOnly } = await import("../plugin/loader.ts");
    const { collectPluginHooks } = await import("../plugin/loadPluginHooks.ts");
    const { enabled } = await loadAllPluginsCacheOnly();
    const pluginLayers = enabled.map(collectPluginHooks).filter((x) => x !== null);
    diagnostics.push(...sys.replacePluginHooks(pluginLayers));
  } catch {
    /* 插件缓存不可读不影响列出 settings 来源 */
  }

  const rows: HookRow[] = sys.getAllHooks().map((e) => ({
    event: e.eventName,
    source: e.source,
    ...(e.matcher ? { matcher: e.matcher } : {}),
    ...(e.if ? { if: e.if } : {}),
    type: e.config.type,
    handler: handlerOf(e),
    ...(e.sequential ? { sequential: true } : {}),
    ...(e.config.type === "command" && e.config.async ? { async: true } : {}),
  }));

  if (asJson) {
    console.log(JSON.stringify({ hooks: rows, skipped, diagnostics }, null, 2));
    return;
  }

  if (rows.length === 0) console.log("（没有已注册的 hook）");
  for (const r of rows) {
    const m = r.matcher ? ` matcher=${r.matcher}` : "";
    const i = r.if ? ` if=${r.if}` : "";
    console.log(`${r.event}  [${r.source}]${m}${i}  ${r.type}: ${r.handler}`);
  }
  for (const s of skipped) console.log(`✗ 跳过 ${s.file}（${s.count} 条）：${s.reason}`);
  for (const d of diagnostics) {
    console.log(`${d.level === "error" ? "✗" : "!"} ${d.path}: ${d.message}`);
  }
}
