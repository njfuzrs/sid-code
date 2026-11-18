/**
 * PR12（D5）：explore 子代理的 bash 只读门禁在真实工具链里生效
 *
 * 缺陷形态（方案 §4.10）：explore 只有 read/grep/glob，遇到「哪次提交引入这一行」
 * 这类问题只能整文件读；一旦把 bash 交给它，只读性若只写在系统提示里就等于没有防线。
 * 修复：explore 工具表加 bash，**只读性由工具层的机械门禁判定**（不是提示词）。
 *
 * 构造：主会话第 1 轮派一个 explore；子代理连发两条 bash ——
 * 第 1 条写命令（`echo pwned > pwned.txt`），第 2 条只读命令（`git status --short`）。
 * 回放游标由主会话与子代理共用（同 X3：主会话消费第 1 条，子代理消费第 2/3 条）。
 * 只读命令不用 `git log`：用例仓库是 `git init` 后无提交的空仓，`git log` 会自己失败，
 * 那样就分不清「门禁拒了」还是「git 没有提交」。
 *
 * 判据三条一起看，缺一条都会假绿：
 * - 写命令拿到 `PostToolUse{tool_name=bash,is_error=true}`：被拒的是 bash 本身；
 * - 只读命令拿到 `PostToolUse{tool_name=bash,is_error=false}`：门禁不是「全拒」；
 * - `pwned.txt` 不存在：拒绝发生在执行**之前**（只看 is_error 证明不了没落盘）。
 *
 * 期望来源：方案 §6 PR12 的验收条目 + 门禁拒绝文案（`read-only-bash-guard.ts`）。
 * 未经真模型录制：回放响应是人工构造的（G2 的模型侧本来就该是录好的），
 * 三条判据各自对应一个确定性的 harness 行为。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "X15-readonly-agent-bash-guard",
  ledger: "X15",
  feature: "只读子代理 bash 门禁",
  kind: "guard",
  repo: { "keep.txt": "keep me\n" },
  argv: ["-p", "派个 explore 子代理看看最近的提交"],
  expect: {
    exitCode: 0,
    events: [
      // 写命令：被工具层门禁拒绝（不是权限层，也不是 hook）。
      // 本仓轨迹把成功/失败统一记成 PostToolUse + is_error，没有单独的 Failure 事件名。
      {
        event: "PostToolUse",
        where: { tool_name: "bash", is_error: true },
        count: 1,
      },
      // 只读命令：照常执行（门禁不是「有 bash 就全拒」）
      { event: "PostToolUse", where: { tool_name: "bash", is_error: false }, count: 1 },
      // 子代理正常收尾
      { event: "SubagentStop", where: { status: "completed" }, count: 1 },
    ],
    // 拒绝发生在执行之前：写命令没有落盘
    files: [{ path: "pwned.txt", absent: true }],
  },
  mutations: [
    {
      file: "packages/core/src/agent/sub-agent.ts",
      find: 'if (t.name() === "bash" && readOnlyAgent) {',
      replace: 'if (false && t.name() === "bash" && readOnlyAgent) {',
      why: "只读门禁没接进隔离注册表：explore 的 bash 拿到的是写权限",
    },
    {
      file: "packages/core/src/agent/read-only-bash-guard.ts",
      find: "    if (!verdict.allowed) {",
      replace: "    if (false && !verdict.allowed) {",
      why: "门禁算出「不允许」却仍放行：只读约束退化成装饰",
    },
  ],
};

export default def;
