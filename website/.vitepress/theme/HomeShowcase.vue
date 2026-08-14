<script setup lang="ts">
/**
 * 首页主体 —— 能力条 / 定位主张 / 你会得到什么 / 四大特性 / 四大方向 / 装上试试。
 *
 * ── 为什么把首页正文搬进组件 ──
 *   首页要「一眼看懂 + 视觉够强」，而 markdown 只能产出卡片（默认主题 features）与表格
 *   两种形态。旧版正是这样：特性是卡片、方向是表格、现状是表格 —— 三段内容三种视觉语言，
 *   读者会以为它们是三类不同的东西，而「四大特性」与「四大方向」其实是同等重量的一对
 *   （一个回答"凭什么选"，一个回答"凭什么留"）。搬进组件后**两段共用同一套卡片**
 *   （.hs-card 的 markup 与样式完全一致），差别只在卡片内部载荷。
 *
 * ── 段落顺序：先给证据，再给结论，最后才是能力清单 ──
 *   能力条 → 定位主张 → 你会得到什么 → 四大特性 → 四大方向 → 装上试试。
 *   前三段回答「凭什么信、这是什么、与我何干」，中间两段展开「具体有什么、往哪走」，
 *   末段是出口：读到这里的人已经决定试一下了，此刻还让他去顶栏找「安装」是多余的一步。
 *   能力条与定位主张是**一组**（四个量级数字先立住可信度，紧接着那句话才接得住），
 *   所以两者之间只留 26px，与下一分区之间才是 72px —— 调顺序时这两个 margin 要跟着换。
 *   曾把定位主张与受众收益排在最后：那是把全篇论点放在没人滚到的位置，
 *   读者先看到四张能力卡，得自己推导出结论。
 *
 * ── 内容取自 docs-research/sid-code/四大特性和四大方向.md（§1 / §3 / §5）──
 *   §5「竞争格局分三类」那张对比表**刻意不放首页**：点名比较友商是一种需要长期维护的
 *   承诺（对方改一版就得跟着改，改不动就变成不实陈述），首页不是承担这件事的地方。
 *   首页只讲自己站在哪（定位主张），不讲别人缺什么。
 *
 * ── 三条文案纪律（都是返工出来的）──
 *   1. **不写会漂移的精确指标**。方向卡上曾放过 "TTFT p50 3.3s" "每会话 $0.14"：
 *      轨迹样本集是滚动的（LRU 上限 100 个会话），这类数字每周都不一样，首页放上去
 *      要么很快变成假的，要么逼人定期回来改。方向卡只写**量什么**（口径），不写量到多少；
 *      具体数值属于 /blog/ 的实测长文与内部轨迹，那里能带上样本数与日期。
 *   2. **不做没有数据的图表**。同一轮曾给方向卡配过迷你趋势线 —— 那条线是画上去的，
 *      不对应任何真实序列。用假图表撑视觉比纯文字更糟：它冒充了证据。
 *   3. **hero tagline 与定位块必须在不同的轴上**，判据不是「用词是否相同」。
 *      先后错过两版：一版让 tagline 与定位块逐字重复；一版改成「模型你选，harness 你改，
 *      轨迹和账本都留在你自己手里」——字面不同了，讲的还是「可改 + 数据归你」同一根轴，
 *      同屏读到两遍同一个意思。现在的分工（改任一处前先看另一处，别让它们再收敛）：
 *        hero.text = 这是什么 / tagline = 用了会怎样（方向轴）/ 定位块 = 凭什么（底座轴）。
 *      tagline 与定位块合起来正好是 §5 那句价值主张的前后两半，互补而不重叠。
 *
 * ── 能力条数字口径（改之前先跑命令，别凭记忆改）──
 *   ⚠ 三处须一致：本文件、README.md（英文主入口）、README.zh-CN.md。
 *     2026-08-10 教训：工具数从 "60+" 改成 44 时只改了首页，README 漏改，
 *     两份对外文档不一致挂了两周多。改这里时把三处一起 grep 一遍。
 *
 *     自研代码行数  find packages/{shared,core,cli}/src -name '*.ts' -o -name '*.tsx' | xargs wc -l
 *                   （2026-08-11 实测 203,533 行，不含 vendor 的 ink fork = packages/tui-renderer）
 *     单测          在仓库根跑 grep -rhoE '\b(it|test)\(' 扫 tests、各包的 tests 与 src
 *                   （只算 .test.ts / .test.tsx；2026-08-13 实测 8,576 个用例 / 644 个文件。
 *                     ⚠ 覆盖路径必须含每个包的 tests 目录 —— 分包后漏掉它会数出 30 而不是 644，
 *                     且**不报错、只静默少数 95%**）
 *     Hook 事件数   packages/core/src/hook/types.ts 的 HookEventName 枚举成员数（实测 32）
 *     内置工具数    sid-code --dump-tools 数组长度（2026-07-27 实测 44，与 ref/tools.md 同源）
 *
 * ── 首页交互一律不依赖 JS ──
 *   受众切换用**隐藏 radio + `:checked ~` 兄弟选择器**，纯 CSS，没有任何组件状态。
 *   上一版用 `ref` + `v-show` 写，实测点了没反应：编译产物里 onClick 与 vShow 都在，
 *   即代码本身没错，问题出在「这一段必须等水合完成才活」这个前提上 —— 水合一旦没跑
 *   （SSR/客户端不匹配、脚本被拦、离线打开产物），控件看起来正常但点了毫无反馈，
 *   而这类故障恰恰最难自证。改成 CSS 后这个前提整个消失：HTML 一到就能用。
 *   ⚠ 因此**别把它改回 v-show / v-if**，也别为了"少两个 CSS 选择器"把 radio 换成 button。
 *   同理，数字滚动是纯增强：SSR 产物里已是终值，JS 只是先归零再滚上去，且有 2.5s 兜底。
 */
