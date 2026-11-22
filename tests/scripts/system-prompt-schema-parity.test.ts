/**
 * system-prompt-schema-parity —— 「提示词说必须 + 工具 schema 判 optional」不同源普查门禁（L-2）
 *
 * ## 这个门禁在防什么
 *
 * D-08 是一个已经发生的实例：bash 的 `description` 参数被提示词写成「必须提供
 * description 参数」，而 schema 里它是 `optional()`。模型一旦发现可以不写，对提示词里
 * **其它**「必须」的信任度会跟着下降 —— 这不是某一个参数的问题，是「提示词与 schema
 * 各说一套」这种失效形态的问题。
 *
 * L-2 本轮做过一次人工普查（结论：只有 D-08 一例），但人工普查不会随代码变化重跑。
 * 本文件把它做成门禁：**解析每个工具的 zod schema 找出 optional 参数，再在最终提示词
 * 文本里找「必须/务必 + 该参数名」的共现，命中即红**。
 *
 * ## 为什么两侧都要取"真实的最终形态"
 *
 * - schema 侧取 `zodSchema`（工具的真实运行时校验器），不是手写 `inputSchema()` ——
 *   两者在迁移期可能不一致，而模型看到的定义优先走 zodSchema。
 * - 提示词侧取 `buildSystemPrompt()` 的产物，不是源码字面量 —— 中英双档、语言条件段、
 *   装饰符拼接都只出现在最终文本里。**两档都要过**：en 档漏改同样是「同源」被破坏。
 *
 * ## 判据边界（宁窄勿宽）
 *
 * 只认「必须/务必 + 紧邻参数名」这一种句式。理由：宽判据（同句共现）会把
 * `使用 bash 工具，必须提供 description 参数说明命令意图，设置合理的超时时间`
 * 里的 `timeout` 也算命中（`timeout` 是 optional 且本来就该 optional），
 * 这种误报会逼人给门禁加白名单，最后白名单长得把门禁本身盖住。
 *
 * ## D-08 的状态
 *
 * D-08 由另一个单元修（schema 改必填）。修完后本门禁自然变绿；在它修完之前本文件
 * **预期红一次**，且报错会明确指向 bash.description —— 这是门禁在正常工作，不要放宽判据。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import type { Tool } from "@sid-code/core/tool/types.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { GlobTool } from "@sid-code/core/tool/glob.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
// L-2 复核轮补齐：这 7 个工具在此前的手工覆盖集里缺席，而它们同样声明 zodSchema、
// 同样有 optional 参数（select / message / name / task_id / delay_seconds 等）。
// 漏掉它们不是「当前没有漂移」，而是「漂移了也看不见」—— 普查的意思是扫到每一块面。
import { ToolSearchTool } from "@sid-code/core/tool/tool-search.ts";
import { TeamMessageTool } from "@sid-code/core/tool/team-message.ts";
import { TeamCreateTool } from "@sid-code/core/tool/team-create.ts";
import { StructuredTaskGetTool } from "@sid-code/core/tool/structured-task-get.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { SendMessageTool } from "@sid-code/core/tool/send-message.ts";
import { ScheduleWakeupTool } from "@sid-code/core/tool/schedule-wakeup.ts";

/**
 * 取 zod 对象顶层字段里「optional」的参数名集合。
 *
 * `.min(1)` 之类的链式修饰不改变 optional 判定：判定只看外层是否接受 undefined，
 * 与「给了值之后要多严格」是两件事。
 */
export function optionalTopLevelParamNames(schema: unknown): Set<string> {
  const out = new Set<string>();
  if (!(schema instanceof z.ZodObject)) return out;
  const shape = (schema as z.ZodObject<any>).shape as Record<string, unknown>;
  for (const [key, field] of Object.entries(shape)) {
    // safeParse(undefined) 成功 = 该参数可以不传
    const parsed = (field as z.ZodType).safeParse(undefined);
    if (parsed.success) out.add(key);
  }
  return out;
}

/**
 * 在提示词文本里找「必须/务必 + 紧邻参数名」的共现。
 *
 * 参数名允许被同一种装饰符包住（`` `description` `` / `**limit**` / `"cwd"` / `'limit'`）；
 * 夹杂其它文字（「必须提供 description 参数」）按原句式处理：`必须` + 可选修饰 + 参数名。
 */
