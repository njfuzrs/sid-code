/**
 * B9 / T9.1：冻结的行为基线。
 *
 * 一批契约断言的期望值不是写死的字面量，而是「与冻结基线一致」。基线生成时现场跑了两遍
 * （逐字节一致），结果按「测试文件 / 键」存进 `frozen-baseline/<文件>.json`，`packages/tui` 对它比较。
 *
 * 生成这些 JSON 的实现已不在仓库，**它们不能重生成**，所以这里刻意只读、不提供写入模式：
 * 写入模式只会把当前渲染底座自己的输出记成基线，比较就变成自己比自己。
 * 行为有意变化时手改 JSON，并在 PR 里逐项说明。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, Record<string, unknown>>();

export function frozenBaseline<T>(file: string, key: string): T {
  let data = cache.get(file);
  if (!data) {
    data = JSON.parse(
      readFileSync(join(import.meta.dir, "frozen-baseline", `${file}.json`), "utf8"),
    );
    cache.set(file, data!);
  }
  if (!(key in data!))
    throw new Error(`frozen-baseline/${file}.json 里没有键 ${JSON.stringify(key)}`);
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