import { onMounted, onUnmounted, ref } from "vue";

/* ── 能力条 ── */
interface Stat {
  value: number;
  suffix: string;
  label: string;
}
const STATS: Stat[] = [
  { value: 20, suffix: "万+", label: "行自研 TypeScript" },
  { value: 8000, suffix: "+", label: "单测用例，全绿才提交" },
  { value: 44, suffix: "", label: "个内置工具" },
  { value: 32, suffix: "类", label: "Hook 事件可插拔" },
];

/* ── §5 分开回答两类用户 ── */
const AUDIENCES = [
  {
    key: "team",
    tab: "企业",
    items: [
      "代码与轨迹不出机房，安全审查一次过，不用为合规单独报批",
      "模型不绑死：网关涨价、换供应商、上自研模型，改配置不换工具",
      "你们的规矩能进 harness，团队默认配置一键分发，policy 可管控",
      "过程数据是你们自己的资产：查成本归属、防功能回退、做团队级优化",
    ],
  },
  {
    key: "solo",
    tab: "个人开发者",
    items: [
      "便宜模型 + 好 harness 一样能干活——工具本身就是变量",
      "花了多少钱、慢在哪一步，一目了然",
      "全开源可改，今天发现的问题今天补，不等厂商排期",
      "你的代码不会进任何人的训练集",
    ],
  },
];

/* ── 卡片数据 ──
   icon 用 stroke path 的 d 串数组（描边自绘动画靠 stroke-dashoffset，实心 fill 做不了）。
   circles 单列，因为 <circle> 塞不进 <path d>。 */
interface Card {
  title: string;
  lead: string;
  desc: string;
  link: string;
  linkText: string;
  paths: string[];
  circles?: Array<{ cx: number; cy: number; r: number }>;
  /** 仅「四大方向」用：这条曲线**量什么**。刻意不带数值，理由见文件头文案纪律 1。 */
  gauge?: string;
}

const FEATURES: Card[] = [
  {
    title: "企业级",
    lead: "装上就接得上你公司已有的那套东西。",
    desc: "内部网关计费口径、内网 GitLab、企业 SSO、MCP、团队默认配置分发，是按真实企业内网一条条适配出来的，不用先改造企业来适配工具。",
    link: "/team/defaults",
    linkText: "团队部署",
    paths: ["M3 21h18", "M5 21V7l7-4 7 4v14", "M9.5 21v-5h5v5"],
  },
  {
    title: "可定制",
    lead: "harness 整套可改，模型任你换。",
    desc: "换模型改一行配置，加扩展写一个文件，改内核提一个 PR。你团队的怪规矩今天就能写进 harness，不用等厂商排期。",
    link: "/extend/",
    linkText: "扩展方式",
    paths: ["M4 7h16", "M4 12h16", "M4 17h16"],
    circles: [
      { cx: 9, cy: 7, r: 2.2 },
      { cx: 15, cy: 12, r: 2.2 },
      { cx: 7.5, cy: 17, r: 2.2 },
    ],
  },
  {
    title: "数据主权",
    lead: "代码和对话不出你的机房。",
    desc: "会话轨迹、评测结果、成本账本全落在自己的基础设施里，不进任何人的训练集。数据在自己手上，才谈得上拿它做优化。",
    link: "/use/sessions",
    linkText: "本地落盘",
    paths: [
      "M4 5.5h16v5H4z",
      "M4 13.5h16v5H4z",
      "M7.5 8h.01",
      "M7.5 16h.01",
      "M13 8h4",
      "M13 16h4",
    ],
  },
  {
    title: "可观测",
    lead: "每一分钱、每一步决策都查得到。",
    desc: "钱花在哪、慢在哪、agent 为什么走了这一步，事后都能翻出来；发布前跑一遍评测，知道这个版本有没有退步。默认就开着。",
    link: "/team/observability",
    linkText: "轨迹与度量",
    paths: ["M3 3v18h18", "M7 15.5l4-5 3 3 4.5-6.5"],
  },
];

