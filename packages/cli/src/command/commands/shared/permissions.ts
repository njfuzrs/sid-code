/**
 * permissions.ts 迁移时被多条命令共用的辅助函数（命令体系收口时拆出）。
 */

/** 解析 /allow /deny 的参数：剥离 -p/--persist/save 与 --scope，剩余拼回规则文本。 */
export function parseRuleArgs(args: string): {
  rule: string;
  persist: boolean;
  scope: "user" | "project";
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let persist = false;
  let scope: "user" | "project" = "user";
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-p" || t === "--persist" || t === "save") {
      persist = true;
    } else if (t === "--scope" || t === "-s") {
      // 下一个 token 是 scope 值（user / project）。
      const val = tokens[i + 1];
      if (val === "project" || val === "user") {
        scope = val;
        i++; // 跳过已消费的值
      }
    } else if (t === "--project") {
      scope = "project";
    } else if (t === "--user") {
      scope = "user";
    } else {
      rest.push(t);
    }
  }
  return { rule: rest.join(" "), persist, scope };
}

/**
 * 把 allow/deny 规则持久化到 settings.json 的 permissions.allow / permissions.deny 数组。
 * 复用 /skills 的读-合并-补丁范式：只改 permissions 单顶层字段，其余原样保留
 * （禁整体覆盖 writeSettingsFile——见 settings 有损 round-trip 陷阱）。
 * 返回持久化结果描述（成功/已存在/失败），供命令拼进回显。
 */
export function persistPermissionRule(
  behavior: "allow" | "deny",
  rule: string,
  scope: "user" | "project",
): string {
  try {
    const source = scope === "project" ? "projectSettings" : "userSettings";
    const {
      getSettingsForSource,
      patchSettingsFile,
    } = require("@sid-code/core/config/settings/index.ts");
    const { settings } = getSettingsForSource(source);
    // 保留用户已有的 allow/deny/ask/defaultMode，仅在对应数组里增量追加。
    const perms: Record<string, unknown> = { ...(settings?.permissions ?? {}) };
    const list: string[] = Array.isArray(perms[behavior]) ? [...(perms[behavior] as string[])] : [];
    if (list.includes(rule)) {
      return `（${scope} settings.json 中已存在该 ${behavior} 规则，未重复写入）`;
    }
    list.push(rule);
    perms[behavior] = list;
    patchSettingsFile(source, "permissions", perms);
    return `，并已保存到 ${scope} settings.json（跨会话生效）`;
  } catch (e) {
    return `（⚠ 持久化失败: ${(e as Error)?.message}，仅当前会话生效）`;
  }
}
