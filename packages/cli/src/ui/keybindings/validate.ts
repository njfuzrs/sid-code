/**
 * 键位校验 — K3（运行时冲突检测 + 保留键保护 + schema 校验）
 *
 * 此前只有单测层 `keybindings-full-coverage.test.ts` 的表级不变量断言；K3 把这些
 * 保证提升为运行时校验，供 K2 的 loadUserBindings 在加载用户配置时调用：
 *
 * 1. schema 校验：用 zod 验证 keybindings.json 的结构（action/stroke 字段齐全、类型正确）。
 * 2. 冲突检测：同一组合键被绑到多个 action（含默认表 vs 用户表的交叉冲突）。
 * 3. 保留键保护：禁止把 Ctrl+C 等保留键重绑到其它 action（见 reservedShortcuts.ts）。
 *
 * 设计：纯函数，不读文件、不依赖 React，完全可单测。
 */

import { z } from "zod";
import type { Keystroke } from "./chord.ts";
import type { KeyBinding } from "./defaultBindings.ts";
import { strokeSignature, isReservedStroke } from "./reservedShortcuts.ts";

/** keybindings.json 里单条用户绑定的 zod schema。 */
export const KeystrokeSchema = z
  .object({
    name: z.string().min(1, "stroke.name 不能为空"),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional(),
    cmd: z.boolean().optional(),
  })
  .strict();

/**
 * 用户绑定 schema。
 * 用户配置只需写 action + stroke；display/description/showInHelp 是帮助展示用的
 * 可选元数据，缺省时由合并逻辑从默认表继承或填充。
 */
export const UserKeyBindingSchema = z
  .object({
    action: z.string().min(1, "action 不能为空"),
    stroke: KeystrokeSchema,
    display: z.string().optional(),
    description: z.string().optional(),
    showInHelp: z.boolean().optional(),
  })
  .strict();

/** 整个 keybindings.json 的 schema：绑定数组，或 { bindings: [...] } 包裹。 */
export const UserBindingsFileSchema = z.union([
  z.array(UserKeyBindingSchema),
  z.object({ bindings: z.array(UserKeyBindingSchema) }).strict(),
]);

export type UserKeyBindingInput = z.infer<typeof UserKeyBindingSchema>;

/** 一条校验问题。level=error 会导致该用户绑定被丢弃；warning 仅提示。 */
export interface BindingIssue {
  level: "error" | "warning";
  /** 机器可判类型，便于测试与上层分流。 */
  code:
    | "reserved"
    | "conflict"
    | "duplicate_action"
    | "schema";
  message: string;
  action?: string;
}

export interface ValidateResult {
  /** 通过校验、可安全合并的用户绑定（已剔除违规项）。 */
  accepted: KeyBinding[];
  /** 所有问题（error + warning）。 */
  issues: BindingIssue[];
}

/**
 * 解析并校验用户绑定原始 JSON 对象。
 *
 * @param raw       已 JSON.parse 的对象（数组或 { bindings }）。
 * @param defaults  默认绑定表，用于跨表冲突检测与元数据继承。
 * @returns         accepted（可合并）+ issues（错误/警告）。
 */