const DIRECTIONS: Card[] = [
  {
    title: "更快",
    lead: "从你回车到最终答复，这段时间要一版比一版短。",
    desc: "不只看均值——慢尾巴才是真正让人放弃的地方，所以一律按 p95/p99 复算。",
    link: "/blog/",
    linkText: "实测长文",
    paths: ["M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"],
    gauge: "首字响应 TTFT · 端到端耗时",
  },
  {
    title: "更省",
    lead: "同样一件事，少花 token、少花钱。",
    desc: "缓存命中率兜住大头，会话轮数是成本的最大杠杆——两者都在账本里逐轮记着。",
    link: "/use/cost",
    linkText: "成本与用量",
    paths: ["M22 17.5 13.5 9l-5 5L2 7.5", "M16 17.5h6v-6"],
    gauge: "单位任务 token 与成本 · cache 命中率",
  },
  {
    title: "更少返工",
    lead: "不是模型更聪明，是同一个模型在这里一次做对的比例更高。",
    desc: "模型聪不聪明不由我们决定；重试、空转、反复改同一个文件这些浪费，由 harness 决定。",
    link: "/team/observability",
    linkText: "过程指标",
    paths: ["M21.8 11.2A10 10 0 1 1 17.2 3.4", "M9 11.5l2.5 2.5L21 5"],
    gauge: "一次做对率 · 评测通过率 · 过程病态率",
  },
  {
    title: "更安全",
    lead: "只看正面信号，不拿事故数当指标。",
    desc: "安全是「坏事没发生」，用事故数当指标只会得到一条恒平的曲线，分不清是防线起作用还是运气好。",
    link: "/team/policy",
    linkText: "安全边界",
    paths: [
      "M12 3l7.5 3v6.2c0 4.5-3.1 7.7-7.5 9.3-4.4-1.6-7.5-4.8-7.5-9.3V6L12 3z",
      "M9 12.4l2 2 4.2-4.4",
    ],
    gauge: "防线触发率 · 权限匹配正确率 · 人工确认介入率",
  },
];

/* ── 底部「装上试试」区的安装命令 ──
   ⚠ 与 /start/install 必须逐字一致（那页是唯一事实源）。首页抄一份是为了
   「看完就能装」不用先跳页，代价是两处会漂移 —— 改这里前先去那页核一遍。
   刻意**不推 `sc` 别名**：它等价于 --dangerously-skip-permissions（安装脚本会写这个别名），
   在首页教它，等于让第一次接触的人先敲一条全放行命令，再去别处读到「这个不建议第一次用」。 */
const INSTALL_CMD = "curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | bash";

/* 终端里展示的三行。note 是行尾注释（灰色，不带 `$` 提示符前缀之外的语义）。 */
const TERM_LINES: Array<{ cmd: string; note?: string }> = [
  { cmd: INSTALL_CMD },
  { cmd: "sid-code --version", note: "# 确认装上了" },
  { cmd: "sid-code", note: "# 配好模型后启动" },
];

const STEPS = [
  {
    n: "01",
    title: "安装",
    desc: "上面这一条命令。macOS 与 Linux，arm64 / x64，不需要 sudo，全在家目录下。",
    link: "/start/install",
    linkText: "安装细节与三类常见失败",
  },
  {
    n: "02",
    title: "配模型",
    desc: "sid-code 不带模型。Anthropic / OpenAI / Ollama 三族协议各有一份可直接粘的配置。",
    link: "/start/configure",
    linkText: "配置 LLM Provider",
  },
  {
    n: "03",
    title: "跑第一个任务",
    desc: "每一步它要改什么、要跑什么命令，都摆在你面前等你确认。",
    link: "/start/first-task",
    linkText: "跑通第一个任务",
  },
];

/* 复制安装命令。
   ⚠ 必须保留 execCommand 回退：navigator.clipboard 只在安全上下文（https / localhost）
   可用，站点历史上用过 IP + http 部署，只用 clipboard API 会「点了没反应」。
   与 CopyPage.vue 同一套判断，改一处时看看另一处。
   JS 没跑起来时按钮不动，但命令本身是可选中的纯文本，用户仍能手动复制。 */
const copied = ref<"idle" | "done" | "fail">("idle");
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyInstall() {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(INSTALL_CMD);
    } else {
      const ta = document.createElement("textarea");
      ta.value = INSTALL_CMD;
      ta.setAttribute("readonly", "");
      // 不用 display:none —— 那样选不中，execCommand 会失败
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("execCommand copy 返回 false");
    }
    copied.value = "done";
  } catch {
    copied.value = "fail";
  }
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copied.value = "idle"), 2000);
}

/* ── 数字滚动（纯增强，见文件头）──
   初值即终值：SSR 产物、以及「JS 没跑起来」两种情况下数字都是对的。
   onMounted 里先归零（在浏览器绘制前完成，看不到闪一下），再逐帧滚上去。 */
const shown = ref<number[]>(STATS.map((s) => s.value));
const statsEl = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
let fallback: ReturnType<typeof setTimeout> | null = null;
let raf = 0;

