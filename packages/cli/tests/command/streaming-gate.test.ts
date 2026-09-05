/**
 * 流式插队判据测试（P0-1 / P0-2）。
 *
 * ## 这些用例在防什么
 *
 * 修复前 `handleSubmit` 写的是 `if (busy && !text.startsWith("/"))` —— 那个否定条件
 * 让**所有**斜杠命令在流式中一律直送，包括 `/compact` 这条会读-改-写消息历史的。
 * 症状是「模型说过的话凭空消失」（compact 基于旧快照 setMessages，覆盖掉流式期间
 * 新追加的消息），窗口是"调一次模型"的时长，秒级，很容易撞上。
 *
 * 而 `immediate` 字段 27 处声明 / 0 处生产读取，是纯装饰。所以下面**最后一组**
 * （「变异自证」）才是这份文件的核心：它证明判定真的读了 immediate 字段，
 * 而不是碰巧走对了分支 —— 否则修完仍然是一条死链，只是换了个位置。
 */

import { describe, test, expect } from "bun:test";
import { canRunDuringStreaming } from "@sid-code/cli/command/streaming-gate.ts";

/** 逼近真实命令表：27 条标了 immediate，3 条刻意没标。 */
const COMMANDS = [
  { name: "model", aliases: ["m"], immediate: true, type: "local" },
  { name: "clear", aliases: [], immediate: true, type: "local" },
  { name: "help", aliases: ["h", "?"], immediate: true, type: "local" },
  // 三条不标 immediate 的：都会改动"模型正在读写的那份状态"
  { name: "compact", aliases: [], type: "local" },
  { name: "btw", aliases: [], type: "local" },
  { name: "loop", aliases: [], type: "local" },
  // prompt 型：动作是往对话里塞消息
  { name: "review", aliases: [], immediate: true, type: "prompt" },
];

describe("canRunDuringStreaming", () => {
  test("普通文本一律入队（原有行为不变）", () => {
    expect(canRunDuringStreaming("帮我看看这段代码", COMMANDS)).toBe(false);
    expect(canRunDuringStreaming("", COMMANDS)).toBe(false);
  });

  test("标了 immediate 的命令直送", () => {
    expect(canRunDuringStreaming("/model opus", COMMANDS)).toBe(true);
    expect(canRunDuringStreaming("/clear", COMMANDS)).toBe(true);
  });

  test("别名同样按本名的 immediate 判定", () => {
    expect(canRunDuringStreaming("/m opus", COMMANDS)).toBe(true);
  });

  // 这三条是 P0-1 的核心：修复前它们全部直送
  test("/compact 入队——它与流式写入构成读-改-写竞争", () => {
    expect(canRunDuringStreaming("/compact", COMMANDS)).toBe(false);
  });

  test("/btw 入队——fork 的子代理共享正在被写的上下文", () => {
    expect(canRunDuringStreaming("/btw 这个函数干什么的", COMMANDS)).toBe(false);
  });

  test("/loop 入队——循环调度与正在跑的这一轮语义冲突", () => {
    expect(canRunDuringStreaming("/loop", COMMANDS)).toBe(false);
  });

  test("prompt 型即使标了 immediate 也入队（类型层硬限）", () => {
    // review 的 immediate 是 true，但 type=prompt 必须压过它：
    // prompt 的动作就是往对话里塞消息，而对话正在被写。
    const review = COMMANDS.find((c) => c.name === "review");
    expect(review?.immediate).toBe(true); // 前提成立，否则这条用例在测空气
    expect(canRunDuringStreaming("/review", COMMANDS)).toBe(false);
  });

  test("/exit /quit 直送（dispatchInput 前置拦截，不经注册表）", () => {
    expect(canRunDuringStreaming("/exit", COMMANDS)).toBe(true);
    expect(canRunDuringStreaming("/quit", COMMANDS)).toBe(true);
  });

  test("查不到的命令入队（fail-closed）", () => {
    // 可能是未知命令，也可能是 /tmp 这类路径 passthrough——两者都不该在流式中抢道。
    expect(canRunDuringStreaming("/xyzabc", COMMANDS)).toBe(false);
    expect(canRunDuringStreaming("/tmp", COMMANDS)).toBe(false);
  });

  test("命令表为空时一律入队（启动早期 / 旧体系回退路径）", () => {
    expect(canRunDuringStreaming("/model opus", [])).toBe(false);
  });

  test("参数与多余空白不影响命令名提取", () => {
    expect(canRunDuringStreaming("  /model   opus  ", COMMANDS)).toBe(true);
    expect(canRunDuringStreaming("  /compact  ", COMMANDS)).toBe(false);
  });

  /**
   * 变异自证：把 /model 的 immediate 改成 false，它必须改为入队。
   *
   * 这是整份文件里唯一能证明「immediate 字段真的被读了」的用例。
   * 少了它，上面所有断言在一个把 immediate 完全忽略、只按命令名硬编码白名单的
   * 实现下**也会全绿** —— 那就等于把死链从字段搬到了白名单，缺陷仍在。
   */
  test("变异自证：immediate 改 false 后同一条命令改为入队", () => {
    const mutated = COMMANDS.map((c) => (c.name === "model" ? { ...c, immediate: false } : c));
    expect(canRunDuringStreaming("/model opus", COMMANDS)).toBe(true);
    expect(canRunDuringStreaming("/model opus", mutated)).toBe(false);
  });

  test("变异自证：immediate 字段缺失（undefined）等价于不可插队", () => {
    const stripped = COMMANDS.map(({ immediate: _drop, ...rest }) => rest);
    for (const cmd of stripped) {
      if (cmd.name === "exit" || cmd.name === "quit") continue;
      expect(canRunDuringStreaming(`/${cmd.name}`, stripped)).toBe(false);
    }
  });
});
