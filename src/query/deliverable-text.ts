/**
 * 交付物文本采集（缺口2 层次1 的输入端）
 *
 * 背景：环节③ 的三道机制（预注册证伪 / 矛盾中断 / 交付门禁）全部作用在**登记表状态**
 * 上，没有任何一处看过模型实际写出去的字。轨迹 20260730-142920-d98e7f16 里 H1-H6 全
 * refuted，而交付门禁只问"假设结清了吗"，不问"你交付物里那段结论是不是就是刚被推翻的
 * H3"——被推翻的说法可以原样写进交付物而不触发任何检查。机制3 声明的"不得作为结论
 * 交付"因此只是**声明**，不是**校验**。
 *
 * 本模块负责把 write/edit 类工具写出去的内容攒起来，供收尾时做文本层面的复用检查。
 *
 * 三条刻意的设计约束：
 *   1. **在工具调用点采集，不在收尾时回溯上下文**。交付物内容多为大段文本，收尾时
 *      上下文里可能已被 compact 折叠/截断，回溯不到；工具入参是它进入系统的唯一入口。
 *   2. **有上限，且丢头保尾**。长会话可能写出数百 KB，全存会白占内存；保留尾部是因为
 *      "最终结论"通常写在最后（越靠后越接近交付物定稿）。
 *   3. **按需采集**。调用方只在登记表真有 refuted 假设时才调进来——不用这套机制的
 *      会话（实测占 89.7%）不该为此付任何代价。
 *
 * 纯函数 + SessionState 存储，不读文件、不调 LLM，便于单测。
 */

import type { SessionState } from "../session/state.ts";

/** SessionState 里存交付物缓冲的键。 */
const DELIVERABLE_BUFFER_KEY = "hypothesisDeliverableText";

/**
 * 缓冲上限（字符）。
 *
 * 取 64 KB 的理由：足以覆盖一次典型的"写结论文档 + 改几处代码"，同时远小于会话
 * 上下文本身的量级，内存代价可忽略。超限时丢头保尾（见模块头注释约束 2）。
 */
export const DELIVERABLE_BUFFER_LIMIT = 64 * 1024;

/**
 * 会被视为"产出交付物"的工具名。
 *
 * 只收**写**类工具：读类工具的内容是**输入**而非模型的主张，把它们纳入会让检查变成
 * "你读到的文件里出现过这个词吗"——那必然全中，检查也就失去意义。
 *
 * notebook_edit 一并纳入：它同样是模型写出的内容，且 .ipynb 里常写结论性 markdown。
 */
const DELIVERABLE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "apply_patch",
]);

/** 该工具的输出是否算"交付物内容"。 */
export function isDeliverableTool(toolName: string): boolean {
  return DELIVERABLE_TOOL_NAMES.has(toolName.toLowerCase());
}

/**
 * 从工具入参里提取"模型写出去的文本"。
 *
 * 只取内容字段，**不取路径字段**：路径里的标识符（如 `src/query/hypothesis-ledger.ts`）
 * 不是模型的主张，把它算进交付物会让"假设里提到过某文件名"直接命中，纯误报。
 *
 * 覆盖各写类工具的字段命名差异（content / new_string / edits[].new_string / patch）。
 * 拿不到就返回空串——采集是尽力而为，漏采一次只是少一次检查机会，不该抛错。
 */
export function extractDeliverableText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];

  // write: { file_path, content }
  if (typeof obj["content"] === "string") parts.push(obj["content"]);
  // edit: { file_path, old_string, new_string } —— 只取 new_string（模型写入的那侧），
  // old_string 是被替换掉的旧内容，算不上模型的主张。
  if (typeof obj["new_string"] === "string") parts.push(obj["new_string"]);
  // notebook_edit: { new_source }
  if (typeof obj["new_source"] === "string") parts.push(obj["new_source"]);
  // apply_patch 类：{ patch } 整段 diff（含 +/- 行，可接受：误报方向由调用方的
  // 保守判据 + 疑问句文案兜住）
  if (typeof obj["patch"] === "string") parts.push(obj["patch"]);
  // multi_edit: { edits: [{ old_string, new_string }] }
  const edits = obj["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const ns = (e as Record<string, unknown>)["new_string"];
        if (typeof ns === "string") parts.push(ns);
      }
    }
  }
  return parts.join("\n");
}

/**
 * 把一次写类工具调用的内容追加进会话级缓冲。非写类工具直接跳过。
 *
 * 超限时丢头保尾（保留最后 DELIVERABLE_BUFFER_LIMIT 个字符）：最终结论通常写在最后，
 * 越靠后越接近交付物定稿。
 */
export function appendDeliverableText(
  sessionState: SessionState,
  toolName: string,
  input: unknown,
): void {
  if (!isDeliverableTool(toolName)) return;
  const text = extractDeliverableText(input);
  if (!text) return;
  const prev = (sessionState.get(DELIVERABLE_BUFFER_KEY) as string | undefined) ?? "";
  let next = prev ? `${prev}\n${text}` : text;
  if (next.length > DELIVERABLE_BUFFER_LIMIT) {
    next = next.slice(next.length - DELIVERABLE_BUFFER_LIMIT);
  }
  sessionState.set(DELIVERABLE_BUFFER_KEY, next);
}

/** 读会话级交付物缓冲（空串表示本会话尚无写类工具产出）。 */
export function getDeliverableText(sessionState: SessionState): string {
  return (sessionState.get(DELIVERABLE_BUFFER_KEY) as string | undefined) ?? "";
}

/** 清空缓冲（/clear 时调用，与 ledger.reset() 同步）。 */
export function resetDeliverableText(sessionState: SessionState): void {
  sessionState.delete(DELIVERABLE_BUFFER_KEY);
}
