/**
 * B9 / T9.1：旧底座删除前冻结的 legacy 输出。
 *
 * 双底座契约测试里有一批断言只写了「next 与 legacy 一致」，没有写死期望值。
 * 删掉旧底座后若只去掉 legacy 一侧，这些用例就变成零断言。所以删除前用 legacy 现场跑了两遍
 * （逐字节一致），结果按「测试文件 / 键」存进 `legacy-frozen/<文件>.json`，next 对它比较。
 *
 * 旧底座已不在仓库，**这些 JSON 不能重生成**，所以这里刻意只读、不提供写入模式：
 * 写入模式在旧底座删除后只会把 next 自己的输出记成「legacy 基线」，比较就变成自己比自己。
 * next 行为有意变化时手改 JSON，并在 PR 里逐项说明。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, Record<string, unknown>>();

export function legacyFrozen<T>(file: string, key: string): T {
  let data = cache.get(file);
  if (!data) {
    data = JSON.parse(readFileSync(join(import.meta.dir, "legacy-frozen", `${file}.json`), "utf8"));
    cache.set(file, data!);
  }
  if (!(key in data!))
    throw new Error(`legacy-frozen/${file}.json 里没有键 ${JSON.stringify(key)}`);
  return data![key] as T;
}

/** 冻结键：用例名 + 环境变量（按键排序，与对象书写顺序无关） */
export function frozenKey(...parts: unknown[]): string {
  return parts
    .map((p) =>
      p && typeof p === "object"
        ? JSON.stringify(
            Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))),
          )
        : String(p),
    )
    .join(" | ");
}
