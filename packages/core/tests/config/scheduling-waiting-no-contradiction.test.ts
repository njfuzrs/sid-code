/**
 * N1 反矛盾门禁：同一份系统提示里，「等 CI / 构建 / 部署这类外部状态」只能映射到
 * <waiting-capability>（或它缺席时的后台 bash 兜底），不得再被 <scheduling-capability>
 * 映射到 schedule_wakeup 轮询。
 *
 * 事故形态（docs-research 20261110 §N1，会话 20261109-160803-fbb02831）：
 * `<scheduling-capability>` 写「自适应轮询（『跑到 CI 过为止』『等部署好了告诉我』）→
 * schedule_wakeup」，#722 新增的 `<waiting-capability>` 写「CI 全绿了告诉我 → 后台 bash /
 * monitor」。同一个意图两段给出不同工具，模型只能靠措辞命中猜一个——那次会话的
 * `tool_search` 只激活了 `schedule_wakeup`，monitor 从未进入候选。
 *
 * 四组断言 = 中 / 英 × monitor 已注册 / 未注册。每组锁三件事：
 *  1. 旧的「条件式等待 → schedule_wakeup」例句不许回来；
 *  2. 段内提到 CI / 部署（en: deploy）的行只能是「等外部状态」让出句；
 *  3. 让出句指向的出口必须真实存在：monitor 在则指向 <waiting-capability>（并确认该段
 *     确实注入），不在则给不依赖 monitor 的后台 bash + `wait_until_seconds` 兜底。
 *
 * 为什么 key 在「行」上而不是整段字符串：让出句必须点名 CI / 部署 这类关键词，模型才认
 * 得出这就是用户那句话；要防的是这些关键词被**另一条 bullet** 接走映射到唤醒轮询。
 * 「含 schedule_wakeup 的行不得同时含外部状态关键词」是这条边界最直接的机械形式。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";

function makeTool(name: string) {
  return {
    name: () => name,
    description: () => `${name} 的一句话说明`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
    // 调度工具与 monitor 在生产里都是 shouldDefer=true，按真实形态渲染，
    // 让本门禁同时也覆盖「激活说明存在」时的段文本。
    shouldDefer: true,
  };
}

const SCHEDULING_TOOLS = ["cron_create", "schedule_wakeup", "cron_list", "cron_delete"].map(
  makeTool,
);

function promptOf(opts: { monitor: boolean; en: boolean }): string {
  const tools = opts.monitor ? [...SCHEDULING_TOOLS, makeTool("monitor")] : SCHEDULING_TOOLS;
  clearPromptCache();
  return buildSystemPrompt({
    tools,
    preferredLanguage: opts.en ? "en" : undefined,
  });
}

function sectionOf(prompt: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  // 段落标签独占一行。不能裸 indexOf：monitor 注册时 scheduling 段的让出句里含
  // `<waiting-capability>` 字面量（行内、后面跟反引号），裸 indexOf 会把 waiting 段的
  // 切片起点落到 scheduling 段中间，于是「waiting 段含 wait_until_seconds」被 scheduling
  // 段自己的 wait_until_seconds 满足掉——一条恒绿断言。
  const m = new RegExp(`^${open}$`, "m").exec(prompt);
  expect(m).not.toBeNull();
  const start = m!.index;
  const end = prompt.indexOf(close, start);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end + close.length);
}

const OLD_EXAMPLES = {
  zh: ["跑到 CI 过为止", "等部署好了告诉我", "自适应轮询"],
  en: ["keep going until CI is green", "tell me when the deploy is done", "Adaptive polling"],
} as const;

const EXIT_ANCHOR = { zh: "- **等外部状态**", en: "- **Waiting on external state**" } as const;
const WAKEUP_BAN = { zh: "不要用唤醒轮询", en: "do not poll with wakeups" } as const;

for (const monitor of [true, false]) {
  for (const en of [false, true]) {
    const lang = en ? "en" : "zh";
    const label = `${lang} / monitor ${monitor ? "已注册" : "未注册"}`;

    describe(`N1 反矛盾 — ${label}`, () => {
      beforeEach(() => clearPromptCache());

      test("旧的「条件式等待 → schedule_wakeup」例句不许回来", () => {
        const sec = sectionOf(promptOf({ monitor, en }), "scheduling-capability");
        for (const old of OLD_EXAMPLES[lang]) expect(sec).not.toContain(old);
      });

      test("提到 CI / 部署 的行只能是「等外部状态」让出句，且出口真实存在", () => {
        const prompt = promptOf({ monitor, en });
        const sec = sectionOf(prompt, "scheduling-capability");
        const anchor = EXIT_ANCHOR[lang];
        const keyword = en ? /CI|deploy/ : /CI|部署/;

        const keywordLines = sec.split("\n").filter((l) => keyword.test(l));
        // 让出句必须在：否则 scheduling 段对「等外部状态」没有任何指向。
        expect(keywordLines.length).toBeGreaterThan(0);
        for (const line of keywordLines) expect(line.trim().startsWith(anchor)).toBe(true);

        // 让出句本身必须点破「不要用唤醒轮询」，并在 monitor 缺席时给出不依赖它的出口。
        const exitLine = keywordLines.find((l) => l.trim().startsWith(anchor))!;
        expect(exitLine).toContain(WAKEUP_BAN[lang]);
        expect(exitLine).toContain("wait_until_seconds");
        if (monitor) {
          expect(exitLine).toContain("<waiting-capability>");
          // 指向的段落必须真的注入，且它仍把「CI 全绿」映射到后台等待。
          // 导语那一行是「切片起点确实落在 waiting 段」的锚点（防止上面的路径问题复发）。
          const waitSec = sectionOf(prompt, "waiting-capability");
          expect(waitSec).toContain(en ? "## Waiting on external state" : "## 等待外部状态");
          expect(waitSec).toContain("wait_until_seconds");
        } else {
          expect(exitLine).not.toContain("<waiting-capability>");
          expect(exitLine).toContain("run_in_background=true");
          expect(prompt).not.toContain("<waiting-capability>");
        }
      });

      test("含 schedule_wakeup 的行不再承载外部状态关键词（定时复查仍在）", () => {
        const sec = sectionOf(promptOf({ monitor, en }), "scheduling-capability");
        const keyword = en ? /CI|deploy/ : /CI|部署/;
        const wakeupLines = sec.split("\n").filter((l) => l.includes("schedule_wakeup"));
        expect(wakeupLines.length).toBeGreaterThan(0);
        for (const line of wakeupLines) expect(keyword.test(line)).toBe(false);
      });
    });
  }
}
