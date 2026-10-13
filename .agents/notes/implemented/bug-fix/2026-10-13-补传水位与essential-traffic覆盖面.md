---
Status: implemented
Date: 2026-10-13
---
# 启动补传加水位、--upload-traces 受隐私级别约束、essential-traffic 覆盖面按暴露面区分

## 决定了什么

**P0-3 补传水位**（新模块 `packages/core/src/trace/upload-watermark.ts`）：
- 补传只覆盖「创建时间 ≥ 该上传目标水位」的会话。创建时间取会话 id 前缀（本地时区，与 `generateSessionId` 一致），
  回落 `events.jsonl` 首行 / `session.traj` 的 `start_time`，都取不到按水位前处理（fail-closed）。
- 水位按上传目标（`origin + pathname`）分别记，存 `~/.sid-code/state/upload-watermarks.json`，不写 settings.json。
- 迁移：状态文件首次出现时（cli 入口 loadConfig 之后**无条件**调用 `ensureUploadWatermarks`），
  已配置且实际会上传的目标水位取「最早未上传会话的创建时间」，积压照常补传；之后才出现的目标从进程启动秒起算。
- `scanPendingUploads` 新增 `beforeWatermark` 计数，不计入「待补传」，避免触发 collector 的积压 WARN；`/debug` 体检同口径。
- 配置前的历史只能显式 `--upload-traces --include-history`，执行前打印数量与时间范围。重试队列不受水位影响。

**P2-1**：`--upload-traces` 在构建 UploadManager 之前注入配置文件隐私级别并检查 essential-traffic，命中即报错退出并说明临时放行方法。

**P1-11**：
- 接入 `shouldLoadRemoteConfig()`：自动更新检查（`update/index.ts`，可注入依赖）、外部模型目录同步
  （闸放在 `syncExternalCatalogs` 内部，miss 触发刷新也被覆盖；不记失败退避）。
- 预连接改为取已解析 config 的 `baseURL`（`App.tsx` → `startDeferredPrefetches(true, config.baseURL)`），
  取不到就不连，删除 `api.anthropic.com` 兜底。
- `help.ts`（→ `website/ref/env.md` / `cli.md`）与 `privacy-level.ts` 注释改为实际覆盖面。

## 放弃了什么（以及为什么不选）

- **用目录 mtime 当水位**：resume 刷新 mtime，一次 resume 即可把授权前会话推过水位。
- **第一次读水位时才建基线**：会把「升级一个月后才配上传」的用户误判成迁移，一年历史又被放出去。所以基线必须在启动时无条件建立。
- **essential-traffic 下也登记目标**：产物端到端实测踩到——该目标会按迁移语义拿到最早积压的水位，切回 default 后历史整批放出。改为只登记「url+token 齐全且非 essential-traffic」的目标。
- **网关定价同步、预连接纳入 essential-traffic**：两者只连用户自己的模型端点，不新增暴露面；关掉定价同步会让 `total_cost_usd` 回落内置快照，伤「更省」主口径。
- **水位按 origin 不含 path**：同一主机不同路径前缀可能是两个平台，合并会让 A 的授权泄到 B。

## 拿什么证明它生效了

- 新增 `packages/core/tests/trace/upload-watermark.test.ts`（10 条，覆盖验收判据 2 的四个场景 + 时间解析三级回落 + fail-closed）、
  `packages/cli/tests/app/trace-upload-privacy-wiring.test.ts`（接线反漂移；变异自证：把 P2-1 闸门改成 `if (false)` → 1 fail）、
  更新检查与目录同步的 essential-traffic 用例（目录同步带对照组证明 0 次请求不是假 fetch 造成的）。
- `make build` 产物 + 隔离 `SID_CONFIG_DIR`，两个 2026-01/02 的历史会话：
  - essential-traffic 下 `--upload-traces` → 报错退出，状态文件 `targets: {}`；
  - 切回 default → 「待补传 0 … 配置上传前 2」，并提示 `--include-history`；
  - `touch` 旧会话目录模拟 resume → 仍是「配置上传前 2」；
  - `--include-history` → 先打印「将额外上传 … 时间范围」，随后进入上传；
  - 迁移对照（首启即已配上传）→「待补传 2」，水位 = 最早会话创建时间，与升级前一致。
- 门禁：`format:check` / `lint` / `lint:boundary` / `docs:gen-reference --check` 通过；trace/update/llm/analytics/cli app 等 185 个文件 3055 pass 0 fail。
  `affected-tests:run`（判定为全量）16074 pass / 4 fail，4 个均在 `tests/eval/artifact-identity.test.ts` 的 prune-branch-builds：
  不 import 本次任何模块；在父仓 main@5a8f365d 单跑同样 4 fail；成因是本机多条本地分支 HEAD 恰好是测试造的 commit，被判为 protected。
