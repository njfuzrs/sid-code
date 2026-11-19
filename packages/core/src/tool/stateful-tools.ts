/**
 * 有状态工具工厂
 *
 * read / edit / read_many 共享一个 FileReadTracker 实例来实现「先读后写」校验。
 * tracker 是 per-session 可变状态：主代理与子代理必须各自持有独立 tracker，
 * 否则子代理的读取会污染主代理的缓存新鲜度判断、绕过先读后写护栏（见
 * docs/bugfixes/todo/子代理委托机制 §3 缺口 1）。
 *
 * 把「如何用指定 tracker 构造这组工具」收敛到单一工厂，供主代理（cli.ts）和
 * 进程内子代理（sub-agent.ts）共用，避免构造逻辑散落两处漂移。
 */

import type { LegacyTool as Tool } from "./types.ts";
import { FileReadTracker } from "./file-read-tracker.ts";
import { ReadHistory, ReadTool } from "./read.ts";
import { EditTool } from "./edit.ts";
import { ReadManyTool } from "./read-many.ts";
import { WriteTool } from "./write.ts";
import { NotebookEditTool } from "./notebook-edit.ts";

/**
 * 持有 FileReadTracker 状态的工具名集合。
 * 子代理隔离时据此判断「哪些工具需用独立 tracker 重建、哪些可安全复用父实例」。
 * PR-6：notebook_edit 加入——它现在也持 tracker（冲突闸门 + 写后回写），
 * 子代理若复用父实例，回写的是**父** tracker，自己紧接的 edit 会被误判外部修改
 * （与 F1 bash 当初的问题同型）。
 */
export const STATEFUL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "read_many",
  "write",
  "notebook_edit",
]);

/**
 * 用指定 tracker 构造一组有状态工具（read / edit / read_many / write / notebook_edit）。
 *
 * 这五个工具持有 tracker 引用，是「先读后写」校验与并发冲突检测的状态载体。
 * write 与 edit 共享同一 tracker：write 写入后回写 tracker（后续 edit 不被"没读过"
 * 拒绝），且覆盖已有文件前做先读后写 + 陈旧检测。notebook_edit 同理（PR-6/B8）。
 * grep/glob/ls/bash/web_* 等无 per-session 可变状态，不在此工厂内——复用单例
 * 实例即可，无需重建。
 */
export function createStatefulTools(
  tracker: FileReadTracker,
  isPathHidden?: (absPath: string) => boolean,
): Tool[] {
  // R1：read 与 read_many 共用一份读窗口登记，否则「先 read_many 再 read 同一文件」
  // 这类重复读在 ReadHint 事件与重复读提示里完全看不见（方案 20261116 §4.5）。
  // 每次调用新建一份：主代理与子代理各自持有（子代理会用独立 tracker 重新调用本工厂），
  // 不会跨作用域污染。
  const readHistory = new ReadHistory();
  const readMany = new ReadManyTool(tracker, undefined, readHistory);
  if (isPathHidden) readMany.setPathHiddenFilter(isPathHidden);
  return [
    new ReadTool(tracker, readHistory),
    new EditTool(tracker),
    readMany,
    new WriteTool(tracker),
    new NotebookEditTool(tracker),
  ];
}
