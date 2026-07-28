# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 北极星：长期宗旨与方向（最高纲领，每次会话必读）

**一句话宗旨：以可度量的轨迹数据为底座，做更快、更省、更安全、深度融合企业级开发环境的 coding agent。**

这四个方向是**长期北极星，不是短期验收标准**。每一个都很难，甚至现在有未达成、未接线的部分——这不是缺陷，恰恰是它值得当方向的理由。

四个方向 + 一个底座（现状标注为 2026-07 快照，实时数据以 `bun scripts/trace-digest.ts` 为准）：

- **更快**：降低首字延迟（TTFT）与端到端耗时。现状：几乎无 latency 基线，属于「要补的度量」。
- **更省**：降低单位任务 token / 成本。现状：Prompt cache（deepseek 受控 0→83.2%、anthropic 族 99.5%）已验证有闭环，是四个词里唯一有硬数据的；但 cost 采集尚不全（影子调用绕过埋点），「省了多少」暂测不准。
- **更安全**：从静态防护延伸到 HITL / 权限规则 / 企业 policy。现状：静态防护层（path-validator / bash-security / 危险命令拦截）对标 CC 极高甚至超越；但权限规则层仍有未修 P0（Bash `*` 不跨 `/`、Read/Edit 路径前缀未实现等）。
- **深度融合企业级**：团队记忆、企业 policy、企业系统接入。现状：网关计费 / 飞书 / MCP / vibe-bugfix 已跑通几个企业系统；企业 policy 层仍是未接线的脚手架，团队记忆刚从「半黑洞」修出。
- **底座 · 可度量 / 数据飞轮**：events.jsonl（1481+ 会话）、trace-digest、eval-session、四环防线触发率脚本。**这不是隐含前提，是宗旨的一部分。** 度量的作用不是「验收目标达没达成」，而是「确认每一步是不是在朝北极星走」——「这次改动让 cost 采得更全 / cache 命中又涨几个点 / 又一个权限 P0 接线了」这种朝向感必须能量出来。

**方向内部有张力，落地时要正视而非回避：** 更安全（更多 HITL / 权限校验）天然拖慢速度、增加动态内容，而动态内容又伤 cache 命中率=伤省。真实工程演进就是在这几个约束间找平衡，不是四个指标同时拉满。遇到「弹权限确认 vs 少打扰」这类摇摆时，回到这里，明确本次改动在为哪个方向让路。

**每次会话自检（防止方向漂移）：**
1. 这次改动在朝哪个北极星方向走？还是跑偏了？
2. 朝向感能量出来吗？拿什么轨迹数据/信号证明「真的在进步」而非自我感觉？
3. 它牺牲了哪个方向来成全另一个？这个 trade-off 是否可接受、是否点破？
4. 本次有没有碰到**不属于本次任务**的文件？碰之前读过内容、问过我了吗？
   —— 见 §0「⛔ 铁律：不删与本次任务无关的文件和代码」，这条是有过真实数据丢失事故的。

> 目标层面谈方向，执行层面摆数据——两者不矛盾，是分工。方向定死不动摇，剩下的事是把每个词拆成一串能量出进展的台阶，一级一级踩。

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜
- **构建验证**：task 完成后跑 `bun test`（全量单测，以实际输出为准）以及跑 `make rebuild` 验证构建成功，**不可跳过，必须执行**
- **改了参考页数据源要重新生成官网参考页**：动过 `src/help.ts`、`src/cli.ts`、`src/tool/`、`src/command/`、`src/config/`、`src/hook/` 之后，跑一次
  `bun run docs:gen-reference`，并把 `website/ref/` 与 `website/public/llms.txt` 的改动一并提交。
  `website/ref/` 下 6 页（CLI 参数 / 工具 / 斜杠命令 / Hook 事件 / settings 字段 / 环境变量）是**从源码生成**的，
  源码改了不重新生成就是文档骗人——用户照着文档写一个不存在的参数比没有文档更糟。
  pre-commit 会跑 `--check` 拦住这种漂移（未装 hook 先跑 `bun run install-hooks`）。
  设计与验收见 `docs/reference/官网与文档站设计方案.md` §4.5。

### ⛔ 铁律：不删与本次任务无关的文件和代码（多任务并行前提）

