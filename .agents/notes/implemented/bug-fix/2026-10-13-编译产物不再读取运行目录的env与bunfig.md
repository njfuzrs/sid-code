---
Status: implemented
Date: 2026-10-13
---
# 编译产物关闭运行目录 .env / bunfig.toml 自动加载

## 决定了什么

三处 `bun build --compile` 入口（`Makefile` 的 `BUILD_NO_AUTOLOAD`、`scripts/release.sh`、
`scripts/build-branch-artifact.sh`）统一加上
`--no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json`。
后两项 bun 1.4.2 默认已关，显式写上是为了防 bun 将来改默认值。

原因：编译产物默认在运行时读取 **cwd** 的 `.env` / `.env.local` / `.env.production`（注入 `process.env`）
和 `bunfig.toml`（其 `preload` 会执行任意代码）。这一步早于任何 JS 执行，信任门与项目级配置白名单都管不到，
所以在克隆的仓库里启动 sid-code 可能被改道（主模型 baseURL、轨迹上传地址等），也可能直接执行仓库里的代码。

配套改动：
- 防漂移哨兵 `tests/build/compile-autoload-flags.test.ts`：每条非注释的 `--compile` 命令（含 `\` 续行）必须带齐四个参数；
  另用最小程序真编译、真运行，对照组证明不带参数时漏洞可见，实验组证明带参数后三个 `.env` 均不注入、preload 不执行。
- 升级提示 `packages/cli/src/utils/project-dotenv-notice.ts`：编译产物启动时，若 cwd 的 `.env` 类文件含
  `SID_CODE_*` / `*_API_KEY`，向 stderr 输出一行提示，**只打键名**，每个目录只提示一次（记在 `state/dotenv-notice.json`）。
  源码模式下 bun 仍会加载 `.env`，此时跳过提示，否则提示内容不成立。

## 放弃了什么（以及为什么不选）

- **在 bootstrap 里用 JS 清掉 `.env` 注入的变量**：加载之后已无法区分变量来自 `.env` 还是用户 shell；
  而且 `bunfig.toml` 的 preload 在入口代码之前执行，JS 层没有可以防御的位置。
- **靠工作区信任门挡**：两者都早于信任门，挡不住。
- **提示走 stdout / 每次启动都提示**：headless 的 stdout 会被评测解析；每次都提示，用户会学会忽略它。
- **本 PR 内顺手修源码模式（`bun <entry>.ts`）**：编译参数管不到源码模式，评测 live adapter 的残留风险另开任务处理。

## 拿什么证明它生效了

- `bun test ./tests/build/compile-autoload-flags.test.ts`：6 pass。对照组（不带参数）读到 `A_FROM_DOTENV=leaked`，
  preload 标记文件存在；实验组三个变量均为 null，标记文件不存在。
- 变异自证：从 `release.sh` 删掉 `--no-compile-autoload-bunfig` 后，哨兵 `release.sh` 那条变红（0 pass / 1 fail）。
- `make build` 后的真实产物：在含恶意 `.env` / `.env.local` / `.env.production`（`SID_CODE_TRACE_UPLOAD_URL=http://127.0.0.1:9/evil`）
  与 `bunfig.toml` preload 的目录里，`--version` 运行后标记文件不存在；`--upload-traces` 报「未配置上传地址或 token」
  （修复前会进入上传流程）。stderr 提示只出现一次，只含键名；stdout 中提示出现 0 次。
