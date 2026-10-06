/**
 * Hook 配置单一归一化层（HC3 / HC4 / HC5 / HC6）
 *
 * 所有来源（用户 / 项目 / 本地 / 托管 / 插件 / skill / agent）的 hook 配置都经过这里，
 * 产出注册表认的「一 handler 一条」形状 + 诊断。
 *
 * 为什么只能有一个：此前有 4 个各自独立的转换器（registry.convertLegacyHook、
 * system.convertPluginHook、skill/hooks.ts、agent/agent-hooks.ts），settings 只认平铺、
 * frontmatter 只认嵌套，每个转换器各自漏掉一批字段（env / sequential / timeout / async……）。
 * 「两条路径做同一件事，其中一条退化」在 hook 子系统里出现了第五次，这次直接合并成一个。
 *
 * 形状（逐元素判，同一事件数组里允许混写）：
 *   - 有 `hooks` 数组 → CC 嵌套组 `{matcher?, if?, sequential?, hooks:[handler...]}`
 *   - 没有 `hooks` 但有 type/command/url/prompt → sid 平铺条目（永久兼容，Q4，不告警）
 *   - 都不是 → error，path 点名
 *
 * 本文件只做「形状 → 注册表条目」，不做路径占位符的字符串替换：shell 形式靠导出的环境变量
 * 由 shell 展开，exec 形式（有 args）由 runner 在 spawn 前替换（§三.5，与 H14 同理）。
 */

import { HookEventName, LEGACY_EVENT_MAP, type HookConfig } from "./types.ts";
import { ConfigSource } from "./types.ts";
import { isUserHookHandlerType, UNSUPPORTED_HOOK_HANDLER_TYPES } from "./handler-types.ts";

/** 一条诊断：必须说清原因与改法 */
export interface HookDiagnostic {
  level: "error" | "warn";
  /** 如 "hooks.PreToolUse[0].hooks[1]" */
  path: string;
  message: string;
  source: ConfigSource;
}

/** 归一化后的一条注册项（一 handler 一条） */
export interface NormalizedHookEntry {
  eventName: HookEventName;
  config: HookConfig;
  matcher?: string;
  if?: string;
  sequential?: boolean;
  /** 一次性 hook（只对 skill 来源生效，与 CC 相同） */
  once?: boolean;
}

export interface NormalizeContext {
  /** 诊断 path 前缀，默认 "hooks" */
  pathPrefix?: string;
  /** 插件根目录（插件来源才有）→ handler 的路径变量 */
  pluginRoot?: string;
  /** 插件数据目录（插件来源才有） */
  pluginData?: string;
  /** skill 根目录（skill 来源才有）——CC 让 skill hook 复用 CLAUDE_PLUGIN_ROOT 这个名字 */
  skillRoot?: string;
  /** 给 handler 补的名字（skill:xxx / agent:xxx），未写 name 时用 */
  defaultName?: string;
  /** 额外环境变量（skill 名等），handler 自己的 env 优先 */
  extraEnv?: Record<string, string>;
  /** 是否尊重 handler 的 once 字段（只有 skill 来源为 true） */
  allowOnce?: boolean;
}

export interface NormalizeResult {
  entries: NormalizedHookEntry[];
  diagnostics: HookDiagnostic[];
}

/**
 * HC26：span 用的内部事件。枚举里有它们（trace 要用），但不是用户可配的协议面——
 * 配了没有任何文档化语义，按「内部事件，不支持用户配置」跳过。
 */
export const INTERNAL_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set([
  HookEventName.BeforePermissionCheck,
  HookEventName.AfterPermissionCheck,
  HookEventName.BeforeHookExecution,
  HookEventName.AfterHookExecution,
]);

/** 解析事件名（PascalCase 或旧 snake_case）；未知返回 null */
export function resolveHookEventName(name: string): HookEventName | null {
  const values = Object.values(HookEventName) as string[];
  if (values.includes(name)) return name as HookEventName;
  return (LEGACY_EVENT_MAP as Record<string, HookEventName>)[name] ?? null;
}

