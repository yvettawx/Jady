// Review page for P0.5-07-5, development builds only: #/screens/editor
// A workspace with a note of mixed Chinese, French and English (lists, quote, code, a Mermaid
// diagram, links, a memory card), a private note (AI greyed) and a version comparison. The
// format commands use the browser's contenteditable here; P1 replaces them with ProseMirror.
// Query: ?view=diff starts on the comparison, ?tab=diary on the private note.
import { memo, useCallback, useRef, useState } from "react";
import { CodeBlock } from "../../editor/blocks/CodeBlock";
import { MemoryCardBlock } from "../../editor/blocks/MemoryCardBlock";
import { MermaidBlock } from "../../editor/blocks/MermaidBlock";
import type { SheetMode } from "../../editor/mode";
import { NoteSheet, type FormatCommand } from "../../editor/NoteSheet";
import { SelectionBar } from "../../editor/SelectionBar";
import { VersionDiff, type DiffLayout } from "../../editor/VersionDiff";
import { WikiLink, type LinkTarget } from "../../editor/WikiLink";
import { useColorMode } from "../../theme/mode.ts";
import { SCHEMES } from "../../theme/tokens.ts";
import { GlassBackdrop } from "../../ui/glass/GlassBackdrop";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { useWallpaper } from "../../ui/glass/wallpaper";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { Tree } from "../../ui/Tree";
import { TitleBar } from "../../shell/TitleBar";
import type { WorkspaceApi } from "../../workspace/api";
import type { Layout } from "../../workspace/layout";
import { registerPanel, type PanelProps } from "../../workspace/registry";
import { Workspace } from "../../workspace/Workspace";
import "../lab.css";
import "./screens.css";

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");

const ITEMS: Record<string, LinkTarget> = {
  l11: {
    title: "第 11 课 être 和 avoir",
    body: "两个最常用的助动词。être：je suis, tu es, il est…；avoir：j'ai, tu as, il a…\n下一课的复合过去时要用到它们。",
  },
  gender: {
    title: "讲课：阴阳性",
    body: "法语名词分阴性和阳性，冠词跟着变：le train, la gare。\n以 -tion 结尾的多半是阴性。",
  },
};
const resolve = (id: string) => ITEMS[id] ?? null;

const fmt = (cmd: FormatCommand) => {
  const sel = getSelection()?.toString() ?? "";
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
  // execCommand is deprecated but still the simplest way to show these on a dev page.
  const run = (c: string, v?: string) => document.execCommand(c, false, v);
  switch (cmd) {
    case "bold":
    case "italic":
    case "underline":
      return run(cmd);
    case "highlight":
      return sel && run("insertHTML", `<mark>${esc(sel)}</mark>`);
    case "code":
      return sel && run("insertHTML", `<code>${esc(sel)}</code>`);
    case "heading":
      return run("formatBlock", "h2");
    case "quote":
      return run("formatBlock", "blockquote");
    case "bullets":
      return run("insertUnorderedList");
    case "numbers":
      return run("insertOrderedList");
    case "tasks":
      return run(
        "insertHTML",
        `<ul class="dem-tasks"><li data-checked="false"><input type="checkbox"><p>${esc(sel) || "<br>"}</p></li></ul>`,
      );
    case "link":
      return showToast({ text: "（开发版）P1 里这里会弹出条目搜索" });
  }
};

