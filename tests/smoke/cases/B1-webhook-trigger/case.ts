/**
 * B1 GitHub webhook 触发半边（G2）：daemon 起 webhook 源 → 收到签名正确的 `pull_request`
 * → clone PR 分支、算 diff → fork 无头 `-p` 子进程跑完 → 结果落 `trajectories/daemon-jobs/`。
 *
 * 期望来源：核心功能触发清单 B1 的人工实测（2026-11-05，v0.1.614，真实 GitHub webhook，
 * 测试仓 `njfuzrs/agent-traj-bench` PR #13）：① GitHub 投递 `pull_request` 得 `202`；
 * ② `daemon.log` 出现 `headless job 启动 source=webhook`；③ job `exitCode=0 / timedOut=false`。
 * 回贴半边（PR 上出现 review）是零实现，按后续规划 §6 裁决 4 本季度不做、不在本例。
 *
 * 两个可行性未知数（后续规划 PR-13）的答案：
 * - **clone 地址**：worker 只把 `owner/repo` 拼成 `https://github.com/<owner>/<repo>.git`，
 *   不读载荷里的 `clone_url`。用假 HOME 的 `~/.gitconfig` 写 `url.<file://…>.insteadOf=https://github.com/`
 *   把它重定向到用例仓里的本地裸仓，产品代码不动；`GIT_ALLOW_PROTOCOL` 放开 file。
 * - **job 子进程能否走 replay**：能。子进程继承 daemon 的 env，`SID_CODE_REPLAY_FILE` 指向 `job.jsonl`。
 *
 * 端口：daemon 的 webhook 端口写死 3847（`daemon.ts` 的 `webhookPort ?? 3847`，CLI 没有参数），
 * 本机已有 daemon 占用 3847 时本例会红在「webhook 源已启动」之前——这是真实约束，不绕。
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

const SECRET = "smoke-webhook-secret";
const PORT = 3847;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=s@s", "-c", "user.name=s", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const def: SmokeCase = {
  id: "B1-webhook-trigger",
  ledger: "B1",
  feature: "GitHub webhook 触发 daemon 无头 job（触发半边）",
  kind: "guard",
  repo: { "README.md": "b1\n" },
  argv: ["-p", "你好"],
  after: [
    {
      kind: "daemon",
      replay: "job.jsonl",
      intervalMs: 60_000,
      argv: ["--webhook"],
      env: { SID_CODE_WEBHOOK_SECRET: SECRET, GIT_ALLOW_PROTOCOL: "file:https" },
      // 上游仓（main + feature 各一个提交）→ 裸仓 smoke-owner/smoke-repo.git → 假 HOME 的 insteadOf
      prepare: ({ repoRoot }) => {
        // 3847 已被占（本机常驻 daemon）时 webhook 源起不来，本例会一路等到超时。先探一下，
        // 红在这里并说清原因；不跳过——跳过会让「本机装着 daemon」的人永远看不到这个用例。
        const probe = Bun.spawnSync(["lsof", "-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], {
          stdout: "pipe",
        });
        if (probe.stdout.toString().trim())
          throw new Error(
            `端口 ${PORT} 已被占用（本机常驻 daemon？），先停掉再跑：\n${probe.stdout}`,
          );
        const up = join(repoRoot, "..", "upstream");
        mkdirSync(up, { recursive: true });
        git(up, "init", "-q", "-b", "main");
        git(up, "commit", "-q", "--allow-empty", "-m", "base");
        git(up, "checkout", "-q", "-b", "feature");
        writeFileSync(join(up, "a.txt"), "新增一行\n");
        git(up, "add", "a.txt");
        git(up, "commit", "-q", "-m", "feat");
        const remotes = join(repoRoot, "..", "remotes");
        mkdirSync(join(remotes, "smoke-owner"), { recursive: true });
        git(remotes, "clone", "-q", "--bare", up, "smoke-owner/smoke-repo.git");
        const home = join(repoRoot, "..", "home");
        writeFileSync(
          join(home, ".gitconfig"),
          `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`,
        );
      },
      trigger: {
        ready: /webhook 源已启动 :3847/,
        run: async ({ repoRoot }) => {
          const up = join(repoRoot, "..", "upstream");
          const body = JSON.stringify({
            action: "opened",
            number: 1,
            pull_request: {
              number: 1,
              head: { ref: "feature", sha: git(up, "rev-parse", "feature") },
              base: { ref: "main" },
              diff_url: "",
            },
            repository: { name: "smoke-repo", owner: { login: "smoke-owner" } },
            sender: { login: "smoke" },
          });
          const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
          const res = await fetch(`http://127.0.0.1:${PORT}/webhook/github`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "pull_request",
              "x-hub-signature-256": sig,
            },
            body,
          });
          const json = (await res.json()) as { status?: string };
          return res.status === 202 && json.status === "accepted"
            ? null
            : `webhook 投递期望 202 accepted，实际 ${res.status} ${JSON.stringify(json)}`;
        },
      },
      until: /headless job (完成|退出码非 0|超时)/,
      timeoutMs: 60_000,
    },
  ],
  expect: {
    output: ({ configDir }) => {
      const log = readFileSync(join(configDir, "logs/daemon.log"), "utf8");
      const order = ["webhook 源已启动", "headless job 启动 source=webhook", "headless job 完成"];
      let at = -1;
      for (const s of order) {
        const i = log.indexOf(s, at + 1);
        if (i < 0) return `daemon.log 缺「${s}」或顺序不对；末尾：${log.slice(-600)}`;
        at = i;
      }
      const dir = join(configDir, "trajectories/daemon-jobs");
      const files = readdirSync(dir).filter((f) =>
        /^pr-smoke-owner-smoke-repo-1-.+\.json$/.test(f),
      );
      if (files.length !== 1)
        return `daemon-jobs 期望 1 个 pr-*.json，实际 ${JSON.stringify(readdirSync(dir))}`;
      const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
      if (rec.job?.source !== "webhook") return `job.source 期望 webhook，实际 ${rec.job?.source}`;
      if (rec.exitCode !== 0 || rec.timedOut !== false)
        return `job 期望 exitCode=0 timedOut=false，实际 ${rec.exitCode}/${rec.timedOut}`;
      // prompt 里嵌了真实算出来的 diff：证明 clone + fetch base + 三点 diff 这段走通了
      if (!String(rec.job?.prompt ?? "").includes("+新增一行"))
        return "job prompt 里没有 PR 的 diff（clone / diff 这段没走通）";
      if (rec.output !== "审查完成：a.txt 新增一行，无问题。")
        return `job output 期望来自 job.jsonl，实际 ${JSON.stringify(rec.output)}`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/daemon/server.ts",
      find: "        const resultPromise = worker.handlePR(prEvent);",
      replace: "        const resultPromise = Promise.resolve(prEvent);",
      why: "webhook 照常回 202 accepted，但 worker 根本没起 job（只看 HTTP 状态会假绿）",
    },
    {
      file: "packages/core/src/daemon/worker.ts",
      find: '        source: "webhook",',
      replace: '        source: "schedule",',
      why: "job 照跑，但来源被记成 schedule——轨迹分不出这次是 webhook 触发的",
    },
    {
      file: "packages/core/src/daemon/server.ts",
      find: '  if (body.action !== "opened" && body.action !== "synchronize" && body.action !== "reopened") {',
      replace: "  if (true) {",
      why: "PR opened 事件被当成不支持的 action 忽略，webhook 返回 200 ignored",
    },
  ],
};

export default def;