const HANDLER_MARKER_FIELDS = ["type", "command", "url", "prompt"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return Object.keys(out).length > 0 ? out : undefined;
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 来源对应的路径变量（runner 导出为环境变量，exec 形式另做字符串替换） */
function pathVarsFor(ctx: NormalizeContext): Record<string, string> | undefined {
  const vars: Record<string, string> = {};
  const root = ctx.pluginRoot ?? ctx.skillRoot;
  if (root) {
    vars.CLAUDE_PLUGIN_ROOT = root;
    vars.SID_CODE_PLUGIN_ROOT = root;
    // sid 旧写法 ${PLUGIN_ROOT}：额外导出同名环境变量兼容，而不是往 shell 串里拼路径（H14 同型）
    if (ctx.pluginRoot) vars.PLUGIN_ROOT = root;
  }
  if (ctx.pluginData) {
    vars.CLAUDE_PLUGIN_DATA = ctx.pluginData;
    vars.SID_CODE_PLUGIN_DATA = ctx.pluginData;
  }
  if (ctx.skillRoot) {
    vars.SKILL_DIR = ctx.skillRoot;
    vars.CLAUDE_SKILL_DIR = ctx.skillRoot;
    vars.SID_CODE_SKILL_DIR = ctx.skillRoot;
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

/**
 * 单个 handler → 注册表 HookConfig。返回 null 时已往 diagnostics 里写了原因。
 */
function convertHandler(
  raw: Record<string, unknown>,
  path: string,
  source: ConfigSource,
  ctx: NormalizeContext,
  diagnostics: HookDiagnostic[],
): HookConfig | null {
  const rawType = raw.type === undefined ? "command" : raw.type;
  if (!isUserHookHandlerType(rawType)) {
    diagnostics.push({
      level: "error",
      path: `${path}.type`,
      message:
        rawType === "runtime"
          ? `type "runtime" 只能由内部代码注册，配置文件里不可用，本条已跳过`
          : `无效的 hook 类型 ${JSON.stringify(rawType)}，有效值为 command / http / url / prompt / agent，本条已跳过`,
      source,
    });
    return null;
  }
  if (UNSUPPORTED_HOOK_HANDLER_TYPES.has(rawType)) {
    diagnostics.push({
      level: "warn",
      path: `${path}.type`,
      message: `type "${rawType}" 暂不支持（已识别，sid-code 本版本不执行），本条已跳过`,
      source,
    });
    return null;
  }

  const name = str(raw.name) ?? ctx.defaultName;
  const timeout = num(raw.timeout);
  const statusMessage = str(raw.statusMessage);
  const pathVars = pathVarsFor(ctx);

  if (rawType === "url" || rawType === "http") {
    const url = str(raw.url);
    if (!url) {
      diagnostics.push({
        level: "error",
        path: `${path}.url`,
        message: `${rawType} 类型的 hook 必须指定 url 字段，本条已跳过`,
        source,
      });
      return null;
    }
    return {
      type: "url",
      ...(name ? { name } : {}),
      url,
      method: str(raw.method),
      headers: strRecord(raw.headers),
      // H5：headers 里 $VAR 插值白名单
      allowedEnvVars: strArray(raw.allowedEnvVars),
      timeout,
      ...(statusMessage ? { statusMessage } : {}),
    };
  }

  if (rawType === "prompt" || rawType === "agent") {
    const prompt = str(raw.prompt);
    if (!prompt) {
      diagnostics.push({
        level: "error",
        path: `${path}.prompt`,
        message: `${rawType} 类型的 hook 必须指定 prompt 字段，本条已跳过`,
        source,
      });
      return null;
    }
    if (rawType === "prompt") {
      return {
        type: "prompt",
        ...(name ? { name } : {}),
        prompt,
        model: str(raw.model),
        timeout,
        ...(statusMessage ? { statusMessage } : {}),
      };
    }
    return {
      type: "agent",
      ...(name ? { name } : {}),
      prompt,
      model: str(raw.model),
      tools: strArray(raw.tools),
      timeout,
      ...(statusMessage ? { statusMessage } : {}),
    };
  }

  // command
  const command = str(raw.command);
  if (!command) {
    diagnostics.push({
      level: "error",
      path: `${path}.command`,
      message: "command 类型的 hook 必须指定 command 字段，本条已跳过",
      source,
    });
    return null;
  }
  const args = strArray(raw.args);
  if (raw.args !== undefined && !args) {
    diagnostics.push({
      level: "error",
      path: `${path}.args`,
      message: "args 必须是字符串数组，本条已跳过",
      source,
    });
    return null;
  }
  const shell = str(raw.shell);
  if (shell && shell !== "bash" && shell !== "sh") {
    diagnostics.push({
      level: "warn",
      path: `${path}.shell`,
      message: `shell ${JSON.stringify(shell)} 暂不支持，按 sh 执行`,
      source,
    });
  }
  const env = { ...(ctx.extraEnv ?? {}), ...(strRecord(raw.env) ?? {}) };
  return {
    type: "command",
    ...(name ? { name } : {}),
    command,
    ...(args ? { args } : {}),
    timeout,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(pathVars ? { pathVars } : {}),
    async: raw.async === true ? true : undefined,
    asyncRewake: raw.asyncRewake === true ? true : undefined,
    ...(statusMessage ? { statusMessage } : {}),
  };
}

/**
 * 归一化一份 `{ EventName: [...] }` hooks 配置。
 * @param raw settings.json 的 hooks 段 / 插件 hooks.json / skill 或 agent frontmatter 的 hooks
 */
export function normalizeHooksConfig(
  raw: unknown,
  source: ConfigSource,
  ctx: NormalizeContext = {},
): NormalizeResult {
  const entries: NormalizedHookEntry[] = [];
  const diagnostics: HookDiagnostic[] = [];
  const prefix = ctx.pathPrefix ?? "hooks";
  if (raw === undefined || raw === null) return { entries, diagnostics };
  if (!isObject(raw)) {
    diagnostics.push({
      level: "error",
      path: prefix,
      message: "hooks 必须是 { 事件名: [...] } 形式的对象",
      source,
    });
    return { entries, diagnostics };
  }

  for (const [eventKey, list] of Object.entries(raw)) {
    const eventPath = `${prefix}.${eventKey}`;
    const eventName = resolveHookEventName(eventKey);
    if (!eventName) {
      diagnostics.push({
        level: "warn",
        path: eventPath,
        message: `未知的事件名 "${eventKey}"，本事件下的 hook 已跳过`,
        source,
      });
      continue;
    }
    if (INTERNAL_HOOK_EVENTS.has(eventName)) {
      diagnostics.push({
        level: "warn",
        path: eventPath,
        message: `${eventName} 是内部事件（trace span 用），不支持用户配置，本事件下的 hook 已跳过`,
        source,
      });
      continue;
    }
    if (!Array.isArray(list)) {
      diagnostics.push({
        level: "error",
        path: eventPath,
        message: "hook 配置必须是数组",
        source,
      });
      continue;
    }

    list.forEach((item, i) => {
      const itemPath = `${eventPath}[${i}]`;
      if (!isObject(item)) {
        diagnostics.push({
          level: "error",
          path: itemPath,
          message: "hook 条目必须是对象",
          source,
        });
        return;
      }

      const groupMatcher = str(item.matcher);
      const groupIf = str(item.if);
      const groupSequential = item.sequential === true;

      let handlers: Array<{ raw: Record<string, unknown>; path: string }>;
      if (Array.isArray(item.hooks)) {
        // CC 嵌套组
        handlers = [];
        item.hooks.forEach((h, j) => {
          const hp = `${itemPath}.hooks[${j}]`;
          if (isObject(h)) handlers.push({ raw: h, path: hp });
          else
            diagnostics.push({
              level: "error",
              path: hp,
              message: "handler 必须是对象",
              source,
            });
        });
      } else if (HANDLER_MARKER_FIELDS.some((f) => item[f] !== undefined)) {
        // sid 平铺条目：自身就是一个 handler（matcher / if 与 type 同级）
        handlers = [{ raw: item, path: itemPath }];
      } else {
        diagnostics.push({
          level: "error",
          path: itemPath,
          message:
            "无法识别的 hook 条目：既没有 hooks 数组（CC 嵌套写法 {matcher, hooks:[{type, command}]}），" +
            "也没有 type / command / url / prompt（平铺写法），本条已跳过",
          source,
        });
        return;
      }

      for (const h of handlers) {
        const config = convertHandler(h.raw, h.path, source, ctx, diagnostics);
        if (!config) continue;
        // if 两层都允许写（CC 写在 handler 上，sid 平铺写在条目上），统一下沉到 handler 级
        const ifCond = str(h.raw.if) ?? groupIf;
        entries.push({
          eventName,
          config: { ...config, source },
          ...(groupMatcher ? { matcher: groupMatcher } : {}),
          ...(ifCond ? { if: ifCond } : {}),
          ...(groupSequential || h.raw.sequential === true ? { sequential: true } : {}),
          ...(ctx.allowOnce && h.raw.once === true ? { once: true } : {}),
        });
      }
    });
  }

  return { entries, diagnostics };
}

/** 把诊断格式化成启动横幅 / --print stderr 用的一行 */
export function formatHookDiagnostic(d: HookDiagnostic): string {
  return `[${d.source}] ${d.path}: ${d.message}`;
}
