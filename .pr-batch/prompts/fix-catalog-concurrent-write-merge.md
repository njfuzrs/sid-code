# 任务

只做一件事：**`persist()` 写盘前重读一次磁盘并与内存态合并，再原子写**（乐观合并，不引入文件锁依赖）。

这是方案文档的 PR11（D7）。方案文档绝对路径：
`$DOCS_ROOT/sid-code/bugfixes/todo/20260818-模型元数据体系重构-数据源选错档位与投票规则反向-彻底修复方案.md`

**只读这两段，不要读整份文档**（它 2155 行，读全文是 lost in middle 的来源）：

- **第 303-306 行**（`### PR11 — D7 并发写`）—— PR 范围
- **第 1593-1620 行**（`### 6.2 D7：无跨进程写锁`）—— 为什么要做、对标 opencode 的做法

**核心判断（方案原文，别搞混这两件事）**：
现有原子写（`tmp → rename`，`:232-233`）防的是**「半截文件」**，
**不防「丢更新」** —— 这是两件不同的事。两个 sid-code 进程同时启动
（开两个终端、或 `sc-dev` 与 `sc` 并存、或子代理并发）时，后写的会整份覆盖前写的采集结果。

## 分支与提交

分支已建好，你就在里面（`fix-catalog-concurrent-write-merge`，从 `origin/main` 切出）。

PR 标题（≤70 字符，squash merge 后直接进 CHANGELOG.md）：

```
fix(llm): 目录缓存写盘前重读合并，防并发进程丢更新
```

# 文件领地（并行安全的约束 —— 请严格遵守，没有任何机制会拦你越界）

⚠️ **本层还有另一路会话在并行改同一个文件**（PR10，改 `parseOpenRouter`）。
我们按实测的冲突判据算过：你改 `:232` 附近，它改 `:388` 和 `:402` 附近，
**最小行距 156 行 → C3 → 可并行**。但这个结论**依赖你不越界**。

✅ 我可以改：`packages/core/src/llm/model-capabilities.ts` 的 `function persist()`（`:218-237`），**仅此一处**
✅ 我可以**读**：`readCacheFile()`（`:154`）、`mergeEntry()`（`:282`）—— 合并逻辑要用它们
✅ 我可以改/新增：`packages/core/tests/llm/` 下的测试文件

⛔ **我不能碰 `interface OpenRouterEntry`（`:388-394`）与 `function parseOpenRouter`（`:397-421`）**
   ← PR10 正在改这里，改了就是真冲突
⛔ 我不能碰 `parseLitellm`（`:367-385`）← PR10 拿它当参照物
⛔ **尽量不要改 `readCacheFile()` / `mergeEntry()` 的签名或函数体**。
   如果你判断必须改它们才能实现合并，**先停下告诉我** —— 那会扩大足迹，
   分层的 C3 结论要重新算（它们在 `:154` 和 `:282`，后者距 PR10 的 `:388` 只有 106 行，
   仍是 C3，但**签名变更是语义耦合，判据管不到**）。
⛔ 我不能碰 `gateway-pricing.ts` ← 方案 §6.2 提到它有同样的问题，但**不在本 PR 范围**
⛔ 我不能碰任何与本任务无关的文件（CLAUDE.md 铁律，2026-07-28 有真实数据丢失事故）

**不要顺手改**：看到附近有别的问题，**不要在本 PR 里修** —— 按本 prompt 末尾「分叉处置协议」那一节的格式开 issue（不是只在对话里说一句）。
一个 PR 一件事（CONTRIBUTING.md）。

# 实现要点

`persist()` 现在的形态（`origin/main`，已核）：

```
218  function persist(): void {
219    if (persistDisabled) return;               // 测试态：绝不碰用户真实文件
220    try {
221      const path = sidPaths.modelCapabilities();
222      mkdirSync(dirname(path), { recursive: true });
223      const file: CapabilityCacheFile = { schema_version, models: memModels ?? {}, ... };
229      // 原子写注释
232      writeFileSync(tmp, ...);
233      renameSync(tmp, path);
234    } catch { /* 落盘失败：内存仍生效，下次启动重新采集 */ }
```

合并逻辑插在**构建 `file` 对象之后、`writeFileSync` 之前**。

⚠️ **四个必须想清楚的点，不要想当然**：

1. **合并方向**：磁盘上可能有本进程没有的模型条目（别的进程刚采的）。
   合并语义应该是「以磁盘为底，本进程的内存态覆盖上去」还是反过来？
   **想清楚再写，并把理由写进注释。** `mergeEntry`（`:282`）已经是逐字段合并了，
   但它合并的是**内存态与 patch**，不是内存态与磁盘。
2. **`catalog_synced_at` / `catalog_fail_count` 这两个元数据字段怎么合并**？
   它们不是 per-model 的，不能逐字段合。取谁的？为什么？
3. **`persistDisabled`（`:219`）那条早返回不要动** —— 它是测试态守卫。
4. **不要引入 flock / proper-lockfile 之类的依赖**。方案明确说最小修法是乐观合并
   （对标 opencode 用了 flock，但我们刻意不引依赖）。

保持本文件的注释风格：**写为什么，不写在做什么**。现有那条原子写注释
（`:229-230`）就是范例——它解释的是「不这么做会发生什么」。

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
2. **worktree 里有一例可预期假失败**：`plan-mode-write-plan-file.test.ts`
   （cwd 含 `.claude/` → 命中 `permission/checker.ts` 的敏感路径守卫）。
   **只有这一例可以判为环境问题。出现第二例请停下告诉我，不要自己归因为"既存失败"** ——
   宣称一个失败与改动无关需要三条证据（不 import 改动模块 / 在父仓 main 上单跑能过 / 能指出环境成因）。

带测试（CONTRIBUTING.md 要求）。测试要锁住：
- **模拟「另一个进程写了新条目」**：先落盘一份含条目 A 的文件，
  内存态只有条目 B，`persist()` 后**磁盘上 A 和 B 都在**（这是本 PR 的核心断言）
- 元数据字段（`catalog_synced_at` / `catalog_fail_count`）的合并结果符合你在注释里写的语义
- 原子写行为没被破坏（仍是 `tmp → rename`）
- `persistDisabled` 为真时仍然一个字节都不写

⚠️⚠️ **这个 PR 的测试有个特别高的落盘风险**：它天生就是在测「写文件」。
**必须把落盘目标重定向到 tmpdir**（`SID_CONFIG_DIR` 指向临时目录），
并**存/恢复原值而不是无条件 delete**（`bun test` 同批多文件跑在同一进程里，
直接删会把 `bunfig.toml` preload 的兜底一起抹掉）。
**不要硬编码 `join(homedir(), ".sid-code", ...)` 算期望路径，用 `getSidHome()` 派生。**
违反这条的测试**会全绿**，同时往用户真实的 `~/.sid-code/` 里灌假数据。

# 最后一步

→ 提 PR，正文写清「改了什么 / 为什么这么改 / 怎么验证的」（贴 `bun test` 与 `make build` 结果）
→ 正文里**明确写出你对上面「四个必须想清楚的点」第 1、2 条的结论和理由**
→ **停下等我 review，不要自己 merge**
→ 顺便告诉我：`check-gen` 是 skip 还是别的、有没有出现第二例测试假失败、
   有没有需要动 `readCacheFile` / `mergeEntry` 签名
