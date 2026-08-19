# 贡献指南

感谢你愿意花时间改进 sid-code。本文只写**这个仓库真实生效的规则**，
不写通用套话——凡是下面提到的门禁，都能在本地跑出来验证。

面向 AI agent 的仓库约定在 [CLAUDE.md](./CLAUDE.md)，
两份文件受众不同但规则一致：agent 与人遵守同一套门禁。

---

## ⚠️ 先读这一条：本项目当前的许可状态

本仓库的 [LICENSE](./LICENSE) 是 **MIT**，你的贡献将按同一许可分发。
没有 CLA，提 PR 即视为同意按该许可授权。

但**本项目自身的许可不等于整个仓库都干净**，有一条必须在你动手前知道：

> 第三方代码的来源与许可记录在 [NOTICE](./NOTICE)。其中终端渲染底座（现 `packages/tui-renderer/src/`）
> **含有我们未获授权的第三方增量修改**，正在被重构掉。
> **改动 `packages/tui-renderer/src/` 之前请先读 NOTICE 第 1 节**与
> [`packages/tui-renderer/src/README.md`](./packages/tui-renderer/src/README.md)。
> （分包前它在 `src/ink/`。）

我们宁愿在这里如实说明现状，也不想让你在不知情的前提下贡献代码。
如果你发现 NOTICE 里的描述与事实不符（低估了外部来源比例、漏记来源），
请指出来，我们会更正。

---

## 环境准备

只需要 Bun，不需要 Node（发行产物是单文件二进制）：

```bash
curl -fsSL https://bun.sh/install | bash    # 已装可跳过
bun --version                                # 开发用 1.3.x，CI 用 latest
```

```bash
git clone <仓库地址>
cd sid-code
bun install
make build            # 构建开发版二进制（不改版本号）
```

### `eval-framework` 是仓内 workspace 包，不是外部依赖

评测框架在 `packages/eval-framework/`，通过 bun workspace 接入
（根 `package.json` 的 `"workspaces": ["packages/*"]` + `"eval-framework": "workspace:*"`）。
`bun install` 会把 `node_modules/eval-framework` 建成指向它的 **symlink**，
所以直接改 `packages/eval-framework/` 下的源码**立即生效，不需要重新 install**。

它曾经是 `file:../eval-framework`（指向仓库外一个未入库项目），导致外部贡献者
`bun install` 装不上、22 个引用文件类型全断。这条已在 P1-5 修掉，
**不要再把它改回仓库外路径**。

框架自己的 4 个测试文件（159 个用例）会被根 `bun test` 一并跑到，这是预期的。

### 贡献者不需要任何 LLM API key

`evals/` 目录、`packages/eval-framework/` 依赖真实模型调用，但这**不是**外部贡献者
提 PR 的门槛。提 PR 之前必须跑的五道 CI 门禁（见下一节）全部不需要 LLM：
`bun test` / `make build` / `bun run lint` / `bun run format:check` /
`bun run lint:boundary` 都是本地静态检查或跑固定断言，没有一处调真实模型。

评测（`.github/workflows/eval-*.yml`）是维护者职责，需要仓库配好
`DEEPSEEK_API_KEY`（judge 打分还需 `ANTHROPIC_API_KEY`）才能真正跑起来。
你作为贡献者不需要关心这些 workflow 何时触发、怎么触发——那是维护者侧的
CI 拓扑决策（各文件头注释有说明），跟你提 PR 该做什么完全无关。fork PR
更是天然拿不到仓库 secret：这是 GitHub 平台层的安全机制（防止任何人改
workflow 偷 secret），不是本仓刻意设的限制。

想在本地跑评测是可选行为，用你自己的 key：

```bash
DEEPSEEK_API_KEY=xxx bun run eval:run -- --provider sid-code --cases case_001
```

成本量级供参考：5 个 P0 smoke case 一次性跑完（agent + judge）约 ¥8，
单 case 更低。

---