function fmt(v: number): string {
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function run() {
  const DUR = 1100;
  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / DUR);
    // easeOutCubic：末段减速，视觉上像「停稳」而不是「被掐断」
    const e = 1 - Math.pow(1 - p, 3);
    shown.value = STATS.map((s) => s.value * e);
    if (p < 1) raf = requestAnimationFrame(tick);
    else shown.value = STATS.map((s) => s.value);
  };
  raf = requestAnimationFrame(tick);
}

onMounted(() => {
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || typeof IntersectionObserver === "undefined") return;

  shown.value = STATS.map(() => 0);
  // 兜底：observer 因任何原因没回调时，2.5s 后强制回填终值。
  // 没有这条，异常路径下页面会永远停在一排 0 —— 比不做动画糟得多。
  fallback = setTimeout(() => {
    cancelAnimationFrame(raf);
    shown.value = STATS.map((s) => s.value);
  }, 2500);

  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io?.disconnect();
      io = null;
      if (fallback) clearTimeout(fallback);
      run();
    },
    { threshold: 0.25 },
  );
  if (statsEl.value) io.observe(statsEl.value);
});

onUnmounted(() => {
  io?.disconnect();
  if (fallback) clearTimeout(fallback);
  if (copyTimer) clearTimeout(copyTimer);
  cancelAnimationFrame(raf);
});
</script>

