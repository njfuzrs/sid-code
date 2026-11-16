---
Status: implemented
Date: 2026-11-16
Source: 委派与交接：06H1 剩余事项（T4 / T6 / T7）（2026-11-15）
---
# 删除 sub_agent 的 fork 参数：有利场景实验 0/12，真实轨迹 0/58

## 决定了什么

删掉 `sub_agent` 工具的 `fork` 参数及其整条链路：

- `agent/tool.ts`：schema 的 `fork`、`runSync` 的继承构建段、T1（fork + 后台）与 T2（未注入 provider）两条报错、
  `mainContextProvider` / `setMainContextProvider`
- `cli/src/app.ts`：`wireSubAgentMainContext` 接线
- `agent/fork.ts`（`buildForkMessages`，106 行）及 `spec18-subagent.test.ts` 的 Fork 段

**保留** `SubAgentTask.forkMessages` 和「forkMessages 非空 → 强制进程内」（T1 的另一半）：
`tool/send-message.ts` 的 sidechain 真恢复（P2-3）用它把重建的完整历史灌给新子代理，spawn 的父子协议传不了这个字段。

轨迹语义随之调整：带预置历史的委派原来记作 `delegation_mode=fork`，现在记作 `resume`（此时唯一的来源就是 send_message 续接）。
`parent_messages` 只对 fork 有意义，跟着删除；`inherited_messages` 保留，表示 resume 预置的条数。
⚠️ 2026-11-07 至 11-16 的历史轨迹里仍可能出现 `fork`，这段时间里 send_message 续接也被记成 fork，`hook/types.ts` 的注释已写明。

引入提交（`git log -S buildForkMessages`）：`dd489975`（2026-06-03，初始提交）→ `934ef5ef`（10-07，F1 保留工具往返，#190）→
`b4873f23`（11-07，T1/T2 明确报错）。

## 放弃了什么（以及为什么不选）

- **等满 T3 两周窗口（11-21）再判**：日常工作不一定碰到「接着当前对话往深里钻」的场景，窗口期的 0 只能说明没碰上，
  说明不了有利场景下也不用，而且这个窗口可能永远等不到数据。改为主动搭场景。
- **为了测频率在 prompt 里点名 fork**：那样测的是模型听不听话，不是自选率。造场景可以，造使用记录不行。
- **保留 fork，改成 CC 那样的字节相同继承**（传渲染好的 system 字节、原样工具池）：前提是模型会选它。0/12 时投入没有回报。
- **连 `forkMessages` 字段一起删**：会打断 send_message 的真恢复。改名成 `presetMessages` 之类可以做，但会扩大 diff，
  也和本次关注点无关，所以只改了注释。
- **`delegation_mode` 继续记 `fork`**：会把续接次数混进「fork 用了几次」这条历史判据，以后读数据时说不清。

已知局限：只测了 `origin-deepseek-v4-1-flash` 一个模型，任务集是代码阅读类。换模型重跑只需改实验脚本的 `MODEL`。

## 拿什么证明它生效了

**去留判据**（实验目录 `~/Code/person/t7-fork-exp`，配置隔离在 `SID_CONFIG_DIR`，trace 上传关闭）：
12 个三轮会话，前两轮读文件、形成结论，第 3 轮要求「沿着刚才的分析派子代理深挖」。prompt 里不出现 fork 字样。

```
$ python3 -I analyze.py | tail -2
合计 case=12  委派形态={'isolated': 17}  有子代理的 case=12
fork 选中 case 数=0/12
```

17 次调用全是同步，同步正是 fork 唯一可用的路径。A01 的 `raw.jsonl` 证实每次请求的 schema 都带 `fork` 及其描述。
总费用 $2.90。真实轨迹（`~/.sid-code/trajectories`）58 条 SubagentStart 也全部是 `isolated`。

**改动本身**：

- `bun test`（affected 选测 + skill/tool 目录）：7929 pass / 0 fail
- `subagent-fork-guard.test.ts` 新增「schema 里没有 fork 字段」，做了变异自证：把 `fork: z.boolean().optional()`
  临时加回 schema，断言报 `Expected to not contain: "fork"` 变红；恢复后 3 pass
- `make build` 自检通过；`typecheck:gate` 62/62 无新增；lint / format:check / lint:boundary / lint:command-system / lint:legacy-tool 全过
- `docs:gen-reference` 已重新生成，`website/ref/tools.md` 的 sub_agent 参数里去掉了 `fork`