## 双版本并存：验证改动必须跑 `sc-dev`

本地是两个不同的二进制名，不靠 PATH 优先级区分：

| 命令 | 指向 | 用途 |
| --- | --- | --- |
| `sc` / `sid-code` | 线上下载版 | 对照线上行为 |
| `sc-dev` / `sid-code-dev` | 仓库根构建产物 | **验证你的改动** |

> ⚠️ 改了代码跑 `sc` 验证不到任何本地改动——它是线上稳定版。
> 拿不准时先 `which sid-code-dev sid-code` 确认指向。

版本号是**编译期内联**进二进制的（`bun build --compile` 把 `package.json` 打进产物），
所以 `git pull` 拿到新源码后**必须重新 `make build`**，否则跑的还是旧代码。

---

## 分支与工作流

### 用 GitHub Flow，不是 GitFlow

**只有一条长期分支 `main`，所有改动走「短命分支 → PR → 合回 main」。**
没有 `develop`、没有 `release/*`、没有 `hotfix/*`。

这不是图省事，是与现有基础设施对齐的**唯一可行选择**：

- `.github/workflows/ci.yml` 的触发条件写死了 `branches: [main]`（`pull_request` 与 `push` 都是）。
  **建一条 `develop` 分支，往它提的 PR 一道 CI 都不会跑** —— 门禁静默失效，PR 页面还显示绿色。
  （这个坑本仓踩过一次：2026-08 把默认分支 `master` 改名 `main` 时忘了同步改 workflow 的
  `branches:`，导致门禁不触发而 PR 显绿。）
- 发布走 `./scripts/release.sh`，它直接从当前 HEAD bump + 打 tag，**本来就不需要 release 分支**。
  版本号是编译期内联的，"准备发布"这个阶段不存在需要单独隔离的状态。

所以：**改动都从 `main` 切出去，都提 PR 回 `main`。**

### ⚠️ 别把 PR 的 base 指向另一条 PR 分支（stacked PR）

同一个 `branches: [main]` 过滤器还有第二个坑，2026-08-15 在 PR #31 上实测踩到过：

把 PR B 的 base 设成 PR A 的分支（stacked PR），CI **一次都不会跑** —— base 不是
`main`，`pull_request` 事件被过滤器整个滤掉。这部分和上面 `develop` 的情形同源。

真正阴的是后面：等 A 合入 main，GitHub 会自动把 B 的 base 改成 `main`
（PR timeline 里的 `automatic_base_change_succeeded`）。此时 base 已经合规了，
但那次自动改 base 发出的是 `pull_request` 的 **`edited`** action，
**不是** `synchronize` —— 所以它**仍然不触发 CI**，而且此后再没有任何事件能触发它。

后果不是「少跑一次」，是**这个 PR 永久卡死**：ruleset `protect-main` 要求
`all-checks-passed` 这个检查，它由 `ci.yml` 产出。
一个 run 都没有 → 检查恒为 pending，PR 页面显示
`Some checks haven't completed yet` + `Waiting for status to be reported`。
**没有红叉，只有一个永远转不完的圈**，比直接失败更难归因。

> 事故当时（2026-08-15）绑的是 `test (ubuntu-latest)` / `test (macos-latest)` / `lint`
> 三个具体 job 名，2026-08-19 已收成一个汇聚 job（见下文「必需检查只有一个」）。
> **换成一个检查并不能修掉这个失败模式** —— 检查数从 3 变 1，恒 pending 照样卡死。
> 真正修它的是 `types` 里那个 `edited`。

`ci.yml` 现在显式声明了 `types: [opened, synchronize, reopened, edited]` 来覆盖这种情况
（反漂移门禁在 `tests/release-flow-contract.test.ts`），所以自动改 base 之后 CI 会补跑。
但**仍然建议不要 stacked**：在 base 指向别的分支的那段时间里 CI 依然是不跑的，
你会在没有任何门禁反馈的情况下往上堆提交。

