/**
 * 门禁 · 无头长驻形态必须注册定时注入通道（T6）
 *
 * `/compact` 与 `/loop` 按形态放行（`-p` 拒绝、stream-json / Bridge 放行）的前提是：
 * 长驻形态下真的存在一条「把定时 prompt 送进主循环」的通道。
 *
 * 核实前它并不存在——`App.setPromptInjector` 全仓只有 TUI 的 `onUserInput` 一处调用，
 * 于是 cron / `/loop` / `schedule_wakeup` 到点触发的 prompt 只进
 * `App.scheduledPromptQueue` 再没人认领（`enqueueScheduledPrompt` 的
 * `if (this.busy || !this.promptInjector) push` 永远命中）。命令照样报
 * 「空闲时会自动触发」，实际永不触发——正是方案 D6 那类假成功。
 *
 * 这条接线跨三个文件（core 的 headless-runner / bridge-runner + cli 的 app.ts），
 * 断在中间**不会有任何运行时症状**：命令能执行、退出码 0、输出「已创建循环任务」。
 * 所以用静态断言锁住，而不是等端到端测试跑满一分钟才发现。
 *
 * ⚠️ 用 readFileSync 而非 shell grep：app.ts 曾含 NUL 字节，grep 会判成 binary
 * 并**静默跳过**（同 cmdctx-session-id-wiring.test.ts 里的注释）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliSrc = join(import.meta.dir, "..", "..", "src");
const coreSrc = join(import.meta.dir, "..", "..", "..", "core", "src");

const appSrc = readFileSync(join(cliSrc, "app.ts"), "utf-8");
const headlessRunnerSrc = readFileSync(join(coreSrc, "sdk", "headless-runner.ts"), "utf-8");
const bridgeRunnerSrc = readFileSync(join(coreSrc, "bridge", "bridge-runner.ts"), "utf-8");

describe("T6 接线：长驻形态必须注册定时注入通道", () => {
  test("stream-json（runHeadlessSDK）把注入通道接到 App.promptInjector", () => {
    // 声明了 onInjectorReady 不等于接线：必须真的把它变成 promptInjector。
    expect(appSrc).toContain("onInjectorReady: (inject) => {");
    expect(appSrc).toContain("this.setPromptInjector(async (text) => inject(text));");
  });

  test("Bridge（runBridge）把注入通道接到 BridgeRunner.injectLocalMessage", () => {
    expect(appSrc).toContain(
      "this.setPromptInjector(async (text) => bridgeRunner.injectLocalMessage(text));",
    );
  });

  test("core：runHeadlessStreaming 真的消费 onInjectorReady（入队 + 唤醒）", () => {
    // 只声明参数不调用，等于通道不存在。
    expect(headlessRunnerSrc).toContain("options.onInjectorReady?.((");
    // 入队：与宿主消息同一条 commandQueue
    expect(headlessRunnerSrc).toContain(
      'commandQueue.enqueue({ mode: "prompt", value: text, priority: "next" });',
    );
    // 唤醒：少了 notify，stdin 已 EOF 时主循环会错过队列非空的复查
    expect(headlessRunnerSrc).toContain("notify();");
  });

  test("core：BridgeRunner.injectLocalMessage 复用远程消息的同一条队列", () => {
    expect(bridgeRunnerSrc).toContain("injectLocalMessage(text: string): void {");
    // 必须是 this.enqueue(...)：另起一条队列会让两条消费链抢同一个会话
    // （谁先谁后、错误怎么报都会分叉）。
    expect(bridgeRunnerSrc).toMatch(
      /injectLocalMessage\(text: string\): void \{\s*\n\s*this\.enqueue\(text\);/,
    );
  });

  test("core：注入通道不传给 -p 单轮路径（text/json 分支不注册）", () => {
    // runHeadless 的 text/json 分支在函数末尾，`onInjectorReady` 只在 stream-json
    // 分支透传。这里锁住「透传点出现在 runHeadlessStreaming 调用块内」——
    // 若有人把它提到函数开头，-p 也会注册注入器，语义就错了（单轮没有下一次触发）。
    const streamingCall = headlessRunnerSrc.indexOf(
      "for await (const msg of runHeadlessStreaming(",
    );
    const passThrough = headlessRunnerSrc.indexOf("onInjectorReady: options.onInjectorReady");
    expect(streamingCall).toBeGreaterThan(-1);
    expect(passThrough).toBeGreaterThan(streamingCall);
  });
});