<template>
  <div class="hs">
    <!-- ── 能力条：紧接 hero，先给「这东西真在跑」的量级证据 ── -->
    <section ref="statsEl" class="hs-stats" aria-label="项目规模">
      <div v-for="(s, i) in STATS" :key="s.label" class="hs-stat" :style="{ '--i': i }">
        <span class="hs-stat-n">
          {{ fmt(shown[i]) }}<span class="hs-stat-u">{{ s.suffix }}</span>
        </span>
        <span class="hs-stat-l">{{ s.label }}</span>
      </div>
    </section>

    <!-- ── 定位主张：全篇论点，垫在证据之后 ── -->
    <section class="hs-pos">
      <div class="hs-pos-in">
        <p class="hs-pos-eyebrow">sid-code 的位置</p>
        <p class="hs-pos-main">
          别人给你一个 agent；<br
            class="hs-br"
          />我们给你一个<em>你能改、能量、能审、数据不出门</em>的 agent 底座。
        </p>
        <p class="hs-pos-sub">
          开源社区的技术自由度 + 商业产品的工程完备度，再加一件通用工具不会做的事——
          为你这一家企业的研发环境做适配，并把过程数据留在你自己手里。
        </p>
      </div>
    </section>

    <!-- ── 你会得到什么 ──
         radio + label + `:checked ~` 纯 CSS 切换，不依赖水合（理由见文件头）。
         ⚠ radio、labels、面板必须是**同一个父元素的兄弟**，`~` 才选得到；
           中间插一层包装元素会让切换静默失效。 -->
    <section class="hs-sec">
      <header class="hs-head">
        <span class="hs-orb" aria-hidden="true" />
        <h2 class="hs-h2">你会得到什么</h2>
        <p class="hs-sub">同一个底座，两类人拿走的东西不一样</p>
      </header>

      <div class="hs-auds">
        <!-- 隐藏 radio：opacity 0 但**不能** display/visibility 隐藏，否则键盘聚焦不到 -->
        <input
          v-for="(a, i) in AUDIENCES"
          :id="'hs-aud-' + i"
          :key="'in-' + a.key"
          class="hs-aud-in"
          type="radio"
          name="hs-aud"
          :checked="i === 0"
          :aria-label="a.tab"
        />
        <div class="hs-seg">
          <label
            v-for="(a, i) in AUDIENCES"
            :key="'lb-' + a.key"
            class="hs-seg-btn"
            :for="'hs-aud-' + i"
            >{{ a.tab }}</label
          >
        </div>
        <div v-for="(a, i) in AUDIENCES" :key="'pn-' + a.key" class="hs-gains" :data-aud="i">
          <div v-for="(t, k) in a.items" :key="t" class="hs-gain" :style="{ '--i': k }">
            <span class="hs-gain-n">{{ k + 1 }}</span>
            <p>{{ t }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 四大特性 ── -->
    <section class="hs-sec">
      <header class="hs-head">
        <span class="hs-orb hs-orb-2" aria-hidden="true" />
        <h2 class="hs-h2">四大特性</h2>
        <p class="hs-sub">凭什么选它 —— 建成即成立，每条都能演示一次</p>
      </header>
      <div class="hs-grid">
        <a
          v-for="(c, i) in FEATURES"
          :key="c.title"
          class="hs-card"
          :href="c.link"
          :style="{ '--i': i }"
        >
          <span class="hs-sheen" aria-hidden="true" />
          <span class="hs-ico" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path v-for="(d, k) in c.paths" :key="k" :d="d" />
              <circle
                v-for="(o, k) in c.circles || []"
                :key="'c' + k"
                :cx="o.cx"
                :cy="o.cy"
                :r="o.r"
              />
            </svg>
          </span>
          <h3 class="hs-t">{{ c.title }}</h3>
          <p class="hs-lead">{{ c.lead }}</p>
          <p class="hs-d">{{ c.desc }}</p>
          <span class="hs-more">
            {{ c.linkText }}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8h9" />
              <path d="M8.5 4.5 12 8l-3.5 3.5" />
            </svg>
          </span>
        </a>
      </div>
    </section>

    <!-- ── 四大方向：与上面**同一套卡片**，只多一条口径标签 ── -->
    <section class="hs-sec">
      <header class="hs-head">
        <span class="hs-orb hs-orb-3" aria-hidden="true" />
        <h2 class="hs-h2">四大方向</h2>
        <p class="hs-sub">凭什么留下 —— 每条背后都有一个能按版本重算的数字</p>
      </header>
      <div class="hs-grid">
        <a
          v-for="(c, i) in DIRECTIONS"
          :key="c.title"
          class="hs-card"
          :href="c.link"
          :style="{ '--i': i }"
        >
          <span class="hs-sheen" aria-hidden="true" />
          <span class="hs-ico" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path v-for="(d, k) in c.paths" :key="k" :d="d" />
            </svg>
          </span>
          <h3 class="hs-t">{{ c.title }}</h3>
          <p class="hs-lead">{{ c.lead }}</p>
          <p class="hs-d">{{ c.desc }}</p>
          <span v-if="c.gauge" class="hs-gauge">{{ c.gauge }}</span>
          <span class="hs-more">
            {{ c.linkText }}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8h9" />
              <path d="M8.5 4.5 12 8l-3.5 3.5" />
            </svg>
          </span>
        </a>
      </div>
    </section>

    <!-- ── 装上试试：首页的出口 ──
         页面读到这里的人已经决定试一下了，此刻还要他去顶栏找「安装」是多余的一步。
         命令与 /start/install 逐字一致（见 INSTALL_CMD 上方注释）。 -->
    <section class="hs-sec hs-sec-last">
      <header class="hs-head">
        <span class="hs-orb hs-orb-4" aria-hidden="true" />
        <h2 class="hs-h2">装上试试</h2>
        <p class="hs-sub">一条命令装完 · macOS 与 Linux · 不需要 sudo</p>
      </header>

      <div class="hs-term">
        <div class="hs-term-bar">
          <span class="hs-dots" aria-hidden="true"><i /><i /><i /></span>
          <span class="hs-term-title">bash</span>
          <button
            class="hs-copy"
            type="button"
            :data-state="copied"
            aria-label="复制安装命令"
            @click="copyInstall"
          >
            {{ copied === "done" ? "✓ 已复制" : copied === "fail" ? "复制失败" : "⧉ 复制" }}
          </button>
        </div>
        <div class="hs-term-body">
          <p v-for="(l, i) in TERM_LINES" :key="l.cmd" class="hs-line" :style="{ '--i': i }">
            <span class="hs-prompt" aria-hidden="true">$</span>
            <span class="hs-cmd">{{ l.cmd }}</span>
            <span v-if="l.note" class="hs-note">{{ l.note }}</span>
            <!-- 光标只跟在最后一行：多个闪烁光标会让人以为是渲染错误 -->
            <span v-if="i === TERM_LINES.length - 1" class="hs-caret" aria-hidden="true" />
          </p>
        </div>
      </div>

      <div class="hs-steps">
        <a v-for="(s, i) in STEPS" :key="s.n" class="hs-step" :href="s.link" :style="{ '--i': i }">
          <span class="hs-step-n" aria-hidden="true">{{ s.n }}</span>
          <h3 class="hs-step-t">{{ s.title }}</h3>
          <p class="hs-step-d">{{ s.desc }}</p>
          <span class="hs-more">
            {{ s.linkText }}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8h9" />
              <path d="M8.5 4.5 12 8l-3.5 3.5" />
            </svg>
          </span>
        </a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hs {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 8px;
}
@media (min-width: 768px) {
  .hs {
    padding: 0 48px 8px;
  }
}

/* ── 入场动画 ──
   纯 CSS + animation-fill-mode: both：JS 没跑也一定停在终态。
   延迟按 --i 递增，形成从左到右的落位节奏。 */
@keyframes hs-rise {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 描边自绘：dasharray 取一个大于所有 path 长度的定值即可，
   不必逐条量 getTotalLength（那要 JS，且会让终态依赖 JS）。 */
@keyframes hs-draw {
  from {
    stroke-dashoffset: 260;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes hs-float {
  0%,
  100% {
    transform: translate3d(0, 0, 0) scale(1);
  }
  50% {
    transform: translate3d(0, -14px, 0) scale(1.06);
  }
}
@keyframes hs-shimmer {
  from {
    background-position: 0% 50%;
  }
  to {
    background-position: 200% 50%;
  }
}

/* ── 定位主张：渐变描边 + 缓慢流动的高光 ── */
.hs-pos {
  display: block;
  /* 上边距小、下边距大：它紧贴在能力条下方（两者是"证据 + 结论"一组），
     与下一个分区之间才留大间隔。改顺序时这两个值要跟着换，否则分组关系会读反。 */
  margin: 0 0 72px;
  padding: 1px;
  border-radius: 18px;
  background: linear-gradient(
    100deg,
    var(--sid-brand),
    #7c5cf6 30%,
    var(--sid-brand) 55%,
    #7c5cf6 80%,
    var(--sid-brand)
  );
  background-size: 200% 100%;
  animation: hs-shimmer 9s linear infinite;
  box-shadow: 0 20px 44px -26px var(--sid-brand-glow);
}
.hs-pos-in {
  padding: 30px 28px 28px;
  border-radius: 17px;
  background: var(--sid-card);
  text-align: center;
}
.hs-pos-eyebrow {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}
.hs-pos-main {
  margin: 12px auto 0;
  max-width: 760px;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.62;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}
.hs-pos-main em {
  font-style: normal;
  background: linear-gradient(120deg, var(--sid-brand-strong) 10%, #7c5cf6 90%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.hs-pos-sub {
  margin: 14px auto 0;
  max-width: 680px;
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
}

/* ── 能力条 ── */
.hs-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 4px 0 26px;
  padding: 22px 8px;
  border: 1px solid var(--sid-card-border);
  border-radius: 16px;
  background: linear-gradient(180deg, var(--sid-brand-soft), transparent 70%), var(--sid-card);
  box-shadow: 0 1px 2px var(--sid-card-shadow-2);
}
.hs-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
  animation: hs-rise 0.5s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  animation-delay: calc(var(--i) * 70ms);
}
/* 数字之间用竖线分隔而不是各自描边成卡片：四个数字是一组并列证据，
   拆成四张卡会让人以为它们是四类东西 */
.hs-stat + .hs-stat {
  border-left: 1px solid var(--vp-c-divider);
}
.hs-stat-n {
  font-family: var(--vp-font-family-mono);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  background: linear-gradient(120deg, var(--sid-brand-strong) 10%, #7c5cf6 90%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  /* 滚动过程中位数变化会抖动，等宽数字锁住列宽 */
  font-variant-numeric: tabular-nums;
}
.hs-stat-u {
  font-size: 15px;
  margin-left: 1px;
}
.hs-stat-l {
  font-size: 12.5px;
  color: var(--vp-c-text-3);
}

/* ── 分区标题 ── */
.hs-sec {
  position: relative;
  margin-bottom: 78px;
}
.hs-sec-last {
  margin-bottom: 16px;
}
.hs-head {
  position: relative;
  margin-bottom: 26px;
  text-align: center;
}
.hs-h2 {
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--vp-c-text-1);
  border: 0;
  padding: 0;
}
.hs-sub {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--vp-c-text-3);
}
/* 标题背后的品牌光斑：唯一的"氛围"元素，缓慢浮动，不抢内容 */
.hs-orb {
  position: absolute;
  top: -70px;
  left: 50%;
  width: 320px;
  height: 180px;
  margin-left: -160px;
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--sid-brand-glow), transparent 72%);
  filter: blur(28px);
  opacity: 0.5;
  pointer-events: none;
  animation: hs-float 9s ease-in-out infinite;
}
.hs-orb-2 {
  background: radial-gradient(closest-side, rgba(124, 92, 246, 0.3), transparent 72%);
  animation-duration: 11s;
}
.hs-orb-3 {
  animation-duration: 13s;
}
.hs-orb-4 {
  background: radial-gradient(closest-side, rgba(124, 92, 246, 0.26), transparent 72%);
  animation-duration: 10s;
}