如果你已经卡在这个状态里（`gh pr view <n> --json statusCheckRollup` 看到必需检查
一个 run 都没有），手动解开的办法是发一个 CI 认的事件：

```bash
gh pr close <n> && gh pr reopen <n>    # 发 reopened，不留多余提交
```

### 不要直接 push 到 `main`

即使你有权限。理由是机制性的，不是纪律要求：

- 直推绕过 PR，就没有任何 diff review 的落点，也绕过 ruleset `protect-main`
  要求的 `all-checks-passed` 在**合入之前**给出结论这件事。
- `ci.yml` 虽然 `push: branches: [main]` 也会跑，但那时代码**已经在 main 上了** ——
  红了是在污染主干之后才知道，而不是之前。
- 改到一半的状态会暴露给所有人：这是开源仓库，`main` 是别人 `git clone` 拿到的东西。

### 分支命名

```text
<type>/<简短描述>
```

`type` 与 Conventional Commits 保持一致（`fix` / `feat` / `refactor` / `perf` / `docs` /
`test` / `build` / `ci` / `chore`），描述用小写英文加连字符：

```bash
git switch main && git pull
git switch -c fix/subagent-timeout-discards-output
git switch -c feat/digest-auto-trigger
git switch -c docs/contributing-branch-policy
```

> 历史分支里有 `feature/xxx` 形式（分包前留下的），**新分支统一用 `feat/`**，
> 与 commit type 同名，省掉「这个前缀对应哪个 type」的换算。

### 一个 PR = 一个可独立上线 / 回滚 / 一次 review 完的单元

> ⚠️ **2026-08-19 判据已改**。旧规则是「互不依赖的缺陷各自一个 PR」，
> 它被读成了「必须各自一个」，实测在一份 11 个缺陷的方案上产出了 **13 个 PR**、
> 依赖链 13 个节点。新判据下同一份方案是 9–11 个，依赖链塌到 4 层以内。
> 已按旧判据拆好的方案文档见本节末尾的迁移说明。

**PR 不是工作量单位，是审查 / 回滚 / 上线单位。** 三条测试：

1. **能独立上线** —— 合入后自己就是一个完整状态，不是「等另一个 PR 才不算半成品」。
2. **能独立回滚** —— `revert` 它不会让 `main` 停在半修复状态，也不会顺带带走别的已修好的东西。
3. **能一次 review 完** —— 一口气读完，中途不用回想别的 PR 改了什么。

**任一条不过就合并**（不过 1 或 2）**，或者再拆小**（不过 3）。

⚠️ **三条全过 ≠ 必须各自一个 PR** —— 这是旧规则最容易被误读的地方。
三条都过时，**按关注点合到最大**：只要 review 时脑子里装的是同一件事，就合成一个。
PR 数本身有固定成本（分支、CI 一轮、review 的上下文切换、并行时一份
`node_modules` 275–413M），拆得越碎不是越安全。

**唯一强到能推翻「合起来」的理由是上线时机**：一份方案里 3 个「用户正在受损」的 P0
和 4 个「加固」的 P2 绑在一起，等于让 P0 的修复速度由 P2 决定。**这条不是流程洁癖，
是用户能感知的损失。** 反过来，同优先级、同关注点的东西没有理由分开。

其余三条细则不变：

- 按**关注点**拆，不按文件数拆。改 10 个文件修一个 bug 是一个 PR；
  改 2 个文件修两个无关 bug 是两个 PR。
- **上限：单 PR > 300 个文件必须拆**。判据是一条真实事故链 ——
  `1bf92d39`（改 1,613 个文件）→ `5acda521`（补 212 个漏提交的文件，`main` 上
  **HEAD 构建不出来**）。那个体积既 review 不了，当时也没有 CI 在合并前拦。
- 顺手发现的无关问题（路径漂移、拼写、注释过时）：单独开 `docs:` / `chore:` 的 PR，
  **不要塞进正在做的功能 PR 里**。混进去会让 review 的人分不清哪些改动是必要的。

