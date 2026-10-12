---
Status: implemented
Date: 2026-10-12
---
# 内置 skill 下沉插件市场 P1：仓内 plugins/、门禁接线、静态 index 打包、skill 调用埋点

## 决定了什么

- 新建仓库根 `plugins/`，按领域打 3 个插件（方案 §5）：
  - `github-pr`：`comments`（原 bundled `pr-comments`，TS 改写为 SKILL.md）。
  - `ops`：`ci-heal`（原 `ci-self-heal`）、`incident-rca`。
  - `compliance`：`security-audit`、`governance`（原 `code-governance`）。
  调用名一律是 `/插件名:skill名`，不做短名回退。插件副本里的 frontmatter `name` 也改成短名，因为 skill 名取自 frontmatter，不取目录名。
- 二进制本期不删。`packages/core/src/skill/builtin/` 与 `bundled/pr-comments.ts` 原样保留，`embed-builtin-skills.ts` 不动。源码是复制过去的，P1 到 P4 之间两份并存，旧份冻结不再改，P4 删除。
- `comments/SKILL.md` 写 `disable-model-invocation: true`，保住原内置版的「禁止模型调用」（方案 §3.4）。
- 原 `ci-self-heal/scripts/parse-diff.ts` 在 git 里是**符号链接**，指向 `../../code-review/scripts/parse-diff.ts`。方案 §2.2 写的「自己的拷贝」不对。插件包不允许链接条目，客户端 `archive.ts` 和服务端 `package.py` 都会整包拒绝，所以插件里换成实体拷贝，SKILL.md 三处描述同步改正。
- 6 个测试文件 `git mv` 到 `plugins/tests/`。路径改走 `helpers.ts`。「SkillManager.discover 标为 builtin」这类断言换成走真实插件加载链（`loadPluginFromDirectory → loadSkillsForPlugin`），断言对象是带命名空间的 SkillDefinition。4 个 `scripts/eval/run-*-skill.ts` 的 `SKILL_ROOT` 改到插件路径。`check-skill-holdout-regression.ts` 无参数时同时扫 builtin 和 `plugins/`。
- 补齐方案 §4.1 的三处门禁接线：
  - `affected-tests` 的 `ROOT_TEST_AREAS` 加 `^plugins/` 与 `scripts/plugins-pack.ts` → `./plugins/`；
  - `no-real-path-writes` 的 `testRoots` 加 `plugins/tests`，并要求**每个根都非空**（原来只断言总数 > 100，一个根被挪走会被其他根的文件数掩盖）；
  - E-14 抽出 `listE14SkillDirs()`，扫 `plugins/<插件>/skills/<skill>/`。
- `scripts/plugins-pack.ts`：自己写 ustar（mtime / uid 固定为 0、gzip level 9），保证产物**字节级确定**。index 与后端同契约（`schema:1, name:"sid-code"`），artifact 路径为 `artifacts/<name>/<version>.tar.gz`。打包阶段就拒绝符号链接、非 semver 版本、name 与目录名不一致、hooks / MCP、没有 skill 的插件。只打包不发布，发布是 P2。
- skill 调用埋点：`core/skill/telemetry.ts` 新增 `skill_invoked` 事件（`skill / via / loaded_from / plugin?`），只进本地轨迹 `events.jsonl`。接在三个位置：
  - 用户斜杠路径（`cli/command/executor.ts`，权限通过之后）；
  - 模型路径的 Skill 元工具（与 `logToolInvoked` 同址）；
  - bundled 工具包装器。
  被 deny / 被拒的调用不计。

## 放弃了什么（以及为什么不选）

