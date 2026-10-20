---
Status: implemented
Date: 2026-10-20
---
# 随仓 skill 删除已失效的 timeout-mins 与 /pr-workflow 虚构的「50 轮、30 分钟」

## 决定了什么

PR-B（2026-10-17）起 fork 子代理无墙钟、未声明即无轮次上限，但随仓分发的 skill 还按旧契约声明 / 宣称上限。这不是纯措辞问题，有运行时后果：

- `timeout-mins` 是**敏感属性**：声明了它就会触发 Skill 授权。模型路径下 ask 即拒，所以字段本身不生效，却会让 skill 平白多一道授权；同时每次加载都会往 stderr 打一条「已不再生效」warn。实测内置 code-review 冷启动就有这条 warn。
- `/pr-workflow` 的 prompt 告诉模型「最多 50 轮、30 分钟，轮次吃紧就降级自审」。这个上限是虚构的，模型会据此提前收缩自审。
- Skill Creator 的模板和档位选项会把 `timeout-mins` 继续生成进用户的 skill，还告诉用户要重启才能加载（实际上用户级目录有热重载）。

改动：

- 内置 code-review、4 个插件 skill（governance / security-audit / ci-heal / incident-rca）、`github-pr:comments` 删掉 frontmatter 里的 `timeout-mins`，正文 RL-004 只保留 `max-turns`；
- Skill Creator 删掉超时档位与模板字段，改为轮次档位（推荐不设上限），重启说明改为热重载 + `/skills` 确认；
- `/pr-workflow` prompt 改为「先保证提交和发 PR，自审聚焦高风险点」，不再给数字；
- loader 的 warn 文案去掉 `task_stop`（它只认后台任务 id，停不了前台 skill）；
- 重新生成 `builtin-embedded.generated.ts`。

## 放弃了什么（以及为什么不选）

- **把 `timeout-mins` 从敏感属性表里移除**：能消掉授权，但它仍是能被写进 skill 的字段，删分类会让「未来重新接线」时默认放行；而且问题根在随仓 skill 声明了死字段，不在分类表。
- **恢复墙钟 watchdog 让字段重新生效**：与 PR-B「对齐 CC、子代理无墙钟」的决定冲突，需要单独立项论证，不在本次修复范围。
- **插件 `plugin.json` 升版本**：版本号只在发布流程（`plugins-release.sh` G3/G4）里变，PR 自查要求不在普通 PR 改版本；已发布的 1.0.0 制品不受影响，下次发版带上。
- **SLA 段（`sla.p95_ms` 等）一并删除**：那是评测口径的 metadata，不触发授权也不 warn，是否还准确要按评测事实另核，本次不预判。
- 核查记录里 R0b / R1 / R2（类型注释、Creator 的 name 措辞、effort 值域注释）只是注释和措辞，不改行为，按用户要求暂不处理。

## 拿什么证明它生效了

- 修复前探针：`SkillManager.discover` 加载内置 skill 时 stderr 输出 `⚠ [SKILL] skill 声明了 timeoutMins=15，已不再生效`，`code-review timeoutMins = 15`。
- 新增 `packages/core/tests/skill/shipped-skills-no-stale-budget.test.ts`：扫全部随仓 SKILL.md（≥8 个，防路径漂移空跑），断言不含 `timeout-mins` / `timeoutMins`；断言 Creator 模板不含该字段；断言 `/pr-workflow` prompt 不含「50 轮」「30 分钟」。
- 变异自证：把 incident-rca 的 `timeout-mins: 3` 和 pr-workflow 的「50 轮、30 分钟」放回去，对应 2 条用例变红；恢复后 11/11 通过。
- 原先钉死旧值的测试（code-review / ci-self-heal / incident-rca / security-audit / github-pr）改为断言字段缺省。
- `affected-tests:run` 675 pass / 0 fail；skill + plugins 相关 417 pass；`make build` 自检通过（code-review 正文 7197 字符）；lint / format / typecheck:gate / lint:boundary 通过。
