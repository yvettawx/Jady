/* eslint-disable react-refresh/only-export-components -- demo data and panels for dev pages, not hot-reloaded */
// Demo content shared by the development pages: a few notes, the directory, the open list
// and the default three-column layout. Importing this module registers the demo panels.
import { Tree } from "../ui/Tree";
import type { Layout } from "../workspace/layout";
import { OpenList } from "../workspace/OpenList";
import { registerPanel, type PanelProps } from "../workspace/registry";
import "./lab.css";

export const NOTES: Record<string, string> = {
  home: "首页",
  l11: "第 11 课",
  l12: "第 12 课 Le passé composé",
  draft: "第三章草稿",
  cv: "简历 2026 秋",
};

function Note({ contentId, tabId, kind, workspace, params }: PanelProps) {
  return (
    <div className="lab-note">
      <h2>{NOTES[contentId] ?? (params.title as string | undefined) ?? contentId}</h2>
      <textarea
        aria-label="正文"
        placeholder={kind === "preview" ? "预览页签：开始输入就变成临时页签" : "在这里输入"}
        onInput={() => workspace.promote(tabId)}
      />
    </div>
  );
}

function Directory({ workspace }: PanelProps) {
  const open = (id: string, kind: "preview" | "temp") =>
    NOTES[id] && workspace.open({ contentId: id, title: NOTES[id], component: "note" }, { kind });
  return (
    <div
      onDoubleClick={(e) => {
        const row = (e.target as HTMLElement).closest("[data-key]");
        if (row) open(String(row.getAttribute("data-key")), "temp");
      }}
    >
      <Tree
        aria-label="目录"
        defaultExpandedKeys={["lang", "fr"]}
        onAction={(id) => open(String(id), "preview")}
        items={[
          {
            id: "lang",
            label: "语言",
            icon: "folder",
            children: [
              {
                id: "fr",
                label: "法语",
                icon: "folder",
                children: [
                  { id: "l11", label: NOTES.l11 ?? "", icon: "file" },
                  { id: "l12", label: NOTES.l12 ?? "", icon: "file" },
                ],
              },
            ],
          },
          { id: "draft", label: NOTES.draft ?? "", icon: "file" },
          { id: "cv", label: NOTES.cv ?? "", icon: "job" },
        ]}
      />
    </div>
  );
}

registerPanel({ id: "note", icon: "file", render: Note });
registerPanel({ id: "tree", icon: "tree", role: "widget", render: Directory });
registerPanel({
  id: "open",
  icon: "app-window",
  role: "widget",
  render: ({ workspace }) => <OpenList workspace={workspace} />,
});
registerPanel({
  id: "outline",
  icon: "outline",
  role: "widget",
  render: () => <p className="lab-quiet">大纲</p>,
});
registerPanel({
  id: "links",
  icon: "link",
  role: "widget",
  render: () => <p className="lab-quiet">反向链接</p>,
});

const tab = (
  id: string,
  component: string,
  title: string,
  kind: "pin" | "temp" | "preview" = "temp",
) => ({
  id,
  contentId: id,
  component,
  title,
  kind,
});
export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  columns: [
    {
      size: 0.22,
      cells: [
        { size: 0.45, tabs: ["open"] },
        { size: 0.55, tabs: ["tree"] },
      ],
    },
    { size: 0.56, cells: [{ size: 1, tabs: ["home", "l12", "draft"], active: "l12" }] },
    {
      size: 0.22,
      cells: [
        { size: 0.6, tabs: ["outline"] },
        { size: 0.4, tabs: ["links"] },
      ],
    },
  ],
  floating: [],
  tabs: {
    open: tab("open", "open", "打开的内容", "pin"),
    tree: tab("tree", "tree", "目录", "pin"),
    home: tab("home", "note", "首页", "pin"),
    l12: tab("l12", "note", NOTES.l12 ?? ""),
    draft: tab("draft", "note", NOTES.draft ?? "", "preview"),
    outline: tab("outline", "outline", "大纲", "pin"),
    links: tab("links", "links", "反向链接", "pin"),
  },
};