- **移动源码 + 让 embed 脚本过渡期从 plugins/ 读回旧名**：只留一份源码，但要动构建输入（`artifact-identity` 的 `BUILD_INPUT_PATHS`、release.sh 的 add 清单），P1 的回滚面变大。用户选了「复制，P4 删旧」。
- **插件里保留 parse-diff 符号链接**：两端解包都会整包拒绝，等于这个包永远上不了架。
- **测试里继续用 `SkillManager.discover`**：迁走后这些 skill 只有装了插件才存在。继续测 builtin 副本，P4 一删就全红，而且测的不是用户实际拿到的那份。
- **斜杠埋点复用 `logCommandInvoke`**：它对非内置命令只报 `"custom"` 占位，按 skill 名分不开。真名在 `_PROTECTED_` 通道，HTTP 后端默认剥掉。走本地轨迹不出机器，也就没有脱敏问题。
- **打包用系统 `tar`**：会写入 mtime / uid / uname，macOS bsdtar 还会塞 `._*` 和 pax 扩展属性。同一份源码打出不同的 sha256，「版本不可覆盖」的判据就失去了意义。
- 方案 §9 列出的 rejected 项（独立 Skill 市场、GitHub 源、短名回退、发布即自动推送、commit / pr / pr-workflow 迁成 markdown、CI 持有 sid-code.cc 上传凭据），论证都在方案文档 §3.2 / §5 / §6.1 / §7 里，本 PR 没有重新论证，也没有偏离。

## 拿什么证明它生效了

- `bun test ./plugins/`：8 个文件全绿（迁过来的 6 个，加上 `github-pr.test.ts`、`plugins-pack.test.ts`）。
- 「pr-comments 插件版经 Skill 元工具调用被拒」：`plugins/tests/github-pr.test.ts` 把插件加载结果注入 SkillManager，再调 `SkillMetaTool.execute`，返回 `isError` 且文案含「禁止模型自动调用」，listing 里也看不到它。
- `package.json` 的 `lint / lint:fix / format / format:check` 扫描面加 `plugins`。不加的话，CI 的 oxlint / oxfmt 门禁扫不到插件里的 TS 脚本和测试，§4.1「不用改」的判断只对了一半。
- affected-tests：`tests/scripts/affected-tests.test.ts` 新增 7 条，覆盖 4 类 plugins 路径、打包脚本、`decide()` 选择性判定。
- 变异自证（每次只注入一个变异，跑对应测试，再从备份恢复）：
  - 删掉 `ROOT_TEST_AREAS` 的 `^plugins/` 行：affected-tests 5 fail；
  - 删掉 `comments/SKILL.md` 的 `disable-model-invocation: true`：github-pr 3 fail；
  - E-14 不遍历 `plugins/`：e14 测试 2 fail；
  - 斜杠路径埋点改成永不触发：skill-invoked 2 fail；
  - `testRoots` 里的 `plugins/tests` 改成不存在的目录：no-real-path-writes 1 fail（靠的就是新加的「每个根非空」断言）。

  恢复后全部 0 fail。
- E-14：`bun run scripts/eval/lint-architecture.ts --rules E-14` 输出 0 finding。`tests/eval/lint-architecture-e14.test.ts` 断言 5 个插件 skill 都在扫描面里，临时仓库里新增的插件也会自动纳入。
- 服务端 `inspect_package`：本地对 3 个包逐个跑 `agent-backend/backend/app/modules/marketplace/service/package.py::inspect_package`，结果全是 OK：
  - compliance 1.0.0：`['governance','security-audit']`，35 个条目；
  - github-pr 1.0.0：`['comments']`，2 个条目；
  - ops 1.0.0：`['ci-heal','incident-rca']`，42 个条目。

  本仓 CI 跑不到 Python 端，这一项只有这次手工记录。
- 客户端 `parseIndex`：`plugins-pack.test.ts` 用真实的 `parseIndex / resolveArtifactUrl / parseTarGz / validateManifest / validateMarketManifestPaths / sha256Hex` 断言能装上，并断言两次打包的 sha256 相同。
- skill 埋点：`packages/core/tests/skill/skill-invoked-telemetry.test.ts` 覆盖斜杠放行计一次、插件归因、deny 不计、元工具被拒不计。真实会话里是否触发，要等 P3 生产走查时看 `events.jsonl` 里的 `skill_invoked`。build 和单测过了不算数，防线验收要在真实会话里被触发过（CLAUDE.md「更安全」节）。
- 排查中踩到的环境坑：worktree 的 `node_modules` 是指向主仓的符号链接，`@sid-code/cli` 被解析到**主仓**的源码，测试改的是 worktree、跑的却是主仓的 executor，埋点测试因此假红。解除链接、在 worktree 里单独 `bun install` 之后恢复正常。
