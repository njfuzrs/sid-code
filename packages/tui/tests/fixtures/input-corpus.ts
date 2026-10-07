/**
 * 键位解析对拍语料（B9 / T5.1，契约 I1 / I6 / I8）。
 *
 * 纯数据：每条是写进 stdin 的若干块字节，块之间可插等待毫秒数（数字）。
 * 生成器（scripts/tui-input-vectors.ts）在旧底座上逐条挂一个 `useInput` 组件，记下回调收到的
 * `(input, key)` 序列；测试（tests/input.test.ts）在新底座上跑同一串，逐条比较。不 import 任何底座。
 *
 * 刻意不收的输入：
 * - `\x1a`（Ctrl+Z）：旧底座会给进程发 SIGSTOP 挂起（契约 I7，归 T5.1e），生成器进程会被停住；
 * - `ESC ]` / `ESC P` / `ESC X` / `ESC ^` / `ESC _` 开头的串、`CSI ?…c` 等终端回复：属于 I3 的
 *   responseFragment 规则，归 T5.2。
 */

export type InputCase = { name: string; chunks: Array<string | number> };

const E = "\x1b";
const hex = (n: number) => n.toString(16).padStart(2, "0");
const one = (name: string, s: string): InputCase => ({ name, chunks: [s] });

const cases: InputCase[] = [];

// —— 单字节：C0 控制符 / 可打印 ASCII / DEL ——
for (let b = 0; b <= 0x7f; b++) {
  if (b === 0x1a) continue; // Ctrl+Z → I7
  cases.push(one(`byte ${hex(b)}`, String.fromCharCode(b)));
}

// —— ESC + 单字节（meta 组合），去掉字符串引导符 ——
for (let b = 0; b <= 0x7f; b++) {
  const c = String.fromCharCode(b);
  if (b === 0x1a || "]PX^_".includes(c)) continue;
  cases.push(one(`meta ${hex(b)}`, E + c));
}

// —— 非 ASCII 文本与多字符块 ——
for (const s of [
  "é",
  "中",
  "中文",
  "😀",
  "👨‍👩‍👧",
  "ab",
  "AB",
  "aB",
  "A1",
  "Ab c",
  "\r\n",
  "\r\r",
  "\t\t",
  "\n\n",
  "a\r",
  "a\x7f",
  "\x7f\x7f",
  "\b\b",
  "a\x01",
  " ",
  "  ",
]) {
  cases.push(one(`text ${JSON.stringify(s)}`, s));
}

// —— CSI 方向 / Home / End 及修饰位 1–16 ——
for (const f of "ABCDHFEPQRS") {
  cases.push(one(`csi ${f}`, `${E}[${f}`));
  for (let m = 1; m <= 16; m++) cases.push(one(`csi 1;${m}${f}`, `${E}[1;${m}${f}`));
}

// —— CSI 数字~ 键及常用修饰 ——
for (const n of [
  1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24, 25, 26, 28, 29, 31, 32,
  33, 34,
]) {
  cases.push(one(`csi ${n}~`, `${E}[${n}~`));
  for (const m of [2, 3, 5, 6, 9]) cases.push(one(`csi ${n};${m}~`, `${E}[${n};${m}~`));
}

// —— SS3 ——
for (const f of "ABCDHFMPQRSabcdjklmnopqrstuvwxy") cases.push(one(`ss3 ${f}`, `${E}O${f}`));

// —— rxvt 风格 ——
for (const f of "abcde") cases.push(one(`rxvt [${f}`, `${E}[${f}`));
for (const n of [2, 3, 5, 6, 7, 8]) {
  cases.push(one(`rxvt ${n}$`, `${E}[${n}$`));
  cases.push(one(`rxvt ${n}^`, `${E}[${n}^`));
}
for (const s of ["[[A", "[[B", "[[C", "[[D", "[[E", "[Z", "[1;2Z", "[G", "[1;5G"])
  cases.push(one(`misc ${s}`, E + s));
