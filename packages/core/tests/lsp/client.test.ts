/**
 * LSPClient 帧协议单测（D7）
 *
 * ## 为什么这个文件必须存在
 *
 * `client.ts` 曾是 `lsp/` 里**唯一有真实算法逻辑却没有测试**的文件，而一次逐文件核查
 * 查出的三条真缺陷（多字节字符跨 chunk 损坏 / 畸形 Content-Length 永久卡死 /
 * buffer 无上限）**全部落在这一个 36 行的 `handleData` 里**。同层其它四个有测试的文件
 * 一条真缺陷都没查出来。所以这个文件不是"补测"，它是那三条修复的验证手段。
 *
 * ## 测试手法
 *
 * `handleData` 是纯函数式的（输入字节 → 副作用是 `handleMessage` 调用），不需要真进程：
 * 造一个 `LSPClient`、把 `handleMessage` 换成记录器、直接喂 Buffer。
 *
 * ⚠️ 用 `as any` 触及 private 成员是**刻意的**：被测对象正是这个私有状态机，
 * 而它没有、也不该有公开入口（公开等于邀请外部绕过帧协议塞数据）。
 *
 * ## 标了「防回归」的用例
 *
 * 那几条是核查时**原以为有问题、跑完发现没问题**的路径（头部损坏后恢复、body 内含
 * `\r\n\r\n` 字面量、多字段头部）。写下来的价值在于：下一个人改 `handleData` 时
 * （比如再换一次累积方式），它们会挡住回归。
 */

import { describe, test, expect } from "bun:test";
import { LSPClient } from "@sid-code/core/lsp/client.ts";

/** 与 client.ts 内部常量保持一致；不导出那些常量，故在此复述并由用例反向锁定 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const STALE_FRAME_TIMEOUT_MS = 60_000;

/** 造一条合法帧（Content-Length 按 UTF-8 字节数算，与 writeMessage 同口径） */
function frame(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`, "utf-8");
}

/**
 * 找一个落在多字节字符续字节（0b10xxxxxx）上的切点。
 * 返回 -1 表示没有——用例会先断言它 > 0，避免"切点没找到导致用例其实没测多字节"。
 */
function findContinuationByteOffset(buf: Buffer, from: number): number {
  for (let i = from; i < buf.length; i++) {
    if ((buf[i]! & 0xc0) === 0x80) return i;
  }
  return -1;
}

/** 造一个 client，把 handleMessage 换成记录器，返回喂数据的钩子 */
function makeHarness() {
  const client = new LSPClient("test-server") as any;
  const got: any[] = [];
  client.handleMessage = (msg: any) => got.push(msg);
  return {
    client,
    got,
    feed: (data: Buffer | string) =>
      client.handleData(typeof data === "string" ? Buffer.from(data, "utf-8") : data),
    /** 当前解析器状态，用于断言"没有卡在等待态" */
    state: () => ({ contentLength: client.contentLength, bufferLen: client.buffer.length }),
  };
}

describe("LSPClient 帧解析 — 既有正确行为（防回归）", () => {
  test("两条完整帧拼在一起、一次喂入 → 两条都被解析", () => {
    const h = makeHarness();
    h.feed(Buffer.concat([frame({ id: 1 }), frame({ id: 2 })]));
    expect(h.got).toEqual([{ id: 1 }, { id: 2 }]);
    expect(h.state()).toEqual({ contentLength: -1, bufferLen: 0 });
  });

  test("一条帧拆成两次喂入 → 拼回完整一条", () => {
    const h = makeHarness();
    const f = frame({ id: 3, method: "x" });
    h.feed(f.subarray(0, 12));
    expect(h.got).toEqual([]); // 头部都还没完整
    h.feed(f.subarray(12));
    expect(h.got).toEqual([{ id: 3, method: "x" }]);
  });

  test("头部无 Content-Length → 跳过该头部后仍能解析下一条帧", () => {
    const h = makeHarness();
    h.feed(Buffer.concat([Buffer.from("X-Junk: 1\r\n\r\n", "utf-8"), frame({ id: 4 })]));
    expect(h.got).toEqual([{ id: 4 }]);
  });

  test("前缀垃圾没有自己的 \\r\\n\\r\\n → 不影响帧解析", () => {
    const h = makeHarness();
    // 垃圾与真实头部之间没有分隔符，于是垃圾成为头部的一部分，正则仍能命中
    h.feed(Buffer.concat([Buffer.from("noise noise ", "utf-8"), frame({ id: 5 })]));
    expect(h.got).toEqual([{ id: 5 }]);
  });

  test("头部里的非 ASCII 字节不影响 Content-Length 匹配", () => {
    const h = makeHarness();
    // 头部按 latin1 逐字节映射，所以多字节序列既不抛错、也不会吞掉后面的字段
    h.feed(Buffer.concat([Buffer.from("X-Note: 启动横幅\r\n", "utf-8"), frame({ id: 51 })]));
    expect(h.got).toEqual([{ id: 51 }]);
  });

  test("body 内含 \\r\\n\\r\\n 字面量 → 不被误切", () => {
    const h = makeHarness();
    const payload = { id: 6, text: "line1\r\n\r\nline2" };
    h.feed(frame(payload));
    expect(h.got).toEqual([payload]);
  });

  test("头部含 Content-Type 等多字段 → 正常解析", () => {
    const h = makeHarness();
    const json = JSON.stringify({ id: 7 });
    h.feed(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`,
    );
    expect(h.got).toEqual([{ id: 7 }]);
  });

  test("Content-Length: 0 → 不崩，且后续帧仍能解析", () => {
    const h = makeHarness();
    h.feed(Buffer.concat([Buffer.from("Content-Length: 0\r\n\r\n", "utf-8"), frame({ id: 8 })]));
    // 空体自身解析失败（只记 error 日志、不抛），关键是不污染后续
    expect(h.got).toEqual([{ id: 8 }]);
    expect(h.state().contentLength).toBe(-1);
  });
});

