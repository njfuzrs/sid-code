// 确定性验证：插桩 setTimeout/clearTimeout，复刻 parseSSE read 循环的两种写法，
// 数「存活未清理」的定时器。旧写法每次 read 泄漏 1 个，新写法 0 泄漏。
let live = 0, created = 0, cleared = 0;
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const handles = new Set<any>();
(globalThis as any).setTimeout = ((fn: any, ms: any) => {
  created++; live++;
  const h = realSet(() => { /* 不实际 fire，只测存活 */ }, 999999);
  handles.add(h);
  return h;
}) as any;
(globalThis as any).clearTimeout = ((h: any) => {
  if (handles.has(h)) { handles.delete(h); live--; cleared++; realClear(h); }
}) as any;

const IDLE = 300_000, N = 500; // 模拟 500 次 reader.read()（token 级流式常见量级）

// 旧写法：cancelTimeout 无句柄、不清理
function oldLoop() {
  for (let i = 0; i < N; i++) {
    let timeoutId: any = null;
    timeoutId = setTimeout(() => {}, IDLE);        // 有句柄
    setTimeout(() => {}, IDLE + 100);              // ← 无句柄，泄漏
    try { /* race settle */ } finally { if (timeoutId) clearTimeout(timeoutId); }
  }
}
// 新写法：两个都有句柄，finally 都清
function newLoop() {
  for (let i = 0; i < N; i++) {
    let timeoutId: any = null, cancelTimeoutId: any = null;
    timeoutId = setTimeout(() => {}, IDLE);
    cancelTimeoutId = setTimeout(() => {}, IDLE + 100);
    try { /* race settle */ } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (cancelTimeoutId) clearTimeout(cancelTimeoutId);
    }
  }
}

created = cleared = live = 0; handles.clear();
oldLoop();
const oldLeak = live;
console.log(`旧写法：${N} 次 read → 创建 ${created}，清理 ${cleared}，存活泄漏 ${oldLeak} 个定时器`);

created = cleared = live = 0; handles.forEach(h => realClear(h)); handles.clear();
newLoop();
const newLeak = live;
console.log(`新写法：${N} 次 read → 创建 ${created}，清理 ${cleared}，存活泄漏 ${newLeak} 个定时器`);

handles.forEach(h => realClear(h));
(globalThis as any).setTimeout = realSet; (globalThis as any).clearTimeout = realClear;
console.log(`\n结论：旧写法每次 read 泄漏 1 个存活 300s 的定时器（500 次 read → ${oldLeak} 个堆积）；新写法 0 泄漏 ✓`);