**一个连带效果值得知道**：同一个 PR **内部不存在并行冲突**。按上面合完之后，
原先「因为改同一个文件所以要分层串行」的一批约束会自动消失
（实测一份方案的 L1/L2/L3 三层塌成一层），而层间等待正是并行编排最大的时间成本。

### 合并

由维护者合并。**默认用 merge commit（不 squash）**，合并后删掉远端分支。

> ⚠️ **2026-08-19 从 squash-only 改过来**。改的理由是 AI 开发：
> agent 的中间提交是 `git bisect` 的唯一依据，也是 review 时看清「它是怎么一步步
> 走到这个结果」的唯一途径。squash 之后这些全部消失。
> `squash` 仍然允许（ruleset `allowed_merge_methods: [merge, squash]`），
> 单提交的小 PR 用哪个都行。

两条配套约束，破了任何一条 `CHANGELOG.md` 就会出错：

- **PR 标题必须是合规的 Conventional Commits** —— 仓库设置把
  `merge_commit_title` 定为 `PR_TITLE`、`merge_commit_message` 定为 `PR_BODY`，
  所以标题会直接成为 `main` 上那个 merge commit 的 subject 并进 `CHANGELOG.md`。
  （默认值 `MERGE_MESSAGE` 会生成 `Merge pull request #N from ...`，不合规。）
- **changelog 取数走 `--first-parent`**，不是 `--no-merges`。
  常量在 `scripts/lib/changelog-git.ts` 的 `HISTORY_WALK_FLAG`，
  反漂移断言在 `tests/website/changelog-integration.test.ts`。
  改回 `--no-merges` 会同时丢掉 PR 标题、放出所有 `wip:` 中间提交，
  而且**产物照样生成、站点照样构建，没有任何东西会红**。

### 必需检查只有一个：`all-checks-passed`

ruleset `protect-main` 只绑这**一个**汇聚检查（`ci.yml` 的 `all-checks-passed` job），
它自己不跑任何测试，只把 `test` / `lint` 的结论收成一条。

**为什么要这层间接**：原先绑的是 `test (ubuntu-latest)` / `test (macos-latest)` /
`lint` 三个具体 job 名，于是分支保护与 workflow 内部结构耦合。已经因此踩过两次，
两次都是「不报红只转圈」的形态（改分支名静默停 CI；stacked PR 改 base 后三个检查恒
pending）。现在加 job 只改 `all-checks-passed` 的 `needs` 一行，不动 ruleset。

⚠️ **加了新 job 一定要同步 `needs`** —— 漏了就是一个绕过分支保护的后门，
而且 PR 页面一片绿。`tests/release-flow-contract.test.ts` 有一条断言机械地拦这个
（`needs` 必须覆盖除自己以外的全部 job）。

另外开了两个自动化，**目的是让人只需要 review**：

- **auto-merge**：`gh pr merge <n> --auto --merge` 挂上之后，CI 绿了自动合，
  不用盯着 CI 等。
- **strict 必需检查**：分支必须与 `main` 最新才能合并，所以 CI 跑的是
  「最新的 `main` + 你的改动」，而不是一个过期的 base。

⚠️ **合并队列（merge queue）用不了**：GitHub 官方限制「仅**组织拥有**的公共仓库，
或用 Enterprise Cloud 的组织的私有仓库」，本仓 owner 是个人账户（往 ruleset 加
merge_queue 规则返回 `422 Invalid rule 'merge_queue'`，2026-08-19 实测）。

⚠️ **strict 不等价于队列，别把它当替代品**：strict 保证你的 CI 跑在最新 main 上，
但**两个 PR 都通过 strict 之后先后合入时，后合的那个的 CI 结论仍然是合并前的**
（它跑的时候前一个还没进 main）。所以「各自绿、合起来红」这类语义冲突在本仓
**没有合并前的机制对策**，只能靠合并后在 `main` 上跑一次门禁、必要时 revert。

