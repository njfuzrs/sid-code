# sid-code — 长在企业研发环境里的 coding agent

## 北极星：长期宗旨与方向（最高纲领，长期不变）

**一句话宗旨：别人给你一个 agent；sid-code 给你一个你能改、能量、能审、数据不出门的 agent 底座——然后用你自己的轨迹数据，让它每个版本都更快、更省、更少返工。**

### 四大特性（能演示）

1. **企业级** —— 内部网关（含计费取价口径）、内网 GitLab、企业 SSO、MCP、团队默认配置分发、企业 policy、缺陷系统闭环。装上就接得上公司已有的那套东西。
2. **可定制** —— 配置层（多 provider、降级链、权限规则）/ 扩展层（Hook、Skill、子代理、MCP、插件）/ 源码层（工具、上下文工程、主循环全部开源可改）。
3. **数据主权** —— 代码、对话、轨迹、评测、成本账本全部本地，不进任何人的训练集。
4. **可观测** —— 每一轮的耗时、成本、决策都留有轨迹，发布前能跑评测知道有没有退步。它是四大方向的载体：没有轨迹就画不出那四条曲线。

### 四大方向：更快 / 更省 / 更准（更少返工）/ 更安全

每个方向一个主口径进 release 曲线，加一组辅助口径用于归因。**各指标的取数源、状态（✅/⚠️/❌）与口径铁律（TTFT/TTFB 等）见 `northstar/README.md`**，改指标、加埋点、引用数字前先读它。

四条跨方向通用铁律（都是踩出来的）：

1. **一律看 p95/p99，均值会骗人**。
2. **每个指标必须能指到源字段**。说不出取数源的数字就是自我感觉。
3. **分母比分子重要**。分母口径一变曲线就整体平移，分母必须和指标一起写死。
4. **区分 stock 与 flow**。末次快照值除以累加值是错数，要用累积字段（如 `total_cumulative_prompt_tokens`）。

四个方向必然互斥（更安全 ↔ 更快/更省；更准 ↔ 更省），改动时要点破牺牲了哪一个。

### 每次会话自检（防止方向漂移）

1. 这次改动在朝哪个北极星方向走？服务的是哪一条特性？
2. 拿什么轨迹数据/信号证明「真的在进步」而非自我感觉？
3. 它牺牲了哪个方向来成全另一个？这个 trade-off 是否可接受、是否点破？
4. 我引用的「现状」是回源码/轨迹核过的，还是照抄文档的？
5. 本次有没有碰到**不属于本次任务**的文件？见下方「⛔ 铁律」。
6. 这次是非平凡改动吗？**Agent Note 写了吗**？写在记忆里不算。

### 决策留痕：`.agents/notes/`

**非平凡改动必须在同一个 PR 内加或更新一份 Agent Note。**
平凡 = 纯机械/局部编辑，不改行为、契约、结构、流程、理由。

路径 `.agents/notes/{proposed,implemented,rejected}/{feature,architecture,bug-fix,simplification,process,testing}/yyyy-mm-dd-标题.md`，
正文三段：**决定了什么 / 放弃了什么（以及为什么不选）/ 拿什么证明它生效了**。格式见 `.agents/notes/README.md`。

必须落在仓库而不是记忆里：记忆只有一个实例读得到，不随 PR 进 review。`rejected/` 最值钱——否决论证不落盘，下一个 agent 会重新提议同一件事。
`scripts/verify-agent-note.ts` 只查形态，不查内容、不拦「该写没写」，那一层靠 review。

## 流程与门禁在 CONTRIBUTING.md

@CONTRIBUTING.md

分支/PR 流程、CI 与 git hook 门禁清单、测试落盘隔离约定都在上面这份，本文件不重复。
**发版、回滚、改 `release.sh` 前读 `scripts/RELEASE.md`**（双版本并存、发布通道、changelog、构建目标）。

## 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文。
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜。
- **构建验证**：task 完成后跑 `bun run affected-tests:run`（覆盖本次 diff 的最小测试集）以及跑 `make build` 验证构建成功，**不可跳过，必须执行**。
  - 全量 `bun test` 只在三种情况下跑：CI；用户显式要求；`affected-tests` 自己判定为仓库级改动。
  - **选测与 PR 化必须成对**：选测的补偿是 CI 在合并前跑全量，直推 main 时不许用选测。
  - 改 `scripts/affected-tests.ts` 必须过 `tests/scripts/affected-tests.test.ts`（防「选了个空集然后全绿」）。
  - 日常只用 `make build`（不动版本号），**不要**用 `make build-bump`（版本号 +1）。
  - 验证本地改动用 `sc-dev`，不是 `sc`（后者是线上稳定版）。
  - **选测会漏掉的一类：跨域源码字面量断言**。不少测试直接 `readFileSync` 别的包/域的源码断言字面量（如 `packages/core/tests/llm/quota-effective-limit.test.ts` 读 `cli/src`），`affected-tests` 按目录名映射选不到它们。删/改字段名、参数名、字符串常量时，推送前先 `grep -rnF '<旧字面量>' tests packages/*/tests`，命中的文件一并跑。
