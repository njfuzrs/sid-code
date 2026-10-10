---
Status: implemented
Date: 2026-10-04
---
# 新渲染底座 @sid-code/tui 接入 workspace，并锁住编译冒烟（B9 / T1.2）

## 决定了什么

- 新增 `packages/tui/package.json`（`@sid-code/tui`）。依赖取上游 ink@7.1.1 声明的范围内的**精确版本**，能复用仓内已装的版本就复用：react 19.2.8 / react-reconciler 0.33.0 / scheduler 0.27.0 与根包同一份 store，实测 realpath 一致，不会出现两份 React。chalk 5.6.2 与 signal-exit 3.0.7 跟仓内的 6.0.0 / 4.1.0 不同，按上游范围单独装，各自隔离。
- **react-devtools-core 与 ws 是普通 dependency，不是 optional**。理由见下方「放弃了什么」。
- `packages/tui/bunfig.toml` 指回根 preload，与 tui-renderer 同款，满足 `test-isolation-preload-wiring` 门禁。
- `pkg-boundary-scan`：`tui` 进 `PACKAGES`，rank 1（与旧底座同层，不许往上导 core / cli）；pre-commit 的边界扫描触发正则同步加上 `tui`。
- 两个测试：
  - `packages/tui/tests/compile-smoke.test.ts`：真跑 `bun build --compile`，再运行产物，断言 Box+Text 圆角边框渲染、yoga 可用；`DEV=true` 时也不崩。
  - `bun-node-api.test.ts`：只核对上游**实际用到的** Node API 在 Bun 下可用。
- 还没有 CLI 侧接线（`render-port/next.ts`），归 T1.3。

## 放弃了什么（以及为什么不选）

- **react-devtools-core 设为 optional / 构建时 `--external`**：直觉上它只在 `DEV=true` 时用。但实测 external 后，bun 把 `devtools.ts` 的静态 import 提到产物顶层，**DEV 开不开都在启动时崩**（`Cannot find package 'react-devtools-core'`，rc=1）。上游 `import.meta.resolve` 的探测在 `$bunfs` 里拦不住这个。打进产物后 `DEV=true` 只会多一条 package.json 读取告警，rc=0。
- **在 Bun 下把 Node 22 API 查全**：没有判据，查完也不知道哪条有用。按 grep 出的实际用量来查，以后用到新的 API 就补进表。
- **测 `process.stdin.ref`**：stdin 是 /dev/null 时，Bun 和 Node 下它都是 undefined（全量 `bun test` 就是这种环境，实测单跑绿、全量红）。上游只在 TTY raw mode 路径调用它，所以改为查 `tty.ReadStream.prototype`。

## 拿什么证明它生效了

- `bun test ./packages/tui/tests/`：6 pass。
- 变异自证：给编译命令加 `--external react-devtools-core` → 两条运行用例都红；还原后 sha256 核对一致。
- 全量 `bun test`：13486 pass / 0 fail。`make build` rc=0，`will always be undefined` 0 处。
- `bun run lint` / `format:check` / `lint:boundary` / `docs:gen-reference --check` 全绿。
