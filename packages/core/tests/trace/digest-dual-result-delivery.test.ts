/**
 * F6：`dual_result_delivery` —— 同一后台任务的终态结果既经 task_output tool_result、
 * 又经 <task-notification> 送达。基线会话 20261019-002707-0d3ddd0e 修前检出 7 个。
 */

import { describe, test, expect } from "bun:test";
import { detectDualResultDelivery } from "@sid-code/core/trace/digest.ts";

const notif = (id: string, status = "completed") => ({
  type: "text",
  text: `[系统通知]\n<task-notification>\n  <task-id>${id}</task-id>\n  <status>${status}</status>\n</task-notification>`,
});
const call = (callId: string, taskId: string) => ({
  type: "tool_use",
  id: callId,
  name: "task_output",
  input: { task_id: taskId, timeout: 600000 },
});
const res = (callId: string, content: string) => ({
  type: "tool_result",
  tool_use_id: callId,
  content,
});

describe("detectDualResultDelivery", () => {
  test("旧 JSON 返回体 + 通知 → 检出；仅一路 → 不检出", () => {
    const messages = [
      { role: "assistant", content: [call("c1", "a1"), call("c2", "a2")] },
      {
        role: "user",
        content: [
          res("c1", '{"task_id":"a1","status":"completed"}\n\n--- 输出 ---\nx'),
          res("c2", '{"task_id":"a2","status":"completed"}'),
          notif("a1"),
          notif("a3"),
        ],
      },
    ];
    expect(detectDualResultDelivery(messages)).toEqual(["a1"]);
  });

  test("新标签块返回体也能判；运行中返回与停滞提示不算", () => {
    const messages = [
      { role: "assistant", content: [call("c1", "a1"), call("c2", "s1")] },
      {
        role: "user",
        content: [
          res("c1", "<task-output>\n  <status>completed</status>\n</task-output>"),
          res("c2", "<task-output>\n  <status>running</status>\n</task-output>"),
          notif("a1"),
          notif("s1", "running"),
        ],
      },
    ];
    expect(detectDualResultDelivery(messages)).toEqual(["a1"]);
  });
});
