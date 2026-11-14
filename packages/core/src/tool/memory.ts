/**
 * Memory 工具 - 让 LLM 主动保存记忆
 * 当前只有 /memory 斜杠命令能写记忆，此工具让 LLM 在对话中主动保存
 *
 * ADR-026: 写盘前过 SecretRedactHook.detect, 命中 secret 直接拒绝写入
 *          (纵深防御 — 不是 redact 后写入, 而是引导 LLM 不要写 secret)
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import type { MemoryStore, MemorySetResult } from "../memory/store.ts";
import { formatEvictionNotice } from "../memory/store.ts";
import { MEMORY_TYPES, type MemoryType } from "../memory/types.ts";
import { getLogger } from "../debug/logger.ts";
import { getSharedSecretRedactHook } from "../llm/hooks/secret-redact.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import { logMemoryWrite } from "../analytics/events.ts";

/**
 * 缺陷 12：写入质量的**软提示**（不拒绝，只把问题回给模型）。
 *
 * 为什么不做成硬拒绝：相对日期、快照形态都靠关键词判断，误判率不低——
 * 「今天的约定是…」可能是引用原话。硬拒绝会让一次合法保存失败且模型无从绕过；
 * 软提示让模型在同一轮用相同 key 覆盖修正，判断权仍在模型手里。
 * 主防线是提示词（memory/prompt.ts「不应保存」与「写法要求」）。
 *
 * ⚠️ 星期必须在列：§3.4 用来讲这条纪律的原例就是「周四冻结合并」，
 * 旧正则只认今天/下周这类词，原例本身漏检（2026-10-24 实测 0 条提示）。
 */
