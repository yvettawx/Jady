// Review page for P0.5-07-6, development builds only: #/screens/board
// The 求职 scenario (PRD S8): job postings as a board and a table, with the detail sliding in.
// Query: ?layout=table starts on the table; ?rows=1000 adds generated postings (scrolling check).
import { useState } from "react";
import type { LinkTarget } from "../../editor/WikiLink";
import { SCHEMES } from "../../theme/tokens.ts";
import { useColorMode } from "../../theme/mode.ts";
import { GlassBackdrop } from "../../ui/glass/GlassBackdrop";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { useWallpaper } from "../../ui/glass/wallpaper";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { TitleBar } from "../../shell/TitleBar";
import type { Item, TypeDef } from "../../views/model";
import { RecordsView, type RecordsLayout } from "../../views/RecordsView";
import type { WorkspaceApi } from "../../workspace/api";
import type { Layout } from "../../workspace/layout";
import { registerPanel, type PanelProps } from "../../workspace/registry";
import { Workspace } from "../../workspace/Workspace";
import "../lab.css";
import "./screens.css";

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");

const JOB: TypeDef = {
  id: "job",
  name: "职位",
  titleField: "title",
  fields: [
    { id: "title", label: "职位", kind: "text" },
    { id: "company", label: "公司", kind: "text" },
    {
      id: "status",
      label: "状态",
      kind: "select",
      options: [
        { id: "want", label: "想投", tone: "neutral" },
        { id: "sent", label: "已投", tone: "accent" },
        { id: "interview", label: "面试", tone: "ai" },
        { id: "offer", label: "录用", tone: "ok" },
        { id: "closed", label: "结束", tone: "warn" },
      ],
    },
    { id: "due", label: "截止", kind: "date" },
    { id: "source", label: "来源", kind: "source" },
    { id: "tags", label: "标签", kind: "tags" },
    { id: "notes", label: "备注", kind: "longtext" },
  ],
};

/** An ISO date some days from today, so 截止 shows its near and past states. */
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const job = (
  id: string,
  title: string,
  company: string,
  status: string,
  due: number | null,
  source: "mine" | "aiSearch" | "import",
  tags: string[],
  notes = "",
): Item => ({
  id,
  values: { title, company, status, due: due === null ? null : inDays(due), source, tags, notes },
});

const SEED: Item[] = [
  job(
    "j1",
    "后端开发实习",
    "云栈科技",
    "want",
    2,
    "aiSearch",
    ["Rust", "远程"],
    "AI 每周搜到的。要求会写 Rust，正好拿 [[Jady 开发]] 当作品。",
  ),
  job(
    "j2",
    "研究助理",
    "大学历史系",
    "interview",
    4,
    "mine",
    ["明末"],
    "10月28日面试。准备 [[读书笔记：万历十五年]]。",
  ),
  job("j3", "Android 开发实习", "鹿角工作室", "sent", 9, "aiSearch", ["Kotlin"]),
  job("j4", "数据分析实习", "北辰咨询", "want", 14, "import", ["SQL"], "从招聘表格导入的。"),
  job("j5", "全栈开发", "小船出版", "sent", -1, "mine", ["TypeScript"]),
  job(
    "j6",
    "法语翻译助理",
    "里昂文化中心",
    "want",
    21,
    "aiSearch",
    ["法语"],
    "要 B2，先把 [[第 12 课 Le passé composé]] 那几课复习完。",
  ),
  job("j7", "前端开发实习", "极光设计", "interview", 1, "mine", ["React"]),
  job(
    "j8",
    "数据库内核实习",
    "列存数据库公司",
    "closed",
    null,
    "aiSearch",
    ["C++"],
    "没通过笔试。",
  ),
  job("j9", "运维开发", "山海云", "sent", 6, "import", ["Linux"]),
  job("j10", "技术写作", "开源基金会", "offer", null, "mine", ["写作", "远程"]),
  job("j11", "游戏客户端实习", "雾岛游戏", "want", 30, "aiSearch", ["C#"]),
];

