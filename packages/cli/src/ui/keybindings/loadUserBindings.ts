/**
 * 用户自定义键位加载 — K2
 *
 * 从 ~/.sid-code/keybindings.json 读取用户绑定，经 K3 校验（schema + 冲突 + 保留键）后
 * 与默认表合并，产出最终的运行时键位表供 App.tsx / InputArea.tsx 的 matchBinding 使用。
 *
 * 合并语义：用户绑定按 action 覆盖默认绑定（同 action → 用户 stroke 生效）；
 * 用户新增的 action 追加到表尾。被默认表占用、但用户把该 stroke 改绑到别的 action 时，
 * 旧默认绑定中"持有该 stroke 的那一条"会被移除，避免一键双义。
 *
 * 设计：
 * - 读文件 + JSON.parse 的副作用集中在 loadUserBindings；mergeBindings 是纯函数，可单测。
 * - 任何加载/校验失败都降级为"仅用默认表"，绝不让坏配置阻断启动。
 */

import { existsSync } from "fs";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { sidHomePath } from "@sid-code/core/config/paths.ts";
import { DEFAULT_BINDINGS, type KeyBinding } from "./defaultBindings.ts";
import { strokeSignature } from "./reservedShortcuts.ts";
import { validateUserBindings, type BindingIssue } from "./validate.ts";

/** keybindings.json 在配置目录下的路径。 */
export function userBindingsPath(): string {
  return sidHomePath("keybindings.json");
}

export interface LoadBindingsResult {
  bindings: KeyBinding[];
  issues: BindingIssue[];
  /** 是否真的读到并应用了用户配置（false = 纯默认表）。 */
  userConfigApplied: boolean;
}

/**
 * 纯函数：把用户绑定合并进默认表。
 *
 * 规则：
 * 1. 用户绑定按 action 覆盖默认表里同 action 的项（stroke/display/description 全替换），
 *    **原位替换**——此前是跳过默认项再把用户项追加到表尾，结果只要 keybindings.json 里写了
 *    （哪怕与默认完全相同的）覆盖，那几项就从帮助面板原来的位置跑到最后。
 * 2. 若用户把某 stroke 绑给 action X，而默认表里该 stroke 原属 action Y(≠X)，
 *    则移除默认表中那条 Y 绑定（防止同一键触发两个动作）。
 * 3. 用户新增的 action 追加到表尾。
 */
export function mergeBindings(
  userBindings: KeyBinding[],
  defaults: KeyBinding[] = DEFAULT_BINDINGS,
): KeyBinding[] {
  const userByAction = new Map(userBindings.map((b) => [b.action, b]));
  const userStrokeSigs = new Set(userBindings.map((b) => strokeSignature(b.stroke)));

  const merged: KeyBinding[] = [];
  for (const d of defaults) {
    // 该默认 action 被用户覆盖 → 原位换成用户项。
    const override = userByAction.get(d.action);
    if (override) {
      merged.push(override);
      continue;
    }
    // 该默认项的 stroke 被用户抢去绑别的 action → 移除，避免一键双义。
    if (userStrokeSigs.has(strokeSignature(d.stroke))) continue;
    merged.push(d);
  }
  // 追加用户新增的 action。
  const defaultActions = new Set(defaults.map((d) => d.action));
  merged.push(...userBindings.filter((b) => !defaultActions.has(b.action)));
  return merged;
}

/**
 * 从 ~/.sid-code/keybindings.json 加载并合并用户键位。
 * 无文件 / 解析失败 / 全部校验失败时，返回纯默认表（userConfigApplied=false）。
 */
export async function loadUserBindings(
  defaults: KeyBinding[] = DEFAULT_BINDINGS,
): Promise<LoadBindingsResult> {
  const log = getLogger();
  const path = userBindingsPath();

  if (!existsSync(path)) {
    return { bindings: defaults, issues: [], userConfigApplied: false };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(path).text());
  } catch (err) {
    log.warn("KEYBINDING", `keybindings.json 解析失败，使用默认键位: ${err}`);
    return {
      bindings: defaults,
      issues: [
        {
          level: "error",
          code: "schema",
          message: `keybindings.json JSON 解析失败: ${err}`,
        },
      ],
      userConfigApplied: false,
    };
  }

  const { accepted, issues } = validateUserBindings(raw, defaults);

  // 把错误/警告写进日志，便于用户排查（不阻断启动）。
  for (const issue of issues) {
    if (issue.level === "error") {
      log.warn("KEYBINDING", `[键位配置错误] ${issue.message}`);
    } else {
      log.info("KEYBINDING", `[键位配置提示] ${issue.message}`);
    }
  }

  if (accepted.length === 0) {
    return { bindings: defaults, issues, userConfigApplied: false };
  }

  const merged = mergeBindings(accepted, defaults);
  log.info("KEYBINDING", `已应用 ${accepted.length} 条用户自定义键位`);
  return { bindings: merged, issues, userConfigApplied: true };
}