**这个仓库里随时可能有多个任务并行执行**——人在写文档、另一个 agent 在改代码、测试在跑。
因此 `git status` 里的「意外文件」**默认属于别人的在途工作，不是你的脏数据**。

禁止的操作（除非用户明确要求删除这个具体目标）：

- `rm` / `rm -f` 任何不是你本次亲手创建的文件
- `git checkout -- <dir>` / `git checkout -- <file>`、`git restore`、`git reset --hard`、`git clean`
  —— 这类命令会**静默且不可逆地**丢弃未提交改动，没有回收站、没有 reflog 可救
- 以「清理测试产物」「回到干净状态」为由批量还原目录

必须遵守的判断顺序：

1. **动手前先读**。要删/还原任何文件，先 `Read` 或 `head` 看一眼内容。
   人写的文档和生成产物一眼可辨——省这一步就是在赌。
2. **git status 快照是证据**。会话开始时的 git status 里已存在的改动，**一定不是**你或测试
   造成的，是用户的在途工作，绝对不许动。
3. **区分「测试写脏」与「别人在写」**。测试确实会写产物（如 `website/ref/`、`llms.txt`），
   但产物路径是确定且可枚举的；出现在预期之外路径的新文件，按「别人的工作」处理。
4. **不确定就问，或者干脆不动**。留着一个多余文件的代价是零；删错一个文件的代价是
   用户几小时的工作凭空消失。工作区不干净**不影响**你交付任务。

**2026-07-28 真实事故（本条铁律的来源）**：误判用户并行写的 `website/` 文档为「测试脏产物」，
`rm` 两个新页 + `git checkout -- website/`，**2 个未 add 的新页面 + 约 300 行已追踪改动永久丢失**，
所有恢复途径查证全空。两个被忽略的信号：① `config.ts` 在**会话初始** git status 快照里就是 `M`，
不可能是测试产物；② 动手前**从未读过**文件内容。完整复盘见
`docs/bugfixes/done/20260728-误删并行任务文件-数据永久丢失复盘.md`。

教训一句话：**归因错误 + 立即执行不可逆操作 = 数据永久丢失。
先读再判断，不可逆操作先问，工作区脏不是理由。**

## 1. 开发 / 发布 / 更新三线流程

### 本地环境：双版本并存

| 命令                      | 指向                                          | 版本   | 用途         |
| ------------------------- | --------------------------------------------- | ------ | ------------ |
| `sid-code` / `sc`         | `~/.local/bin/sid-code` → 线上下载版          | 稳定版 | 验证线上版本 |
| `sid-code-dev` / `sc-dev` | `~/bin/sid-code-dev` → 本地构建产物（仓库根） | 开发版 | 日常开发调试 |


两条命令是**不同的二进制名**，不靠 PATH 优先级区分。

> **⚠️ 调试铁律：改了代码要验证，必须跑 `sc-dev`（开发版），不要跑 `sc`。**
> `sc` / `sid-code` 现在指向**线上稳定版**，跑它验证不到你本地的任何改动——历史上 `sc` 曾经是开发版，肌肉记忆很容易搞错，导致「代码改了、命令跑错、验证不生效」白忙一场。判断口诀：**验证本地改动 → `sc-dev`；对照线上行为 → `sc`。** 拿不准时先 `which sid-code-dev sid-code` 确认指向。

### 日常开发

```bash
git pull          # 拉最新源码
make rebuild      # 重建二进制（版本号不变）
sc-dev            # 启动开发版（注意是 sc-dev，不是 sc）
```

### 发布上线

**⚠️ 铁律：先提交功能代码，再发布，最后补 bump 提交。禁止先发布后提交。**
发布产物必须能对应到一个确切 git commit。先发布后提交会开一个「已发布但未提交」的窗口——期间任何源码改动都会让线上二进制与 commit 对不上，出线上问题无法定位到确切代码版本；且 `release.sh` 首次失败时也会残留一个已 bump 但未发布的脏版本号。

标准顺序：