const RELATIVE_DATE_RE =
  /(今天|昨天|明天|前天|后天|本周|这周|下周|上周|本月|这个月|下个月|上个月|今年|明年|去年|(?:下|上|本|这)?(?:周|星期|礼拜)[一二三四五六日天]|\btoday\b|\byesterday\b|\btomorrow\b|\b(?:next|last|this) (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b)/i;

/**
 * Why / How to apply 必须是**行首标签**，不是正文里出现过的词。
 *
 * 旧正则 `/\bwhy\s*[:：]|为什么|原因[:：]/` 让「分支策略为什么用 GitHub Flow 我也说不清」
 * 这种恰恰没有理由的规则通过检查——命中的是一个疑问词。本机磁盘 feedback/project 里
 * 39 条没有规范的 `Why:` 行，其中 18 条正是靠这个宽松匹配逃过提示。
 * 判据是「**标签**」：出现在行首或句读之后（`。Why: …` 这种单行写法也算），
 * 带冒号且后面有内容。允许 `**Why:**` / `Why:` / `- Why：` 等写法；疑问词「为什么」不算。
 */
const LABEL_LEAD = String.raw`(?:^|[。．.;；!！?？，,]\s*)(?:[-*]\s*)?\**\s*`;
const LABEL_TAIL = String.raw`\s*\**\s*[:：]\s*\**\s*\S`;
const WHY_LINE_RE = new RegExp(`${LABEL_LEAD}why${LABEL_TAIL}`, "im");
const HOW_LINE_RE = new RegExp(`${LABEL_LEAD}how to apply${LABEL_TAIL}`, "im");

/**
 * 快照形态：§3.3/§3.4 明确要拒的「PR 状态 / 进度 / 截至某日的活动记录」。
 * 本机实测这类记忆照样被存了进来（`login_closure_pr_status`、`*_phase_status`…），
 * 而且当时没有任何信号能看到。判据只看 key 与首行（标题级措辞），不扫全文——
 * 正文里顺带提一个 PR 号是正常引用。
 */
const SNAPSHOT_RE = /(截至|截止到|进度|阶段状态|pr[-_ ]?status|progress|status\b|周报|活动日志)/i;

/**
 * P0-2（MD2）：后台提取代理写 feedback 时，正文里必须有「」包住的用户原话。
 *
 * 判据是「有原话可引」，不是「像不像一条规矩」。本缺陷的原始形态是
 * `feedback_browser_batch_screenshot` 这类条目：内容是 agent 自己的操作步骤
 * （怎么批量截图、按什么顺序跑命令），整条没有任何一句来自用户。这类文本再流畅，
 * 也不可能包含一对包住 ≥4 字的「」——所以才用这个结构性判据，而不是关键词黑名单
 * （「做法」「步骤」这类词在真正的用户原话里也会出现）。
 *
 * 为什么门槛是 4 字：`「X」` 这种单字引用多半是行文里的强调（「他说『要』」），
 * 不足以承载一句用户原话；20 字以上又会把「以后都跑 lint」这类短而明确的指令挡掉。
 */
const USER_QUOTE_RE = /「[^」]{4,}」/;

export interface MemoryWriteQuality {
  hasWhy: boolean;
  hasHow: boolean;
  hasUrl: boolean;
  relativeDate: string | null;
  looksSnapshot: boolean;
}

export function assessMemoryWrite(key: string, value: string): MemoryWriteQuality {
  const firstLine = value.split("\n").find((l) => l.trim()) ?? "";
  return {
    hasWhy: WHY_LINE_RE.test(value),
    hasHow: HOW_LINE_RE.test(value),
    hasUrl: /\bhttps?:\/\//i.test(value),
    relativeDate: value.match(RELATIVE_DATE_RE)?.[0] ?? null,
    looksSnapshot: SNAPSHOT_RE.test(key) || SNAPSHOT_RE.test(firstLine),
  };
}

export function memoryWriteHints(value: string, type: MemoryType, key = ""): string[] {
  const q = assessMemoryWrite(key, value);
  const hints: string[] = [];
  if (q.relativeDate) {
    hints.push(
      `含相对日期「${q.relativeDate}」：记忆会在很久之后被读到，请改写成绝对日期（YYYY-MM-DD）后用相同 key 覆盖。`,
    );
  }
  if (type === "feedback" || type === "project") {
    const missing = [!q.hasWhy && "Why:", !q.hasHow && "How to apply:"].filter(Boolean);
    if (missing.length > 0) {
      hints.push(
        `${type} 类正文缺少 ${missing.join(" 与 ")} 标签——没有理由的规则日后无法判断边界，请补上后用相同 key 覆盖。`,
      );
    }
  }
  if (type === "reference" && !q.hasUrl) {
    hints.push(
      "reference 类用于指向外部系统（URL / dashboard / ticket），这条正文没有 URL：若它是约定或决策，请改用 feedback / project 重存。",
    );
  }
  if (q.looksSnapshot) {
    hints.push(
      "这条像进度 / 状态快照：快照一周后就过期，但仍会被召回。请只保留其中非显而易见、以后还用得上的那一点（为什么、踩了什么坑），或者删掉它。",
    );
  }
  return hints;
}

/** Memory 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const memorySchema = lazySchema(() =>
  z.object({
    key: z.string().describe("记忆键名（简短描述性名称，如 'coding_style' 或 'test_framework'）"),
    value: z.string().describe("记忆内容（具体的偏好或约定）"),
    // 必填（2026-10-24）：此前没有 type 参数，类型全靠 inferMemoryType 关键词猜，
    // 本机实测两种失败——① 正文提到「文档」就判 reference（43 次调用 17 次误判）；
    // ② 模型想表达类型只能塞进 scope，后台代理 scope_denied 共 28 次（遥测口径）里 20 次是
    // scope=feedback/user/reference。类型是模型最清楚的语义，让它显式给。
    type: z
      .enum(MEMORY_TYPES)
      .describe(
        "记忆类型（必填）：user（用户画像）/ feedback（用户的纠正或确认，须带 Why: 与 How to apply:）/ project（无法从代码推导的项目决策与约束，须带 Why: 与 How to apply:）/ reference（外部系统指针，正文应含 URL）。类型填这里，不要填进 scope",
      ),
    scope: z
      .enum(["global", "project", "team", "agent"])
      .optional()
      .describe(
        "记忆范围：global（全局，所有项目）/ project（当前项目，默认）/ team（团队共享，同步给所有协作者）/ agent（当前子代理类型的跨会话领域经验，仅在子代理内可用）",
      ),
  }),
);

export class MemoryTool implements Tool {
  private store: MemoryStore;
  /** 当前子代理类型（仅子代理隔离工具集里注入；主会话为 undefined，此时 agent scope 不可用） */
  private agentType?: string;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = memorySchema();

  /**
   * 声明读执行器注入的 `_agentId`（契约见 `tool/types.ts`）：`writeVia` 用它区分写入来源
   * 是主会话 / forked 代理 / 子代理。漏声明会让所有来源都记成 `main`，遥测里的来源分布
   * 从此失真（不报错，只是数字变错——属于静默失败）。
   */
  readonly consumesAgentId = true as const;

  /**
   * P0-2（MD2）：声明读执行器注入的 `_querySource`（契约见 `tool/types.ts`）。
   * 后台提取代理写 feedback 时的「必须带用户原话」闸门靠在它上面——`_agentId` 只能
   * 分辨到 "forked" 粒度，会把 auto-dream / session-memory-update 一起拦掉。
   * 拿不到时（主会话 / 子代理 / 直接 execute）闸门不触发，这是安全默认。
   */
  readonly consumesQuerySource = true as const;

  constructor(store: MemoryStore, agentType?: string) {
    this.store = store;
    this.agentType = agentType;
  }

  /**
   * 派生一个绑定了 agentType 的副本（共享同一 MemoryStore）。
   * 供子代理隔离工具集使用——让 save_memory 的 agent scope 能定位到当前子代理类型目录。
   */
  withAgentType(agentType: string): MemoryTool {
    return new MemoryTool(this.store, agentType);
  }

  /** 低风险工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "save_memory";
  }

  description(): string {
    return "保存记忆到持久化存储。用于记录用户偏好、项目约定、重要决策等信息。";
  }

  usageGuide(): string {
    return `- 当用户要求**跨会话**记住（以后都... / 我偏好... / 下次...）时使用；只说"记住"要看内容在未来会话里是否仍有用
- 发现用户的编码风格偏好、项目约定、重要决策时，主动保存为记忆
- 记忆会持久化到磁盘，下次对话时自动加载
- 项目记忆优先于全局记忆
- team 范围：团队共享约定/规范，会同步给所有协作者（需启用 teamMemory）；含 secret 会被拒绝
- agent 范围：仅子代理内可用——沉淀「这一类子代理」跨会话复用的领域经验（常见坑、领域约定、有效方法），下次同类型子代理开工时自动注入
- type 必填：user / feedback / project / reference；类型填 type，不要填进 scope
- feedback / project 正文用行首的 Why: 与 How to apply: 两行写明理由与用法
- 不要保存只在本会话内用的临时信息（口令、暗号、样例值、上下文复述测试），即使用户说了"记住"
- 用户说"不要写入记忆 / 不要调用工具"时，一律不保存
- 不适合保存：会话状态、进度/PR 状态快照、敏感数据（API Key 等）、已在 CLAUDE.md 中的内容`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(memorySchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      key: string;
      value: string;
      type?: string;
      scope?: "global" | "project" | "team" | "agent";
      /** forked / 子代理执行器注入的来源标记（见 agent/forked-agent.ts、agent/sub-agent.ts） */
      _agentId?: string;
      /** P0-2：本次 fork 的任务标签（只在自报 consumesQuerySource 时有值，主会话/子代理为 undefined） */
      _querySource?: string;
    };

    if (!params.key || !params.value) {
      return { output: "错误: 缺少 key 或 value 参数", isError: true };
    }

    // 执行器的 zod 校验已经拦过一次；这里再判一次是因为 execute 也会被直接调用
    // （测试、未走 validateToolInput 的旧路径），type 缺失时绝不能退回关键词猜测——
    // 那正是本次要去掉的失败形态。
    if (!isMemoryTypeValue(params.type)) {
      return {
        output: `错误: 缺少或非法的 type 参数，必须是 ${MEMORY_TYPES.join(" / ")} 之一（类型填 type，不要填进 scope）`,
        isError: true,
      };
    }
    const type: MemoryType = params.type;

    // 输入清洗
    const key = params.key.replace(/\n/g, " ").trim();
    const value = params.value.trim();
    const scope = params.scope || "project";
    const via = writeVia(params._agentId);

    if (key.length === 0) {
      return { output: "错误: key 不能为空", isError: true };
    }

    if (value.length === 0) {
      return { output: "错误: value 不能为空", isError: true };
    }

    // 长度限制
    if (value.length > 10000) {
      return { output: "错误: value 过长（最多 10000 字符）", isError: true };
    }

    // ADR-026 §4.2 第 3 项: save_memory 写盘前过 secret-redact 检测
    // 命中 secret 时拒绝写入 (RL-002 不泄露凭证 — 纵深防御)
    const redactHook = getSharedSecretRedactHook();
    const secretHits = redactHook.detect(value);
    if (secretHits.length > 0) {
      const categories = Array.from(new Set(secretHits.map((h) => h.category))).join(", ");
      log.warn("TOOL", `✗ 拒绝保存含 secret 的记忆 [${scope}] ${key} — 命中: ${categories}`);
      // P1-12 指标 ③：这条防线**本来就在**（ADR-026），此前只是没有计数 ——
      // 于是「secret 闸门拦下过几次」这个问题在轨迹里答不出来，
      // 也就无从对比 P1-8 新补的两条线是否真的开始工作。
      try {
        const { logMemoryGuard } = await import("../analytics/events.ts");
        logMemoryGuard({ kind: "secret_rejected", via: "save_memory", scope });
      } catch {
        /* 埋点失败不影响拒绝行为 */
      }
      return {
        output:
          `错误: 检测到 value 中包含敏感信息 (${categories}), 拒绝写入持久化存储.\n` +
          `安全建议: 请勿把 API Key / token / 密码等凭证存到 memory. ` +
          `这类信息应该放在 .env 或环境变量, 通过 process.env 在运行时读取.\n` +
          `如需保存与凭证相关的元信息, 请仅描述类型 (例如 "用户使用 GitHub Personal Access Token 调 API"), ` +
          `不要把凭证明文写入 value 字段.`,
        isError: true,
      };
    }

    // P0-2（MD2）：后台提取代理写 feedback 类记忆时，正文里必须有「」包住的用户原话。
    //
    // 为什么只拦 memory-extract：主模型写记忆通常就是用户当轮明确要求的事，它手上的
    // 原话就在上下文里；而提取代理面对的是「用户没反对」的静默采纳，把 agent 自己的
    // 操作步骤复述成 feedback（本缺陷的原始形态）时，没有任何原话可引。
    //
    // 为什么用 _querySource 而不是 via：via 只能分辨到 "forked" 粒度，那个粒度同时
    // 覆盖 auto-dream / session-memory-update —— 按 via 拦会把它们的写入一起打掉，
    // 而且失败形态是「写入静默减少」，没人会发现。
    //
    // 拿不到 _querySource（主会话 / 子代理 / 直接调 execute）一律放行：
    // 那是安全默认，见 tool/types.ts 的 consumesQuerySource 契约。
    if (
      type === "feedback" &&
      params._querySource === "memory-extract" &&
      !USER_QUOTE_RE.test(value)
    ) {
      log.warn("TOOL", `✗ 拒绝保存缺少用户原话的 feedback 记忆 [${scope}] ${key}`);
      try {
        const { logMemoryGuard } = await import("../analytics/events.ts");
        logMemoryGuard({ kind: "feedback_no_quote", via: "save_memory", scope });
      } catch {
        /* 埋点失败不影响拒绝行为 */
      }
      return {
        output:
          "错误: feedback 类记忆必须在正文里逐字引用用户原话（用「」包住，至少 4 个字）。\n" +
          "判据: 没有原话的 feedback 多半是 agent 自己推断出来的「用户会喜欢这样」，" +
          "而不是用户真的说过——本缺陷的原始形态就是把 agent 的操作步骤写成了经验。\n" +
          "改正方式: 把你依据的那句用户原话原样放进 value，例如 用户说「以后提交前都跑一遍 lint」。\n" +
          "若找不到这样一句原话，这条就不是 feedback：它是 agent 自己的操作步骤，不要保存。",
        isError: true,
      };
    }

    log.info("TOOL", `▶ 保存记忆 [${scope}] ${key}`);

    // team scope：写入团队共享记忆目录（落盘后由 watcher 同步到共享目录）
    if (scope === "team") {
      const { getTeamMemoryOptions } = await import("../memory/team/runtime.ts");
      const { isTeamMemoryEnabled } = await import("../memory/team/paths.ts");
      const teamOpts = getTeamMemoryOptions();
      if (!isTeamMemoryEnabled(teamOpts)) {
        return {
          output:
            "错误: 团队记忆未启用。请在配置中设置 teamMemory.enabled=true（并配置共享目录 teamMemory.dir）后再用 team 范围。\n" +
            "或改用 project / global 范围保存到本地记忆。",
          isError: true,
        };
      }
      try {
        const { saveTeamMemory } = await import("../memory/team/store.ts");
        const result = await saveTeamMemory(key, value, { type });
        if (!result.success) {
          log.warn("TOOL", `✗ 团队记忆保存失败 ${key}: ${result.error}`);
          return { output: `错误: ${result.error}`, isError: true };
        }
        log.info("TOOL", `✓ 团队记忆已保存 ${key}`);
        return {
          output:
            `记忆已保存到团队共享范围（将同步给所有协作者）:\n键: ${key}\n值: ${preview(value)}` +
            reportWrite(key, value, type, scope, via),
        };
      } catch (err: any) {
        return { output: `保存团队记忆失败: ${err.message}`, isError: true };
      }
    }

    // agent scope（G13）：写入当前子代理类型的跨会话领域记忆。
    // 只在子代理隔离工具集里注入了 agentType 时可用；主会话无 agentType → 引导改用 project。
    if (scope === "agent") {
      if (!this.agentType) {
        return {
          output:
            "错误: agent 范围仅在子代理内可用（用于沉淀该类型子代理的跨会话领域经验）。\n" +
            "主会话请改用 project / global 范围。",
          isError: true,
        };
      }
      try {
        const { saveAgentMemory } = await import("../memory/agent-store.ts");
        await saveAgentMemory(this.agentType, key, value, { type });
        log.info("TOOL", `✓ agent 记忆已保存 [${this.agentType}] ${key}`);
        return {
          output:
            `记忆已保存到 agent 范围（${this.agentType} 类型跨会话领域经验）:\n键: ${key}\n值: ${preview(value)}` +
            reportWrite(key, value, type, scope, via),
        };
      } catch (err: any) {
        return { output: `保存 agent 记忆失败: ${err.message}`, isError: true };
      }
    }

    try {
      // PR-A（A2）：`set()` 现在回传淘汰明细 —— 满额时这次写入的真实代价
      // 必须出现在工具结果里，模型同一轮就能看到并决定删掉临时记忆。
      const result = await this.store.set(key, value, scope, { type });

      log.info("TOOL", `✓ 记忆已保存 [${scope}] ${key}`);

      const scopeLabel = scope === "global" ? "全局" : "项目";
      return {
        output:
          `记忆已保存到${scopeLabel}范围:\n键: ${key}\n值: ${preview(value)}` +
          reportWrite(key, value, type, scope, via, result) +
          formatEvictionNotice(result.evicted),
      };
    } catch (err: any) {
      return { output: `保存记忆失败: ${err.message}`, isError: true };
    }
  }
}

