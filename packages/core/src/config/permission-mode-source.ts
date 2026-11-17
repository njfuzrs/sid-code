/**
 * 起始权限模式的来源解析与字面量归一。
 *
 * 为什么需要单独一层：`permissions.defaultMode` 在 SettingsSchema 里声明了很久，
 * 但生产代码没有一处读它（M2：用户写 `permissions.defaultMode: "acceptEdits"` 后
 * `permissionMode` 恒为 default）；`settings.local.json` 的顶层 `permissionMode`
 * 不在 PROJECT_BEHAVIOR_FIELDS 白名单里，静默失效（M17）；CC 的 `bypassPermissions`
 * 别名与拼错值既不归一也不提示（M3/M18）。
 *
 * 三件事共享同一个判据——「这份文件有没有资格指定这个档位」——所以放在一处，
 * 而不是在 config.ts 里散成三段互不相干的 if。
 *
 * 核心安全前提：项目级 `settings.json` 随仓库分发，任何人都能提交一个
 * `permissions.defaultMode: "dangerously-skip-permissions"`；之后 clone 这个仓库的人
 * 第一次启动就在无审批执行。所以「档位强度」必须与「来源可信度」绑定——
 * 这不是洁癖，是把「仓库自带配置能不能放宽权限」的答案固化成一张表。
 */

import { PERMISSION_MODES } from "./schema.ts";

/**
 * 解析结果来自哪一层；没有任何来源声明时为 `builtin`（config 默认值 default）。
 *
 * `flag` = `--settings` 显式传入（内存源，见 `SETTING_SOURCES`）：它比任何磁盘源都高，
 * 但低于企业 policy —— 与 settings 合并链同一顺序，否则「policy 压制 --settings」
 * 这条在权限档位上会破一个口子。
 */
export type StartModeOrigin = "policy" | "flag" | "local" | "project" | "user" | "builtin";

export interface StartModeDiagnostic {
  /** info 只用于「别名被改写」这类无需处置的提示，warning 表示用户配置没有按预期生效。 */
  level: "info" | "warning";
  message: string;
}

export interface StartModeResolution {
  /** 已归一的规范化模式名（恒为 PERMISSION_MODES 里的值） */
  mode: string;
  origin: StartModeOrigin;
  /** 被采用的原始字面量（归一前）；`builtin` 时无。用于遥测与诊断。 */
  raw?: string;
  diagnostics: StartModeDiagnostic[];
}

/**
 * 来源可信度。
 *
 * - `full`：用户级 settings / 企业 managed settings —— 用户自己的机器或管理员下发的策略，
 *   可以指定任何档位。
 * - `no-skip`：未被 git 追踪的 `settings.local.json` —— 名义上是「用户自己写的」，
 *   但它在项目目录里、可能被仓库脚本或安装脚本写入，skip 档必须排除。
 * - `restricted`：项目级 `settings.json`、被 git 追踪的 `settings.local.json` ——
 *   随仓库分发，只允许「不能放宽权限」的档位。
 */
export type SourceTrust = "full" | "no-skip" | "restricted";

/** 一份 settings 文件参与模式解析所需的事实。 */
export interface StartModeSource {
  origin: Exclude<StartModeOrigin, "builtin">;
  /** 诊断文案里的来源名，如「企业 managed settings」「项目级 settings.json」 */
  label: string;
  /** 原始 settings 对象（`getSettingsForSource(...).settings`） */
  settings: unknown;
  trust: SourceTrust;
}

/**
 * 项目级 / 被追踪 local 允许的档位：全是「当前模式下权限只会更紧或不变」的档位。
 *
 * `manual` 不在此列但同意——它归一成 `default` 后才进判断，归一发生在白名单之前。
 * `deny-write`：只读 + 不写；`dontAsk`：不问、默认拒绝；`plan`：不落地。
 */
const RESTRICTED_MODES: ReadonlySet<string> = new Set(["default", "plan", "dontAsk", "deny-write"]);

/**
 * 字面量别名。CC 用户按 CC 的名字写，sid 内部用规范名。
 *
 * 注意与 `dangerously-skip-permissions` 的关系：那是 sid 自己的规范名，不是别名。
 */
const MODE_ALIASES: Readonly<Record<string, string>> = {
  manual: "default",
  bypassPermissions: "always-allow",
};

const VALID_MODES: ReadonlySet<string> = new Set<string>(PERMISSION_MODES);

export type ModeLiteralKind = "valid" | "alias" | "invalid";

export interface NormalizedMode {
  /** 归一后的规范名；无效值落到 `default`（与「无效配置不能阻止启动」一致） */
  mode: string;
  raw: string;
  kind: ModeLiteralKind;
}