```bash
# 1. 验证构建（全量单测由 release.sh 门禁负责，此处不重复跑）
make rebuild

# 2. 先提交功能代码（此时版本号还没动，固化「功能」这个逻辑单元）
git add <改动文件>
git commit -m "feat: ..."

# 3. 发布：内部 bump 版本号 + 生成 changelog 三产物 + 打 tag + 重新生成
#    builtin-embedded.generated.ts；不需要先跑 make build
./scripts/release.sh --upload

# 4. 补提交版本号 + changelog 三产物（漏掉 changelog.json 官网 /changelog 就拿不到这个版本）
git add package.json src/skill/builtin-embedded.generated.ts \
        CHANGELOG.md CHANGELOG.html website/.vitepress/data/changelog.json
git commit -m "bump vX.Y.Z"

# 5. 推送（tag 已在 release.sh 上传后推过，这里兜底补推）
git push

# 5.5 发布官网（必做）：/changelog 是站点构建期快照，release.sh 只生成数据不发站点。
#     必须放在 bump 提交之后，工作区干净才过得了 website-deploy.sh 的 dirty 门禁。
./scripts/website-deploy.sh

# 6. 对齐开发版二进制版本号（见下方 Make 表格注解，不补则 sc-dev 比线上低一位）
make rebuild
```

> `release.sh` 首次失败（如上传阶段报错）已 bump 过版本号时，第二次用 `--no-bump --upload` 复用。重跑安全：tag 已存在会跳过创建，changelog 同版本块原地替换，均幂等。
>
> **Changelog + Tag**：release.sh 在 bump 后从 git 历史（上个 semver tag → HEAD，按 feat/fix/… 分组）重建 changelog，并打 annotated tag `vX.Y.Z`。**git 历史是唯一事实源**，每次运行完整重建，确定性且幂等。三份产物各有唯一职责：
>
> | 产物 | 职责 |
> | --- | --- |
> | `CHANGELOG.md` | 文本事实源（累积追踪、不删除），给 diff / `curl` / 脚本 |
> | `website/.vitepress/data/changelog.json` | 官网 `/changelog` 页的数据源，由 `theme/Changelog.vue` 渲染 |
> | `CHANGELOG.html` | 跳转页 → `/changelog`，只为保住散落各处的老链接不 404 |
>
> **用户看更新日志的唯一入口是官网 `http://<host>/changelog`**（2026-07-28 起）。它和文档站同站同配色，自带只搜版本变更的独立搜索框，且**不进全站搜索索引**（否则几百条 commit 描述会把正常查询冲成噪音）。实现见 `website/.vitepress/config.ts` 的 `search.options._render`。
>
> ⚠ **两条禁令**，破了就是数据错乱或每次 commit 都红：
> - `website-deploy.sh` **不得**重跑 `generate-changelog.ts` —— 会把 HEAD 上尚未发版的提交归到已发布的版本号名下。只有 `release.sh` 有资格生成这份数据。
> - changelog 产物**不纳入** `docs-gen-reference --check` 那类反漂移门禁 —— `website/ref/` 能立门禁是因为源是源码；changelog 的源是 git 历史，每提交一次就变。

**上传凭据**：SSH 信息读自 `scripts/deploy.env`（不入库，见 `deploy.env.example` 模板）。
配了 `DEPLOY_SSH_PASSWORD` 后用 sshpass 免交互上传，无需每次输密码。首次配置：
`cp scripts/deploy.env.example scripts/deploy.env` 后填入真实值。

### 用户更新（或自己验证线上版）

```bash
sid-code update    # 下载服务器最新版
sc                 # 启动线上稳定版（sc / sid-code 就是线上版）
```

### 三个 Make 目标职责

| 命令                            | 版本号 | 用途                                    |
| ------------------------------- | ------ | --------------------------------------- |
| `make rebuild`                  | 不变   | 日常开发：拉代码后更新二进制            |
| `make build`                    | +1     | 本地自测：构建带新版本号的二进制        |
| `./scripts/release.sh --upload` | +1     | 正式发布：构建 4 平台制品并上传到服务器 |

三条由「版本号内联进二进制」派生的规则（`bun build --compile` 编译时把 `package.json` 写进产物，git pull 更新源码不会改它）：

- **源码更新后必须重新编译**，否则跑的还是旧代码。
- **版本号只 bump 一次**：直接 `./scripts/release.sh --upload`，别先跑 `make build`（它内部也 bump，会让版本号 +2）。已 bump 过用 `--no-bump --upload` 复用。
- **`make build` / `release.sh` 之后补一次 `make rebuild`**：发布制品是跨平台编译产物，仓库根的开发版二进制不会跟着更新，内联版本号还停在旧值 —— 不补则 `sc-dev` 显示的版本比线上低一位，容易误判。
