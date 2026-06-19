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
import { ReadTool } from "./read.ts";
import { EditTool } from "./edit.ts";
import { ReadManyTool } from "./read-many.ts";

/**
 * 持有 FileReadTracker 状态的工具名集合。
 * 子代理隔离时据此判断「哪些工具需用独立 tracker 重建、哪些可安全复用父实例」。
 */
export const STATEFUL_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "edit", "read_many"]);

/**
 * 用指定 tracker 构造一组有状态工具（read / edit / read_many）。
 *
 * 这三个工具持有 tracker 引用，是「先读后写」校验的状态载体。grep/glob/ls/bash/web_*
 * 等无 per-session 可变状态，不在此工厂内——复用单例实例即可，无需重建。
 */
export function createStatefulTools(tracker: FileReadTracker): Tool[] {
  return [
    new ReadTool(tracker),
    new EditTool(tracker),
    new ReadManyTool(tracker),
  ];
}
