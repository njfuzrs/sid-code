/**
 * CG-1：cwd 跨出工作区根后的「值型」撤销通知 + enter_worktree 报错带路径。
 *
 * 剧本（文档 §3.4 定的那条）：先 `cd /tmp`（跨出用例仓的工作区根），再 `enter_worktree {name}`。
 *
 * 判据有两条，都是**结构信号**而不是文案观感：
 * 1. enter_worktree 的报错里有「检查过的目录」+ 那个目录值 —— 原实现只说
 *    「当前目录不在 Git 仓库中」，模型无法区分 cd 漂了 / 路径写错 / 这目录确实不是仓库，
 *    01 §5.2 的基线是单会话连续 27 次撞同一句话；
 * 2. 后续某次请求的 messages 里有 `<working-directory-change>` 持久块，且**带作废声明**
 *    —— 只播报新值不撤销旧说法，模型会两个都信（§2.2 采纳附件 B §10.2 的理由）。
 *
 * ⚠️ 断言不写死 `/private/tmp`：那是 macOS 上 `pwd -P` 的物理路径，Linux CI 上就是 `/tmp`。
 * 这里断言「有 /tmp 这一段」+「有检查过的目录这行」，跨平台都成立。
 *
 * expect 来源：文档 §3.4 明确写死的人工判据（报错文本带路径、下一轮含作废声明），
 * 不是从实现输出反推的。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "CG1-cwd-cross-root",
  ledger: "CG-1",
  feature: "cwd 单源 + 值型撤销通知",
  kind: "guard",
  repo: {
    "hello.txt": "hello\n",
  },
  argv: ["-p", "先 cd /tmp，再尝试创建 worktree"],
  expect: {
    output: ({ requests }) => {
      if (requests.length < 2) {
        return `期望至少 2 次请求（cd → enter_worktree），实际 ${requests.length}`;
      }
      const all = JSON.stringify(requests);

      // 判据 1：报错里说清了检查的是哪个目录
      if (!all.includes("检查过的目录")) {
        return "enter_worktree 的报错里没有「检查过的目录」——R5 的回到旧文案了";
      }
      if (!all.includes("/tmp")) {
        return "enter_worktree 的报错里没有实际检查的目录值";
      }

      // 判据 2：cd 跨出根之后的请求里，有带作废声明的持久块
      if (!all.includes("<working-directory-change>")) {
        return "cd 跨出工作区根后，没有注入 <working-directory-change> 持久块（R4 没生效）";
      }
      if (!all.includes("以本条为准")) {
        return "持久块里没有「以本条为准」的作废声明 —— 只播报不撤销，旧说法仍然权威";
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/tool/bash.ts",
      find: `      this.cwdSwitchListener(newCwd);`,
      replace: `      void this.cwdSwitchListener;`,
      why: "cwd 跨根变更不再通知外层 → 没有 <working-directory-change> 持久块",
    },
    {
      file: "packages/core/src/tool/enter-worktree.ts",
      find: `          \`检查过的目录: \${checkedDir}\\n\` +`,
      replace: `          \`\\n\` +`,
      why: "报错不再带检查过的目录 → 模型只能盲猜自己站在哪",
    },
  ],
};

export default def;
