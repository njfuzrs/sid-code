/**
 * HC1：按来源收集 hooks 配置层（user / project / local / managed）。
 *
 * 为什么 hooks 不走 PROJECT_BEHAVIOR_FIELDS：那份清单的语义是「项目级可以覆盖用户级」，
 * 而 hooks 要**合并**——与 CC 一致，各层按事件追加、互不替换。原先 hooks 只从用户级读，
 * 项目级 `.sid-code/settings.json` / `settings.local.json` 里的 hooks 根本不加载。
 *
 * 为什么直接读原始 JSON、不用 getSettingsForSource 的结果：后者经 resolveEnvVars 展开过 `${VAR}`。
 * hook 命令里的 `${CLAUDE_PROJECT_DIR}` 必须留给 hook 子进程的 shell 展开——在 sid 自己的进程里
 * 提前展开，值要么是空（变量未设置，路径变成 `/.claude/hooks/x.sh`），要么是外层 CC 会话的项目目录
 * （在 Claude Code 的终端里启动 sid 时）。两种都是错的，且错得无声。
 *
 * 本文件不做形状校验：归一化与诊断统一在 hook/config-normalize.ts。
 */

import { existsSync, readFileSync } from "fs";
import { getSettingsFilePath, listManagedSettingsDropIns } from "./settings/constants.ts";
import { getEnabledSettingSources, getSettingsForSource } from "./settings/settings.ts";
import { isUntrustedSettingsFile } from "./settings/security.ts";

/** 与 hook/types.ts 的 ConfigSource 取值一致（这里不 import 枚举，避免配置层拖入 hook 子系统） */
export type HookLayerSource = "flag" | "user" | "project" | "local" | "managed";

export interface HookLayer {
  source: HookLayerSource;
  /** 来源文件（诊断与 /hooks 面板展示用） */
  file: string;
  /** 原始 hooks 段（未经 env 插值） */
  hooks: Record<string, unknown>;
  /** 随仓库分发（项目级 / 被 git 追踪的 local），需过信任门 */
  untrusted: boolean;
  /** 被信任门摘掉（未信任工作区）。摘掉的层保留在列表里，供 /hooks 与 `hooks list` 展示 */
  skippedByTrust?: boolean;
}

/**
 * 把任意一份 hooks 段归一成「事件名 → 数组」，空对象视为没有。
 *
 * 抽出来是因为 flagSettings（`--settings`）来自内存对象、没有文件，但同样要支持
 * 极旧的数组写法（与 normalizeConfigKeys 同口径按 event 分组）。
 */
function normalizeRawHooks(hooks: unknown): Record<string, unknown> | null {
  let value = hooks;
  if (Array.isArray(value)) {
    const grouped: Record<string, unknown[]> = {};
    for (const h of value) {
      const ev = (h && typeof h === "object" && (h as { event?: string }).event) || "pre_tool_use";
      (grouped[ev] ??= []).push(h);
    }
    value = grouped;
  }
  if (!value || typeof value !== "object") return null;
  return Object.keys(value as Record<string, unknown>).length > 0
    ? (value as Record<string, unknown>)
    : null;
}

function readRawHooks(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeRawHooks(raw && typeof raw === "object" ? raw.hooks : undefined);
  } catch {
    // JSON 本身坏掉由 settings 链报错，这里不重复
    return null;
  }
}

/**
 * 收集各来源的 hooks 层，顺序即注册顺序：managed → user → project → local。
 * 受 --setting-sources 过滤（policy 始终保留，与 settings 链同口径）。
 */
export function collectHookLayers(workspacePath: string = process.cwd()): HookLayer[] {
  const enabled = new Set(getEnabledSettingSources());
  const layers: HookLayer[] = [];

  // 托管策略：主文件 + managed-settings.d/*.json，各自一层（按 CC 语义追加，用户层 disableAllHooks 关不掉）
  const policyFiles = [getSettingsFilePath("policySettings", workspacePath)];
  policyFiles.push(...listManagedSettingsDropIns());
  for (const file of policyFiles) {
    if (!file) continue;
    const hooks = readRawHooks(file);
    if (hooks) layers.push({ source: "managed", file, hooks, untrusted: false });
  }

  const disk: Array<["userSettings" | "projectSettings" | "localSettings", HookLayerSource]> = [
    ["userSettings", "user"],
    ["projectSettings", "project"],
    ["localSettings", "local"],
  ];
  for (const [settingSource, source] of disk) {
    if (!enabled.has(settingSource)) continue;
    const file = getSettingsFilePath(settingSource, workspacePath);
    if (!file) continue;
    const hooks = readRawHooks(file);
    if (!hooks) continue;
    layers.push({
      source,
      file,
      hooks,
      untrusted: isUntrustedSettingsFile(settingSource, file),
    });
  }

  // flagSettings（`--settings`）是用户本次命令显式给的内存源：不读磁盘、不过信任门，
  // 但必须与磁盘三层同口径参与合并。不补这一层，「`--settings` 里的 hook 不生效」就还在 ——
  // 这是同一根因的第三次：hooks 只读用户级（HC1 补齐磁盘三源）→ `--settings` 只进
  // getSettings 视野（本次补齐 Config 与 hooks，见 2026-11-16 二次核查）。
  //
  // 放在 local 之后：与 SETTING_SOURCES 的相对顺序一致（... local → flag → policy）。
  // hooks 是按事件追加，顺序即执行次序，所以这一层的相对位置不能随手挪。
  //
  // 直接取内存对象、不做 env 插值：`${CLAUDE_PROJECT_DIR}` 必须留给 hook 子进程展开，
  // 与上面各层读原始 JSON 的理由相同（见文件头注释）。
  const flagSettings = getSettingsForSource("flagSettings").settings as {
    hooks?: unknown;
  } | null;
  const flagHooks = normalizeRawHooks(flagSettings?.hooks);
  if (flagHooks) {
    layers.push({ source: "flag", file: "<--settings>", hooks: flagHooks, untrusted: false });
  }
  return layers;
}
