/**
 * 键位对拍的比较与分组统计（B9 / T5.1，契约 I8）。测试与诊断脚本 `scripts/tui-input-diff.ts` 共用。
 *
 * 两种口径：
 * - **full**：key 对象逐字段比较（含值为 false 的字段）。字段集合本身是端口面，这是最终验收口径；
 * - **semantic**：只比 `input` 与值为真的字段。对齐过程中用它看「解析结果」差在哪，
 *   字段集合的差异不会把所有条目都染红（T5.1b 对齐前新底座多 `capsLock` / `hyper` / `numLock`、少 `fn` / `wheelUp` / `wheelDown`）。
 */
import type { InputCase } from "./input-corpus.ts";
import type { InputEventRecord } from "./input-drive.tsx";

export type Mode = "full" | "semantic";

const semantic = (evs: InputEventRecord[] | undefined) =>
  (evs ?? []).map(([input, key]) => [
    input,
    Object.entries(key)
      .filter(([, v]) => v !== false && v !== undefined)
      .map(([k, v]) => (v === true ? k : `${k}=${String(v)}`))
      .join(","),
  ]);

export function shape(evs: InputEventRecord[] | undefined, mode: Mode): unknown {
  return mode === "full" ? (evs ?? null) : semantic(evs);
}

/** 名字的第一个词：`byte` / `csi` / `kitty` / `kitty-ev` / `sgr` …，与语料的分组一一对应 */
export const prefixOf = (name: string) => name.split(" ")[0]!;

export function mismatches(
  corpus: InputCase[],
  want: Record<string, InputEventRecord[]>,
  got: Record<string, InputEventRecord[]>,
  mode: Mode,
): InputCase[] {
  return corpus.filter(
    (c) => JSON.stringify(shape(got[c.name], mode)) !== JSON.stringify(shape(want[c.name], mode)),
  );
}

export function countByPrefix(cases: InputCase[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cases) out[prefixOf(c.name)] = (out[prefixOf(c.name)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([, a], [, b]) => b - a));
}
