# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜
- **构建验证**：task 完成后跑 `bun test`（全量单测，以实际输出为准）以及跑 `make rebuild` 验证构建成功，**不可跳过，必须执行**

## 1. 开发 / 发布 / 更新三线流程

### 本地环境：双版本并存

| 命令                            | 指向                             | 版本   | 用途         |
| ------------------------------- | -------------------------------- | ------ | ------------ |
| `sid-code` / `sc`               | `~/bin/sid-code` → 本地构建      | 开发版 | 日常开发调试 |
| `sid-code-stable` / `sc-stable` | `~/.local/bin/sid-code` → 线上版 | 稳定版 | 验证线上版本 |

PATH 优先级：`~/bin` 在 `~/.local/bin` 之前，所以 `sid-code` 走本地开发版。

### 日常开发

```bash
git pull          # 拉最新源码
make rebuild      # 重建二进制（版本号不变）
sc                # 启动开发版
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

# 3. 发布（release.sh 内部会 bump 版本号 + 生成 CHANGELOG.md + 打 tag vX.Y.Z
#    + 重新生成 builtin-embedded.generated.ts，上传成功后推 tag 并传 CHANGELOG.md 到服务器顶层）
#    不需要先跑 make build！
./scripts/release.sh --upload

# 4. 补提交版本号变更 + changelog（CHANGELOG.md 由 release.sh 生成，必须一并提交）
git add package.json src/skill/builtin-embedded.generated.ts CHANGELOG.md
git commit -m "bump vX.Y.Z"

# 5. 推送（tag 已在 release.sh 上传后推过；此处 git push 兜底补推本地 tag）
git push
```

> `release.sh` 若首次失败已 bump 过版本号（如上传阶段报错），第二次用 `--no-bump --upload` 复用现有版本号，避免版本号 +2。tag 与 CHANGELOG.md 均幂等：`--no-bump` 复用同版本时 tag 已存在会跳过创建、changelog 同版本块原地替换，不会重复。
>
> **Changelog + Tag**：release.sh 在 bump 后自动从 git 历史（上个 semver tag → HEAD，按 feat/fix/… 分组）生成仓库根 `CHANGELOG.md`（累积追踪、不删除），并打 annotated tag `vX.Y.Z`。用户可通过 `http://<host>/releases/sid-code/CHANGELOG.md` 查看版本变更；install/update 完成提示里也会带这个链接。

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
sc-stable          # 启动线上稳定版
```

### 团队默认配置（首装 + 更新补全）

`scripts/team-defaults.template.json` 是团队默认配置的**唯一事实源**，两条路径共用：

- **首次安装**：install.sh 从服务器下载 `team-defaults.json` 整份拷贝到 `~/.sid-code/settings.json`（仅当不存在时）。
- **更新已装用户**：`sid-code update` 只换二进制、纯 bash 无法合并 JSON；补全交给**新二进制首次启动时**的迁移 `src/migrations/backfill-team-defaults.ts`（挂在 `runMigrations` 上，按 `migrations.json` 水位线**每台机器只补一次**），只追加用户缺失的顶层字段，绝不覆盖已有配置，用户主动删掉的键也不会被加回。

**改了模板后必须推送服务器**（否则新装用户拿到的还是旧模板）：

```bash
./scripts/release.sh --upload-team-defaults scripts/team-defaults.template.json
```

> 模板同时被 TS 侧 `import` 内联进二进制（供更新补全），所以改模板后除了推送服务器，还需重新构建/发布二进制才能让"更新补全"带上新字段。

### 三个 Make 目标职责

| 命令                            | 版本号 | 用途                                    |
| ------------------------------- | ------ | --------------------------------------- |
| `make rebuild`                  | 不变   | 日常开发：拉代码后更新二进制            |
| `make build`                    | +1     | 本地自测：构建带新版本号的二进制        |
| `./scripts/release.sh --upload` | +1     | 正式发布：构建 4 平台制品并上传到服务器 |

### 二进制版本号嵌入机制

`bun build --compile` 在编译时把 `package.json` 内联进二进制。之后即使 git pull 更新了源码，磁盘上的二进制版本号也不会变。**源码更新后必须重新编译**（`make rebuild` 或 `make build`）。
