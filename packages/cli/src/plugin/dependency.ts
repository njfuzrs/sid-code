/**
 * 插件依赖解析与安全边界
 *
 * 依赖语义：apt 风格的"存在保证"，不是 npm 风格的模块图。
 * 插件 A 依赖插件 B 意味着：B 的命名空间组件（MCP 服务器、命令、Agent）
 * 在 A 运行时必须可用。不支持版本约束（semver range）——插件的"接口"是
 * MCP 协议和 Markdown 模板，兼容性无法用 semver 精确描述。
 */

import type { LoadedPlugin, PluginError } from "./types.ts";

/** 依赖闭包解析结果 */
export type ResolutionResult =
  | {
      ok: true;
      /** 安装顺序（依赖在前，根在后） */
      closure: string[];
    }
  | {
      ok: false;
      reason: "cycle";
      chain: string[];
    }
  | {
      ok: false;
      reason: "not-found";
      missing: string;
      requiredBy: string;
    };

/**
 * 计算依赖闭包（DFS 后序遍历）
 *
 * @param rootId         要安装的插件标识符
 * @param lookup         查找插件元数据的函数（返回 null 表示找不到）
 * @param alreadyEnabled 已启用的插件集合（跳过，不重复安装）
 */
export async function resolveDependencyClosure(
  rootId: string,
  lookup: (id: string) => Promise<{ dependencies?: string[] } | null>,
  alreadyEnabled: ReadonlySet<string>,
): Promise<ResolutionResult> {
  const closure: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = []; // 用于循环检测

  async function walk(id: string, requiredBy: string): Promise<ResolutionResult | null> {
    // 根插件永远不跳过（重新安装场景）
    if (id !== rootId && alreadyEnabled.has(id)) return null;

    // 循环检测
    if (stack.includes(id)) {
      return { ok: false, reason: "cycle", chain: [...stack, id] };
    }

    // 已访问
    if (visited.has(id)) return null;
    visited.add(id);

    const entry = await lookup(id);
    if (!entry) {
      return { ok: false, reason: "not-found", missing: id, requiredBy };
    }

    stack.push(id);
    for (const dep of entry.dependencies ?? []) {
      const err = await walk(dep, id);
      if (err) return err;
    }
    stack.pop();

    closure.push(id); // 后序添加（依赖在前，根在后）
    return null;
  }

  const err = await walk(rootId, rootId);
  if (err) return err;
  return { ok: true, closure };
}

/**
 * 验证已启用插件的依赖，不满足的降级为 disabled。
 *
 * 使用固定点循环：A 依赖 B，B 依赖 C
 *   第一轮：C 被禁用 → B 的依赖不满足 → B 被降级
 *   第二轮：B 被降级 → A 的依赖不满足 → A 被降级
 *   第三轮：没有新的降级 → 循环结束
 *
 * 降级是会话级的，不写入 settings（最小惊讶原则）。
 *
 * 注意：依赖名匹配同时支持「插件名」和「完整 source（name@xxx）」两种写法，
 * 因为 manifest.dependencies 通常只写插件名，而 plugin.source 是 name@local 等形式。
 */
export function verifyAndDemote(
  enabled: LoadedPlugin[],
  disabled: LoadedPlugin[],
): { enabled: LoadedPlugin[]; disabled: LoadedPlugin[]; errors: PluginError[] } {
  // 构建「可识别名集合」：name 与 source 都纳入
  const enabledKeys = new Set<string>();
  for (const p of enabled) {
    enabledKeys.add(p.name);
    enabledKeys.add(p.source);
  }
  const knownKeys = new Set<string>();
  for (const p of [...enabled, ...disabled]) {
    knownKeys.add(p.name);
    knownKeys.add(p.source);
  }

  // 以 source 为唯一键追踪每个插件是否仍启用
  const stillEnabled = new Set(enabled.map((p) => p.source));
  const errors: PluginError[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of enabled) {
      if (!stillEnabled.has(p.source)) continue;

      for (const dep of p.manifest.dependencies ?? []) {
        // 依赖满足的条件：dep 命中某个仍启用插件的 name 或 source
        const satisfied = isDependencySatisfied(dep, enabled, stillEnabled);
        if (!satisfied) {
          stillEnabled.delete(p.source);
          // 从启用键集合中移除该插件的 name/source，触发级联
          enabledKeys.delete(p.name);
          enabledKeys.delete(p.source);
          errors.push({
            type: "dependency-unsatisfied",
            source: p.source,
            plugin: p.name,
            dependency: dep,
            reason: knownKeys.has(dep) ? "not-enabled" : "not-found",
          });
          changed = true;
          break;
        }
      }
    }
  }

  const newEnabled = enabled.filter((p) => stillEnabled.has(p.source));
  const demoted = enabled.filter((p) => !stillEnabled.has(p.source));
  const newDisabled = [...disabled, ...demoted.map((p) => ({ ...p, enabled: false }))];

  return { enabled: newEnabled, disabled: newDisabled, errors };
}

/** 判断依赖 dep 是否被某个仍启用的插件满足 */
function isDependencySatisfied(
  dep: string,
  enabled: LoadedPlugin[],
  stillEnabled: ReadonlySet<string>,
): boolean {
  for (const p of enabled) {
    if (!stillEnabled.has(p.source)) continue;
    if (p.name === dep || p.source === dep) return true;
  }
  return false;
}

/**
 * 查找所有依赖指定插件的已启用插件
 * 用于卸载/禁用前的警告提示。
 * @param pluginId 可以是插件名或完整 source
 */
export function findReverseDependents(
  pluginId: string,
  plugins: readonly LoadedPlugin[],
): string[] {
  // 目标插件可能用 name 或 source 被依赖
  const target = plugins.find((p) => p.name === pluginId || p.source === pluginId);
  const names = new Set<string>([pluginId]);
  if (target) {
    names.add(target.name);
    names.add(target.source);
  }

  return plugins
    .filter(
      (p) =>
        p.enabled &&
        p.source !== pluginId &&
        p.name !== pluginId &&
        (p.manifest.dependencies ?? []).some((d) => names.has(d)),
    )
    .map((p) => p.name);
}