// —— 参数形状的边角：省略 `1;`、非 1 的首参、未知编号、焦点带修饰、SS3 未定义字母、孤立的 paste 结束 ——
for (const s of [
  "[5A",
  "[2;5A",
  "[3A",
  "[1;5I",
  "[1;5O",
  "[1;5Z",
  "[9~",
  "[99~",
  "[10~",
  "[16~",
  "[2;5$",
  "[f",
  "[z",
  "Oe",
  "Oi",
  "OZ",
  "O5A",
  "[201~",
  "[0;5A",
  "[1;0A",
]) {
  cases.push(one(`edge ${s}`, E + s));
}
cases.push(one("edge ESC×3", `${E}${E}${E}`));
cases.push(one("edge ESC 后跟非 BMP", `${E}😀`));
cases.push(one("edge CSI 中途遇控制符", `${E}[1\x01`));
cases.push(one("edge CSI 中途遇 ESC", `${E}[1${E}[A`));

// —— kitty 键盘协议 CSI u ——
const KITTY_CODES = [
  9,
  13,
  27,
  32,
  48,
  49,
  65,
  90,
  97,
  99,
  122,
  127,
  47,
  91,
  1074,
  // 功能键区：57344 起（含未定义码位）
  ...Array.from({ length: 0xe06d - 0xe000 + 1 }, (_, i) => 0xe000 + i),
];
for (const cp of KITTY_CODES) {
  cases.push(one(`kitty ${cp}u`, `${E}[${cp}u`));
}
for (const cp of [9, 13, 27, 32, 65, 97, 99, 127, 57399, 57414, 57441]) {
  for (const m of [1, 2, 3, 4, 5, 6, 7, 9, 13, 17, 33, 65, 129])
    cases.push(one(`kitty ${cp};${m}u`, `${E}[${cp};${m}u`));
  for (const t of [1, 2, 3]) cases.push(one(`kitty ${cp};1:${t}u`, `${E}[${cp};1:${t}u`));
  cases.push(one(`kitty ${cp};5:3u`, `${E}[${cp};5:3u`));
}
// `57416u` / `57414;3u` 与上面两个循环生成的条目字节相同：保留是为了让杂项组自成一套，
// 名字加「杂项」后缀避免重名（向量文件按名字作 key，重名会让一条静默覆盖另一条）
for (const s of [
  "97:65;2u",
  "97;;97u",
  "97;1;97u",
  "97;2;65u",
  "1u",
  "0u",
  "97;0u",
  "8u",
  "8;5u",
  "8;3u",
  "126u",
  "128u",
  "160u",
  "57416u",
  "57414;3u",
  "57399;0u",
  "200u",
]) {
  const name = `kitty ${s}`;
  cases.push(one(cases.some((c) => c.name === name) ? `${name} 杂项` : name, `${E}[${s}`));
}
// kitty 方向键 / 功能键带事件类型
for (const s of ["1;1:1A", "1;1:3A", "1;5:2C", "3;1:3~", "1;2:1H"])
  cases.push(one(`kitty-ev ${s}`, `${E}[${s}`));

// —— xterm modifyOtherKeys：CSI 27 ; m ; k ~ ——
for (const k of [9, 13, 27, 32, 49, 65, 97, 127]) {
  for (const m of [1, 2, 3, 5, 6, 7, 9]) cases.push(one(`mok 27;${m};${k}~`, `${E}[27;${m};${k}~`));
}

