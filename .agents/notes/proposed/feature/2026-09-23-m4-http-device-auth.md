---
Status: proposed
Date: 2026-09-23
---
# M4 PR-4.1：analytics HTTP 出口接设备凭据，稳定不发一律 throw

## 决定了什么

`analytics/exporters/http.ts` 的远程上报从「配置里写死的静态 token」改成**设备凭据优先**，
并把三种「稳定不发」与「瞬时故障」分成两条路径：

| 情况 | 行为 | 为什么 |
| --- | --- | --- |
| 有设备凭据 | `Authorization: Bearer <cred>`（优先于 authHeader） | 服务端 `require_device` 从凭据取 org/team，不从 body 取 |
| 无凭据、配了 `authHeader` | 用 `authHeader` | 企业自建 collector 不认本平台凭据，这条路必须留 |
| 无凭据且无 `authHeader` | `SkipRemoteExportError("no_auth")` → 不发、不写盘、不退避 | fail-open：没有身份就不往远程发，本地 JSONL 照常落 |
| 明文非本地 endpoint | `SkipRemoteExportError("plaintext_http")` | events 是 POST，明文会在 301 **之前**把 metadata body 发出去 |
| 响应 401 | `UnauthorizedExportError` → 不写盘、不退避 | 与 `config/policy.ts:495` 同源判断：凭据不会自己变好 |
| 500 / 网络 | 写盘 + 退避（原行为不变） | 这才是瞬时故障 |

三种稳定不发各有独立的「只告警一次」旗标，401 连发 N 批只出一行 WARN。

**关键点：一律 `throw`，不用 `return`。** `disk-cache.ts:retryPreviousBatches` 把
`sendFn` 成功 resolve 当成「这批已送达」并 `unlink` 文件。用 `return` 的话，
`recoverFromDisk()` 在凭据过期时会**静默删掉盘上的 failed_events**，
「过期凭据的机器堆到 24h 自清」这个意图当场落空。同一处在 `disk-cache.ts`
补了 T2 注释（文件头 + `retryPreviousBatches` doc + unlink 前），防下一个人当 bug 查。

没有这个 PR，服务端 PR-4.3 给 `POST /events` 挂 `require_device` 会让客户端全量 401
→ 写盘 → 退避 → 24h `MAX_AGE_MS` 过期**永久丢弃**。表现是「通道全在、单测全过、
服务端零入库、盘上悄悄堆 failed_events 然后消失」。

## 放弃了什么（以及为什么不选）

- **删掉 `authHeader` 字段、只留设备凭据**：会断掉 OTLP / 企业自建 collector 那条路
  （它们不认本平台凭据）。保留为回落，设备凭据优先。
- **`return` 而不是 `throw`**（M4 文档初稿的字面写法）：见上，会让 disk-cache 删文件。
  这是本切片唯一一处**与设计初稿相反**的决定，来源是读 `disk-cache.ts:51-79` 的实际行为。
- **改 `disk-cache.ts` 的 unlink 条件**（例如让 sendFn 返回 `"skipped"`）：
  要动重试语义与 otlp 共用路径，回滚粒度变粗。靠 throw 对齐即可，零行为改动。
- **同步给 `otlp.ts` 接设备凭据**：企业 collector 不认本平台凭据，接了就是必然 401。
  OTLP 在 M4 是零代码改动。
- **给事件加 `event_id` 做幂等**：幂等放服务端内容指纹（01-契约 §3）。
  加 id 要动 `http.ts` + `disk-cache.ts` + otlp + 4 个测试，会把这个 PR 的回滚粒度撑大。
- **在 `http-exporter.test.ts` 里断言「无凭据时本地后端仍收到」**：
  HttpExporter 单测证明不了 LocalEventBackend，两者是独立 backend。写了是假证据。

## 拿什么证明它生效了

**五条变异自证**（逐条把源码改坏，看测试是否精确报红——绿测试不等于有效测试）：

| 变异 | 结果 |
| --- | --- |
| 退回静态 `authHeader`（去掉 `applyDeviceAuth` + no_auth 分支） | **6 fail** / 11 pass |
| 稳定不发改回 `return`（初稿字面写法） | **1 fail**：`recoverFromDisk 无凭据时不删已有 failed_events` |
| 去掉 `isNonLocalHttp` 明文检查 | **1 fail**：`明文非本地 endpoint：不发 fetch、不写磁盘` |
| 401 当普通失败（走写盘 + 退避） | **2 fail**：`响应 401：不写磁盘、不调度退避` + `401 连续 3 批只告警一次` |
| 去掉 `warnedUnauthorized` 旗标 | **1 fail**：`401 连续 3 批只告警一次` |

第 2 条是 R1 的核心回归：`return` 版本**其余 16 条全绿**，只有那一条拦得住它。

**命令与输出**：

- `bun test ./packages/core/tests/analytics/http-exporter.test.ts` → **17 pass / 0 fail**
  （原有 6 个回归保留，新增 11 个；原 6 个里「真要发请求」的 4 个显式补了 `authHeader`，
  否则接上鉴权后 fetch 根本不会被调用 —— 这不是放宽断言，是把老用例的前提写明）
- `bun run affected-tests:run` → 判定 selective，**118 pass / 0 fail**（11 files）
- 选测只覆盖 analytics，而本次新增跨模块导入（`identity/credential`、`config/policy`），
  额外跑 `tests/build/package-boundary.test.ts` + `tests/identity/` +
  `tests/config/remote-policy.test.ts` → **53 pass / 0 fail**
- `bun run lint` / `lint:boundary`（越界依赖 0 处）/ `format:check` 全绿
- `make build` 成功，**且 grep 过 `will always be undefined`：无命中**
  （worktree 下新增导出会只报 warning 但仍 exit 0，光看退出码会交出一个新函数是
  `undefined` 的产物）

**尚未验证、留给后续的**：真实机器端到端（配 `analytics.backends` 指向真实 events
endpoint、服务端入库）要等 PR-4.3 上线才能做。本切片只保证客户端侧行为正确。
