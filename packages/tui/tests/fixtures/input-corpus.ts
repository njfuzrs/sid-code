/**
 * 键位解析对拍语料（B9 / T5.1，契约 I1 / I6 / I8）。
 *
 * 纯数据：每条是写进 stdin 的若干块字节，块之间可插等待毫秒数（数字）。
 * 生成器（scripts/tui-input-vectors.ts）在旧底座上逐条挂一个 `useInput` 组件，记下回调收到的
 * `(input, key)` 序列；测试（tests/input.test.ts）在新底座上跑同一串，逐条比较。不 import 任何底座。
 *
 * 刻意不收的输入：
 * - `\x1a`（Ctrl+Z）：两套底座都会给进程发 SIGSTOP 挂起，生成器进程会被停住。它的行为是契约 I7，
 *   在 `packages/cli/tests/render-port/stdin-suspend.test.tsx` 里 mock 掉 `process.kill` 单独对拍；
 *
 * 终端回复（契约 I3，T5.2a）收在文件末尾的 `resp` 组：完整回复、分片（切在 1、2、中间、末字节，块间隔 10 / 80ms）、
 * 冲刷后的残片、残片后紧跟按键，以及 APC / SOS / PM、粘贴里夹回复等边角。
 * 刻意不收：非私有的 `CSI …$y`（如 `ESC [2026;2$y`），旧底座把它解成 shift，这是 I8 的 rxvt `$` 边角，不是回复残片，
 * 新底座尚未对齐（2026-10-08 探针实测）。
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

// —— 终端回复与残片（契约 I3，T5.2a）：名字统一以 `resp ` 开头 ——
// 期望值由旧底座生成：完整的 DCS / OSC / 私有与次级 CSI 回复、冲刷出来的半截都不出事件；APC 原样交出
const addResp = (name: string, chunks: Array<string | number>) =>
  cases.push({ name: `resp ${name}`, chunks });
// A. 旧底座 terminal-response-fragment.test.ts 的 10 条输入
addResp("old xtversion 分片冲刷", [`${E}P>|xterm.js(6.1.0-beta.288)`, 80]);
addResp("old ST 残尾+DA1", [`${E}\\${E}[?1;2c`]);
addResp("old DA1 缺 c 冲刷", [`${E}[?1;2`, 80]);
addResp("old OSC11 分片冲刷", [`${E}]11;rgb:1a1a/1b1b`, 80]);
addResp("old 完整 xtversion", [`${E}P>|ghostty 1.2${E}\\`]);
addResp("old 完整 DA1", [`${E}[?1;2c`]);
addResp("old 方向键", [`${E}[A${E}[B${E}[C${E}[D`]);
addResp("old 修饰键 home end del", [`${E}[1;5A${E}[3~${E}[H${E}[F`]);
addResp("old 文本", ["hello world"]);
addResp("old 单独 ESC", [E, 80]);
// B. 完整回复 × 分片边界
const RESPONSES: Record<string, string> = {
  dcs: `${E}P>|xterm.js(6.1.0)${E}\\`,
  dcsbel: `${E}P>|xterm.js(6.1.0)\x07`,
  osc: `${E}]11;rgb:1a1a/1b1b/1c1c${E}\\`,
  oscbel: `${E}]11;rgb:1a1a/1b1b/1c1c\x07`,
  da1: `${E}[?62;22c`,
  da2: `${E}[>0;276;0c`,
  decrpm: `${E}[?2026;2$y`,
  mok: `${E}[>4;2m`,
  kittyq: `${E}[?31u`,
  st: `${E}\\`,
};
for (const [k, s] of Object.entries(RESPONSES)) {
  addResp(`full ${k}`, [s]);
  addResp(`full ${k}+a`, [s + "a"]);
  const cuts = [...new Set([1, 2, Math.floor(s.length / 2), s.length - 1])].filter(
    (c) => c > 0 && c < s.length,
  );
  for (const c of cuts) {
    addResp(`split ${k} @${c} gap10`, [s.slice(0, c), 10, s.slice(c)]);
    addResp(`split ${k} @${c} gap80`, [s.slice(0, c), 80, s.slice(c)]);
    addResp(`frag ${k} @${c} 冲刷`, [s.slice(0, c), 80]);
    addResp(`frag ${k} @${c} 冲刷后 x`, [s.slice(0, c), 80, "x"]);
    addResp(`frag ${k} @${c} 后紧跟方向键`, [s.slice(0, c) + `${E}[A`]);
    addResp(`frag ${k} @${c} 后紧跟 a`, [s.slice(0, c) + "a", 80]);
  }
}
// C. 边角
for (const [n, s] of Object.entries({
  apc: `${E}_abc${E}\\z`,
  sos: `${E}Xabc${E}\\z`,
  pm: `${E}^abc${E}\\z`,
  "apc frag": `${E}_abc`,
  "sos frag": `${E}Xabc`,
  "pm frag": `${E}^abc`,
  "?A": `${E}[?A`,
  ">1~": `${E}[>1~`,
  "?1;2A": `${E}[?1;2A`,
  "=1c": `${E}[=1c`,
  "= frag": `${E}[=1`,
  "<frag": `${E}[<0;1`,
  cpr: `${E}[12;5R`,
  "st in text": `a${E}\\b`,
  "dcs esc a": `${E}Pab${E}acd${E}\\z`,
  "dcs esc [A": `${E}Pab${E}[Acd${E}\\z`,
  "osc esc a": `${E}]ab${E}acd\x07z`,
  "csi? ctrl": `${E}[?1\x01b`,
  "csi? esc": `${E}[?${E}[A`,
  "x dcs y": `x${E}P>|t${E}\\y`,
  "osc c1st": `${E}]11;x\x9cz`,
  "dcs c1st": `${E}Pab\x9cz`,
  "csi> intermediate": `${E}[>1 q`,
  "csi? ctrl tail": `${E}[?1\x01`,
  "dcs nl": `${E}Pa\nb${E}\\z`,
  "dcs ESC ESC \\": `${E}Pab${E}${E}\\z`,
  "csi? space esc": `${E}[? ${E}[A`,
})) {
  addResp(`x ${n}`, [s, 80]);
  addResp(`x ${n} +k`, [s, 80, "k"]);
}
addResp("x dcs 多次间隔", [`${E}Pab`, 30, "cd", 30, "ef", 80, "k"]);
addResp("x dcs 多次间隔后 ST", [`${E}Pab`, 30, "cd", 30, `ef${E}\\k`]);
addResp("x csi? 间隔", [`${E}[?1`, 30, ";2", 30, "c", 80, "k"]);
addResp("x st 分片", [E, 10, "\\k"]);
addResp("x da1 粘连两条", [`${E}[?1;2c${E}[?62c`, 80, "k"]);
addResp("x dcs+da1", [`${E}P>|xterm.js(6.1.0)${E}\\${E}[?1;2c`, 80, "k"]);
addResp("x dcs 切在 ESC 后 + DA1", [`${E}P>|x${E}`, 10, `\\${E}[?1;2c`, 80, "k"]);
addResp("y apc bel", [`${E}_abc\x07z`, 80]);
addResp("y apc esc a", [`${E}_ab${E}acd${E}\\z`, 80]);
addResp("y apc split gap10", [`${E}_ab`, 10, `cd${E}\\z`, 80]);
addResp("y apc split gap80", [`${E}_ab`, 80, `cd${E}\\z`, 80]);
addResp("y apc empty", [`${E}_${E}\\z`, 80]);
addResp("y apc +[A", [`${E}_ab${E}[A`, 80]);
addResp("y apc @2 冲刷", [`${E}_`, 80, "k"]);
addResp("y apc @2 +a", [`${E}_a`, 80, "k"]);
addResp("y dcs@2 + st gap80", [`${E}P`, 80, `${E}\\k`]);
addResp("y osc only bel", [`${E}]\x07k`]);
addResp("y dcs only st", [`${E}P${E}\\k`]);
addResp("y osc bel inside then st", [`${E}]a\x07b${E}\\k`]);
addResp("y csi? final @", [`${E}[?@k`]);
addResp("y csi> ~ then text", [`${E}[>0;1~ab`]);
addResp("y csi? 1;2 cut esc esc", [`${E}[?1;2${E}${E}[A`, 80]);
addResp("y csi> cut ctrl", [`${E}[>1\x01`, 80]);
addResp("y csi? flush then k", [`${E}[?1;2`, 80, "k"]);
addResp("y csi? M", [`${E}[?M  !k`]);
addResp("y csi> M", [`${E}[>M abk`]);
addResp("y csi ? at second param", [`${E}[1?ck`]);
addResp("y csi 1;?", [`${E}[1;?ck`]);
addResp("y csi> pending flush with intermediate", [`${E}[>1 `, 80, "k"]);
addResp("y dcs paste inside", [`${E}Pa${E}[200~b${E}[201~c${E}\\k`, 80]);
addResp("y text+dcs frag", [`ab${E}P>|x`, 80, "k"]);
addResp("y meta P then", [`${E}P`, 10, "a", 80, "k"]);
addResp("y osc @2 gap10 ctrl", [`${E}]`, 10, "\x03", 80, "k"]);
addResp("y dcs 0x9c then st", [`${E}Pa\x9cb${E}\\k`]);
addResp("y st split esc ST gap80", [`${E}P>|x${E}`, 80, "\\k"]);
addResp("z paste dcs 后续", [`${E}[200~a${E}Pb${E}[201~k`, 80, "more", 80, `${E}\\z`, 80, "q"]);
addResp("z paste dcs 后续2", [`${E}[200~a${E}Pb${E}\\c${E}[201~k`]);
addResp("z paste osc", [`${E}[200~a${E}]b\x07c${E}[201~k`]);
addResp("z paste csi?", [`${E}[200~a${E}[?1cb${E}[201~k`]);
addResp("z paste apc", [`${E}[200~a${E}_b${E}[201~k`, 80, "q"]);

export const INPUT_CORPUS: InputCase[] = cases;

/** 重名会让向量文件少 key、一条覆盖另一条，加载时就拦 */
const dup = cases.map((c) => c.name).filter((n, i, all) => all.indexOf(n) !== i);
if (dup.length) throw new Error(`input-corpus 有重名：${dup.join(", ")}`);
