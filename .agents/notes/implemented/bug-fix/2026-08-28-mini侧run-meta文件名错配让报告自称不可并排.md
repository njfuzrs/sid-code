---
Status: implemented
Date: 2026-08-28
---
# mini 侧 run-meta 文件名错配 → 报告自称「不可与其他 run 并排」，恰好否掉 A7.18 的验收判据

## 决定了什么

`mini-adapt.ts` 除 `run-meta.mini.json` 外，**再产出一份 `run-meta.json`**
（`grade.ts` 只读这个固定文件名），新增 `buildMiniGradeMeta()` 做形状翻译，
`--gateway-host` 参数传入跑 mini 时用的网关 host。

原形态：`grade.ts:1065` 读 `runs/<id>/run-meta.json`，而适配器写的是
`run-meta.mini.json`。于是 mini 侧 `run-meta.mini.json` 里模型名、必控变量**全都在**，
`grade.ts` 产出的报告却写着：

```
- 被测模型：`未记录（该分数不可与其他 run 并排）`
- 网关 host：`未记录`
- 必控变量：effort `未记录`，成本闸门 $未记录，并发 未记录
```

**这条正好打在 A7.18 的验收判据上**——那条判据是「两侧 grade.ts 报告能并排」，
而 mini 侧报告自己声明"不可与其他 run 并排比较"。
形态是**两份产物各自都对、合起来的结论是错的**，且没有任何一层报错。

修好后同一份数据、同一条命令：

```
- 被测模型：`anthropic/claude-sonnet-5`
- 网关 host：`code.ppchat.vip`
```

**缺的字段一律不写那个键**（不是落 null / `"n/a"`）：mini 没有"我们编的产物"这个概念，
所以报告里就该继续出现「未记录产物 commit」「未记录 effort_level」。
塞占位串会让那两条点破**消失**，把「这个 harness 没有这个概念」伪装成
「已记录且没问题」——与 A7.13.2（null vs 0）完全同型。

## 放弃了什么（以及为什么不选）

**① 改 `grade.ts` 去认第二个文件名（`run-meta.mini.json`）。**
否决：`grade.ts` 的职责是「把官方 report 翻译成验收字段，一个数都不自己算」。
让它按 harness 分支去找不同文件名，等于把"谁产出的"塞进翻译层 ——
下一个对照 harness（terminal-bench / harbor 那条）又要在那里加一个分支。
**适配器的职责本来就是"产出下游认的形状"，文件名是形状的一部分。**

**② 只产 `run-meta.json` 一份，把 mini 特有字段也塞进去。**
否决：`run-meta.mini.json` 里有 `comparability_notes`、`trajectory_format`、
`wall_time_limit_seconds` 这些**只有 mini 侧才有语义**的字段，
它们是 A7.18 验收判据的载体（notes 为空才算必控变量真的对齐）。
合成一份会让 `grade.ts` 的类型解构与 mini 的诊断字段互相污染，
而两者的读者不同：前者给报告，后者给"这一轮到底可不可比"的判断。

**③ 从 traj 里推网关 host。**
否决：mini 的 traj 只记 `model_name`，**不记 base_url**（实测核过 `config.model`
的全部键）。推不出来就是推不出来，猜一个进去就是造数据 ——
路 B 的立命之本是"同网关"，而一个猜出来的网关会让这条必控变量看起来已核对。
所以走参数传入，不传就不写键、报告显示"未记录"。

## 拿什么证明它生效了

**① 端到端：同一份 mini 产物，修前 vs 修后**（上面已贴两段报告输出）。
`solved_count: 8/10` 两次一致 —— 这次改动**不动任何分数**，只修元数据链路。

**② 单测 + 变异自证**（`tests/eval/swe-bench-mini-adapt.test.ts`，46→47 条）：

```
$ bun test ./tests/eval/swe-bench-mini-adapt.test.ts
 47 pass / 0 fail

# 变异：缺网关时落占位串 `"n/a"`（对着真源文件改）
 45 pass / 1 fail   ←「不传网关时不写那个键」翻红
# 变异：缺模型名时落 `"unknown"`
 45 pass / 2 fail   ←「不写 model 键」+ 变异 E 两条翻红
```

**③ ⚠️ 变异自证抓出了我自己写错的一条 —— 这是本条最该记的部分。**

第一版实现是 `model: meta.model_name ?? "unknown"`，注释写着
「用 unknown 让它既触发点破又可读」。**那句理由是错的**：
`grade.ts` 的判据是 `if (!input.model)`，而 `"unknown"` 是 truthy，
于是那条「不可与其他 run 并排比较」的点破**被抑制**。

我为 `gateway_host` 写了"不许落占位串"的断言、却在同一个函数里给 `model`
落了占位串 —— 而**第一轮变异自证（把 model 落成空串）没有翻红**，
正是这个"该红没红"暴露了它。若当时只看「47 pass」就收工，
这条改动会以「修好了元数据」的名义引入一个新的伪装点。

> 教训与记忆里 `explicit-undefined-punches-through-defaults` 同源：
> **判据是"键在不在"还是"值是什么"，决定了占位串能不能骗过它。**
> 统一成"取到才写键"之后，两个字段同一套语义，不再有第二种缺省形态。