/**
 * 归一单个字面量。
 *
 * 无效值落到 `default` 而不是原样保留：原值保留会让下游 `isModeDisabledByPolicy`
 * 之类的判断拿到一个不在集合里的字符串，看起来「没被禁用」，实际却也没被识别——
 * 两边都不成立的状态最难排查。
 */
export function normalizePermissionModeLiteral(raw: string): NormalizedMode {
  const alias = MODE_ALIASES[raw];
  if (alias !== undefined) return { mode: alias, raw, kind: "alias" };
  if (VALID_MODES.has(raw)) return { mode: raw, raw, kind: "valid" };
  return { mode: "default", raw, kind: "invalid" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAllowed(mode: string, trust: SourceTrust): boolean {
  if (trust === "full") return true;
  if (trust === "restricted") return RESTRICTED_MODES.has(mode);
  return mode !== "dangerously-skip-permissions";
}

function rejectReason(trust: SourceTrust): string {
  if (trust === "restricted") {
    return "该模式只能由用户级设置或命令行指定（原因：防止仓库自带配置放宽权限）";
  }
  return "skip 档只能由命令行 flag 或用户级设置指定（原因：防止仓库内的脚本静默提权）";
}

/** 来源名 + 字段名拼成诊断前缀，避免多条 warning 分不清是哪份文件。 */
function where(label: string, field: string): string {
  return `${label} 里的 ${field}`;
}

/**
 * 按优先级解析起始模式。
 *
 * `sources` 必须按优先级从高到低传入（调用方负责顺序）。第一个「有值且被允许」的
 * 来源胜出，其后的来源不再参与——这与配置合并的 first-source-wins 语义一致，
 * 也保证低优先级来源的无效值不会刷出一堆用户无法处置的 warning。
 */
export function resolveStartPermissionMode(sources: StartModeSource[]): StartModeResolution {
  const diagnostics: StartModeDiagnostic[] = [];

  for (const src of sources) {
    const obj = asRecord(src.settings);
    if (!obj) continue;
    const perms = asRecord(obj.permissions);
    const nested = typeof perms?.defaultMode === "string" ? perms.defaultMode : undefined;
    // restricted 来源不读顶层字段：被追踪时它已被 SECURITY_SENSITIVE_FIELDS 滤掉，
    // 这里再挡一次是为了让「白名单」这件事不依赖上游过滤器的实现细节。
    const top =
      src.trust !== "restricted" && typeof obj.permissionMode === "string"
        ? obj.permissionMode
        : undefined;
    if (nested === undefined && top === undefined) continue;

    // 同文件内 `permissions.defaultMode` 优先于顶层 `permissionMode`。
    // 两者都写且归一后不同时给 warning：旧字段静默失效是最难查的那类配置问题
    // （用户看着 settings 里明明写了，行为却按另一个值走）。
    if (nested !== undefined && top !== undefined) {
      const nestedMode = normalizePermissionModeLiteral(nested).mode;
      const topMode = normalizePermissionModeLiteral(top).mode;
      if (nestedMode !== topMode) {
        diagnostics.push({
          level: "warning",
          message:
            `${src.label} 同时配置了 permissionMode="${top}" 与 permissions.defaultMode="${nested}"，` +
            `两者不一致，以后者为准（permissionMode 已被忽略）`,
        });
      }
    }

    const useNested = nested !== undefined;
    const field = useNested ? "permissions.defaultMode" : "permissionMode";
    const raw = (useNested ? nested : top) as string;
    const normalized = normalizePermissionModeLiteral(raw);

    if (normalized.kind === "alias" && raw !== "manual") {
      // manual 的归一是既有静默行为（P2-4），不为它新增启动噪音；
      // bypassPermissions 不同——用户按 CC 的名字写，sid 却映射到另一个语义更窄的档位，
      // 必须说清「跳过了什么、没跳过什么」，否则用户以为自己在无审批执行。
      diagnostics.push({
        level: "info",
        message:
          `${where(src.label, field)}="bypassPermissions" 已按 "always-allow" 处理：` +
          `受保护路径（.git/hooks、settings 等）仍需确认；如需完全跳过请用 --dangerously-skip-permissions`,
      });
    } else if (normalized.kind === "invalid") {
      diagnostics.push({
        level: "warning",
        message: `${where(src.label, field)}="${raw}" 不是有效权限模式，已按 "default" 启动`,
      });
    }

    if (!isAllowed(normalized.mode, src.trust)) {
      diagnostics.push({
        level: "warning",
        message: `${where(src.label, field)}="${raw}" 不生效：${rejectReason(src.trust)}`,
      });
      continue;
    }

    return { mode: normalized.mode, origin: src.origin, raw, diagnostics };
  }

  return { mode: "default", origin: "builtin", diagnostics };
}
