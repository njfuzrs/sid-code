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
