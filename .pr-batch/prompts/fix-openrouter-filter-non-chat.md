# 任务

只做一件事：**给 `parseOpenRouter` 补上非对话模型过滤**。

这是方案文档的 PR10（D9 的 OpenRouter 侧）。方案文档绝对路径：
`$DOCS_ROOT/sid-code/bugfixes/todo/20260818-模型元数据体系重构-数据源选错档位与投票规则反向-彻底修复方案.md`

**只读这两段，不要读整份文档**（它 2155 行，读全文是 lost in middle 的来源）：

- **第 298-301 行**（`### PR10 — D9 OpenRouter 侧过滤`）—— PR 范围
- **第 1646-1668 行**（`### 6.4 D9：非对话模型混入能力缓存`）—— 为什么要做、实测证据

## 分支与提交

分支已建好，你就在里面（`fix-openrouter-filter-non-chat`，从 `origin/main` 切出）。

PR 标题（≤70 字符，squash merge 后直接进 CHANGELOG.md）：

```
fix(llm): OpenRouter 目录源过滤非对话模型
```

# 文件领地（并行安全的约束 —— 请严格遵守，没有任何机制会拦你越界）

⚠️ **本层还有另一路会话在并行改同一个文件**（PR11，改 `persist()`）。
我们按实测的冲突判据算过：你改 `:388` 和 `:402` 附近，它改 `:232` 附近，
**最小行距 156 行 → C3 → 可并行**。但这个结论**依赖你不越界**。

✅ 我可以改：`packages/core/src/llm/model-capabilities.ts` 的这两处，**仅此两处**
- `interface OpenRouterEntry`（`:388-394`）—— 加一个字段用于判别模态
- `function parseOpenRouter`（`:397-421`）—— 在入口校验（`:402`）之后插过滤

✅ 我可以改/新增：`packages/core/tests/llm/` 下的测试文件

⛔ **我不能碰 `function persist()`（`:218-237`）** ← PR11 正在改这里，改了就是真冲突
⛔ 我不能碰 `readCacheFile()`（`:154`）、`mergeEntry()`（`:282`）← PR11 会读它们
⛔ 我不能碰 `parseLitellm`（`:367-385`）← 它已有过滤，是我的**参照物**，不是我的目标
⛔ 我不能碰 models.dev 侧的 parse ← 那是 PR3 的范围（两个源、两套字段，方案里明确说无耦合）
⛔ 我不能碰任何与本任务无关的文件（CLAUDE.md 铁律，2026-07-28 有真实数据丢失事故）

**不要顺手改**：看到附近有别的问题，**不要在本 PR 里修** —— 按本 prompt 末尾「分叉处置协议」那一节的格式开 issue（不是只在对话里说一句）。
一个 PR 一件事（CONTRIBUTING.md）。

# 实现要点

参照 `parseLitellm:373-374` 的同类过滤，它的注释已经写清了理由：

```
// 只收对话类模型（embedding/rerank/image 的窗口语义不同，混入会误导 compact 阈值）。
if (e.mode !== undefined && e.mode !== "chat" && e.mode !== "responses") continue;
```

⚠️ **但 OpenRouter 的字段形态和 litellm 不同，先自己核实**：
litellm 有 `mode` 字段，OpenRouter 可能没有——方案 §6.4 提到镜像那边是靠
`modalities.input/output`（`output` 不含 `"text"` 即非对话）。
**OpenRouter 到底有什么字段，请你自己 grep / 查它的 API 文档确认，不要照抄 litellm 的字段名。**
拿不准就把你查到的字段形态告诉我，别猜。

保持 `parseLitellm` 那条注释的风格：**写为什么，不写在做什么**。

# 生成物自检（改完代码、提交之前跑一次，顺序不能反）

```bash
bash $REPO_ROOT/scripts/pr-batch.sh check-gen
```

⚠️ **必须用上面这个绝对路径**（指向主仓，不是你的 worktree）。这个脚本还没合进 `main`，
而你的 worktree 是从 `origin/main` 切出来的 —— 所以 worktree 里**没有**
`scripts/pr-batch.sh`（实测 `bash scripts/pr-batch.sh` → `No such file or directory`，EXIT=127）。
脚本内部用 `git rev-parse --show-toplevel` 定位，所以用绝对路径调它，
判断的仍然是**你这个 worktree** 的改动，不会串到主仓。

- **退出码 0（含 `skip:`）→ 继续，什么都不用做**。
  ⚠️ 预期就是 skip —— `packages/core/src/llm/` 不在参考页数据源锚点内。
  **如果它没 skip，立刻停下告诉我**，那说明分层阶段的判断错了。
- 退出码 3 → 它会打印你改到的 `website/ref/` 行号。**不要自己决定串并行**，
  把那些行号发给我。

# 完成判据

五道门禁全绿：

```bash
bun test
make build
bun run lint
bun run format:check
bun run lint:boundary
```

⚠️ **两条本仓实测的坑，别踩**：

1. **`make build` 的 exit 0 不等于可交付**。新增导出时必须显式 grep 输出里有没有
   `will always be undefined` —— worktree 里 `@sid-code/core` 可能解析到主仓 checkout。
   本 PR 不新增导出，风险低，但仍请扫一眼构建输出。
2. **worktree 里有一例可预期假失败**：`plan-mode-write-plan-file.test.ts`
   （cwd 含 `.claude/` → 命中 `permission/checker.ts` 的敏感路径守卫，在 plan-mode 判定之前返回）。
   **只有这一例可以判为环境问题。出现第二例请停下告诉我，不要自己归因为"既存失败"** ——
   宣称一个失败与改动无关需要三条证据（不 import 改动模块 / 在父仓 main 上单跑能过 / 能指出环境成因）。

带测试（CONTRIBUTING.md 要求）。测试要锁住：
- 非对话模型被过滤掉
- 对话模型仍然收进来（**反向断言，防止过滤过度**）
- `ctx=0` 被挡掉（方案 §6.4 点名要有单测锁住这条）

⚠️ 测试若会写 `~/.sid-code/`，必须重定向到 tmpdir（`SID_CONFIG_DIR` 或专用变量），
并**存/恢复原值而不是无条件 delete**（同批多文件跑在同一进程里）。

# 最后一步

→ 提 PR，正文写清「改了什么 / 为什么这么改 / 怎么验证的」（贴 `bun test` 与 `make build` 结果）
→ **停下等我 review，不要自己 merge**
→ 顺便告诉我：`check-gen` 是 skip 还是别的、有没有出现第二例测试假失败