// —— 鼠标：SGR 与 X10 ——
for (const b of [
  0, 1, 2, 3, 4, 8, 16, 32, 33, 34, 35, 64, 65, 66, 67, 68, 69, 72, 73, 80, 81, 96, 128,
]) {
  cases.push(one(`sgr ${b}M`, `${E}[<${b};3;4M`));
  cases.push(one(`sgr ${b}m`, `${E}[<${b};3;4m`));
}
for (const b of [0, 1, 2, 3, 32, 35, 64, 65, 66, 67, 68, 80]) {
  cases.push(one(`x10 ${b}`, `${E}[M${String.fromCharCode(b + 32)}!!`));
}
cases.push(one("sgr 双滚轮", `${E}[<64;3;4M${E}[<65;3;4M`));
cases.push(one("sgr 滚轮后跟字符", `${E}[<64;3;4Mx`));
cases.push(one("x10 截断 1 字节", `${E}[Ma`));
cases.push(one("x10 截断 2 字节", `${E}[Ma!`));

// —— 焦点事件 ——
cases.push(one("focus in", `${E}[I`));
cases.push(one("focus out", `${E}[O`));
cases.push(one("focus in 后跟字符", `${E}[Iq`));
cases.push(one("focus 连发", `${E}[I${E}[O`));

// —— bracketed paste ——
for (const s of [
  "paste",
  "a\nb",
  "a\rb",
  "\x1b[A",
  "中文",
  "",
  "a\x7fb",
  "\x03",
  "x\x1bOy",
  "A",
  "\r",
  "\t",
  "\x1b",
  "\x1b\x1b[A",
  "\x1bb",
]) {
  cases.push(one(`paste ${JSON.stringify(s)}`, `${E}[200~${s}${E}[201~`));
}
cases.push(one("paste 前后有字符", `a${E}[200~p${E}[201~b`));
cases.push({ name: "paste 跨块", chunks: [`${E}[200~ab`, 10, `cd${E}[201~`] });
cases.push({ name: "paste 未结束", chunks: [`${E}[200~ab`, 80, "z"] });
cases.push({ name: "paste 只有开头", chunks: [`${E}[200~`, 80, "z"] });

// —— 多事件同块 ——
for (const s of [
  `a${E}[Ab`,
  `ab${E}c`,
  `${E}[A${E}[B`,
  `${E}${E}`,
  `${E}${E}[A`,
  `${E}${E}OA`,
  `${E}${E}x`,
  `x${E}`,
  `${E}[A${E}`,
  `\r${E}[A`,
  `${E}a${E}b`,
  `\x01\x02`,
  `a\x01`,
  `${E}[13;2u${E}[13u`,
  `${E}[97;5u${E}[98;5u`,
]) {
  cases.push(one(`multi ${JSON.stringify(s)}`, s));
}

// —— 跨块与 ESC 冲刷时机（旧底座约 50ms）——
for (const [a, b] of [
  [E, "[A"],
  [E, "a"],
  [`${E}[`, "A"],
  [`${E}[1;`, "5A"],
  [`${E}[13;`, "2u"],
  [`${E}[<64;3`, ";4M"],
  [`${E}O`, "A"],
  [`${E}[M`, " !!"],
  [`${E}${E}`, "[A"],
]) {
  for (const gap of [10, 80])
    cases.push({
      name: `split ${JSON.stringify(a)}+${JSON.stringify(b)} gap ${gap}`,
      chunks: [a, gap, b],
    });
}
for (const s of [
  E,
  `${E}[`,
  `${E}[1`,
  `${E}[1;`,
  `${E}[2`,
  `${E}O`,
  `${E}[<64;3`,
  `${E}[13;2`,
  `${E}[M`,
  `${E}[M `,
  `${E}[M !`,
  `${E}${E}`,
  `a${E}`,
]) {
  cases.push({ name: `pending ${JSON.stringify(s)}`, chunks: [s, 80, "z"] });
}

export const INPUT_CORPUS: InputCase[] = cases;

/** 重名会让向量文件少 key、一条覆盖另一条，加载时就拦 */
const dup = cases.map((c) => c.name).filter((n, i, all) => all.indexOf(n) !== i);
if (dup.length) throw new Error(`input-corpus 有重名：${dup.join(", ")}`);
