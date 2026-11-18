/**
 * 最大余数法（Hamilton 法）——按权重把 `total` 个单位分配成整数。
 *
 * 为什么需要它：展示层有一批「把总量按占比拆成整数」的需求，拆分结果必须
 * **严格等于总量**，否则用户会看到「各项加起来 ≠ 总数」。四舍五入做不到这件事
 * （Σ round ≠ round Σ），而差值又不能凭空塞进某一项——那会伪造归因。
 *
 * 两个已知消费方，用的是同一份实现（不写第二份）：
 * - `packages/core/src/context/manager.ts`：把校准后的上下文总量按各分类的未校准占比拆开，
 *   保证 `Σ 分类 === 校准后总量`（core 不能反向依赖 cli，故落在 shared）。
 * - `packages/cli/src/ui/components/ContextDialog.tsx`：把「已用格数」按各分类占比分给色块，
 *   保证色块总和恰好等于已用格数，不多不少一格。
 *
 * 语义细节：
 * - 权重 ≤ 0 或非有限值的项**不参与分配**（得 0 格/0 token），不会因为负权重把别人的份额吃掉；
 * - 权重全为 0 或 `total ≤ 0` 时全返回 0（此时「严格等于 total」退化为 total=0 的平凡情形）；
 * - 小数部分相同时按下标原始顺序取（稳定排序），保证同一输入每次结果相同——
 *   否则同一份数据刷新两次会看到格子数跳动。
 *
 * @param weights 各项权重（非负），决定分配比例
 * @param total 待分配的单位总数（非负整数；小数会被 floor）
 * @returns 与 `weights` 等长的整数数组，Σ === total（权重和 > 0 时）
 */
export function allocateByWeight(weights: readonly number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  // 负权重会让「按比例」失去意义（一项涨则另一项降），统一按 0 处理。
  const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safeWeights.reduce((s, w) => s + w, 0);
  if (safeTotal === 0 || sum <= 0) return new Array<number>(n).fill(0);

  const exact = safeWeights.map((w) => (w / sum) * safeTotal);
  const units = exact.map((e) => Math.floor(e));
  let assigned = units.reduce((s, c) => s + c, 0);

  // 先按整数部分分配，剩余的零头按小数部分从大到小补齐。
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  let k = 0;
  while (assigned < safeTotal && k < n) {
    units[order[k].i] += 1;
    assigned += 1;
    k += 1;
  }
  // 浮点误差兜底：理论上 floor 之和与 total 的差恒 < n，走不到这里；
  // 真走到了也必须保住「Σ === total」这条不变量，宁可把零头全给最大权重项。
  if (assigned < safeTotal) {
    let maxIdx = 0;
    for (let i = 1; i < n; i++) if (safeWeights[i] > safeWeights[maxIdx]) maxIdx = i;
    units[maxIdx] += safeTotal - assigned;
  }
  return units;
}
