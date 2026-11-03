/**
 * 工具入参摘要（白名单键 + 截断）—— **只用于本地轨迹**。
 *
 * ## 为什么抽到 tool 域
 *
 * 这段逻辑原先是 `trace/collector.ts` 的私有函数，只有走 hook 的
 * `PreToolUse` 事件能用到（主循环 / 子代理）。**forked 路径不 fire hook、也不写
 * PreToolUse**（见 `agent/forked-agent.ts` 顶部与 `trace/digest.ts` 里
 * 「fork 的工具不进主 traj、也不进 PreToolUse」那段），它的工具入参此前**没有任何落点**。
 * 后果是实测会话 20261103-114056-3b4f9ca7 里 「session-memory fork 被拒的那条 bash 命令
 * 是什么」只能从模型事后叙述里猜 —— 一个本可以一条记录回答的问题。
 *
 * 抽出来让两条路径共用同一套键白名单与截断口径：改一处两边同步生效，不会出现
 * 「主循环记了 command、fork 忘了记」这种形状不一致。
 *
 * ## 隐私口径（改这里之前先读）
 *
 * 结果含**路径与命令原文**，只能进本地 `events.jsonl`。上传前由
 * `trace/uploader.ts` 的 `LOCAL_ONLY_EVENT_DATA_FIELDS` 按字段名 `input_summary` 剥掉。
 * ⛔ 不要把它塞进 `analytics/events.ts` 的 `emit` payload —— 那是外发通道，
 * 该文件顶部的三条硬约束（路径只出扩展名）在这里同样有效。
 */

/** input_summary 里允许出现的入参键：够还原「读了哪、搜了什么」，不落全量入参 */
const TOOL_INPUT_SUMMARY_KEYS = [
  "file_path",
  "path",
  "offset",
  "limit",
  "pattern",
  "glob",
  "output_mode",
  "type",
  // 后台任务等待口径：task_output / bg_task_get 的阻塞与上限、sub_agent / bash 的后台启动。
  // 回答「模型有没有阻塞、阻塞多久、上限给多少」，也是北极星「后台阻塞等待」的过滤键；
  // 此前只能从主循环 messages.json 手工统计，子代理一侧完全拿不到。都不含敏感内容。
  "block",
  "timeout",
  "task_id",
  "run_in_background",
] as const;

/** 字符串入参截断长度（command / pattern 可能很长或含敏感内容） */
const TOOL_INPUT_SUMMARY_STR_MAX = 200;

/**
 * 从工具入参里提取摘要。返回 `undefined` 表示没有可记的白名单字段
 * （例如 ls 的 `dir_path`、sub_agent 的 `prompt`），此时调用方不写该字段，
 * 事件形状与旧数据一致。
 */
export function summarizeToolInput(toolInput: unknown): Record<string, unknown> | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const ti = toolInput as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const clip = (v: string) =>
    v.length > TOOL_INPUT_SUMMARY_STR_MAX ? v.slice(0, TOOL_INPUT_SUMMARY_STR_MAX) : v;
  for (const k of TOOL_INPUT_SUMMARY_KEYS) {
    const v = ti[k];
    if (typeof v === "string") out[k] = clip(v);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  if (typeof ti.command === "string") out.command = clip(ti.command);
  // read_many 等多路径工具：只记数量与路径（各自截断），不记内容
  for (const k of ["paths", "file_paths"] as const) {
    const v = ti[k];
    if (Array.isArray(v)) {
      out[`${k}_count`] = v.length;
      out[k] = v.filter((x): x is string => typeof x === "string").map(clip);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