/* ── 装上试试：终端窗口 ── */
@keyframes hs-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}
.hs-term {
  overflow: hidden;
  border: 1px solid var(--sid-card-border);
  border-radius: 14px;
  /* 终端底色**不跟随深浅色主题**：真实终端就是深色的，浅色模式下给一块白底的
     "终端"反而不像终端。这是全站唯一一处刻意写死的深色面板，不要"顺手统一"掉。 */
  background: linear-gradient(180deg, #141a27, #10151f);
  box-shadow: 0 22px 48px -28px rgba(15, 20, 32, 0.55);
}
.hs-term-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.03);
}
.hs-dots {
  display: inline-flex;
  gap: 6px;
}
.hs-dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #3a4356;
}
.hs-dots i:first-child {
  background: #ff5f57;
}
.hs-dots i:nth-child(2) {
  background: #febc2e;
}
.hs-dots i:nth-child(3) {
  background: #28c840;
}
.hs-term-title {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: #6b7688;
}
.hs-copy {
  margin-left: auto;
  padding: 3px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 7px;
  background: transparent;
  color: #a8b3c7;
  font-size: 11.5px;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s;
}
.hs-copy:hover {
  color: #8badff;
  border-color: #8badff;
}
.hs-copy:focus-visible {
  outline: 2px solid #8badff;
  outline-offset: 2px;
}
.hs-copy[data-state="done"] {
  color: #4ade80;
  border-color: #4ade80;
}
.hs-copy[data-state="fail"] {
  color: #ff8095;
  border-color: #ff8095;
}
.hs-term-body {
  padding: 18px 18px 20px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  /* 长命令在窄屏必须能横向滚，折行会让人误以为要敲两行 */
  overflow-x: auto;
}
.hs-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  white-space: pre;
  animation: hs-rise 0.45s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  animation-delay: calc(var(--i) * 110ms);
}
.hs-line + .hs-line {
  margin-top: 9px;
}
.hs-prompt {
  color: #4ade80;
  user-select: none;
}
.hs-cmd {
  color: #e6ebf5;
}
.hs-note {
  color: #6b7688;
}
.hs-caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  background: #8badff;
  animation: hs-blink 1.05s steps(1) infinite;
}
.hs-term-tip {
  margin: 12px 0 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--vp-c-text-3);
}
.hs-term-tip code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}

