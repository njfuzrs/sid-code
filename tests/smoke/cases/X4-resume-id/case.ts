/**
 * X4 resume：`-c` 之后 `--output-format json` 的 `session_id` / `trajectory_path`
 * 必须指向**被恢复的那个会话**——轨迹真的写在那里，拿这个 id 也能 `--resume`。
 *
 * 期望来源：2026-11-08 构建产物探针（修复前）：
 * - 首次 `-p`：stdout `session_id=S1`，轨迹目录 `sessions/S1/`；
 * - `-c -p`：stdout `session_id=S2`（进程新 id）、`trajectory_path=sessions/S2/session.traj`，
 *   但 `sessions/` 下只有 S1（轨迹续写进被恢复会话，`SessionStart{source=resume,resumed_from=S1}`）；
 * - `--resume S2` 报「未找到会话」exit 1，`--resume S1` 正常。
 * 即 stdout 交出的两个字段在 resume 下都是错的。eval 适配器（`evals/providers/sid-code-live.ts`）
 * 读 `trajectory_path` 判健康，路径不存在就判 error。
 *
 * 判据是「与磁盘事实一致」，不是「与某个 id 相等」：两个 id 都是合法 string，
 * 断言写成相等关系时很容易对着错的那个写（agent 记忆「resume 两个 id」）。
 */
import { existsSync } from "node:fs";
import type { SmokeCase } from "../../lib/types.ts";

type Out = { session_id?: unknown; trajectory_path?: unknown };

const def: SmokeCase = {
  id: "X4-resume-id",
  ledger: "X4",
  feature: "resume",
  kind: "guard",
  repo: {},
  argv: ["-p", "hi"],
  after: [{ kind: "print", replay: "continue.jsonl", argv: ["-c", "-p", "again"] }],
  expect: {
    exitCode: 0,
    output: ({ stdout, steps }) => {
      const first = stdout as Out;
      const step = steps[0];
      if (!step || step.exitCode !== 0) return `-c -p 退出码 ${step?.exitCode}，期望 0`;
      let cont: Out;
      try {
        cont = JSON.parse(step.stdout) as Out;
      } catch {
        return `-c -p 的 stdout 不是合法 JSON：${step.stdout.slice(0, 200)}`;
      }
      if (typeof cont.trajectory_path !== "string") return "-c -p 的 stdout 缺 trajectory_path";
      if (!existsSync(cont.trajectory_path))
        return `-c -p 交出的 trajectory_path 不存在：${cont.trajectory_path}`;
      if (cont.session_id !== first.session_id)
        return `-c -p 的 session_id=${String(cont.session_id)}，不是被恢复的会话 ${String(first.session_id)}（拿它 --resume 会报未找到）`;
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
  ],
};

export default def;