**这一条直接影响并行策略**：同时开多路时，如果几路在语义上有耦合（改同一个子系统的
不同角落），把它们放到不同批次串行做，比并行更省——并行省下的等待，会被
「合起来红 → 归因 → revert → 重做」吃掉。`ci.yml` 已预置 `merge_group` trigger，
哪天仓库转到组织下，开队列只需在 ruleset 加一条规则。

### 已按旧判据拆好的方案文档怎么办

`docs-research/.../todo/` 下有三份方案是按旧判据（一个缺陷一个 PR）拆的。
**不需要重写**，按新判据把 PR 合并成单元、并在 PR 总表上方标一句判据已变即可。
`PRn` 编号要保留 —— 它是文档 ↔ `plans/` ↔ PR ↔ issue 四处唯一不变的 id。

---

## 提 PR 之前必须跑的门禁

CI（`.github/workflows/ci.yml`）有 **两个 job、五道门禁**，本地全部可跑：

```bash
# test job
bun test                 # 全量单测，必须 0 fail
make build               # 构建 + 产物自检，必须成功

# lint job
bun run lint             # oxlint，只开 correctness 档
bun run format:check     # oxfmt 排版检查（红了跑 bun run format 再 git add）
bun run lint:boundary    # 包边界扫描，动了跨包导入必跑
```

**五条都跑绿，CI 基本不会红。** 只跑前两条是不够的 —— lint job 是独立的，
排版或跨包导入不合规照样拦。

### 开发过程中用选择性测试，最后一次再跑全量

改一个文件却等全量（实测 127.5s）是不划算的，所以日常迭代用：

```bash
bun run affected-tests       # 只打印判定与命令，不执行（先看一眼选了什么）
bun run affected-tests:run   # 执行选出来的最小测试集
```

它按 diff 触及的路径选测（`packages/core/src/<domain>/` → `packages/core/tests/<domain>/`），
实测 **0.19s–14.5s**。碰到 `bunfig.toml` / `package.json` / `Makefile` / `tests/build/`
这类仓库级文件，或同时改 ≥3 个包，它会自动判定为全量 —— 不需要你记住这些例外。

两条使用约定：

- **提 PR 前仍要跑一次全量 `bun test`。** 选测是给开发过程用的，不替代提交前的完整验证；
  它换来的「快」是以「本地覆盖面变窄」为代价的，补偿是 CI 在合并前跑全量。
- **base 默认是 `origin/main`**，所以本地要先 `git fetch origin main`，
  否则脚本会明确报错而不是猜一个 base（猜错会让选测范围静默变错）。

⚠️ 有一个 bun 陷阱值得知道，因为它会让人误判选测「又慢又没省」：
`bun test` 的位置参数是**完整路径子串匹配**，不是目录。`bun test tests/` 实测搜 692 个文件
（匹配所有路径含 `tests/` 的），`bun test ./tests/` 才是 38 个。脚本输出的路径一律带 `./`，
自己手敲时也要带。

### 另有两个 git hook 门禁（跑 `bun run install-hooks` 安装）

它们**不在 CI 里**，只在本地拦，所以更容易忘记装：

| hook | 门禁 |
| --- | --- |
| pre-commit | oxlint + oxfmt + `docs:gen-reference --check`（参考页反漂移） |
| pre-push | holdout 泄露检测、`holdout/real-tasks` 永封校验、website 站点构建（死链检测）、北极星生成块陈旧检测（30 天） |

没装 hook 的话，参考页漂移和站点死链会一路带到 PR 里才被发现。
**clone 之后第一件事就是 `bun run install-hooks`。**

几个容易踩的点：

- **`make build` 不改版本号**，日常就用它。带 `-bump` 后缀的目标（`make build-bump`）会把版本号 +1，
  贡献者不需要用，**版本号只在发布流程里变**。