/* ── 三步 ── */
.hs-steps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 26px;
}
.hs-step {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 20px 18px 16px;
  border: 1px solid var(--sid-card-border);
  border-radius: 14px;
  background: var(--sid-card);
  text-decoration: none !important;
  color: inherit;
  font-weight: 400;
  animation: hs-rise 0.5s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  animation-delay: calc(var(--i) * 80ms + 120ms);
  transition:
    transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1),
    border-color 0.22s;
}
.hs-step:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-1);
}
.hs-step:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.hs-step-n {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--vp-c-brand-1);
}
.hs-step-t {
  margin: 6px 0 0;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.4;
  color: var(--vp-c-text-1);
  border: 0;
  padding: 0;
}
.hs-step-d {
  margin: 7px 0 0;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--vp-c-text-2);
}
.hs-step:hover .hs-more {
  color: var(--vp-c-brand-1);
}
.hs-step:hover .hs-more svg {
  transform: translateX(3px);
}

/* ── 受众切换：纯 CSS，无组件状态 ── */
.hs-auds {
  position: relative;
}
/* opacity 0 而不是 display:none / visibility:hidden —— 后两者会让 radio
   从 tab 序列里消失，键盘用户再也切不了 */
.hs-aud-in {
  position: absolute;
  top: 0;
  left: 50%;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}
.hs-seg {
  display: flex;
  gap: 4px;
  width: fit-content;
  margin: 0 auto 22px;
  padding: 4px;
  border: 1px solid var(--sid-card-border);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
}
.hs-seg-btn {
  padding: 7px 20px;
  border-radius: 999px;
  color: var(--vp-c-text-2);
  font-size: 13.5px;
  cursor: pointer;
  user-select: none;
  transition:
    background 0.22s,
    color 0.22s;
}
.hs-seg-btn:hover {
  color: var(--vp-c-brand-1);
}
.hs-gains {
  display: none;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}
/*
 * ⚠ 下面三组选择器写死了下标 0 / 1，因为 `~` 需要静态选择器，CSS 里没法按数据长度生成。
 *   AUDIENCES 增减一项，这三组必须同步加/减一行 —— 漏了不会报错，只会「点了没反应」，
 *   正是上一版 v-show 那个故障的症状。改数据前先看这里。
 */
#hs-aud-0:checked ~ .hs-gains[data-aud="0"],
#hs-aud-1:checked ~ .hs-gains[data-aud="1"] {
  display: grid;
}
/* 选中态不只靠颜色：加粗 + 实心底（与 BlogIndex 的筛选 chip 同一套纪律） */
#hs-aud-0:checked ~ .hs-seg .hs-seg-btn[for="hs-aud-0"],
#hs-aud-1:checked ~ .hs-seg .hs-seg-btn[for="hs-aud-1"] {
  background: var(--sid-card);
  color: var(--vp-c-brand-1);
  font-weight: 600;
  box-shadow: 0 1px 2px var(--sid-card-shadow-2);
}
/* radio 本体不可见，焦点环必须转嫁到它的 label 上，否则键盘用户看不到自己在哪 */
#hs-aud-0:focus-visible ~ .hs-seg .hs-seg-btn[for="hs-aud-0"],
#hs-aud-1:focus-visible ~ .hs-seg .hs-seg-btn[for="hs-aud-1"] {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.hs-gain {
  display: flex;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--sid-card-border);
  border-radius: 12px;
  background: var(--sid-card);
  animation: hs-rise 0.4s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  animation-delay: calc(var(--i) * 55ms);
}
.hs-gain p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.72;
  color: var(--vp-c-text-2);
}
.hs-gain-n {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--sid-brand-soft);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
}