export function findMustClaims(text: string, params: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const p of params) {
    // 参数名两侧允许 0-1 个包裹符、中间允许一个空格或"提供/传入/填"这类动词前的空白
    const re = new RegExp(`(?:必须|务必)(?:[^\\n]{0,8}?)[^\\w]?${escapeRe(p)}(?![\\w])`, "g");
    if (re.test(text)) hits.push(p);
  }
  return hits;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 本门禁覆盖的工具集合。
 *
 * 为什么是手工列而不是扫目录自动发现：工具的构造参数各不相同（需要 fake 依赖），
 * 而本门禁只需要 `zodSchema`，自动发现要么靠反射（Bun 无 import.meta.glob），
 * 要么靠正则解析 `zodSchema = xxxSchema()` 的间接定义（不可靠）。
 *
 * 覆盖边界：**新增工具时必须同时加进这里**，否则它就是一个「漂移了也看不见」的盲区。
 * 当前覆盖 13 个：6 个核心工具（bash/read/write/edit/glob/grep）+ 7 个复核轮补入的
 * 延迟工具（tool_search / team_message / team_create / structured_task_get /
 * structured_task_create / send_message / schedule_wakeup）。后者此前缺席，
 * 而它们同样声明 zodSchema、同样有 optional 参数。
 */
function coveredTools(): Tool<any, any>[] {
  return [
    new BashTool(null as any),
    new ReadTool(null as any),
    new WriteTool(null as any),
    new EditTool(null as any),
    new GlobTool(),
    new GrepTool(),
    // 以下 7 个是复核轮补入的（见 import 段注释）
    new ToolSearchTool(new Registry() as any),
    new TeamMessageTool(),
    new TeamCreateTool({} as never, {} as never),
    new StructuredTaskGetTool(),
    new TaskCreateTool(),
    new SendMessageTool(),
    new ScheduleWakeupTool(),
  ] as unknown as Tool<any, any>[];
}

/**
 * 工具名。老接口 `name()` 方法、新接口 `name` 字符串属性（见 `tool/types.ts`），
 * 本文件不关心是哪种（只用于报错文本，不参与判定）。
 */
function toolName(t: any): string {
  return typeof t.name === "function" ? t.name() : String(t.name);
}

function renderPrompt(language: "zh" | "en"): string {
  clearPromptCache();
  const registry = new Registry();
  for (const t of coveredTools()) registry.register(t);
  return buildSystemPrompt({
    tools: registry.enabled(),
    preferredLanguage: language,
    workingDir: "/tmp/schema-parity",
    gitStatus: false,
    model: "claude-opus-5",
  });
}

describe("L-2 提示词「必须」与工具 schema optional 不同源普查", () => {
  for (const language of ["zh", "en"] as const) {
    test(`${language} 档：任何 optional 参数都不得被提示词说成「必须」`, () => {
      const text = renderPrompt(language);
      const problems: string[] = [];
      for (const tool of coveredTools()) {
        const optional = optionalTopLevelParamNames(tool.zodSchema);
        if (optional.size === 0) continue;
        const hits = findMustClaims(text, optional);
        if (hits.length > 0) {
          problems.push(
            `${toolName(tool)}: ${hits.join(", ")}（schema 判 optional，提示词却要求必须）`,
          );
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

describe("门禁自身的判据（变异自证）", () => {
  test("optional 判定：must / optional 混排时只挑出 optional 的那个", () => {
    const schema = z.object({
      command: z.string(),
      description: z.string().min(1),
      cwd: z.string().optional(),
      limit: z.number().optional(),
    });
    expect([...optionalTopLevelParamNames(schema)].sort()).toEqual(["cwd", "limit"]);
  });

  test("共现判据：命中「必须 + 参数名」，不误伤「可限定」里的子串，也不因远端参数名误报", () => {
    const text = [
      "使用 bash 工具，必须提供 description 参数说明命令意图，设置合理的超时时间",
      "可以用 `cwd` 指定工作目录，limit 默认 2000",
    ].join("\n");
    expect(findMustClaims(text, ["description", "cwd", "limit", "timeout"])).toEqual([
      "description",
    ]);
    // 反向：把参数名从「必须」旁边挪走就不再命中（否则判据形状是错的）
    expect(findMustClaims("可以指定 description", ["description"])).toEqual([]);
  });

  test("真实提示词里确实存在「必须 + 参数名」的句式（门禁不是在空气上判）", () => {
    const text = renderPrompt("zh");
    expect(findMustClaims(text, ["description"])).toContain("description");
  });
});
