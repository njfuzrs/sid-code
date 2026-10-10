---
Status: implemented
Date: 2026-10-02
---
# `sid-code review` 改读编译期嵌入的 Skill，并让编译产物自己验证一次（B24）

## 决定了什么

- `packages/cli/src/command/review.ts` 的 `loadCodeReviewSkillPrompt` 只从
  `EMBEDDED_BUILTIN_SKILLS` 取 `code-review` 正文，不再用 `import.meta.url` 加相对路径读磁盘。
  原实现两种运行形态都是坏的：编译产物里模块在 `/$bunfs/`，磁盘上没有那个文件；
  P2-2 分包后 SKILL.md 在 core 包，cli 包下算出的路径在源码树里也不存在。
- 修完加载后，编译产物跑出了第二个 bug：子进程 `-p --output-format json` 现在输出的是
  `{ content: ContentBlock[] }`，review 自带的抽取器只认 `final_response` / `text`，
  于是把整段原始 JSON 当报告吐出来。改为复用 `core/daemon/headless-executor.ts` 的
  `extractFinalResponse`。另外 app.json 开了 `debug: true` 时 debug 日志会排在 JSON 前面，
  整段解析失败；抽取器现在会从最后一个行首独占一行的 `{` 重试。这样 daemon 的 headless
  执行器也一起受益，不在 review 里另造一个 helper（另造的 helper 被命令体系门禁 G1 判成了死导出）。
- `--self-check` 新增「review 子命令可加载 code-review Skill」：由二进制自己跑真实的加载函数。
  `release.sh` 本平台冒烟新增 `review --help`，检查子命令分发本身是否可用。
- 单测从「grep 源码里有路径字面量」改成真调加载函数，并断言结果与源码树里的 SKILL.md 正文逐字一致。

## 放弃了什么（以及为什么不选）

- **磁盘路径作为开发期回退**（整改清单原写法）：不保留。源码树里那条路径本来就算错了，
  嵌入清单已入库且 `make build` 每次都会重新生成，dev 和编译产物读的是同一份字节。
  留一条从没走通过的回退，只会再造一条测不到的分支。
- **在发布冒烟里真跑 `review --diff`**：会调 LLM，破坏发布路径「确定性 + 离线」的约束。
  真实加载由 `--self-check` 覆盖（离线），`--help` 只覆盖分发。
- **同类 `import.meta.url` 用法**：全仓另有三处（`resolve-executable.ts`、`sub-agent.ts`、
  `code-governance/scripts/license-check.ts`）。前两处是有意的「是否存在于磁盘」探测，
  编译产物里预期为 false 并会回退；第三处是 Skill 脚本，被 `ensure-builtin` 释放到磁盘后才执行。
  三处都不是这个 bug，没有改动。

## 拿什么证明它生效了

- 修前，`make build` 后执行 `./sid-code review --diff /tmp/b24.diff` 输出
  `code-review SKILL.md 不存在: /$bunfs/skill/builtin/code-review/SKILL.md`；
  `bun run .../bootstrap.ts review` 报的是源码树里不存在的路径（开发态同样坏）。
- 修后，编译产物 `./sid-code review --diff /tmp/b24.diff` 返回 rc=0，耗时 87.3s；
  stdout 是 38 行 Markdown 报告（`**Verdict**: request_changes`），不含原始 JSON 和 debug 日志。
- `make build` 自检输出 `✓ review 子命令可加载 code-review Skill：正文 7404 字符`。
- 变异自证：把加载函数改回 `import.meta.url` 读磁盘后，新增的两条测试转红（10 pass / 2 fail）；
  还原后全绿。抽取器新增的两条用例在 `scheduler-daemon.test.ts`，与 review / 命令体系门禁合跑 45 pass / 0 fail。
