/**
 * 工具结果 diff 输出生成
 *
 * Edit / Write 工具执行后,把"改了什么"以标准 unified diff 形式放进 output 字符串,
 * 供 TUI 的 DiffRenderer 解析高亮(识别依据是 output 中含 `@@` hunk 头)。
 *
 * 设计要点:
 * - 用 diff 库的 createPatch 生成标准 unified diff,DiffRenderer.parseDiffWithLineNumbers
 *   能直接解析(它会跳过 Index:/===/---/+++ 头,只取 @@ 之后的 hunk)。
 * - 这里主动剥掉 createPatch 的 4 行文件头,只保留从首个 @@ 起的 hunk,
 *   既让回传给 LLM 的内容更干净,也避免下游误判。
 * - 大改动有上限:超过 MAX_DIFF_LINES 行时截断 diff 主体并标注,
 *   避免一次大 write(整文件 + 前缀)把 LLM 上下文撑爆。UI 仍能高亮已展示部分。
 */

import { createPatch, structuredPatch, type StructuredPatchHunk } from "diff";
import { basename } from "path";

/** diff 主体最多保留的行数(超出则截断并标注),约束大改动的 token 开销 */
const MAX_DIFF_LINES = 500;

/**
 * 生成标准 unified diff(剥掉文件头,仅保留 hunk)。
 * 新建文件传 oldContent="" 即可,会得到全 `+` 行的 diff。
 *
 * @returns 可直接拼进工具 output 的 diff 文本;无变化时返回空串。
 */
export function formatUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  // 统一按 LF 比较,避免 CRLF 文件产生满屏 \r 噪声
  const oldNorm = oldContent.replace(/\r\n/g, "\n");
  const newNorm = newContent.replace(/\r\n/g, "\n");
  if (oldNorm === newNorm) return "";

  const name = basename(filePath);
  const patch = createPatch(name, oldNorm, newNorm, "", "", { context: 3 });

  // createPatch 头部固定为 4 行:Index: / ===== / --- / +++ 。
  // 只保留从首个 @@ 起的 hunk(DiffRenderer 本就跳过这些头,剥掉让内容更干净)。
  const hunkStart = patch.indexOf("\n@@");
  if (hunkStart === -1) return "";
  let body = patch.slice(hunkStart + 1);

  // 大改动截断:按行裁剪,保留可解析的 hunk 前缀
  const lines = body.split("\n");
  if (lines.length > MAX_DIFF_LINES) {
    const kept = lines.slice(0, MAX_DIFF_LINES);
    const omitted = lines.length - MAX_DIFF_LINES;
    kept.push(`\\ … 省略 ${omitted} 行 diff(改动过大,完整内容以文件为准）`);
    body = kept.join("\n");
  }

  return body;
}

/**
 * 生成结构化 diff hunks(供 TUI 直接渲染,绕过文本正则解析)。
 * 对标 claude-code utils/diff.ts:getPatchFromContents。
 *
 * 与 formatUnifiedDiff 同口径(CRLF→LF 归一、context:3),保证结构化路径与
 * 文本降级路径视觉一致。新建文件传 oldContent="" 即得全 `+` 行的 hunk。
 *
 * 返回的 hunk.lines 已带 ` `/`+`/`-` 前缀,可直接喂 UI 的 hunksToDiffLines。
 * 大 diff 不在此截断:UI 侧 planDiffWithContextCollapse + RawAnsi 阈值已处理性能。
 *
 * @returns StructuredPatchHunk[];无变化时返回空数组。
 */
export function buildStructuredPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): StructuredPatchHunk[] {
  const oldNorm = oldContent.replace(/\r\n/g, "\n");
  const newNorm = newContent.replace(/\r\n/g, "\n");
  if (oldNorm === newNorm) return [];

  const name = basename(filePath);
  return structuredPatch(name, name, oldNorm, newNorm, "", "", { context: 3 }).hunks;
}
