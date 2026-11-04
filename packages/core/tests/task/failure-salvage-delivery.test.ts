/**
 * F3：失败子代理的残卷投递（方案 §4.3 第 1、2、5 条）。
 *
 * 事故背景（会话 20261103-f5beebde）：三个后台子代理因额度耗尽失败，残卷其实已经生成
 * （已改动文件 / 结论 / 下一步），但四条投递通道没有一条把它交到模型手上：
 * - `failAgentTask` 只把 `error.slice(0, 200)` 塞进 summary，`<error>` 通道空着；
 * - `.output` 在纯工具轮是空文件，`task_output` 读不到；
 * - 墓碑只说「清理前未留存到输出内容」，不提 sidechain（数据其实都在）。
 *
 * 落盘隔离：本文件会写 `.output` 与 sidechain 文件，必须把 SID_CONFIG_DIR 重定向到
 * tmpdir（CLAUDE.md 测试约定；preload 兜底不替代显式隔离）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createAgentTask,
  failAgentTask,
  killAgentTask,
  appendTaskOutput,
  flushTaskOutput,
  dequeuePendingNotifications,
  getTask,
  getAllTasks,
  clearAllTasks,
  updateTask,
  evictTerminalTasks,
  markNotificationsDelivered,
  markMainTurnCompleted,
  getTaskOutputTombstone,
  clearTaskOutputTombstones,
  formatTaskOutputTombstone,
  EVICT_GRACE_MS,
} from "@sid-code/core/task/index.ts";
import { NOTIFICATION_ERROR_MAX_CHARS } from "@sid-code/core/task/notification.ts";
import { __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

/** 一份形态与 `buildSalvageOutput` 一致的残卷（含 `<tool-evidence>`，本缺陷的新增段）。 */
const SALVAGE = [
  "<partial-result>",
  "  <interrupted-because>执行出错：LLM 错误（auth_suspect，3 次尝试）</interrupted-because>",
  '  <progress turns="6" tool_uses="12" input="81000" output="900" cache_read="0" cache_creation="0"/>',
  '  <changed-files count="0"/>',
  '  <tool-evidence count="1">',
  '    <evidence call="bash: git log --oneline -20">',
  "abc123 修缺陷",
  "def456 加测试",
  "    </evidence>",
  "  </tool-evidence>",
  "  <incomplete>",
  "    最后一步停在：bash: git log --oneline -20",
  "  </incomplete>",
  "  <next-step>",
  "    认证失败，检查凭证（API Key / 网关令牌）后重试。",
  "  </next-step>",
  "  <output-file>/tmp/sess-agent.jsonl</output-file>",
  "</partial-result>",
].join("\n");

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "sid-salvage-delivery-"));
  process.env.SID_CONFIG_DIR = configDir;
  clearAllTasks();
  clearTaskOutputTombstones();
  __resetForTest();
  dequeuePendingNotifications();
});

