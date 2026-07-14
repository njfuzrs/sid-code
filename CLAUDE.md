# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜
- **构建验证**：task 完成后跑 `bun test`（全量单测，以实际输出为准）以及跑 `make rebuild` 验证构建成功，**不可跳过，必须执行**

## 1. 开发 / 发布 / 更新三线流程

### 本地环境：双版本并存

| 命令                      | 指向                                          | 版本   | 用途         |
| ------------------------- | --------------------------------------------- | ------ | ------------ |
| `sid-code` / `sc`         | `~/.local/bin/sid-code` → 线上下载版          | 稳定版 | 验证线上版本 |
| `sid-code-dev` / `sc-dev` | `~/bin/sid-code-dev` → 本地构建产物（仓库根） | 开发版 | 日常开发调试 |

> **`sid-code-stable` / `sc-stable` 已删除，不再存在。** 稳定版现在就是 `sc` / `sid-code`。

两条命令是**不同的二进制名**，不靠 PATH 优先级区分：

- `sid-code` 只存在于 `~/.local/bin`（`sid-code update` 下载的线上版）。
- `sid-code-dev` 只存在于 `~/bin`，软链到仓库根 `~/Code/person/sid-code/sid-code`（`make build` / `make rebuild` 的产物）。

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
# 1. 验证（不可跳过）
bun test && make rebuild

# 2. 先提交功能代码（此时版本号还没动，固化「功能」这个逻辑单元）
git add <改动文件>
git commit -m "feat: ..."

# 3. 发布（release.sh 内部会 bump 版本号 + 生成 CHANGELOG.md/.html + 打 tag vX.Y.Z
#    + 重新生成 builtin-embedded.generated.ts，上传成功后推 tag 并传 CHANGELOG.md/.html 到服务器顶层）
#    不需要先跑 make build！
./scripts/release.sh --upload

# 4. 补提交版本号变更 + changelog（CHANGELOG.md/.html 由 release.sh 生成，必须一并提交）
git add package.json src/skill/builtin-embedded.generated.ts CHANGELOG.md CHANGELOG.html
git commit -m "bump vX.Y.Z"

# 5. 推送（tag 已在 release.sh 上传后推过；此处 git push 兜底补推本地 tag）
git push

# 6. 对齐开发版二进制版本号（发布制品用的是跨平台编译产物，
#    仓库根的开发版二进制内联版本号还停在旧值，不补 rebuild 则 sc-dev 版本比线上低一位）
make rebuild
```

> `release.sh` 若首次失败已 bump 过版本号（如上传阶段报错），第二次用 `--no-bump --upload` 复用现有版本号，避免版本号 +2。tag 与 CHANGELOG.md 均幂等：`--no-bump` 复用同版本时 tag 已存在会跳过创建、changelog 同版本块原地替换，不会重复。
>
> **Changelog + Tag**：release.sh 在 bump 后自动从 git 历史（上个 semver tag → HEAD，按 feat/fix/… 分组）生成两份产物——`CHANGELOG.md`（文本事实源，累积追踪、不删除）+ `CHANGELOG.html`（科技风网页，可直接点开，含 commit body 细节展开/分组徽章/搜索过滤），并打 annotated tag `vX.Y.Z`。两份都是「git 历史的渲染视图」，每次运行从 git 完整重建（历史 tag 指向不可变提交 → 历史块稳定，只有正在发布的版本块每次变化，确定性且幂等）。用户可通过 `http://<host>/releases/sid-code/CHANGELOG.html`（网页，推荐）或 `.../CHANGELOG.md`（文本）查看版本变更。

**上传凭据**：SSH 信息读自 `scripts/deploy.env`（不入库，见 `deploy.env.example` 模板）。
配了 `DEPLOY_SSH_PASSWORD` 后用 sshpass 免交互上传，无需每次输密码。首次配置：
`cp scripts/deploy.env.example scripts/deploy.env` 后填入真实值。

**版本号只 bump 一次**：`release.sh` 默认自增 patch 版本号一次。若你已经先跑过
`make build`（它内部也会 bump），再直接 `release.sh` 会让版本号 +2 —— 此时加 `--no-bump`
复用现有版本号：`./scripts/release.sh --no-bump --upload`。
推荐做法：不要先 `make build`，直接 `./scripts/release.sh --upload`，一次 bump 到位。

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

> **⚠️ `make build` / `release.sh` 之后要补一次 `make rebuild`。**
> `make build`（以及 `release.sh` 内部）会 bump `package.json` 版本号，但发布制品用的是**跨平台编译产物**，仓库根的开发版二进制（`sid-code-dev` 指向的 `~/Code/person/sid-code/sid-code`）不会跟着更新，它的**内联版本号还停在旧值**。发完版后 `sc-dev` 显示的版本会比线上低一位，容易误判。
> 修复：发布/构建流程结束后再跑一次 `make rebuild`，用最新 `package.json` 重新编译开发版二进制，把内联版本号对齐。

### 二进制版本号嵌入机制

`bun build --compile` 在编译时把 `package.json` 内联进二进制。之后即使 git pull 更新了源码，磁盘上的二进制版本号也不会变。**源码更新后必须重新编译**（`make rebuild` 或 `make build`）。
