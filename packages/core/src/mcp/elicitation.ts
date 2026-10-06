/**
 * MCP Elicitation 机制
 * Server 向用户请求额外信息（表单填写、OAuth 授权 URL 等）
 *
 * D26/D28：原先唯一的实现 `cliElicitationHandler` 打印「授权完成后按 Enter 继续」却不读 stdin、
 * 立即回 accept（虚假的同意），表单一律 cancel（而 capability 已声明支持），且 6 处 console.log
 * 直写 stdout——TUI 下串屏、无头模式下污染结构化输出。注释承诺的「App 里的 UI 版覆盖」不存在。
 *
 * 现在交互走 ask-user-question-bridge（与模型的 ask_user_question 工具、降级弹窗同一条 TUI 通道）：
 * - TUI：app.ts 已注入提问处理器 → 弹出选择 / 输入对话框，用户的选择如实回传；
 * - headless / SDK / CI：无处理器 → 返回 decline，**不写 stdout**（日志走 logger）。
 * 复用桥而不是新写一个对话框组件，是因为 UI 层正在迁移渲染底座，新组件要写两遍。
 */

import { getLogger } from "../debug/logger.ts";
import type { ElicitRequest, ElicitResult } from "./types.ts";
import type {
  AskQuestion,
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from "../tool/ask-user-question-bridge.ts";

export type ElicitationHandler = (
  serverName: string,
  params: ElicitRequest["params"],
  signal?: AbortSignal,
) => Promise<ElicitResult>;

/**
 * 默认 handler：拒绝所有 elicitation 请求
 */
export const defaultElicitationHandler: ElicitationHandler = async () => {
  return { action: "cancel" };
};

/** 提问函数（测试可注入；缺省走 ask-user-question-bridge） */
export type AskFn = (
  request: AskUserQuestionRequest,
  signal?: AbortSignal,
) => Promise<AskUserQuestionResult>;

const URL_ACCEPT = "已在浏览器完成";
const URL_DECLINE = "拒绝";
const FORM_SKIP = "（留空）";
const BOOL_YES = "是";
const BOOL_NO = "否";

interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  default?: unknown;
}

/** 表单字段 → 一道题（无候选项的字段靠对话框自带的「其他…」自由输入） */
function fieldToQuestion(
  serverName: string,
  key: string,
  field: FieldSchema,
  required: boolean,
): AskQuestion {
  const title = field.title || key;
  const desc = field.description ? `（${field.description}）` : "";
  const options: AskQuestion["options"] = [];
  if (Array.isArray(field.enum)) {
    field.enum.forEach((v, i) =>
      options.push({ label: String(field.enumNames?.[i] ?? v), description: String(v) }),
    );
  } else if (field.type === "boolean") {
    options.push({ label: BOOL_YES }, { label: BOOL_NO });
  }
  // string / number / integer：没有候选项，靠对话框自带的「其他…」自由输入
  if (!required) options.push({ label: FORM_SKIP, description: "该项可选，不填写" });
  const kindHint =
    options.length === 0 || (!Array.isArray(field.enum) && field.type !== "boolean")
      ? "，选「其他…」输入"
      : "";
  return {
    question: `[${serverName}] ${title}${required ? "（必填）" : ""}${desc}${kindHint}`,
    header: title.slice(0, 12),
    options,
  };
}

/** 把用户答案按 schema 类型还原；失败返回 Error 描述 */
function coerceAnswer(answer: string, field: FieldSchema): { value?: unknown; error?: string } {
  if (answer === FORM_SKIP) return {};
  if (Array.isArray(field.enum)) {
    const idx = field.enumNames ? field.enumNames.indexOf(answer) : -1;
    if (idx >= 0) return { value: field.enum[idx] };
    const hit = field.enum.find((v) => String(v) === answer);
    if (hit !== undefined) return { value: hit };
    return { error: `不在可选值内: ${answer}` };
  }
  switch (field.type) {
    case "boolean":
      if (answer === BOOL_YES || answer === "true") return { value: true };
      if (answer === BOOL_NO || answer === "false") return { value: false };
      return { error: `不是布尔值: ${answer}` };
    case "number":
    case "integer": {
      const n = Number(answer);
      if (answer.trim() === "" || !Number.isFinite(n)) return { error: `不是数字: ${answer}` };
      if (field.type === "integer" && !Number.isInteger(n)) return { error: `不是整数: ${answer}` };
      return { value: n };
    }
    default:
      return { value: answer };
  }
}