function isMemoryTypeValue(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

function preview(value: string): string {
  return `${value.slice(0, 100)}${value.length > 100 ? "..." : ""}`;
}

/** 写入来源：主会话 / 后台 forked 代理（记忆提取等）/ 子代理。取自执行器注入的 `_agentId`。 */
function writeVia(agentId: string | undefined): "main" | "forked" | "subagent" {
  if (agentId === "forked-agent") return "forked";
  if (agentId === "sub-agent") return "subagent";
  return "main";
}

/**
 * 四个 scope 共用的写入善后：算质量信号 → 埋点 → 拼提示。
 *
 * 旧实现只有 project/global 分支调提示，team/agent 存完直接 return——
 * 会同步给全体协作者的 team 记忆反而一道格式闸都没有。
 * 埋点与提示用**同一次** assess 结果：提示说了什么，曲线上就记了什么，两边不会各算各的。
 *
 * PR-A（A3）：project/global 路径额外传入 `set()` 结果，据此上报 `is_new_key` /
 * `evicted_count`。team/agent 两条线走各自的 store，给不出同口径的「是否新建」判据，
 * 所以不传 → 事件里不带这两个字段（也就不进「新建写入平均挤掉几条」的分母）。
 */
function reportWrite(
  key: string,
  value: string,
  type: MemoryType,
  scope: string,
  via: "main" | "forked" | "subagent",
  result?: Pick<MemorySetResult, "isNewKey" | "evicted">,
): string {
  const q = assessMemoryWrite(key, value);
  const hints = memoryWriteHints(value, type, key);
  logMemoryWrite({
    scope,
    type,
    via,
    quality: q,
    hintCount: hints.length,
    ...(result ? { isNewKey: result.isNewKey, evictedCount: result.evicted.length } : {}),
  });
  return hints.length > 0
    ? `\n\n⚠️ 写入质量提示（已保存，可选修正）:\n- ${hints.join("\n- ")}`
    : "";
}
