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

```bash
# 直接发布（不需要先跑 make build！release.sh 内部会 bump 一次版本号）
./scripts/release.sh --upload

# 发布后提交版本号变更
git add package.json
git commit -m "bump vX.Y.Z"
```

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

### 三个 Make 目标职责

| 命令                            | 版本号 | 用途                                    |
| ------------------------------- | ------ | --------------------------------------- |
| `make rebuild`                  | 不变   | 日常开发：拉代码后更新二进制            |
| `make build`                    | +1     | 本地自测：构建带新版本号的二进制        |
| `./scripts/release.sh --upload` | +1     | 正式发布：构建 4 平台制品并上传到服务器 |

### 二进制版本号嵌入机制

`bun build --compile` 在编译时把 `package.json` 内联进二进制。之后即使 git pull 更新了源码，磁盘上的二进制版本号也不会变。**源码更新后必须重新编译**（`make rebuild` 或 `make build`）。
