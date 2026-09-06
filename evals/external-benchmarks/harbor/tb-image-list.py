#!/usr/bin/env python3
"""从 harbor registry.json 派生「terminal-bench@2.0 里还没拉的镜像」清单。

⚠️ 为什么单独一个脚本而不是内联进 bash：那份 registry.json 有 13.6MB，
本机实测拉一次 **218 秒**（62KB/s）。把它内联进拉镜像循环里，等于每次重跑
都先付 218s，且网络抖动时会卡在解析前 —— 那正是本次要治的形态。
⇒ 缓存在 ~/.cache/sid-tb-images/registry.json，本脚本只读缓存，**不联网**。
   （与 lib/uv-mirror.sh 同源思路：字节在本地就别再出网。）

判据纪律：sample 10 题实测是 full 89 题的**子集**（overlap=10），所以
「还差多少」= full − 本地已有，而不是 full − sample（后者假设 sample 一定还在）。
本地已有一律从 `docker images` 实测，不假设。
"""
import json
import os
import pathlib
import subprocess
import sys

REG = pathlib.Path(os.environ.get("SID_TB_REGISTRY",
                                  pathlib.Path.home() / ".cache/sid-tb-images/registry.json"))
DATASET, VERSION = "terminal-bench", "2.0"
IMAGE_PREFIX = "ghcr.io/laude-institute/terminal-bench"


def registry_tasks() -> list[str]:
    if not REG.exists():
        sys.exit(f"⛔ 缺 registry 缓存: {REG}\n"
                 f"   取一次（约 218s，别在循环里做）:\n"
                 f"   curl -s -m 300 -o {REG} "
                 f"https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json")
    try:
        doc = json.loads(REG.read_text())
    except json.JSONDecodeError as e:
        # 实测踩过：curl 被自己的 -m 60 截断，产出一个 200 但不完整的 JSON。
        # 报错要指出真因，别让人以为是格式变了。
        sys.exit(f"⛔ registry 缓存不完整（{REG.stat().st_size} bytes）: {e}\n"
                 f"   多半是上次 curl 被超时截断。删掉重取，用 -m 300。")
    datasets = doc if isinstance(doc, list) else doc.get("datasets", doc)
    for d in datasets:
        if d.get("name") == DATASET and str(d.get("version")) == VERSION:
            return [t["name"] for t in (d.get("tasks") or [])]
    sys.exit(f"⛔ registry 里没有 {DATASET}@{VERSION}")


def local_images() -> set[str]:
    """本地已有的 tb 镜像名。⚠️ docker 不可达时必须 fail-closed。

    这条是踩出来的：`docker images | wc -l` 在 docker 不可达时输出 0，
    与「真的一张都没有」不可区分 —— 那会让脚本认为「全都要拉」，
    在最该停下的时候埋头干活。所以这里判 returncode，不判输出条数。
    """
    p = subprocess.run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"⛔ docker 不可达（rc={p.returncode}）: {p.stderr.strip()[:200]}\n"
                 f"   先跑: docker context use colima-swebench")
    got = set()
    for line in p.stdout.splitlines():
        if line.startswith(IMAGE_PREFIX + "/") and line.endswith(":" + VERSION):
            got.add(line[len(IMAGE_PREFIX) + 1:-len(VERSION) - 1])
    return got


def size_table() -> dict[str, int | None]:
    """读体积/可达性缓存（`sizes.txt`，由 manifest 探测产出，每行 `名 OK|DENIED 压缩字节`）。

    ⚠️ 为什么要它：2026-09-06 实测两件事让「按 registry 顺序逐张拉」成了错策略。
      ① **15 张恒回 `denied`**（权限态，1s 返回）—— 重试轮数救不了，排在前面只是浪费。
      ② **体积差 94 倍**：`mteb-retrieve`/`mteb-leaderboard` 各 8.5GB 压缩、
         `pytorch-model-recovery` 6.1GB，而其余 24 张压缩合计仅 5.4GB。
         按实测膨胀比 2×，3 张巨张要 46G 落盘换 3 道题，24 张小张只要 11G 换 24 道题。
         磁盘只剩 58G ⇒ 不分桶就会在巨张上撞守卫，把 24 道便宜的题一起赔掉。
    ⇒ 缓存缺失时**退化为原行为**（按名字排序、全都要），不阻断。
    """
    f = pathlib.Path.home() / ".cache/sid-tb-images/sizes.txt"
    if not f.exists():
        return {}
    out: dict[str, int | None] = {}
    for line in f.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 3:
            out[parts[0]] = None if parts[1] == "DENIED" else int(parts[2])
    return out


def main() -> None:
    want, have = registry_tasks(), local_images()
    missing = sorted(set(want) - have)

    sizes = size_table()
    if sizes:
        # 跳过已知 denied（除非显式要求带上，用于复核它是否解封）
        if os.environ.get("SID_TB_INCLUDE_DENIED") != "1":
            missing = [t for t in missing if sizes.get(t, 0) is not None]
        # 体积上限（压缩字节）。默认 0 = 不设限
        cap_gb = float(os.environ.get("SID_TB_MAX_GB", "0") or 0)
        if cap_gb > 0:
            missing = [t for t in missing if (sizes.get(t) or 0) <= cap_gb * 1e9]
        # 小的先拉：同样的磁盘先换到最多的题
        missing.sort(key=lambda t: (sizes.get(t) or 0, t))
    if "--stats" in sys.argv:
        print(f"registry {DATASET}@{VERSION} = {len(want)} 题")
        print(f"本地已有                    = {len(have & set(want))} 题")
        print(f"待拉                        = {len(missing)} 题")
        extra = have - set(want)
        if extra:
            print(f"⚠️ 本地另有 {len(extra)} 个不在 89 题内的 tb 镜像（资产，别删）")
        if sizes:
            denied = [t for t in set(want) - have if sizes.get(t, 0) is None]
            comp = sum(sizes.get(t) or 0 for t in missing)
            print(f"  其中本次会拉        = {len(missing)} 张"
                  f"（压缩 {comp/1e9:.1f}GB ⇒ 落盘约 {comp/1e9*2:.0f}G）")
            print(f"  已知 denied 已跳过  = {len(denied)} 张（重试无用；"
                  f"SID_TB_INCLUDE_DENIED=1 可强制带上复核）")
        return
    print("\n".join(missing))


if __name__ == "__main__":
    main()
