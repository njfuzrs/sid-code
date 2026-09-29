/**
 * SSE 行级语法的**唯一实现**：切行 + 解析字段行。
 *
 * ## 为什么要单独成一个模块
 *
 * 同一个知识（SSE 字段行怎么切）此前在仓内实现了三遍，三遍口径互不相同：
 *
 * | 实现 | 前缀判据 | 认 `data:{...}` | 认 CRLF |
 * | --- | --- | --- | --- |
 * | `openai.ts` parseSSE | `startsWith("data: ")` + `slice(6)` | ❌ | ❌（`[DONE]\r` 恒不等） |
 * | `openai-responses.ts` | `startsWith("data:")` + `slice(5).trim()` | ✅ | ❌（按 `\n\n` 切块） |
 * | `sse-event-line-shim.ts` | `startsWith("data:")` | ✅ | ✅ |
 *
 * 于是有一遍是错的，而测试全绿 —— 因为测试夹具是按各自实现的形状铺的，
 * 不是按协议铺的（`parse-sse-boundary.test.ts` 的夹具全是 `data: ` + `\n\n`）。
 * 错的那份（`openai.ts`）恰好是 OpenAI 族主路径：网关省掉冒号后的空格时
 * **整条流零事件、零报错**，再被 fallback 判成「上游空响应」烧掉重试与降级预算。
 *
 * 所以修法不是把 `"data: "` 改成 `"data:"`，而是把「SSE 行语法」收敛到这一份，
 * 让下一个差异没有机会再分裂一次。
 *
 * ## 口径：按 WHATWG HTML §9.2 server-sent events，而不是按观测到的厂商行为
 *
 * - **行终止符**：CRLF、LF、CR 三者皆可（规范原文 `end-of-line = ( cr lf / cr / lf )`）。
 * - **字段行**：`field ":" [SP] value` —— 冒号后**恰好一个**可选空格被移除，
 *   多出的空格属于 value（所以不能用 `trim()`，它会吃掉 value 内有意义的空白）。
 * - **冒号开头**：注释行（keep-alive），忽略。
 * - **无冒号**：整行是字段名、value 为空串。
 *
 * ⚠️ 与规范**刻意不同**的一处：规范要求 EOF 时丢弃未以空行结束的残余数据。
 * 本模块不替调用方做这个决定 —— {@link splitSSELines} 把残余交回 `rest`，
 * 由调用方决定 EOF 时要不要把它当成最后一行处理（OpenAI 族主路径选择处理：
 * 不以换行结尾的最后一个 usage chunk 丢掉就是一整轮成本记 $0，
 * 而处理一行截断 JSON 的代价只是一次 `JSON.parse` 失败）。
 */

/**
 * 从累积缓冲里切出所有**完整**的行，返回剩余的半行。
 *
 * 跨 chunk 的 CRLF：若缓冲以 `\r` 结尾，它可能是被 TCP 切开的 `\r\n` 的前半，
 * 此时不能当成一个 CR 终止符把行切出去 —— 否则下一块开头的 `\n` 会被当成
 * 又一个空行（= 事件分隔），在按事件分发的调用方那里凭空多派发一次。
 * 所以结尾的 `\r` 留在 `rest` 里，等下一块来了再判；EOF 时由调用方处理残余。
 */
export function splitSSELines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer.charCodeAt(i);
    if (ch === 0x0a /* \n */) {
      lines.push(buffer.slice(start, i));
      start = i + 1;
    } else if (ch === 0x0d /* \r */) {
      if (i === buffer.length - 1) break; // 可能是被切开的 CRLF，留给下一块
      lines.push(buffer.slice(start, i));
      if (buffer.charCodeAt(i + 1) === 0x0a) i++; // CRLF 当一个终止符
      start = i + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

/** 一条 SSE 字段行 */
export interface SSEField {
  field: string;
  value: string;
}

/**
 * 解析一行 SSE（不含行终止符）。
 *
 * 返回 `null` 的两种情形：空行（事件分隔，调用方若按事件分发需自己识别）、
 * 注释行（`:` 开头）。行尾若残留 `\r`（调用方用 `split("\n")` 自己切的行）也会被剥掉，
 * 保证本函数单独使用时同样认 CRLF。
 */
export function parseSSEField(rawLine: string): SSEField | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line === "" || line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  if (colon === -1) return { field: line, value: "" };
  let value = line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1); // 规范：只移除一个
  return { field: line.slice(0, colon), value };
}

/**
 * `[DONE]` 哨兵判定。
 *
 * 用 trim 比较而不是严格相等：`[DONE]` 是 OpenAI 族的**约定**，不是 SSE 规范，
 * 它周围的空白（多一个空格、残留的 `\r`）没有任何语义，却能让严格相等恒为 false ——
 * 而这个判断同时守着 stop_reason、usage、completed 遥测与 `[DONE]` 后早退四件事。
 */
export function isDoneSentinel(value: string): boolean {
  return value.trim() === "[DONE]";
}
