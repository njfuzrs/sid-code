/**
 * Q1：后台任务回执 / system 段 / 循环检测恢复提示的文案契约。
 *
 * 事故：三处回执（子代理 `agent/tool.ts`、bash 后台、Ctrl+B 转后台）给了「需要看进度时
 * read output_file」的许可，离行动最近的那条压过了 system 里的禁令；循环检测的轮询恢复提示
 * 第一条推荐的是阻塞式 bg_task_get，与主循环新加的拦截方向相反。
 *
 * 锁的是源码层面：三处都引用同一个常量（改一处不会漏两处），旧许可字面量不再出现。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BACKGROUND_RECEIPT_NOTICE } from "@sid-code/core/task/background-receipt.ts";
import { LOOP_RECOVERY_POLLING_PROMPT } from "@sid-code/core/agent/loop-detection.ts";
import { buildSubagentResultBoundarySectionEn } from "@sid-code/core/config/prompt-sections-en.ts";

const SRC = join(import.meta.dir, "..", "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("后台回执", () => {
  test("常量本身：禁令 + 路径相关动词 + 「仍在运行」替代话术，不含许可", () => {
    expect(BACKGROUND_RECEIPT_NOTICE).toContain("不要");
    expect(BACKGROUND_RECEIPT_NOTICE).toMatch(/read.*ls.*tail/);
    expect(BACKGROUND_RECEIPT_NOTICE).toContain("output_file");
    expect(BACKGROUND_RECEIPT_NOTICE).toContain("仍在运行");
    expect(BACKGROUND_RECEIPT_NOTICE).toContain("自动通知");
    expect(BACKGROUND_RECEIPT_NOTICE).not.toMatch(/可 ?read output_file|需要看进度时 read/);
  });

  test("子代理后台回执引用共享常量，不再出现「可 read output_file」", () => {
    const s = read("agent/tool.ts");
    expect(s).toContain("子代理已在后台启动 (task_id: ${taskId})。${BACKGROUND_RECEIPT_NOTICE}");
    expect(s).not.toContain("可 read output_file");
  });

  test("bash 后台回执与 Ctrl+B 回执都引用共享常量", () => {
    const s = read("tool/bash.ts");
    expect(s).toContain(
      "命令已作为后台任务启动 (task_id: ${taskState.id})。${BACKGROUND_RECEIPT_NOTICE}",
    );
    expect(s).toContain(
      "已将当前前台命令转入后台 (task_id: ${adopted.taskState.id})。${BACKGROUND_RECEIPT_NOTICE}",
    );
    expect(s).not.toContain("需要看进度时 read output_file");
    // 三处之外不许再冒出一份手写禁令（改一处漏两处的老路）
    expect(s.match(/BACKGROUND_RECEIPT_NOTICE/g)?.length).toBe(3); // import + 2 处引用
  });
});

describe("system prompt：「后台任务不要轮询」整段中英同删，「按需拉取完整结论」保留", () => {
  test("中文", () => {
    const s = read("config/system-prompt.ts");
    expect(s).not.toContain("## 后台任务不要轮询");
    expect(s).toContain("## 按需拉取完整结论");
    expect(s).toContain("read(<output-file>)");
  });

  test("英文", () => {
    const en = buildSubagentResultBoundarySectionEn();
    expect(en).not.toContain("Do not poll background tasks");
    expect(en).toContain("Pull the full result on demand");
    expect(en).toContain("read(<output-file>)");
  });
});

describe("循环检测轮询恢复提示", () => {
  test("不再推荐阻塞等待原语", () => {
    expect(LOOP_RECOVERY_POLLING_PROMPT).not.toContain("block: true");
    expect(LOOP_RECOVERY_POLLING_PROMPT).not.toMatch(/阻塞等待\*\*（推荐）/);
    expect(LOOP_RECOVERY_POLLING_PROMPT).toContain("<task-notification>");
    expect(LOOP_RECOVERY_POLLING_PROMPT).toContain("结束本轮");
  });
});
