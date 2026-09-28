/**
 * safetyCheck 受保护路径的单一事实源。
 *
 * 写工具走 checker.safetyCheck（file_path / notebook_path）；
 * bash 重定向走 shell-parser.hasSensitiveRedirection——两条路必须读同一份名单，
 * 否则修 write 漏 bash、修 bash 漏 write（P1-4 就是这份名单分叉后漏了 .git/hooks/）。
 *
 * ⚠️ 顺序敏感：首次命中即返回，越具体/越严格的项必须排在越前面。
 * 例如 ".sid-code/commands/"（绝对禁止）必须排在 ".sid-code/"（可审批）之前。
 */

export interface SafetyProtectedPath {
  pattern: string;
  /** 是否允许自动模式的分类器审批（false = 绝对禁止） */
  classifierApprovable: boolean;
  reason: string;
}

/**
 * worktree 容器目录：`<repo>/.sid-code/worktrees/<slug>/` 与 `<repo>/.claude/worktrees/<slug>/`。
 * `[^/]+` 而不是具体 slug 形态——不去猜命名规则（用户命名的词汇 slug 与 agent-<hex> 都算）。
 */
const WORKTREE_CONTAINER_RE = /(^|\/)\.(?:sid-code|claude)\/worktrees\/[^/]+(?=\/)/g;

/**
 * 剥掉路径里的 worktree 容器前缀，让 worktree 内的文件按它在**仓库里的位置**判定（W4）。
 *
 * 为什么必须有这一层：本仓所有 worktree 的物理路径都是
 * `<repo>/.sid-code/worktrees/<slug>/…`（manager.ts 的 worktreeDir），于是 worktree 里
 * **任何**文件的绝对路径都含 `/.sid-code/`，被下面的 ".sid-code/" 一条整体命中——
 * `src/app.ts` 这种普通源码也被判成「sid-code 配置目录」。后果不是「某个测试会红」：
 * - 交互模式下隔离子代理每写一个文件都要人点一次确认（并行反而比串行更累）；
 * - 自动模式的分类器拿到一个**错误的前提**（"这是配置目录"），既可能拒掉正常源码改动，
 *   也可能放行真正写进 worktree 内 `.sid-code/settings.json` 的动作——两者在剥离前
 *   长得一模一样。
 * 而 Step 6 是 bypass-immune 且排在 allow 规则之后，copyLocalSettings 复制过去的
 * allow 规则救不了它。
 *
 * 剥离后仍然照常判定 worktree **内部**的敏感路径：`<wt>/.sid-code/settings.json`
 * 剥成 `/.sid-code/settings.json` 依旧命中，`<wt>/.git/hooks/pre-commit` 同理。
 * 也就是说这不是放宽守卫，而是把判定对象从「祖先目录名」换成「文件在仓库里的真实位置」。
 *
 * 多层嵌套（worktree 里再建 worktree）用 replace 全局剥净，避免只剥一层后外层前缀仍命中。
 */
export function stripWorktreeContainerPrefix(path: string): string {
  let stripped = path.replace(WORKTREE_CONTAINER_RE, "");
  // 相对路径（bash 重定向目标未必是绝对路径）在开头命中时，`(^|/)` 捕获的是空串，
  // 剥完会留下后一段的分隔符（".sid-code/worktrees/a/src/x" → "/src/x"）。
  // 原本不是绝对路径就不该变成绝对路径——那会让前半那些 /^\/etc\// 之类的规则错配。
  if (!path.startsWith("/") && stripped.startsWith("/")) {
    stripped = stripped.slice(1);
  }
  // 全剥光后可能只剩空串（理论上不会：worktree 目录自身之后总有文件名），保底回原值。
  return stripped || path;
}

export const SAFETY_PROTECTED_PATHS: SafetyProtectedPath[] = [
  // ── classifierApprovable: false（绝对禁止，不可自动审批）——最具体、最危险，排最前 ──
  { pattern: ".git/hooks/", classifierApprovable: false, reason: "Git hooks 可执行任意代码" },
  { pattern: ".husky/", classifierApprovable: false, reason: "Husky hooks 可执行任意代码" },
  // 斜杠命令目录：命令体可执行任意 shell，等同 hooks 风险，绝对禁止自动审批
  // （对标 claude-code isClaudeConfigFilePath 对 commands/agents/skills 的精细管控）
  {
    pattern: ".sid-code/commands/",
    classifierApprovable: false,
    reason: "sid-code 斜杠命令可执行任意代码",
  },
  {
    pattern: ".sid-code/agents/",
    classifierApprovable: false,
    reason: "sid-code 子代理定义影响执行",
  },
  {
    pattern: ".sid-code/skills/",
    classifierApprovable: false,
    reason: "sid-code Skill 可执行任意代码",
  },
  {
    pattern: ".claude/commands/",
    classifierApprovable: false,
    reason: "Claude 斜杠命令可执行任意代码",
  },
  { pattern: ".claude/agents/", classifierApprovable: false, reason: "Claude 子代理定义影响执行" },
  {
    pattern: ".claude/skills/",
    classifierApprovable: false,
    reason: "Claude Skill 可执行任意代码",
  },
  // 设置文件精细项：settings 可注入 permissionMode/skipPermissions/yesMode 等安全开关，
  // 风险等同上面的 commands/agents/skills，故 classifierApprovable 同样为 false（绝对禁止
  // 自动审批，必须人工确认）。auto 分支读这个字段：false 时分类器结果直接丢弃（P0-1）。
  {
    pattern: ".sid-code/settings.json",
    classifierApprovable: false,
    reason: "sid-code 设置文件（可影响安全控制）",
  },
  {
    pattern: ".sid-code/settings.local.json",
    classifierApprovable: false,
    reason: "sid-code 本地设置文件",
  },
  { pattern: ".claude/settings.json", classifierApprovable: false, reason: "Claude 设置文件" },
  {
    pattern: ".claude/settings.local.json",
    classifierApprovable: false,
    reason: "Claude 本地设置文件",
  },
  // ── classifierApprovable: true（分类器可根据上下文判断）——较宽泛的父目录，排后 ──
  { pattern: ".git/", classifierApprovable: true, reason: "Git 仓库内部文件" },
  { pattern: ".sid-code/", classifierApprovable: true, reason: "sid-code 配置目录" },
  { pattern: ".claude/", classifierApprovable: true, reason: "Claude 配置目录" },
  { pattern: ".vscode/", classifierApprovable: true, reason: "VS Code 配置目录" },
  { pattern: ".bashrc", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".zshrc", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".profile", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".bash_profile", classifierApprovable: true, reason: "Shell 配置文件" },
  { pattern: ".ssh/", classifierApprovable: true, reason: "SSH 配置目录" },
];
