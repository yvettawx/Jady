// Launcher sources for the shell review pages (P0.5-07-7): the home demo's items as content
// (the diary is private), their tags, areas, projects and spaces for `@`, and four types for `+`.
import {
  contentSource,
  newSource,
  scopeSource,
  tagSource,
  type ContentEntry,
  type ScopeEntry,
  type TypeEntry,
} from "../../launcher/builtins";
import { registerSource } from "../../launcher/sources";
import type { StarGraph } from "../../home/starmap/graph";
import type { Space } from "../../shell/spaces";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

const TAGS: Record<string, string[]> = {
  fr: ["法语", "学习"],
  write: ["写作"],
  ming: ["明末", "研究"],
  job: ["求职"],
  db: ["数据库", "学习"],
  dev: ["开发"],
};
const RECENT = ["l12", "draft", "cv", "l11", "write:hub"];

export const DEMO_TYPES: TypeEntry[] = [
  { id: "note", name: "笔记", icon: "file" },
  { id: "card", name: "记忆卡", icon: "card" },
  { id: "todo", name: "待办", icon: "todo" },
  { id: "job", name: "职位", icon: "job" },
];

export function demoEntries(graph: StarGraph): ContentEntry[] {
  const cluster = new Map(graph.clusters.map((c) => [c.id, c]));
  return graph.nodes.map((n) => {
    const c = n.cluster ? cluster.get(n.cluster) : undefined;
    const recent = RECENT.indexOf(n.id);
    return {
      id: n.id,
      title: n.title,
      path: c?.name ?? "收集箱",
      icon: n.hub ? "folder" : c?.private ? "book" : "file",
      tags: n.cluster ? (TAGS[n.cluster] ?? []) : [],
      privacy: c?.private ? "private" : "normal",
      recent: recent < 0 ? undefined : RECENT.length - recent,
    };
  });
}

export function registerLauncherDemo(
  t: T,
  graph: StarGraph,
  spaces: () => Space[],
  ws: () => WorkspaceApi | null,
): () => void {
  const entries = demoEntries(graph);
  const scopes = (): ScopeEntry[] => [
    { id: "fr", name: "法语", kind: "area" },
    { id: "write", name: "写作", kind: "area" },
    { id: "ming", name: "明末", kind: "area" },
    { id: "job", name: "求职", kind: "project" },
    { id: "dev", name: "Jady 开发", kind: "project" },
    ...spaces().map((s): ScopeEntry => ({ id: `space:${s.id}`, name: s.name, kind: "space" })),
  ];
  const offs = [
    registerSource(
      contentSource(
        t,
        () => entries,
        (e, how) =>
          ws()?.open(
            { contentId: e.id, title: e.title, component: "note", params: { title: e.title } },
            how === "split" ? { split: "right" } : how === "tab" ? { newTab: true } : {},
          ),
      ),
    ),
    registerSource(tagSource(t, () => entries)),
    registerSource(scopeSource(t, scopes)),
    registerSource(
      newSource(
        t,
        () => DEMO_TYPES,
        (type, text) =>
          showToast({
            text: type
              ? `（开发版）已新建${type.name}：${text}`
              : `（开发版）已放进收集箱：${text}`,
          }),
      ),
    ),
  ];
  return () => offs.forEach((off) => off());
}
