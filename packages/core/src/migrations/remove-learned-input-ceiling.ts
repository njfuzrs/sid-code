/**
 * 迁移 v8：删除已废弃的运行时窗口学习文件（S6 遗留）
 *
 * 背景：S6「运行时学习已放行输入上限」（2026-10-18 引入）会把
 * 「输入 + max_tokens=384000 撞 1,048,576」的 400 误判成「窗口只有 664k」，写进
 * `~/.sid-code/learned-input-ceiling.json` 覆盖注册表窗口。后果是 Footer 百分比放大
 * 1.5 倍、压缩/遮罩阈值全部按错的分母算、有效上下文损失约 1/3。
 *
 * 代码侧已整体删除（PR #770：读取点、写入点、`ModelMetaSource "learned"`、路径常量），
 * 删除后没有任何地方再读这个文件。但**已经写进用户磁盘的那份还在**：
 *   · 排查时会误以为它仍然生效；
 *   · 一旦回滚 #770，664k 会立刻复活。
 * 改代码只影响新装用户，已落盘的只能靠迁移收回 —— 与 v6（remove-team-default-trace-upload）
 * 同型，所以放进同一套水位线，只跑一次。
 *
 * ## 判据：宁可漏删，不可错删
 *
 * 删错了是「用户自己的数据被静默抹掉」，比留一个孤儿文件严重得多。所以只认 S6 自己
 * 写出的那一种形态：
 *   · 顶层 `schema_version === 1`（S6 唯一写过的版本）；
 *   · `entries` 是非空对象，且**每一条**都同时带 `ceiling` / `maxAdmitted` / `overflows` 三个数字。
 * 任何一条不满足就原样保留（可能是用户手写的同名文件，或将来别的功能复用这个文件名）。
 *
 * 空 `entries` 也保留：S6 的写入路径（recordContextOverflow）只会往里加条目，不会产出空对象，
 * 所以空对象不是我们写的，没有理由动它。
 *
 * ## 为什么不写 stderr
 *
 * 这是清理我们自己写错的运行时数据，用户不需要做任何事，告知只是噪音。
 * v6 写 stderr 是因为它涉及「轨迹曾被静默上传」，用户有权知道；两者性质不同。
 * （迁移还跑在 initLogger 之前，logger 不可用，见 warnings.ts 头注释。）
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { sidHomePath } from "../config/paths.ts";

const FILE_NAME = "learned-input-ceiling.json";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 判断一份内容是否**完全**符合 S6 写出的形态。
 * 任一条不符即返回 false —— 调用方据此保留文件。
 *
 * 导出是为了让测试能直接覆盖判据分支，不必每次都走文件系统。
 */
export function isLegacyLearnedCeiling(data: unknown): boolean {
  if (!isPlainObject(data)) return false;
  if (data.schema_version !== 1) return false;
  const entries = data.entries;
  if (!isPlainObject(entries)) return false;
  const values = Object.values(entries);
  if (values.length === 0) return false;
  for (const entry of values) {
    if (!isPlainObject(entry)) return false;
    if (!isFiniteNumber(entry.ceiling)) return false;
    if (!isFiniteNumber(entry.maxAdmitted)) return false;
    if (!isFiniteNumber(entry.overflows)) return false;
  }
  return true;
}

export function migrate(): void {
  try {
    const path = sidHomePath(FILE_NAME);
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isLegacyLearnedCeiling(parsed)) return;
    rmSync(path, { force: true });
  } catch {
    // 解析失败（文件损坏/被改成非 JSON）→ 不是我们写的形态，保留；
    // 权限不足 / 只读挂载 → 保持现状，下次启动重跑（幂等）。
    // 迁移失败不阻塞启动，runMigrations 已有同一套约定。
  }
}