- **不要跑 `./scripts/release.sh`**，那是维护者的发布脚本。
- CI **刻意不含** `tsc --noEmit`：仓库有存量类型错误（P1-3），暂不纳入门禁。
  但请不要新增类型错误。
- `bun run lint` 跑 oxlint（P1-4，2026-08-10 接入），CI 与 pre-commit 都会拦。
  规则集只开 correctness 档（真错误），不管风格。规则口径与豁免理由见仓库根
  `.oxlintrc.json` 的注释。
  （`bun run lint:fix` 也在，但当前唯一开启的规则 `no-unused-vars` oxlint 不做自动修复，
  跑了也是空操作——留着是为了将来规则集扩展后不用再补这个脚本。）
- `bun run format` 跑 oxfmt（P2-1，2026-08-12 接入），CI 与 pre-commit 拦的是
  `bun run format:check`。**排版不用再靠"照着周边写"**，交给它就行。
- 两个格式化门禁都刻意只**报错**、不自动改你的文件：hook 里偷偷改工作区，会让你提交的内容
  与你 review 过的内容不一致。红了就跑 `bun run format` 再 `git add`。
- **北极星生成块陈旧检测**（pre-push，阈值 30 天）只在本仓库内**确实含生成块的 `.md`** 上生效；
  没有块的文件一律不拦（否则会在无关文件上误报，人会直接卸掉 hook）。红了就跑
  `bun run scripts/northstar-snapshot.ts --emit-markdown` 刷新，**不要手改块内数字** ——
  手改会让时间戳与数字脱节，正是这个门禁要防的东西。

### 北极星指标：本地看板与周报（人工触发，不是全自动）

四个方向的主指标都能从本地数据算出来，**一行 LLM 调用都没有**：

```bash
bun run scripts/northstar-snapshot.ts              # 当前快照（含三个会话数分母 + 一致性断言）
bun run scripts/northstar-snapshot.ts --weekly     # 最近 7 天周报
bun run scripts/northstar-snapshot.ts --compare 0.1.600 0.1.601   # 版本间对比
```

两条必须说清楚的事：

- **周趋势是「人工触发的自动化脚本」，不是全自动。** CI runner 上没有 `~/.sid-code/`，
  所以 `northstar-weekly.yml` 只跑 `--self-test`（验计算逻辑没坏），**不聚合真实用量** ——
  在 CI 里硬聚合只会产出一份 n=0 的快照，而它看起来像数据，比没有快照更危险。
  真实周趋势需要维护者本机跑。把这件事写成"已自动化"就是那类文档漂移。
- **版本快照由 `release.sh` 在发版时自动产出**（`northstar/v<version>.json` +
  `northstar/latest-delta.md`），**只报告不阻断发版**：指标退步需要人判断，
  自动拦发版会逼人加 `--skip` 绕过，最后连报告都不看。

### 改了这些目录，还要重新生成官网参考页

`website/ref/` 下 6 个页面是**从源码生成**的。动过
`packages/cli/src/help.ts`、`packages/cli/src/cli.ts`、`packages/core/src/tool/`、
`packages/cli/src/command/`、`packages/core/src/config/`、`packages/core/src/hook/`
之后跑：

```bash
bun run docs:gen-reference
```

并把 `website/ref/` 与 `website/public/llms.txt` 的改动一并提交。
pre-commit hook 有 `--check` 门禁会拦住这种漂移（未装 hook 先跑 `bun run install-hooks`）。

源码改了不重新生成就是文档骗人——用户照着文档写一个不存在的参数，比没有文档更糟。

---

## 代码风格

排版交给 **oxfmt**（`bun run format`，配置见仓库根 `.oxfmtrc.json`，每个取值都写了理由）。
`oxlint` 管的是正确性（未用变量这类真问题），两者分工不重叠。所以**排版不必手调**，
写完跑一次 format 就行。

