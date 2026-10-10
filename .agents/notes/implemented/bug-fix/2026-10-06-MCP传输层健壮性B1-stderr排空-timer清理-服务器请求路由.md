---
Status: implemented
Date: 2026-10-06
---
# MCP 传输层健壮性（B1）：stderr 排空、timer 清理、各传输统一应答服务器请求

## 决定了什么

全部落在 `packages/core/src/mcp/transport.ts`：

- **D7**：`StdioTransport` 构造时起 `drainStderr()` 持续读子进程 stderr，转 debug 日志，只留尾部 8KB（`stderrTail`）。原先 `stderr: "pipe"` 从不读，管道写满后 Server 写日志会阻塞，请求全部超时。
- **D8**：Stdio / SSE / WS 三个 `send()` 的超时 timer 归入 `cleanup`，响应、超时、abort、close、断线这几条 settle 路径都会 `clearTimeout`。WS 顺便补上了 abort 监听器的移除（原先没有 cleanup）。
- **D9**：SSE / WS 构造时给 `connectPromise` 挂一个兜底 `.catch(() => {})`，只用来标记「已处理」。真正的错误仍然由 `send()` 里 `await this.connectPromise` 抛出。
- **D10 / D12**：抽出 `dispatchServerRequest()`：有 `onRequest` 就回结果，抛错回 -32603，没有就回 -32601。WS 和进程内传输补上了「id + method」这一支；Stdio / SSE / StreamableHTTP 改为复用它，删掉三份重复代码。进程内 `sendNotification` 改走对端的 `handleIncoming`。
- **D11**：`HTTPTransport` 加上 `closed` 标志和 `closeController`。close 之后 `send` 立即 reject，在途请求被 abort。
- **D6**：只补用例（`parseSSEStream` 已经把状态放在循环外，是 D5 顺带修好的）。

## 放弃了什么（以及为什么不选）

- **D7 改成 `stderr: "ignore"`**：同样能消除死锁，但会丢掉 Server 自报的诊断（如「API key 无效」）。drain + 尾部上限能同时补上可观测性缺口，上限也防止「死锁换成 OOM」。
- **D9 改成惰性连接（首次 send 才连）**：改变了连接时机，`manager` 的连接超时与心跳语义要跟着重新审，超出本批范围。
- **D10 让 client 的 capability 声明依赖传输能力**：缺陷文档提到这条可以作为根治方案。这次先让五个传输都具备应答能力，于是「声明了却不能应答」的不一致从事实上消失。能力协商的改造放到批次 3（elicitation）一起考虑。
- **D12 的 sanitize / close 通知对端（缺陷 3、4）**：不在 B1 验收判据里，也会改变 `onClose` 语义（与 D1「主动 close 不触发 onClose」的约定相关），这次不动。

## 拿什么证明它生效了

- 新增 `packages/core/tests/mcp/transport-robustness.test.ts`，共 17 条，全部用真 socket 或真子进程：`bun test` 17 pass / 0 fail。
- **变异自证**：逐条把修复改回去，对应的组都会变红。D6（每个 chunk 清空状态）、D7（去掉 drainStderr）、D8（去掉 clearTimeout，3 条红）、D9（去掉兜底 catch，3 条红）、D10（删掉 id+method 分支，3 条红）、D11（close 改回空实现，2 条红）、D12a（删掉请求分派，2 条红）、D12b（通知改回直调 onNotification，1 条红）。
- `grep -c 'clearTimeout(' transport.ts` 从 0 变成 3，`grep -c 'proc\.stderr'` 从 0 变成 1。
- `bun run affected-tests:run`（mcp 目录 150 pass），另跑了 sdk / ide / bridge 共 334 pass。`make build` 自检通过，没有 `will always be undefined` 警告。lint、format:check、lint:boundary 全绿。