/** ?rows=N: N more postings, for the scrolling and filtering check. */
function generated(n: number): Item[] {
  const st = ["want", "sent", "interview", "offer", "closed"];
  return Array.from({ length: n }, (_, i) =>
    job(
      `g${i}`,
      `职位 ${String(i + 1).padStart(4, "0")}`,
      `公司 ${(i * 7919) % 300}`,
      st[i % st.length] as string,
      (i % 40) - 5,
      i % 3 ? "aiSearch" : "import",
      [["Rust", "SQL", "React", "法语"][i % 4] as string],
    ),
  );
}

const LINKS: Record<string, LinkTarget> = {
  "Jady 开发": {
    title: "Jady 开发",
    body: "P0 已完成：格式规范、加密封装、CRDT 选型。\nP0.5 正在画界面。",
  },
  "读书笔记：万历十五年": {
    title: "读书笔记：万历十五年",
    body: "黄仁宇从 1587 年这个“无关紧要的年份”写起。\n面试时可以讲讲它对明末研究的影响。",
  },
};

function JobsPanel({ workspace }: PanelProps) {
  const [items, setItems] = useState<Item[]>(() => {
    const n = Number(params.get("rows")) || 0;
    return n ? [...SEED, ...generated(n)] : SEED;
  });
  return (
    <RecordsView
      title="投递"
      type={JOB}
      table={{ columns: ["title", "company", "status", "due", "source", "tags"] }}
      board={{ groupBy: "status", cardFields: ["company", "due", "tags"] }}
      items={items}
      onItems={setItems}
      initialLayout={(params.get("layout") as RecordsLayout) ?? "board"}
      virtualized={items.length > 200}
      onOpenTab={(id) => {
        const it = items.find((x) => x.id === id);
        if (it)
          workspace.open(
            { contentId: id, title: String(it.values.title), component: "job-page" },
            { newTab: true },
          );
      }}
      resolve={(t) => LINKS[t] ?? null}
      onOpenLink={(t, how) =>
        showToast({ text: `（开发版）${how === "tab" ? "新页签" : "分屏"}打开《${t}》` })
      }
      newItem={(values) => ({
        id: `n${Date.now()}`,
        values: {
          title: "新职位",
          company: "",
          due: null,
          source: "mine",
          tags: [],
          notes: "",
          ...values,
        },
      })}
    />
  );
}

registerPanel({ id: "jobs", icon: "kanban", render: JobsPanel });
registerPanel({
  id: "job-page",
  icon: "job",
  render: ({ contentId }) => (
    <div className="dem-sheet">
      <div className="dem-sheet-body">
        <div className="dem-sheet-page">
          <p className="lab-quiet">（开发版）条目 {contentId} 作为页签打开，P1 是完整的条目页。</p>
        </div>
      </div>
    </div>
  ),
});

const LAYOUT: Layout = {
  version: 1,
  columns: [{ size: 1, cells: [{ size: 1, tabs: ["jobs"] }] }],
  floating: [],
  tabs: { jobs: { id: "jobs", contentId: "jobs", component: "jobs", title: "投递", kind: "pin" } },
};

declare global {
  interface Window {
    __ws?: WorkspaceApi;
  }
}

function Page() {
  const mode = useColorMode();
  const wallpaper = useWallpaper(mode, SCHEMES.aurora[0]);
  return (
    <div className="lab">
      <GlassBackdrop source={wallpaper} accent={SCHEMES.aurora[0][0]} />
      <TitleBar />
      <div className="screen-ws">
        <Workspace
          onReady={(ws) => {
            ws.load(LAYOUT);
            window.__ws = ws;
          }}
        />
      </div>
      <ToastRegion />
    </div>
  );
}

export function BoardScreens() {
  return (
    <GlassProvider accent={SCHEMES.aurora[0][0]}>
      <Page />
    </GlassProvider>
  );
}