- **改了参考页数据源要重新生成官网参考页**：动过 `packages/cli/src/help.ts`、`packages/cli/src/cli.ts`、`packages/core/src/tool/`、`packages/cli/src/command/`、`packages/core/src/config/`、`packages/core/src/hook/` 之后，跑 `bun run docs:gen-reference`，把 `website/ref/` 与 `website/public/llms.txt` 一并提交。pre-commit 有 `--check` 拦漂移。
- **新增门禁或回归测试必做变异自证**：先把被测代码改坏，确认对应断言变红，再恢复。恒绿的门禁比没有门禁更危险。看它**报了什么**，不只看退出码。
- **修缺陷前先回源码核实诊断**：审计/缺陷文档给的根因和行号可能已经过期，照着文档改等于修一个不存在的 bug。
- **长任务增量提交**：大文件重写拆成多次小 Edit，每完成一个可验证的单元就提交。请求体上限或 API 错误中断会话时，没提交的进度只能留在会话导出里。

## 环境与工具陷阱（都踩过，失败形态是静默）

- **格式化只用 oxfmt**（`bun run format`），本仓没有 prettier 配置，**不要运行 prettier**，它会让 pre-commit 和契约测试变红。
- **macOS 没有 `timeout` / `gtimeout`**。需要限时就用 Monitor/后台任务，或在 bun/node 脚本里自己计时，不要写 `timeout 60 cmd`，它会直接 command not found，产出空基线。
- **shell 是 zsh，未加引号的 `$VAR` 不做 word splitting**。把多个参数或文件名攒进变量再展开，会整体变成**一个** argv，grep/bun test 静默匹配 0 个且退出 0。用数组 `"${arr[@]}"` 或逐个字面写出。
- **TUI/终端相关测试会吃宿主环境变量**（`TERM_PROGRAM=vscode` 等）。本机绿不代表 CI 绿，复现 CI 用 `env -u TERM_PROGRAM -u KITTY_WINDOW_ID -u WT_SESSION -u ZED_TERM -u VTE_VERSION -u TMUX TERM=xterm-256color bun test <file>`；做旧行为探测同理。
- **`UPDATE_TERM_BENCH=1` 会重写 term-bench 冻结基线**，只在确认行为变化是有意的之后才带它跑。

## ⛔ 铁律：不删与本次任务无关的文件和代码

这个仓库随时有多个任务并行（人在写文档、另一个 agent 在改代码、测试在跑），`git status` 里的「意外文件」**默认属于别人的在途工作**。这条有过真实数据丢失事故。

禁止（除非用户明确要求删除这个具体目标）：

- `rm` 任何不是你本次亲手创建的文件
- `git checkout -- <path>`、`git restore`、`git reset --hard`、`git clean`、`git stash` 做基线——静默且不可逆
- 以「清理测试产物」「回到干净状态」为由批量还原目录

判断顺序：

1. **动手前先读**内容，人写的文档和生成产物一眼可辨。
2. **会话开始时 git status 里已有的改动一定是用户的在途工作**，绝对不许动。
3. 测试产物路径是确定可枚举的（如 `website/ref/`、`llms.txt`）；预期外路径的新文件按「别人的工作」处理。
4. **不确定就问，或者不动**。工作区不干净不影响交付。

## 收尾自检

1. 解决的是用户提的问题，还是顺手扩大/缩小了范围？
2. 拿什么证明它真的生效了？写跑了什么命令、看到什么输出，不写「机理上讲得通」。
   **目标指标改善 + 测试全绿 + 机理讲得通，三者同时成立时结论仍可能是错的**——回到端到端真实指标验证，代理指标会奖励「把浪费重新贴个标签」。

### 在 worktree 里跑门禁：`exit 0` 不等于可交付

- worktree 默认没有自己的 `node_modules`，`@sid-code/core` 会向上解析到主仓 checkout，新增导出会变成 `<名字> will always be undefined` 而构建仍 exit 0。**进 worktree 先 `bun install`**（动了 `website/` 还要在那里再装一次），新增导出的改动必须 grep 这条 warning。
- **主仓 `node_modules` 本身也可能是旧的**：sid-code 建 worktree 默认把 `node_modules` symlink 到主仓（`worktree.symlinkDirectories`），而主仓 `node_modules/@sid-code/` 只有上次 `bun install` 时已存在的 workspace 包链接。之后新增的包（如 2026-10-04 加入的 `packages/tui`）在主仓重装前一直没有链接，表现为 `docs:gen-reference --check` 等报 `Cannot find module '@sid-code/tui/...'`（2026-10-22 实测）。lockfile 一致性告警**查不出这一类**，因为两边 lockfile 是相同的。处置：worktree 里删掉 `node_modules` 软链（它是本次建 worktree 时生成的链接，不是别人的文件）后 `bun install`；或者在主仓重装一次。

### 判定「这个失败与我无关」必须举证，且别叫它「既存失败」

三条证据缺一不可：① 该测试不 import 本次改动的模块；② 在**父仓 main** 上单跑能通过；③ 能指出具体的环境成因。

- 超时类失败先看数字：失败于约 5000ms 是 bun **默认 5s 单测超时**，慢 runner 上的 flake，重跑即绿。
- **防漂移哨兵红了要补清单而不是删断言**，它红 = 它在正常工作。