export function validateUserBindings(
  raw: unknown,
  defaults: KeyBinding[],
): ValidateResult {
  const issues: BindingIssue[] = [];

  // ── 1. schema 校验 ──
  const parsed = UserBindingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const e of parsed.error.issues) {
      issues.push({
        level: "error",
        code: "schema",
        message: `配置结构非法 @ ${e.path.join(".") || "(root)"}: ${e.message}`,
      });
    }
    return { accepted: [], issues };
  }

  const rawBindings: UserKeyBindingInput[] = Array.isArray(parsed.data)
    ? parsed.data
    : parsed.data.bindings;

  // 默认表里"每个 stroke 签名 → 它合法绑定的 action 集合"，用于保留键豁免判定。
  const defaultStrokeActions = new Map<string, Set<string>>();
  for (const d of defaults) {
    const sig = strokeSignature(d.stroke);
    if (!defaultStrokeActions.has(sig)) defaultStrokeActions.set(sig, new Set());
    defaultStrokeActions.get(sig)!.add(d.action);
  }

  const accepted: KeyBinding[] = [];
  const seenActions = new Set<string>();
  // 跨用户绑定的 stroke 占用表：签名 → action，用于检测用户内部冲突。
  const userStrokeOwner = new Map<string, string>();

  for (const ub of rawBindings) {
    const stroke = normalizeStroke(ub.stroke);
    const sig = strokeSignature(stroke);

    // ── 2. 保留键保护 ──
    if (isReservedStroke(stroke)) {
      // 豁免：用户把保留键绑回它在默认表里的原 action（如 Ctrl+C → app:quit）。
      const defaultActions = defaultStrokeActions.get(sig);
      const isRebindToSameAction =
        defaultActions !== undefined && defaultActions.has(ub.action);
      if (!isRebindToSameAction) {
        issues.push({
          level: "error",
          code: "reserved",
          action: ub.action,
          message: `保留键 ${formatStroke(stroke)} 不可重绑到 "${ub.action}"（系统保留）`,
        });
        continue;
      }
    }

    // ── 3a. 用户表内部重复 action ──
    if (seenActions.has(ub.action)) {
      issues.push({
        level: "warning",
        code: "duplicate_action",
        action: ub.action,
        message: `action "${ub.action}" 在用户配置中重复出现，后者覆盖前者`,
      });
      // 移除已接受的同 action 旧项，保留最后一条（后者覆盖）。
      const idx = accepted.findIndex((a) => a.action === ub.action);
      if (idx >= 0) accepted.splice(idx, 1);
    }

    // ── 3b. 用户表内部 stroke 冲突（不同 action 抢同一组合键）──
    const existingOwner = userStrokeOwner.get(sig);
    if (existingOwner && existingOwner !== ub.action) {
      issues.push({
        level: "error",
        code: "conflict",
        action: ub.action,
        message: `组合键 ${formatStroke(stroke)} 同时被 "${existingOwner}" 和 "${ub.action}" 占用`,
      });
      continue;
    }

    userStrokeOwner.set(sig, ub.action);
    seenActions.add(ub.action);
    accepted.push(materialize(ub, stroke, defaults));
  }

  return { accepted, issues };
}

/** 把可选修饰键补成 false，保证签名稳定。 */
function normalizeStroke(s: Keystroke): Keystroke {
  return {
    name: s.name,
    ctrl: !!s.ctrl,
    shift: !!s.shift,
    alt: !!s.alt,
    cmd: !!s.cmd,
  };
}

/** 人类可读的组合键展示，如 "Ctrl+Shift+K"。 */
export function formatStroke(s: Keystroke): string {
  const parts: string[] = [];
  if (s.ctrl) parts.push("Ctrl");
  if (s.shift) parts.push("Shift");
  if (s.alt) parts.push("Alt");
  if (s.cmd) parts.push("Cmd");
  // 单字符键大写（k → K）；多字符键名首字母大写（enter → Enter）。
  const name =
    s.name.length === 1
      ? s.name.toUpperCase()
      : s.name.charAt(0).toUpperCase() + s.name.slice(1);
  parts.push(name);
  return parts.join("+");
}

/** 把用户输入补全成完整 KeyBinding：缺省元数据从默认表同 action 继承或兜底。 */
function materialize(
  ub: UserKeyBindingInput,
  stroke: Keystroke,
  defaults: KeyBinding[],
): KeyBinding {
  const fromDefault = defaults.find((d) => d.action === ub.action);
  return {
    action: ub.action,
    stroke,
    display: ub.display ?? fromDefault?.display ?? formatStroke(stroke),
    description: ub.description ?? fromDefault?.description ?? "",
    showInHelp: ub.showInHelp ?? fromDefault?.showInHelp ?? false,
  };
}
