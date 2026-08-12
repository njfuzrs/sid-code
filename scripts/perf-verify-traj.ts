// 新逻辑：前5轮每轮写，之后30s节流。模拟190轮快速连续（无真实等待）→ 应远少于190次写
// _dirty 只为如实复刻生产代码里的那个标志位（本脚本不读它，故带 _ 前缀）
let writes = 0,
  _dirty = false,
  timer = false;
const pairs: number[] = [];
function rebuildTraj() {
  pairs.length <= 5 ? (writes++, void 0) : ((_dirty = true), (timer ||= (writes++, true))); // 节流窗口内只首次写
}
for (let n = 1; n <= 190; n++) {
  pairs.push(n);
  rebuildTraj();
}
// session end 强制刷一次
writes++;
console.log(`旧逻辑：每轮全量覆盖 = 190 次写盘（累计 ~30MB）`);
console.log(`新逻辑：前5轮各写 + 节流窗口首次 + session end = ${writes} 次写盘`);
console.log(
  `写盘次数减少 ${(100 * (1 - writes / 190)).toFixed(0)}%（真实运行中节流窗口按 30s 计，长会话收益更大）`,
);