`.oxfmtrc.json` 有两处刻意的范围限制，改之前先读那里的注释：**yaml 与 markdown 不在
格式化范围内**（yaml 是评测 case 数据、含 `evals/holdout/` 永封集；markdown 会被重排
表格并动到 `CLAUDE.md` 这类约定事实源），生成物与 `packages/tui-renderer/src/_vendor/`
也排除在外。

风格约定本身（formatter 覆盖不到的部分）：

- **TypeScript，2 空格缩进**（`src/` 下零 tab 缩进文件），LF 换行，文件末尾留一个换行。
  这四项与 `.editorconfig` 和 `.oxfmtrc.json` 三处一致，改一处要同步改三处。
- **注释用中文**，且注释解释**为什么**这么写，不解释代码在做什么。
  仓库里大量注释记录了「这里踩过什么坑、为什么不能改回去」——
  这类注释是资产，遇到时请读，不要因为「看着啰嗦」删掉。
- 新代码跟着**改动周边的既有风格**走，不要引入新的库或新的模式来解决已有解法的问题。

### 注释里的 `docs/xxx.md` 路径指向仓外，点不开是正常的

源码与测试注释里有 266 处（分布在 153 个文件）形如 `docs/bugfixes/...md`、
`docs-research/...md` 的路径引用。**本仓没有 `docs/` 目录**，这些文件在维护者的私有
文档库里，不会开源。

它们**不是断链，也不需要修**。每一条都是「这里为什么写成这样」的历史线索——注释正文
本身已经把结论说清楚了，路径只是标明结论出自哪次排查。遇到时**忽略路径、读注释本身**
就够了。

也请**不要提 PR 批量删除这些路径**：删掉等于抹掉设计决策的唯一溯源线索，而读注释的人
本来也不依赖那个路径。开发过程文档不入本仓是刻意的（见 `CLAUDE.md`），面向用户的文档
在 `website/`。

## 测试约定

新功能与 bug 修复都要带测试。有一条容易违反且**测试全绿时也发现不了**的硬约定：

> **只要一个函数除返回值外还会写 `~/.sid-code/`，调它的测试就必须把落盘目标重定向到 tmpdir。**

隔离手段：设 `SID_CONFIG_DIR` 指向临时目录，或用组件自己的专用重定向变量
（如 `SID_CODE_CACHE_BREAKS`）。`bunfig.toml` 的 `[test].preload` 里有一道兜底
（`tests/preload-isolate-sid-home.ts`），但**兜底不替代显式隔离**：
要断言落盘内容的测试仍应自己设专用变量。

四个实测踩到的坑：

1. **必须存/恢复原值，不要无条件 `delete`**——`bun test` 同批多文件跑在同一进程里，
   直接删会把 preload 的兜底一起抹掉。
2. 落盘走 `import().then()` 的，恢复 env 前先让微任务跑干
   （`await new Promise(r => setTimeout(r, 0))`）。
3. **不要硬编码 `join(homedir(), ".sid-code", ...)` 算期望路径**，用 `getSidHome()` 派生。
4. **spawn 子进程的 e2e 测试要显式传 `SID_CONFIG_DIR`**，子进程不继承进程内的 env 改动。

为什么这条约定要写进贡献指南：违反它的测试**会全绿**，同时往用户真实的
`~/.sid-code/` 里灌假数据，把线上遥测查询污染成查不到真记录。
防复发门禁在 `packages/core/tests/telemetry/no-real-path-writes.test.ts`
（静态扫描**全部 5 个测试根**：4 个包内 `tests/` + 仓库级根 `tests/`）。

> ⚠️ 还有一个分包带来的隐患：`bunfig.toml` 的 preload 兜底**只在以仓库根为 cwd 跑
> `bun test` 时生效**。`cd packages/core && bun test` 读不到根 bunfig，兜底消失，
> 直接写你真实的 `~/.sid-code/`。**新增含 `tests/` 的包时，必须一起加一份
> `bunfig.toml` 指回根预载文件**（门禁见 `tests/build/test-isolation-preload-wiring.test.ts`）。

---

## 提交与 PR