/** The long text. Rendered once (memo with no props that change): after that it is the editor's. */
const LessonText = memo(function LessonText({
  onOpen,
}: {
  onOpen: (id: string, how: "tab" | "split") => void;
}) {
  const link = (id: string) => (
    <WikiLink
      target={id}
      resolve={resolve}
      onOpen={onOpen}
      onCreate={(t) => showToast({ text: `（开发版）新建《${t}》` })}
    />
  );
  return (
    <>
      <p>
        复合过去时（le passé composé）用来讲<strong>已经完成</strong>
        的动作，相当于中文的“了”。它由两部分组成：助动词 avoir 或 être
        的现在时，加上动词的过去分词。助动词的变位在
        {link("l11")}里学过，这一课把它们用起来。
      </p>
      <h2>怎么构成</h2>
      <ol>
        <li>
          <p>
            选助动词：大多数动词用 <code>avoir</code>，表示位置移动和状态变化的十几个动词用{" "}
            <code>être</code>。
          </p>
        </li>
        <li>
          <p>把助动词变成现在时：j'ai、tu as、il a、nous avons……</p>
        </li>
        <li>
          <p>
            加过去分词：-er 动词把词尾换成 <mark>-é</mark>（manger → mangé），-ir 动词多半换成
            -i（finir → fini）。
          </p>
        </li>
      </ol>
      <blockquote>
        <p>Hier, j'ai mangé une pomme et je suis allé à la gare.</p>
        <p>昨天我吃了一个苹果，然后去了火车站。</p>
      </blockquote>
      <p>
        用 être 的时候，过去分词要和主语<em>性数配合</em>：elle est allée，nous sommes
        allés。名词的阴阳性见
        {link("gender")}；条件式放到下一课，{link("讲课：条件式")}。
      </p>
      <h2>哪些动词用 être</h2>
      <p>可以记成一幅“房子”：从门进出、上下楼梯、出生和死去，都是位置或状态的改变。</p>
      <MermaidBlock
        initial={`flowchart LR
  A[动词] --> B{表示位置移动\\n或状态变化？}
  B -- 是 --> C[être<br/>aller, venir, naître…]
  B -- 否 --> D[avoir<br/>manger, finir, voir…]
  C --> E[过去分词和主语配合]`}
      />
      <h3>自己写个小程序检查一下</h3>
      <p>写 OS 开发日志时顺手记的：判断该用哪个助动词。</p>
      <CodeBlock
        language="TypeScript"
        initial={`// 用 être 的动词（DR MRS VANDERTRAMP）
const ETRE = new Set(["aller", "venir", "naître", "mourir", "partir", "rester"]);

function auxiliary(verb: string): "être" | "avoir" {
  return ETRE.has(verb) ? "être" : "avoir";
}

console.log(auxiliary("aller")); // être
`}
      />
      <MemoryCardBlock
        front="« Je suis allé à la gare » 里为什么用 être？"
        back="aller 表示位置移动，复合过去时用 être 做助动词；主语是阳性单数，所以过去分词是 allé。"
        mastery={64}
        due="明天"
      />
      <h2>这周要做的</h2>
      <ul className="dem-tasks">
        <li data-checked="true">
          <input type="checkbox" defaultChecked />
          <p>把 20 个常用动词的过去分词抄一遍</p>
        </li>
        <li data-checked="false">
          <input type="checkbox" />
          <p>用复合过去时写 5 句话，讲讲上周末（en français, s'il vous plaît）</p>
        </li>
      </ul>
      <hr />
      <p>
        参考：<a href="https://www.lawlessfrench.com/grammar/passe-compose/">Lawless French</a>
        的讲解写得很清楚；2026 年 10 月复习到第 12 课，共 37 个生词。
      </p>
    </>
  );
});

function NotePanel({ contentId, workspace }: PanelProps) {
  const [mode, setMode] = useState<SheetMode>("edit");
  const prose = useRef<HTMLDivElement>(null);
  const priv = contentId === "diary";
  // Stable, so the memoised text never renders again.
  const open = useCallback(
    (id: string, how: "tab" | "split") => {
      const item = ITEMS[id];
      if (!item) return;
      workspace.open(
        { contentId: id, title: item.title, component: "editor-peeked" },
        how === "split" ? { split: "right" } : { newTab: true },
      );
    },
    [workspace],
  );
  return (
    <>
      <NoteSheet
        number={priv ? "0217" : "0142"}
        kind={priv ? "日记" : "笔记"}
        kindIcon={priv ? "book" : "file"}
        date={priv ? "10月17日" : "10月24日"}
        title={priv ? "10月17日" : "第 12 课 Le passé composé"}
        mode={mode}
        onMode={setMode}
        onFormat={fmt}
        privacy={priv ? "private" : "normal"}
        onAi={(a) => showToast({ text: `（开发版）AI ${a === "summary" ? "总结" : "整理"}` })}
      >
        <div
          ref={prose}
          className="dem-prose"
          data-mode={mode}
          contentEditable={mode === "edit"}
          suppressContentEditableWarning
          aria-label="正文"
          role="textbox"
          aria-multiline
        >
          {priv ? (
            <p>
              今天去了里昂。火车晚点四十分钟，在站台上和一位老太太聊了半天，她说我的法语“très
              bien”，大概是客气。
            </p>
          ) : (
            <LessonText onOpen={open} />
          )}
        </div>
      </NoteSheet>
      <SelectionBar
        root={prose}
        disabled={mode === "read"}
        privacy={priv ? "private" : "normal"}
        onAction={(a, text) => {
          if (a === "card") showToast({ text: `（开发版）生成记忆卡：「${text.slice(0, 20)}」` });
          else if (a === "ask-ai") showToast({ text: "（开发版）打开和这个页签关联的 AI 对话" });
          else fmt(a);
        }}
      />
    </>
  );
}

