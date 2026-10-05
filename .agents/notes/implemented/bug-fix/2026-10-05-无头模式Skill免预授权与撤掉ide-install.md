---
Status: implemented
Date: 2026-10-05
---
# 无头模式下 Skill 工具免预授权；撤掉必然失败的 /ide install

## 决定了什么

- `SkillMetaTool` 实现 `checkPermissions` 返回 allow（`packages/core/src/skill/meta-tool.ts`）。此前它既没实现该方法、也不在只读工具表，落到 checker 默认 ask，`-p` 下没有确认通道就地判拒——**任何** skill 都要 `--allowed-tools Skill` 预授权，否则模型绕开 skill 自己干（PR #167 实测 D66 时发现）。理由：调用 Skill 只是加载一份指令，真正的副作用落在后续工具调用上，那些仍各自过权限；敏感属性（`allowed-tools` / `hooks` / `shell` 等）在 execute 里的 `authorizeSkill` 照旧 ask，`-p` 下照旧 fail-closed。
- 删除 `/ide install` 子命令与仅被它使用的 `packages/core/src/ide/extension-install.ts`。IDE 扩展本体已裁决不做，这条命令执行必然失败；无 lockfile 时的提示文案不再指向它。`/ide` 其余子命令保留。

## 放弃了什么（以及为什么不选）

- **把 Skill 放进 `READ_ONLY_TOOLS`**：那张表在 plan 模式下也直接放行，而 delegate 子代理的 subChecker 会把模式改写成 dontAsk、丢掉 plan 约束。工具级 allow 排在 plan / deny-write、deny 规则、disallowedTools、ask 规则之后，不越过它们。
- **保持现状、只在拒绝时提示加 `--allowed-tools Skill`**：等于让每个无头用户都背一条与安全无关的样板参数，而它挡住的东西（加载指令）本身没有副作用。
- **连敏感属性一起放宽**：`allowed-tools` 会给后续工具预授权，是真正需要人确认的那一层，不动。
- **保留 `/ide install` 并改成「即将推出」**：扩展不做，留着就是一条兑现不了的下一步。

## 拿什么证明它生效了

- `packages/core/tests/permission/skill-headless.test.ts` 9 条：`-p` / 批处理下放行、端到端执行成功；边界 6 条（敏感属性 fail-closed、deny、disallowedTools、ask、plan、deny-write）。变异自证：去掉 `checkPermissions` 后前 3 条转红。
- 编译产物实测：临时 `SID_CONFIG_DIR` + 项目级 skill（不写 `allowed-tools`），`sid-code -p "用 changelog-entry skill 生成一条变更记录"` 不加 `--allowed-tools Skill`，轨迹里 Skill 被调用且未进 `permission_denials`（唯一一条拒绝是 bash 的 flag 混淆启发式，与本改动无关）。
- `ide-no-lockfile-message.test.ts` 断言提示文案与源码不再出现 `/ide install` / `IDEInstallCommand`。
