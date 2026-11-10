/**
 * X4 resume：`-c` 之后交出的会话 id 必须指回**被恢复的那个会话**。两条输出路径都守：
 *
 * 1. `--output-format json` 的 `session_id` / `trajectory_path`（#666）；
 * 2. `--output-format stream-json` 的 `session_id` —— 引擎用同一个 config.sessionId 填
 *    `system/init`、每条 user/assistant 与全部 result（PR-5）。
 *
 * 期望来源：构建产物探针（修复前）。
 * - 2026-11-08 json：首次 `-p` 得 S1；`-c -p` 交出 S2（进程新 id）与
 *   `sessions/S2/session.traj`，但磁盘上只有 S1（轨迹续写进被恢复会话，
 *   `SessionStart{source=resume,resumed_from=S1}`）；
 * - 2026-11-10 stream-json：`-c -p` 的 `system/init`、每条 user/assistant、`result`
 *   的 `session_id` 全是 S2；磁盘上仍只有 S1；`--resume S2` 报「未找到会话」exit 1，
 *   `--resume S1` exit 0（那一轮又交出第三个新 id，同样不可用）。
 *
 * 判据是「与磁盘事实一致」，不是「与某个 id 相等」：两个 id 都是合法 string，
 * 断言写成相等关系时很容易对着错的那个写（agent 记忆「resume 两个 id」）。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

type Out = { session_id?: unknown; trajectory_path?: unknown };

/** 隔离配置目录里的 `sessions/<slug>/<id>.jsonl`。找不到 = 这个 id 拿去 --resume 会报未找到 */
function findSessionFile(configDir: string, sessionId: string): string | null {
  const root = join(configDir, "sessions");
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** NDJSON → 消息数组；有一条坏行就抛，交给调用方报「不是合法 NDJSON」 */
function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const def: SmokeCase = {
  id: "X4-resume-id",
  ledger: "X4",
  feature: "resume",
  kind: "guard",
  repo: {},
  argv: ["-p", "hi"],
  after: [
    { kind: "print", replay: "continue.jsonl", argv: ["-c", "-p", "again"] },
    {
      kind: "print",
      replay: "continue.jsonl",
      outputFormat: "stream-json",
      argv: ["-c", "-p", "third"],
    },
  ],
  expect: {
    exitCode: 0,
    output: ({ stdout, steps, configDir }) => {
      const first = stdout as Out;
      if (typeof first.session_id !== "string") return "首次 -p 的 stdout 缺 session_id";

      // ── ① json 输出（#666） ──
      const jsonStep = steps[0];
      if (!jsonStep || jsonStep.exitCode !== 0)
        return `json 的 -c -p 退出码 ${jsonStep?.exitCode}，期望 0`;
      let cont: Out;
      try {
        cont = JSON.parse(jsonStep.stdout) as Out;
      } catch {
        return `json 的 -c -p 的 stdout 不是合法 JSON：${jsonStep.stdout.slice(0, 200)}`;
      }
      if (typeof cont.trajectory_path !== "string")
        return "json 的 -c -p 的 stdout 缺 trajectory_path";
      if (!existsSync(cont.trajectory_path))
        return `json 的 -c -p 交出的 trajectory_path 不存在：${cont.trajectory_path}`;
      if (cont.session_id !== first.session_id)
        return `json 的 -c -p 的 session_id=${String(cont.session_id)}，不是被恢复的会话 ${first.session_id}（拿它 --resume 会报未找到）`;

      // ── ② stream-json 输出（PR-5）：同一份会话的另一条路径 ──
      const streamStep = steps[1];
      if (!streamStep || streamStep.exitCode !== 0)
        return `stream-json 的 -c -p 退出码 ${streamStep?.exitCode}，期望 0`;
      let messages: Array<Record<string, unknown>>;
      try {
        messages = parseNdjson(streamStep.stdout);
      } catch {
        return `stream-json 的 stdout 不是合法 NDJSON：${streamStep.stdout.slice(0, 200)}`;
      }
      const results = messages.filter((m) => m.type === "result");
      const last = results[results.length - 1];
      if (!last) return "stream-json 输出里没有 result";
      const sid = last.session_id;
      if (typeof sid !== "string" || !sid) return "stream-json 的 result.session_id 不是非空字符串";
      // 主判据：这个 id 在磁盘上有对应会话文件，才谈得上「拿去 --resume 能用」
      if (!findSessionFile(configDir, sid))
        return `stream-json 的 result.session_id=${sid} 在磁盘上没有会话文件（拿它 --resume 会报「未找到会话」exit 1）`;
      if (sid !== first.session_id)
        return `stream-json 的 result.session_id=${sid}，不是被恢复的会话 ${first.session_id}`;
      // 同源字段：system/init、user、assistant 都由引擎的同一个 config.sessionId 填，
      // 漏改一处就会出现一条会话两种 id。
      const inconsistent = messages.filter(
        (m) => typeof m.session_id === "string" && m.session_id !== sid,
      );
      if (inconsistent.length > 0)
        return `stream-json 里有 ${inconsistent.length} 条消息的 session_id 与 result 不一致：${inconsistent
          .map((m) => `${String(m.type)}:${String(m.session_id)}`)
          .slice(0, 3)
          .join(" / ")}`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/cli/src/app.ts",
      find: "      const outputSessionId = this.getLogicalSessionId();",
      replace: "      const outputSessionId = this.sessionState.sessionId;",
      why: "json 输出回到进程新 id：-c 后 trajectory_path 指向不存在的目录、session_id 无法 --resume",
    },
    {
      file: "packages/cli/src/app.ts",
      find: "        sessionId: this.getLogicalSessionId(),\n        model: this.config.model,",
      replace: "        sessionId: this.sessionState.sessionId,\n        model: this.config.model,",
      why: "stream-json 的 session_id 回到进程新 id：磁盘上没有该会话，宿主拿它 --resume 报未找到",
    },
  ],
};

export default def;