function PeekedPanel({ contentId }: PanelProps) {
  const item = ITEMS[contentId];
  return (
    <div className="dem-sheet">
      <div className="dem-sheet-body">
        <div className="dem-sheet-page">
          <h1 className="dem-sheet-title">{item?.title}</h1>
          <div className="dem-prose">
            {item?.body.split("\n").map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const V1 = [
  "复合过去时用来讲已经完成的动作。它由助动词的现在时加上过去分词组成。",
  "怎么构成",
  "大多数动词用 avoir，少数动词用 être。",
  "Hier, j'ai mangé une pomme.",
  "用 être 的时候，过去分词不变。",
];
const V2 = [
  "复合过去时（le passé composé）用来讲已经完成的动作，相当于中文的“了”。它由助动词的现在时加上过去分词组成。",
  "怎么构成",
  "大多数动词用 avoir，表示位置移动和状态变化的十几个动词用 être。",
  "Hier, j'ai mangé deux pommes et je suis allé à la gare.",
  "用 être 的时候，过去分词要和主语性数配合：elle est allée。",
  "可以记成一幅“房子”：从门进出、上下楼梯、出生和死去。",
];

function DiffPanel() {
  const [layout, setLayout] = useState<DiffLayout>("split");
  return (
    <VersionDiff
      before={{ label: "10月20日 21:06", paragraphs: V1 }}
      after={{ label: "10月24日 09:41", paragraphs: V2 }}
      layout={layout}
      onLayout={setLayout}
    />
  );
}

function NavPanel({ workspace }: PanelProps) {
  const open = (id: string) => {
    const t = workspace.tabs().find((x) => x.contentId === id);
    if (t) workspace.activate(t.id);
  };
  return (
    <Tree
      aria-label="目录"
      defaultExpandedKeys={["fr"]}
      onAction={(id) => open(String(id))}
      items={[
        {
          id: "fr",
          label: "法语",
          icon: "folder",
          children: [
            { id: "l12", label: "第 12 课 Le passé composé", icon: "file" },
            { id: "diff", label: "第 12 课的版本对比", icon: "history" },
          ],
        },
        { id: "diary", label: "日记 10月17日", icon: "book" },
      ]}
    />
  );
}

registerPanel({ id: "editor-note", icon: "file", render: NotePanel });
registerPanel({ id: "editor-peeked", icon: "file", render: PeekedPanel });
registerPanel({ id: "editor-diff", icon: "history", render: DiffPanel });
registerPanel({ id: "editor-nav", icon: "tree", role: "widget", render: NavPanel });

const start =
  params.get("view") === "diff" ? "diff" : params.get("tab") === "diary" ? "diary" : "l12";
const LAYOUT: Layout = {
  version: 1,
  columns: [
    { size: 0.2, cells: [{ size: 1, tabs: ["nav"] }] },
    { size: 0.8, cells: [{ size: 1, tabs: ["l12", "diff", "diary"], active: start }] },
  ],
  floating: [],
  tabs: {
    nav: { id: "nav", contentId: "nav", component: "editor-nav", title: "目录", kind: "pin" },
    l12: {
      id: "l12",
      contentId: "l12",
      component: "editor-note",
      title: "第 12 课 Le passé composé",
      kind: "pin",
    },
    diff: {
      id: "diff",
      contentId: "diff",
      component: "editor-diff",
      title: "版本对比",
      kind: "temp",
    },
    diary: {
      id: "diary",
      contentId: "diary",
      component: "editor-note",
      title: "10月17日",
      kind: "temp",
    },
  },
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

export function EditorScreens() {
  return (
    <GlassProvider accent={SCHEMES.aurora[0][0]}>
      <Page />
    </GlassProvider>
  );
}