afterEach(async () => {
  // 必须先 flush 在途 drain 再删 tmpdir：`evictTaskOutput` 只 unlink、不取消 drain，
  // 队列里若还有内容，drain 会对着已删除的目录 appendFile → ENOENT。
  // 那是磁盘层既有的并发形态（本 PR 不改它），但测试里会让 bun 报「Unhandled error
  // between tests」并把全量结果标成 1 error。
  for (const t of getAllTasks()) await flushTaskOutput(t.id);
  await new Promise((r) => setTimeout(r, 0));
  clearAllTasks();
  clearTaskOutputTombstones();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

function newAgentTask(description = "核查 git 历史") {
  return createAgentTask({ agentType: "explore", prompt: "p", description }).taskState;
}

describe("F3 失败残卷投递", () => {
  test("残卷写进 .output（纯工具轮也读得到成果）", async () => {
    const t = newAgentTask();
    // 纯工具轮的逐轮摘要（F3-3 写入），残卷在其后追加
    appendTaskOutput(t.id, "[轮次 1] bash(git log) → 12 字节\n");

    await failAgentTask(t.id, SALVAGE);
    await flushTaskOutput(t.id);

    const content = readFileSync(t.outputFile, "utf-8");
    expect(content).toContain("[轮次 1] bash(git log) → 12 字节");
    expect(content).toContain("<partial-result>");
    expect(content).toContain("<tool-evidence");
    expect(content).toContain("abc123 修缺陷");
  });

  test("失败通知的 <error> 通道带上完整残卷（此前一直空着）", async () => {
    const t = newAgentTask();
    await failAgentTask(t.id, SALVAGE);

    const notifs = dequeuePendingNotifications();
    expect(notifs).toHaveLength(1);
    // untrusted 标记：残卷含任意工具结果（外部网页 / 仓库文件），与 <result> 同口径
    expect(notifs[0]!.content).toContain('<error untrusted="true">');
    expect(notifs[0]!.content).toContain("<tool-evidence");
    expect(notifs[0]!.content).toContain("执行出错：LLM 错误（auth_suspect，3 次尝试）");
  });

  test("summary 只留一行原因（不是残卷前 200 字）", async () => {
    const t = newAgentTask("核查 git 历史");
    await failAgentTask(t.id, SALVAGE);

    const content = dequeuePendingNotifications()[0]!.content;
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(content)?.[1] ?? "";
    // 「执行出错：」前缀被剥掉：summary 模板已经写了「执行失败」，不去重会「失败: 出错：」
    expect(summary).toBe('Agent "核查 git 历史" 执行失败: LLM 错误（auth_suspect，3 次尝试）');
    // 摘要里不应出现残卷结构（那是 <error> 的职责）
    expect(summary).not.toContain("<partial-result>");
  });

  test("裸错误消息（顶层异常兜底）取首行当摘要", async () => {
    const t = newAgentTask();
    await failAgentTask(t.id, "子代理执行异常: ECONNRESET\n    at foo.ts:1");

    const content = dequeuePendingNotifications()[0]!.content;
    expect(content).toContain(
      '<summary>Agent "核查 git 历史" 执行失败: 子代理执行异常: ECONNRESET</summary>',
    );
    expect(content).toContain('<error untrusted="true">子代理执行异常: ECONNRESET');
  });

  test("超长残卷按 4000 字截断，并附 output-file 指针", async () => {
    const t = newAgentTask();
    // 构造 5000 字的残卷：<error> 通道上限是 NOTIFICATION_ERROR_MAX_CHARS
    const longSalvage = `<partial-result>\n  <interrupted-because>执行出错：boom</interrupted-because>\n${"x".repeat(5000)}\n</partial-result>`;
    await failAgentTask(t.id, longSalvage);

    const content = dequeuePendingNotifications()[0]!.content;
    expect(content).toContain("[输出过长，已截断");
    expect(content).toContain(t.outputFile); // 完整内容在 .output 里（F3-2 已写入）
    expect(content.length).toBeLessThan(NOTIFICATION_ERROR_MAX_CHARS + 1000);
  });

  test("已被 kill 的任务不追写残卷（.output 归 kill 路径收尾）", async () => {
    const t = newAgentTask();
    killAgentTask(t.id);
    // killAgentTask 的 flush 是 fire-and-forget，等它落地
    await flushTaskOutput(t.id);

    await failAgentTask(t.id, SALVAGE);
    await flushTaskOutput(t.id);

    expect(existsSync(t.outputFile) ? readFileSync(t.outputFile, "utf-8") : "").not.toContain(
      "<partial-result>",
    );
    expect(getTask(t.id)!.status).toBe("killed");
  });

  test("前台子代理（notify=false）不投递通知，但残卷仍写进 .output", async () => {
    const t = newAgentTask();
    await failAgentTask(t.id, SALVAGE, false);
    await flushTaskOutput(t.id);

    expect(dequeuePendingNotifications()).toHaveLength(0);
    expect(readFileSync(t.outputFile, "utf-8")).toContain("<partial-result>");
  });
});

describe("F3 墓碑指向 sidechain", () => {
  /** 把任务推到「已完成、已送达、回合已过、面板驻留期已过」——下一步就能被驱逐。 */
  function readyToEvict(id: string) {
    updateTask<LocalAgentTaskState>(id, (t) => ({
      ...t,
      status: "completed",
      endTime: Date.now() - EVICT_GRACE_MS - 1,
      notified: true,
    }));
    markNotificationsDelivered([id]);
    markMainTurnCompleted();
  }

  test("sidechain 存在时，墓碑给出「完整轨迹在这里」", async () => {
    const t = newAgentTask();
    const sidechainDir = join(configDir, "sessions", "proj");
    mkdirSync(sidechainDir, { recursive: true });
    const sidechainFile = join(sidechainDir, "sess-agent.jsonl");
    writeFileSync(sidechainFile, '{"type":"sidechain_start"}\n');
    updateTask<LocalAgentTaskState>(t.id, (s) => ({ ...s, sidechainFile }));

    appendTaskOutput(t.id, "纯工具轮摘要\n");
    readyToEvict(t.id);
    evictTerminalTasks();

    const tomb = getTaskOutputTombstone(t.id);
    expect(tomb?.sidechainFile).toBe(sidechainFile);
    const text = formatTaskOutputTombstone(t.id, t.outputFile);
    expect(text).toContain(`完整轨迹（不会被清理）: ${sidechainFile}`);
  });

  test(".output 为空时墓碑不再只说「未留存」，也指向 sidechain", async () => {
    const t = newAgentTask();
    const sidechainFile = join(configDir, "sess-agent.jsonl");
    writeFileSync(sidechainFile, "{}\n");
    updateTask<LocalAgentTaskState>(t.id, (s) => ({ ...s, sidechainFile }));

    readyToEvict(t.id);
    evictTerminalTasks();

    const text = formatTaskOutputTombstone(t.id, t.outputFile);
    expect(text).toContain("清理前未留存到输出内容");
    expect(text).toContain(sidechainFile);
  });

  test("sidechain 路径不存在时不进墓碑（不给假指针）", async () => {
    const t = newAgentTask();
    updateTask<LocalAgentTaskState>(t.id, (s) => ({
      ...s,
      sidechainFile: join(configDir, "never-written.jsonl"),
    }));

    readyToEvict(t.id);
    evictTerminalTasks();

    expect(getTaskOutputTombstone(t.id)?.sidechainFile).toBeUndefined();
    expect(formatTaskOutputTombstone(t.id, t.outputFile)).not.toContain("完整轨迹（不会被清理）");
  });
});
