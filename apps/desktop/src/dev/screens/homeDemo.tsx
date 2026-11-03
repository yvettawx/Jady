/* eslint-disable react-refresh/only-export-components -- demo data and panels for dev pages, not hot-reloaded */
// Fake data for the home review page: a star map of about 120 items in 7 clusters (one of them
// private), reminders, to-dos and the heat map. Registers the home widget panels.
import { useState } from "react";
import { HeatMap } from "../../heatmap/HeatMap";
import type { HeatItem } from "../../heatmap/model";
import { useT } from "../../i18n/context";
import type { HomeWidget } from "../../home/HomeGrid";
import { seeded, type StarGraph, type StarNode } from "../../home/starmap/graph";
import { Reminders, TodayTodos, type Todo } from "../../home/widgets";
import { Button } from "../../ui/Button";
import { showToast } from "../../ui/toast";
import { registerPanel, type PanelProps } from "../../workspace/registry";
import { NOTES } from "../demo";
import { demoItems, demoYear } from "./heatDemo";

const CLUSTERS: { id: string; name: string; hub: string; items: string[]; private?: boolean }[] = [
  {
    id: "fr",
    name: "语言 / 法语",
    hub: "法语",
    items: [
      ...Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 课`),
      "le train",
      "le quai",
      "la voie",
      "le retard",
      "l'horaire",
      "le guichet",
      "la valise",
      "le métro",
      "讲课：条件式",
      "讲课：阴阳性",
      "讲课：问路",
    ],
  },
  {
    id: "write",
    name: "写作",
    hub: "长篇小说",
    items: [
      "第一章",
      "第二章",
      "第三章草稿",
      "人物：沈墨",
      "人物：苏婉",
      "地点：金陵城",
      "全书大纲",
      "时间线",
      "第四章提纲",
      "对白片段",
      "开头的三种写法",
      "雪景素材",
    ],
  },
  {
    id: "ming",
    name: "研究 / 明末",
    hub: "研究提纲",
    items: [
      "明末史料目录",
      "南京城防",
      "科举制度",
      "江南米价",
      "读书笔记：万历十五年",
      "人物考：阮大铖",
      "地图：应天府",
      "年表",
      "引文摘录",
    ],
  },
  {
    id: "job",
    name: "求职",
    hub: "求职",
    items: [
      "后端实习 A",
      "实习 B",
      "实习 C",
      "研究助理",
      "简历 2026 秋",
      "作品集",
      "面试准备",
      "公司调研",
      "推荐信",
      "投递记录",
    ],
  },
  {
    id: "db",
    name: "数据库课程",
    hub: "数据库考试",
    items: ["SQL 练习", "范式", "索引", "事务与锁", "B+ 树", "查询优化", "错题本", "往年试卷"],
  },
  {
    id: "dev",
    name: "Jady 开发",
    hub: "P0 总结",
    items: [
      "格式规范",
      "CRDT 选型",
      "全文搜索验证",
      "加密封装",
      "开发日志 10月18日",
      "开发日志 10月19日",
      "设计规范",
      "名词表",
      "Windows 验证",
    ],
  },
  {
    id: "diary",
    name: "日记",
    hub: "日记",
    private: true,
    items: ["10月17日", "10月16日", "10月15日", "10月14日", "10月13日", "10月12日"],
  },
];
const LOOSE = [
  "一个法语慢速播客",
  "第三章可以倒叙",
  "周末买菜",
  "想看的电影",
  "键盘轴体对比",
  "咖啡豆",
];

/** Note titles that open a real demo note; everything else opens as a placeholder. */
const NOTE_ID = Object.fromEntries(Object.entries(NOTES).map(([id, title]) => [title, id]));

export function demoGraph(): StarGraph {
  const rnd = seeded(7);
  const nodes: StarNode[] = [],
    edges: [string, string][] = [];
  for (const c of CLUSTERS) {
    const hub = `${c.id}:hub`;
    nodes.push({ id: hub, title: c.hub, cluster: c.id, hub: true });
    const ids = c.items.map((title, k) => {
      const id = NOTE_ID[title] ?? `${c.id}:${k}`;
      nodes.push({ id, title, cluster: c.id });
      return id;
    });
    ids.forEach((id, k) => {
      if (k % 3 !== 2) edges.push([hub, id]);
      const prev = ids[k - 1];
      if (prev && rnd() < 0.55) edges.push([prev, id]);
      const any = ids[Math.floor(rnd() * ids.length)];
      if (any && rnd() < 0.3) edges.push([id, any]);
    });
  }
  // A few links across clusters, so the map reads as one body of knowledge.
  edges.push(
    ["write:hub", "ming:hub"],
    ["write:3", "ming:5"],
    ["write:5", "ming:1"],
    ["dev:hub", "db:hub"],
    ["db:2", "dev:2"],
    ["job:hub", "job:5"],
    ["job:5", "dev:hub"],
    ["fr:hub", "fr:22"],
  );
  LOOSE.forEach((title, k) => nodes.push({ id: `loose:${k}`, title }));
  return {
    clusters: CLUSTERS.map(({ id, name, private: p }) => ({ id, name, private: p })),
    nodes,
    edges,
  };
}

function TodayPanel() {
  const [items, setItems] = useState<Todo[]>([
    { id: "t1", title: "复习 6 个法语词", done: false },
    { id: "t2", title: "投递 2 家实习", done: false },
    { id: "t3", title: "写 OS 开发日志", done: true },
  ]);
  return (
    <TodayTodos
      items={items}
      onToggle={(id, done) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, done } : x)))}
    />
  );
}

function RemindersPanel({ workspace }: PanelProps) {
  return (
    <Reminders
      items={[
        { id: "l12", title: "该复习：6 张法语记忆卡", when: "今天" },
        { id: "cv", title: "后端实习 A：再问一次", when: "下周一" },
        { id: "db", title: "数据库考试", when: "10月25日" },
      ]}
      onOpen={(id) =>
        NOTES[id] && workspace.open({ contentId: id, title: NOTES[id], component: "note" })
      }
    />
  );
}

/** One pending AI proposal; the proposal queue itself is P3 (P0.5-09 designs it). */
function ProposalsPanel() {
  return (
    <div className="lab-prop">
      <p className="lab-prop-what">
        <span className="lab-prop-ai">AI</span>给 la gare 补一句例句
      </p>
      <p className="lab-prop-where">第 12 课</p>
      <p className="lab-prop-diff">+ 例句：Je cherche la gare.</p>
      <div className="lab-prop-actions">
        <Button size="sm" variant="quiet" onPress={() => showToast({ text: "（开发版）忽略" })}>
          忽略
        </Button>
        <Button size="sm" variant="primary" onPress={() => showToast({ text: "（开发版）确认" })}>
          确认
        </Button>
      </div>
    </div>
  );
}

const YEAR = demoYear();
const yearItems = demoItems(YEAR);
const openItem = (item: HeatItem) => showToast({ text: `（开发版）打开 ${item.title}` });

/** The small one on the home page: picking a day opens the big one in the workspace. */
function HeatWidget({ workspace }: PanelProps) {
  const t = useT();
  return (
    <HeatMap
      data={YEAR}
      itemsOf={yearItems}
      onOpen={openItem}
      onExpand={(date) => {
        const id = workspace.open({
          contentId: "heatmap",
          component: "heatmap",
          title: t("heatmap.title"),
        });
        workspace.setTabParams(id, { date });
      }}
    />
  );
}

function HeatPanel({ params }: PanelProps) {
  return (
    <div className="dem-heat-page">
      <HeatMap
        key={String(params.date)}
        data={YEAR}
        itemsOf={yearItems}
        onOpen={openItem}
        initialDay={typeof params.date === "string" ? params.date : null}
      />
    </div>
  );
}

registerPanel({
  id: "home-reminders",
  icon: "notifications",
  role: "widget",
  render: RemindersPanel,
});
registerPanel({ id: "home-todos", icon: "todo", role: "widget", render: TodayPanel });
registerPanel({ id: "home-proposals", icon: "ai", role: "widget", render: ProposalsPanel });
registerPanel({ id: "home-heatmap", icon: "heatmap", role: "widget", render: HeatWidget });
registerPanel({ id: "heatmap", icon: "heatmap", role: "widget", render: HeatPanel });

/** The main space's home as in the P0.5 visual final: two columns of widgets, the map between. */
export function demoWidgets(t: (k: string) => string): HomeWidget[] {
  return [
    { id: "todo", panel: "home-todos", title: t("home.todos"), col: 0, row: 0, w: 3, h: 3 },
    { id: "rem", panel: "home-reminders", title: t("home.reminders"), col: 0, row: 3, w: 3, h: 2 },
    { id: "prop", panel: "home-proposals", title: t("home.proposals"), col: 9, row: 0, w: 3, h: 3 },
    { id: "heat", panel: "home-heatmap", title: t("home.heatmap"), col: 9, row: 3, w: 3, h: 2 },
  ];
}
