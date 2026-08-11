import { buildTrajectory } from "@sid-code/core/trace/builder.ts";
function makePair(i: number) {
  return {
    timestamp: new Date(0).toISOString(), index: i, model: "test-model",
    request: {
      model: "test-model",
      raw_messages: Array.from({ length: i }, (_, k) => ({ role: "user", content: `msg ${k}` })),
      new_messages: [{ role: "user", content: `turn ${i}` }],
      ...(i === 1 ? { system: "sys", tools: [], messages: [] } : { _messages_count: i }),
    },
    response: { content: [
      { type: "text", text: "这是第 " + i + " 轮的助手回复，包含说明文字。".repeat(3) },
      { type: "tool_use", id: "t" + i, name: "bash", input: { command: "ls -la /some/path" } },
    ] },
    usage: { input_tokens: 100 * i, output_tokens: 200 },
    stop_reason: "tool_use", is_partial: false,
  } as any;
}
const meta: any = {
  session_id: "bench", model: "test", working_directory: "/tmp",
  tools_used: new Set(["bash"]), files_edited: new Set(), user_prompts: [],
  compactions: [], subagent_spans: [], total_api_calls: 0,
  total_tokens_sent: 0, total_tokens_received: 0, total_cost_usd: 0,
  total_cache_creation_tokens: 0, total_cache_read_tokens: 0,
  total_cumulative_prompt_tokens: 0, side_api_calls: 0, side_cost_usd: 0,
  side_tokens_sent: 0, side_tokens_received: 0,
  start_time: new Date(0).toISOString(), has_thinking: false, has_sub_agent: false,
};
console.log("累计轮次N  本轮rebuild(ms)  traj大小KB  累计写盘MB");
let cumBytes = 0; const pairs: any[] = [];
for (let n = 1; n <= 190; n++) {
  pairs.push(makePair(n));
  const t0 = performance.now();
  const traj = buildTrajectory(pairs, meta);
  const json = JSON.stringify(traj, null, 2);
  const ms = performance.now() - t0;
  cumBytes += json.length;
  if (n % 20 === 0 || n === 190) console.log(`${String(n).padEnd(10)} ${ms.toFixed(2).padEnd(15)} ${(json.length/1024).toFixed(0).padEnd(11)} ${(cumBytes/1024/1024).toFixed(1)}`);
}
console.log(`\n190 轮累计写盘 ${(cumBytes/1024/1024).toFixed(1)}MB（每轮全量覆盖重写 session.traj）`);
