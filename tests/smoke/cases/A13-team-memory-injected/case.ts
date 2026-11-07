/**
 * A13 团队记忆：共享目录里已有一条团队记忆，新会话首轮请求的 system 里要出现团队索引段。
 *
 * 期望来源：核心功能触发清单 A13 的人工实测（2026-11-05）。用的是其中「跨成员」那一步
 * （会话 20261105-194229-08940a79）的形态：本地 `team-memory/` 不存在，只有共享目录里有条目，
 * 启动期 watcher 初始同步把它拉回来、重建 MEMORY.md，首轮 system 命中 1。
 * 记忆文件原样取自那次的共享目录 `/tmp/a13-shared/project_team-release-freeze.md`。
 *
 * 选这一步而不是「同会话 save_memory 后再问」：注入是启动期一次性快照，存记忆的会话自身
 * 首轮命中 0（实测），那条要两次进程才能演示，而跨成员这一步一次进程就同时守住了
 * 「共享目录 → 本地」的拉取和「本地索引 → system」的注入两段接线。
 *
 * 局限（台账 A13 已注明）：G2 只能断言最终序列化结果，证明不了加载方式没变；
 * 模型会不会据此答对是 G3 的事，夹具里的回答只是为了让会话正常收尾。
 */
import type { SmokeCase } from "../../lib/types.ts";

const SHARED_DIR = ".team-shared";
const TEAM_SECTION = "### 团队共享记忆索引（团队 MEMORY.md）";

const def: SmokeCase = {
  id: "A13-team-memory-injected",
  ledger: "A13",
  feature: "团队记忆",
  kind: "guard",
  repo: {
    [`${SHARED_DIR}/project_team-release-freeze.md`]: [
      "---",
      "name: team-release-freeze",
      "description: 团队发布冻结约定：每月最后一个周五为发布冻结日，代号 BLUE-FALCON。冻结期间只允许 hotfix 合并。",
      "type: project",
      "created: 1793878659758",
      "updated: 1793878659758",
      "---",
      "",
      "团队发布冻结约定：每月最后一个周五为发布冻结日，代号 BLUE-FALCON。冻结期间只允许 hotfix 合并。",
      "",
    ].join("\n"),
  },
  // 共享目录要绝对路径（schema 校验），放在用例仓里随临时目录一起回收
  settings: ({ defaults, repoRoot }) => ({
    ...defaults,
    teamMemory: { enabled: true, dir: `${repoRoot}/${SHARED_DIR}` },
  }),
  argv: ["-p", "团队发布冻结日的代号是什么"],
  expect: {
    output: ({ requests }) => {
      const first = requests[0] as { system?: unknown } | undefined;
      if (!first) return "raw.jsonl 里没有任何请求";
      const system = typeof first.system === "string" ? first.system : JSON.stringify(first.system);
      const hits = system.split(TEAM_SECTION).length - 1;
      if (hits !== 1) return `首轮 system 里「${TEAM_SECTION}」期望 1 次，实际 ${hits} 次`;
      const section = system.slice(system.indexOf(TEAM_SECTION));
      // 索引行由拉回本地后的 frontmatter 重建，desc 按 INDEX_DESC_MAX_LEN=40 截断，所以只断言前段
      const line = "[team-release-freeze](project_team-release-freeze.md)";
      if (!section.includes(line)) return `团队索引段里没有索引行 ${line}`;
      if (!section.includes("代号 BLUE-FALCON"))
        return "团队索引段里没有记忆摘要「代号 BLUE-FALCON」";
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/memory/prompt.ts",
      find: "if (teamIndexContent && teamIndexContent.trim()) {",
      replace: "if (false) {",
      why: "团队索引读到了但不进 system，模型不知道团队知识存在",
    },
    {
      file: "packages/core/src/memory/team/watcher.ts",
      find: "const result = await syncTeamMemory(opts, cwd);",
      replace: "const result = { success: false, pulled: 0, pushed: 0 };",
      why: "启动期不从共享目录拉取，新协作者本机看不到团队记忆",
    },
  ],
};

export default def;