describe("LSPClient 帧解析 — D1：多字节字符跨 chunk 边界", () => {
  test("汉字被切在字节中间 → 内容无损（守 D1）", () => {
    const h = makeHarness();
    const payload = { id: 9, message: "类型「数字」不能赋值给类型「字符串」" };
    const f = frame(payload);
    const cut = findContinuationByteOffset(f, 20);
    expect(cut).toBeGreaterThan(0); // 前提成立：确实存在这样的切点
    h.feed(f.subarray(0, cut));
    h.feed(f.subarray(cut));
    expect(h.got).toEqual([payload]); // 无 U+FFFD、无长度错位
  });

  test("D1→D2 级联：含中文的诊断 + 紧随的第二条，在字符中间切开 → 两条都收到", () => {
    const h = makeHarness();
    const m1 = {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///项目/计算器.ts", diagnostics: [{ message: "类型不匹配" }] },
    };
    const m2 = { jsonrpc: "2.0", id: 99, result: "第二条消息" };
    const wire = Buffer.concat([frame(m1), frame(m2)]);
    const cut = findContinuationByteOffset(wire, 40);
    expect(cut).toBeGreaterThan(0);
    h.feed(wire.subarray(0, cut));
    h.feed(wire.subarray(cut));
    // 旧实现（逐 chunk toString）在这里只收到 1 条：第一条会被当成第二条的躯体截走
    expect(h.got).toEqual([m1, m2]);
  });

  test("emoji（4 字节）逐字节喂入 → 内容无损", () => {
    const h = makeHarness();
    const payload = { id: 10, emoji: "🚀🔥" };
    const f = frame(payload);
    for (const byte of f) h.feed(Buffer.from([byte]));
    expect(h.got).toEqual([payload]);
  });
});