/**
 * 构造一个通过提问通道交互的 elicitation handler。
 *
 * 语义（MCP 规范三态）：
 * - 无交互通道（unavailable）→ decline：诚实地告诉服务器「这里问不了用户」；
 * - 用户 ESC → cancel；用户选「拒绝」→ decline；
 * - 只有用户真的确认 / 填完表单才 accept。
 */
export function createElicitationHandler(ask?: AskFn): ElicitationHandler {
  return async (serverName, params, signal) => {
    const log = getLogger();
    const doAsk: AskFn =
      ask ?? (await import("../tool/ask-user-question-bridge.ts")).askUserQuestion;
    const { withHumanInputWait } = await import("../query/human-input-gate.ts");
    // 阻塞等用户期间关掉无进展看门狗（同 fallback 弹窗，见 human-input-gate.ts）
    const run = (req: AskUserQuestionRequest) => withHumanInputWait(() => doAsk(req, signal));

    // URL 模式：只有用户确认「已完成」才 accept
    if (params.url) {
      const question = `MCP 服务器 ${serverName} 请求您在浏览器打开以下链接：\n${params.url}\n${params.message ?? ""}`;
      const res = await run({
        questions: [
          {
            question,
            header: "MCP 授权",
            options: [
              { label: URL_ACCEPT, description: "已打开链接并完成操作" },
              { label: URL_DECLINE, description: "不打开该链接" },
            ],
          },
        ],
      });
      if (res.status === "unavailable") {
        log.info("MCP", `${serverName} 请求 URL elicitation，但当前无交互通道，已 decline`);
        return { action: "decline" };
      }
      if (res.status === "cancelled") return { action: "cancel" };
      return res.answers[question] === URL_ACCEPT ? { action: "accept" } : { action: "decline" };
    }

    // 表单模式：每个字段一道题
    const schema = params.requestedSchema as
      | { properties?: Record<string, FieldSchema>; required?: string[] }
      | undefined;
    if (schema) {
      const props = Object.entries(schema.properties ?? {});
      const required = new Set(schema.required ?? []);
      if (props.length === 0) {
        // 无字段的表单等价于一次确认
        return confirmOnly(serverName, params.message, run, log);
      }
      const questions = props.map(([k, f]) => fieldToQuestion(serverName, k, f, required.has(k)));
      // 第一题带上服务器给的说明
      if (params.message) questions[0].question = `${params.message}\n${questions[0].question}`;
      const res = await run({ questions });
      if (res.status === "unavailable") {
        log.info("MCP", `${serverName} 请求表单 elicitation，但当前无交互通道，已 decline`);
        return { action: "decline" };
      }
      if (res.status === "cancelled") return { action: "cancel" };

      const content: Record<string, unknown> = {};
      for (let i = 0; i < props.length; i++) {
        const [key, field] = props[i];
        const answer = res.answers[questions[i].question];
        if (answer === undefined) continue;
        const { value, error } = coerceAnswer(answer, field);
        if (error) {
          log.warn("MCP", `${serverName} 表单字段 ${key} ${error}，已 decline`);
          return { action: "decline" };
        }
        if (value !== undefined) content[key] = value;
      }
      for (const k of required) {
        if (!(k in content)) {
          log.warn("MCP", `${serverName} 表单必填字段 ${k} 未填写，已 decline`);
          return { action: "decline" };
        }
      }
      return { action: "accept", content };
    }

    // 纯消息：确认 / 拒绝
    return confirmOnly(serverName, params.message, run, log);
  };
}

async function confirmOnly(
  serverName: string,
  message: string | undefined,
  run: (req: AskUserQuestionRequest) => Promise<AskUserQuestionResult>,
  log: ReturnType<typeof getLogger>,
): Promise<ElicitResult> {
  const question = `MCP 服务器 ${serverName}: ${message ?? ""}`;
  const res = await run({
    questions: [
      {
        question,
        header: "MCP 请求",
        options: [{ label: "确认" }, { label: URL_DECLINE }],
      },
    ],
  });
  if (res.status === "unavailable") {
    log.info("MCP", `${serverName} 请求 elicitation，但当前无交互通道，已 decline`);
    return { action: "decline" };
  }
  if (res.status === "cancelled") return { action: "cancel" };
  return res.answers[question] === "确认" ? { action: "accept" } : { action: "decline" };
}

/**
 * CLI 主路径注入的 handler（cli.ts）。TUI / 无头由提问通道是否存在自动区分，见文件头。
 */
export const cliElicitationHandler: ElicitationHandler = createElicitationHandler();