/* ── 卡片：特性与方向共用，唯一差别是内部载荷 ── */
.hs-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}
.hs-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 22px 20px 18px;
  border: 1px solid var(--sid-card-border);
  border-radius: 14px;
  background: var(--sid-card);
  box-shadow:
    0 1px 2px var(--sid-card-shadow-2),
    0 6px 18px -12px var(--sid-card-shadow);
  overflow: hidden;
  text-decoration: none !important;
  color: inherit;
  font-weight: 400;
  animation: hs-rise 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  animation-delay: calc(var(--i) * 80ms + 60ms);
  transition:
    transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1),
    border-color 0.22s,
    box-shadow 0.22s;
}
/* 顶部一条渐变高光，hover 时从左铺开 —— 用形变而不是换底色：
   浅色模式下卡片已是纯白，没有"更亮"的余地（同 brand.css 里的既有判断） */
.hs-sheen {
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(90deg, var(--sid-brand), #7c5cf6);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.32s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.hs-card:hover {
  transform: translateY(-4px);
  border-color: var(--vp-c-brand-1);
  box-shadow:
    0 2px 4px var(--sid-card-shadow-2),
    0 18px 34px -18px var(--sid-brand-glow);
}
.hs-card:hover .hs-sheen {
  transform: scaleX(1);
}
/* 键盘焦点必须与 hover 等价可见：整张卡是链接，只做 hover 会让键盘用户丢失位置 */
.hs-card:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}

.hs-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 14px;
  border-radius: 11px;
  background: var(--sid-brand-soft);
  color: var(--vp-c-brand-1);
  transition:
    transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1),
    background 0.22s;
}
.hs-ico svg {
  width: 21px;
  height: 21px;
  stroke-dasharray: 260;
  animation: hs-draw 1.1s ease forwards;
  animation-delay: calc(var(--i) * 80ms + 260ms);
}
.hs-card:hover .hs-ico {
  transform: translateY(-1px) scale(1.07);
}

.hs-t {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  line-height: 1.4;
  color: var(--vp-c-text-1);
  border: 0;
  padding: 0;
}
/* lead 是"一句话收益"，desc 是佐证。两级字色拉开层次，
   让扫读的人只读 lead 也能拿到完整主张。 */
.hs-lead {
  margin: 7px 0 0;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.6;
  color: var(--vp-c-text-1);
}
.hs-d {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--vp-c-text-2);
}
/* 方向卡的口径标签：**量什么**，不写量到多少（数值会漂移，理由见文件头） */
.hs-gauge {
  display: inline-block;
  margin-top: 12px;
  padding: 4px 9px;
  border: 1px dashed var(--sid-card-border);
  border-radius: 7px;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--vp-c-text-3);
}
.hs-more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
  padding-top: 14px;
  font-size: 12.5px;
  color: var(--vp-c-text-3);
  transition: color 0.2s;
}
.hs-more svg {
  width: 13px;
  height: 13px;
  transition: transform 0.22s;
}
.hs-card:hover .hs-more {
  color: var(--vp-c-brand-1);
}
.hs-card:hover .hs-more svg {
  transform: translateX(3px);
}

/* ── 响应式：4 → 2 → 1 ── */
@media (max-width: 959px) {
  .hs-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .hs-steps {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .hs-grid {
    grid-template-columns: 1fr;
  }
  .hs-term-body {
    font-size: 12px;
  }
  /* ⚠ 这里改的是**选中时**的展开值，不能写 .hs-gains{grid-template-columns:1fr}
     以外的 display —— 未选中那份必须保持 display:none */
  .hs-gains {
    grid-template-columns: 1fr;
  }
  .hs-stats {
    grid-template-columns: repeat(2, 1fr);
    row-gap: 20px;
  }
  /* 两列时第 3 个换行，竖线要按新列位重算，否则行首会留一条孤立竖线 */
  .hs-stat:nth-child(odd) {
    border-left: 0;
  }
  .hs-h2 {
    font-size: 25px;
  }
  .hs-pos-main {
    font-size: 18px;
  }
  /* 窄屏一行放不下，强制换行反而把句子切碎 */
  .hs-br {
    display: none;
  }
}

/* 减少动效：入场、光斑浮动、描边自绘、渐变流动全部关掉，只留终态。
   hover 位移也去掉（前庭失调用户对位移最敏感），颜色反馈保留。 */
@media (prefers-reduced-motion: reduce) {
  .hs-stat,
  .hs-card,
  .hs-gain,
  .hs-ico svg,
  .hs-orb,
  .hs-pos,
  .hs-line,
  .hs-step {
    animation: none;
  }
  /* 光标改成常亮而不是消失：它是"这里是终端"的符号，去掉会少一层含义 */
  .hs-caret {
    animation: none;
    opacity: 1;
  }
  .hs-ico svg {
    stroke-dasharray: none;
  }
  .hs-card,
  .hs-ico,
  .hs-more svg,
  .hs-sheen,
  .hs-seg-btn,
  .hs-step,
  .hs-copy {
    transition: none;
  }
  .hs-card:hover,
  .hs-card:hover .hs-ico,
  .hs-step:hover {
    transform: none;
  }
}
</style>