describe("LSPClient 帧解析 — D2：畸形 Content-Length 不得永久卡死", () => {
  test("Content-Length 超上限 → 丢帧重置，后续正常帧仍能解析（守 D2）", () => {
    const h = makeHarness();
    // 999999999 远超 32MB 上限
    h.feed("Content-Length: 999999999\r\n\r\n");
    expect(h.state().contentLength).toBe(-1); // 关键：已重置，不是卡在等待态
    expect(h.state().bufferLen).toBe(0); // 已污染的缓冲被丢弃

    // 旧实现在这里一条都收不到（永久卡死）
    h.feed(frame({ id: 11 }));
    h.feed(frame({ id: 12 }));
    h.feed(frame({ id: 13 }));
    expect(h.got).toEqual([{ id: 11 }, { id: 12 }, { id: 13 }]);
  });

  test("畸形帧后紧跟的字节同一次喂入 → 也能重新同步", () => {
    const h = makeHarness();
    h.feed(
      Buffer.concat([Buffer.from("Content-Length: 999999999\r\n\r\n", "utf-8"), frame({ id: 14 })]),
    );
    // 该批次里畸形帧之后的数据一并丢弃（已污染，无法判断边界），但解析器可用
    expect(h.state().contentLength).toBe(-1);
    h.feed(frame({ id: 15 }));
    expect(h.got).toEqual([{ id: 15 }]);
  });

  test("刚好等于上限的声明值不被误杀（判据是 > 而非 >=）", () => {
    const h = makeHarness();
    h.feed(`Content-Length: ${MAX_MESSAGE_BYTES}\r\n\r\n`);
    // 合法声明：进入等待态而非被丢弃
    expect(h.state().contentLength).toBe(MAX_MESSAGE_BYTES);
  });

  test("超出安全整数的声明值被挡掉，解析器仍可恢复", () => {
    const h = makeHarness();
    // 正则只吃 \d+，负号形态命中的是绝对值；这里验超出安全整数的形态被挡
    h.feed(`Content-Length: 99999999999999999999\r\n\r\n`);
    expect(h.state().contentLength).toBe(-1);
    h.feed(frame({ id: 16 }));
    expect(h.got).toEqual([{ id: 16 }]);
  });
});

describe("LSPClient 帧解析 — D3：buffer 不得无界增长", () => {
  test("始终凑不出帧头时 buffer 超上限 → 重置而非无限增长（守 D3）", () => {
    const h = makeHarness();
    // 8MB 一块地喂无分隔符的垃圾，第 9 块必然越过 64MB
    const junk = Buffer.alloc(8 * 1024 * 1024, 0x41); // 'A'，不含 \r\n\r\n
    for (let i = 0; i < 9; i++) h.feed(junk);
    expect(h.state().bufferLen).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    expect(h.state().contentLength).toBe(-1);
    // 重置之后仍可用
    h.feed(frame({ id: 17 }));
    expect(h.got).toEqual([{ id: 17 }]);
  });

  test("半截帧是合法等待态：只存已收到的部分，不额外堆积", () => {
    const h = makeHarness();
    const json = JSON.stringify({ id: 18, pad: "x".repeat(100) });
    // 声明一个合法（未超上限）但永远收不齐的长度
    h.feed(`Content-Length: ${Buffer.byteLength(json) + 10_000_000}\r\n\r\n`);
    h.feed(Buffer.from(json, "utf-8"));
    expect(h.state().contentLength).toBeGreaterThan(0);
    expect(h.state().bufferLen).toBe(Buffer.byteLength(json));
  });
});

describe("LSPClient 帧解析 — 半截帧看门狗", () => {
  test("帧体超时未收齐 → 下一批数据到达时重置并重新同步", () => {
    const h = makeHarness();
    const json = JSON.stringify({ id: 19 });
    // 合法声明（不触发上界校验），但服务器只发了一部分就不发了
    h.feed(`Content-Length: ${Buffer.byteLength(json) + 500}\r\n\r\n`);
    h.feed(Buffer.from(json, "utf-8"));
    expect(h.state().contentLength).toBeGreaterThan(0); // 仍在等待剩余字节

    // 把帧起始时刻往前推，模拟"这条帧已经等了很久"。改私有字段而不引入假时钟：
    // 被测逻辑是"数据驱动的时间差判定"，直接构造那个时间差最贴近它的真实入口。
    h.client.frameStartedAt = Date.now() - STALE_FRAME_TIMEOUT_MS - 1000;

    // 下一批数据到达时看门狗介入：丢弃陈旧半截帧，从这批数据重新同步
    h.feed(frame({ id: 20 }));
    expect(h.got).toEqual([{ id: 20 }]);
    expect(h.state().contentLength).toBe(-1);
  });

  test("未超时的半截帧不被误杀", () => {
    const h = makeHarness();
    const f = frame({ id: 21, tail: "rest" });
    // 分两次喂入，中间没有时间流逝 → 看门狗不应介入
    h.feed(f.subarray(0, f.length - 5));
    expect(h.state().contentLength).toBeGreaterThan(0);
    h.feed(f.subarray(f.length - 5));
    expect(h.got).toEqual([{ id: 21, tail: "rest" }]);
  });
});