**提交信息用 Conventional Commits**，因为 `CHANGELOG.md` 是从 git 历史机械生成的
（`scripts/generate-changelog.ts` 按 type 分组），格式不对就会被归到「其他」组：

```text
feat(cache): 新增 XXX
fix(tool): 修复 YYY 在 ZZZ 下不生效
docs: 更新 AAA
```

识别的 type：`feat` / `fix` / `refactor` / `perf` / `docs` / `style` / `test` / `build` / `ci` / `chore`
（后 5 个归入「其他」组）。scope 可选。**描述用中文**。

PR 要求：

- **一个 PR = 一个可独立上线 / 回滚 / 一次 review 完的单元**（三条测试见上文同名小节）。
  混合无关改动 review 成本高、出问题不好回滚；拆得过碎则 PR 的固定成本吃掉收益。
- 标题同样用 Conventional Commits 格式，控制在 70 字符内。
  ⚠️ **它会直接成为 `main` 上那个 merge commit 的 subject 并进 `CHANGELOG.md`**
  （仓库设置 `merge_commit_title: PR_TITLE`），格式不对就污染 changelog。
- 正文说清三件事：改了什么、为什么这么改、怎么验证的（贴 `bun test` 与 `make build` 结果）。
- 用 [PR 模板](./.github/pull_request_template.md)，它就是这三件事的清单。

### issue 先行：什么时候需要

不像某些项目那样**一律强制**（我们不想把小修小补也拦在流程外），但这两类必须先开 issue：

| 情况 | 要求 |
| --- | --- |
| 新功能、改变现有行为、动架构 | **先开 issue 讨论**再写代码。否则可能做完才发现方向不对，白费你的时间 |
| 改动跨多个包 / 涉及 `packages/tui-renderer/src/` | 先开 issue（后者还要先读 [NOTICE](./NOTICE) 第 1 节） |
| bug 修复、文档、拼写、路径漂移、加测试 | 直接提 PR 即可，正文说清根因就行 |

PR 正文里用 `Fixes #123` 关联 issue —— 合并时 issue 会自动关闭，也让「为什么做这个」
永久可追溯。修复方案文档里列的缺陷清单，**建议每个缺陷一个 issue**，
这样 PR ↔ issue ↔ 缺陷编号三者对得上。

### ⛔ 一条铁律：不要动与你的改动无关的文件

这个仓库随时有多个任务并行（人在写文档、agent 在改代码、测试在跑）。
所以 `git status` 里的「意外文件」**默认属于别人的在途工作**。

禁止的操作：

- `rm` 任何不是你亲手创建的文件
- `git checkout -- <dir>` / `git restore` / `git reset --hard` / `git clean`
  ——这些会**静默且不可逆地**丢弃未提交改动，没有回收站、没有 reflog 可救
- 以「清理测试产物」「回到干净状态」为由批量还原目录

**工作区不干净不影响你交付改动。** 留着一个多余文件的代价是零；
删错一个文件的代价是别人几小时的工作凭空消失（2026-07-28 真实发生过一次，
2 个未 add 的新页面 + 约 300 行已追踪改动永久丢失）。

---

## 报告问题

- **bug / 功能请求**：用 [issue 模板](./.github/ISSUE_TEMPLATE/)，
  带上 `sid-code --version`、操作系统、可复现步骤。
- **安全漏洞**：**不要开公开 issue**，按 [SECURITY.md](./SECURITY.md) 私下上报。
- **版权 / 归属问题**（尤其涉及 `packages/tui-renderer/src/`，分包前的 `src/ink/`）：见 [NOTICE](./NOTICE) 第 1 节，
  或直接联系维护者。如果你发现 NOTICE 里的描述与事实不符（低估了外部来源比例、
  漏记来源、修改描述不准），**请指出来，我们会更正**——
  我们宁愿披露过度，也不要披露不足。

参与本项目需遵守 [行为准则](./CODE_OF_CONDUCT.md)。
